import { useState, useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { Modal, message } from 'antd'
import ChartPanel from './ChartPanel'
import QueryInspector from './QueryInspector'
import VariableSelector from './VariableSelector'
import SqlEditor from './SqlEditor'
import type { PanelDef, TargetDef, DatasourceRes, DashboardJSON, PanelDataRes, MetricRow, VariableRes, DataLinkDef } from '../api'
import * as api from '../api'

export interface PanelEditPageProps {
  panel: PanelDef
  datasources: DatasourceRes[]
  dashboardId: string
  draftJson?: any
  panelsData?: PanelDataRes[]
  variables?: VariableRes[]
  timePreset?: string
  customFrom?: string
  customTo?: string
  onSave: (updated: PanelDef) => void
  onBack: () => void
}

type SidebarTab = 'options' | 'share'

const CHART_TYPES: { value: PanelDef['type']; label: string; icon: string; hint: string }[] = [
  { value: 'table', label: '表格', icon: '⊞', hint: 'SQL 返回多行多列即展示为表格' },
  { value: 'bar', label: '柱状图', icon: '▐', hint: '第一列作为X轴(分类)，数值列作为Y轴(柱高)' },
  { value: 'timeseries', label: '时间序列', icon: '⌇', hint: '仿 Grafana Time Series，X轴时间，Y轴支持混合 Lines/Bars/Points' },
  { value: 'pie', label: '饼图', icon: '◉', hint: '第一列作为扇形名称，数值列作为扇形大小' },
  { value: 'gauge', label: '仪表板', icon: '◎', hint: '第一行第一列数值作为仪表值' },
]

const refLabels = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/* ── 可折叠分区组件 ── */
function Section({ title, defaultOpen = true, children, badge }: {
  title: string; defaultOpen?: boolean; children: ReactNode; badge?: string
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="pe-section">
      <div className="pe-section-header" onClick={() => setOpen(!open)}>
        <svg width="10" height="10" viewBox="0 0 10 10" style={{
          transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
          transition: 'transform 0.15s', flexShrink: 0,
        }} fill="currentColor">
          <path d="M3 1L8 5L3 9z" />
        </svg>
        <span style={{ flex: 1 }}>{title}</span>
        {badge && <span className="pe-badge">{badge}</span>}
      </div>
      {open && <div className="pe-section-body">{children}</div>}
    </div>
  )
}

export default function PanelEditPage({ panel, datasources, dashboardId, draftJson, panelsData, variables: initialVariables, timePreset: initialTimePreset, customFrom: initialCustomFrom, customTo: initialCustomTo, onSave, onBack }: PanelEditPageProps) {
  const [p, setP] = useState<PanelDef>(clonePanel(panel))
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('options')
  const [liveData, setLiveData] = useState<MetricRow[][]>([])
  const [liveColumns, setLiveColumns] = useState<string[]>([])
  const [queryLoading, setQueryLoading] = useState(false)
  const [hasUnsaved, setHasUnsaved] = useState(false)
  const [variables, setVariables] = useState<VariableRes[]>(initialVariables || [])
  const [variableReloadKey, setVariableReloadKey] = useState(0)
  const [manuallyTouchedVarIds, setManuallyTouchedVarIds] = useState<Set<string>>(new Set())
  const [showVariablesModal, setShowVariablesModal] = useState(false)

  // 查询卡片的折叠状态
  const [collapsedQueries, setCollapsedQueries] = useState<Set<number>>(new Set())

  // 左侧上下区域高度比例（上部占比，范围0.3-0.7）
  const [leftSplitRatio, setLeftSplitRatio] = useState(0.50)
  const [isDragging, setIsDragging] = useState(false)
  const leftPanelRef = useRef<HTMLDivElement>(null)

  // 左右区域宽度比例（左侧占比，范围0.4-0.75）
  const [leftRightRatio, setLeftRightRatio] = useState(0.72)
  const [isVerticalDragging, setIsVerticalDragging] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)

  // 防抖：批量处理多个变量自动全选触发的大量数据刷新
  const reloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingVarsRef = useRef<VariableRes[] | null>(null)

  // 时间范围选择（使用传入的初始值，若没有则从 localStorage 恢复）
  type TimePreset = '5m' | '30m' | '1h' | '6h' | '12h' | '24h' | '2d' | '7d' | '30d' | 'today' | 'yesterday' | 'day_before_yesterday' | 'last_week_today' | 'custom'
  const resolveTimePreset = (): TimePreset => {
    if (initialTimePreset) return initialTimePreset as TimePreset
    try {
      const saved = localStorage.getItem(`dash_time_${dashboardId}`)
      if (saved) return (JSON.parse(saved).timePreset as TimePreset) || '6h'
    } catch {}
    return '6h'
  }
  const resolveCustomFrom = (): string => {
    if (initialCustomFrom) return initialCustomFrom
    try {
      const saved = localStorage.getItem(`dash_time_${dashboardId}`)
      if (saved) return JSON.parse(saved).customFrom || ''
    } catch {}
    return ''
  }
  const resolveCustomTo = (): string => {
    if (initialCustomTo) return initialCustomTo
    try {
      const saved = localStorage.getItem(`dash_time_${dashboardId}`)
      if (saved) return JSON.parse(saved).customTo || ''
    } catch {}
    return ''
  }
  const [timePreset, setTimePresetState] = useState<TimePreset>(resolveTimePreset)
  const [customFrom, setCustomFrom] = useState(resolveCustomFrom)
  const [customTo, setCustomTo] = useState(resolveCustomTo)
  const [timePickerOpen, setTimePickerOpen] = useState(false)
  // 自定义时间的草稿状态：输入时只更新草稿，点击"应用"才提交
  const [draftCustomFrom, setDraftCustomFrom] = useState('')
  const [draftCustomTo, setDraftCustomTo] = useState('')

  // 打开时间选择器时，将草稿初始化为当前已保存值
  useEffect(() => {
    if (timePickerOpen) {
      setDraftCustomFrom(customFrom)
      setDraftCustomTo(customTo)
    }
  }, [timePickerOpen])

  // 持久化时间范围到 localStorage
  const setTimePreset = (preset: TimePreset) => {
    setTimePresetState(preset)
    try {
      localStorage.setItem(`dash_time_${dashboardId}`, JSON.stringify({ timePreset: preset, customFrom, customTo }))
    } catch {}
  }
  // 提交自定义时间（从草稿→正式）并持久化
  const applyCustomTime = () => {
    setCustomFrom(draftCustomFrom)
    setCustomTo(draftCustomTo)
    setTimePresetState('custom')
    try {
      localStorage.setItem(`dash_time_${dashboardId}`, JSON.stringify({ timePreset: 'custom', customFrom: draftCustomFrom, customTo: draftCustomTo }))
    } catch {}
  }

  const getTimeRangeDisplay = (): string => {
    if (timePreset === 'custom') {
      if (customFrom && customTo) {
        return `${customFrom} 至 ${customTo}`
      }
      return '自定义'
    }
    const labels: Record<TimePreset, string> = {
      '5m': '最近5分钟',
      '30m': '最近30分钟',
      '1h': '最近1小时',
      '6h': '最近6小时',
      '12h': '最近12小时',
      '24h': '最近24小时',
      '2d': '最近2天',
      '7d': '最近7天',
      '30d': '最近30天',
      'today': '今天',
      'yesterday': '昨天',
      'day_before_yesterday': '前天',
      'last_week_today': '上周今天',
      'custom': '自定义',
    }
    return labels[timePreset] || '最近6小时'
  }

  const getTimeRange = (): { from: string; to: string } | null => {
    if (timePreset === 'custom') {
      if (!customFrom && !customTo) return null
      return {
        from: customFrom ? new Date(customFrom).toISOString() : '',
        to: customTo ? new Date(customTo).toISOString() : '',
      }
    }

    const now = new Date()
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())

    // 绝对时间范围（整天）
    if (timePreset === 'today') {
      return { from: today.toISOString(), to: now.toISOString() }
    }
    if (timePreset === 'yesterday') {
      const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000)
      const yesterdayEnd = new Date(today.getTime() - 1)
      return { from: yesterday.toISOString(), to: yesterdayEnd.toISOString() }
    }
    if (timePreset === 'day_before_yesterday') {
      const dayBeforeYesterday = new Date(today.getTime() - 2 * 24 * 60 * 60 * 1000)
      const dayBeforeYesterdayEnd = new Date(today.getTime() - 24 * 60 * 60 * 1000 - 1)
      return { from: dayBeforeYesterday.toISOString(), to: dayBeforeYesterdayEnd.toISOString() }
    }
    if (timePreset === 'last_week_today') {
      const lastWeekToday = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000)
      const lastWeekTodayEnd = new Date(lastWeekToday.getTime() + 24 * 60 * 60 * 1000 - 1)
      return { from: lastWeekToday.toISOString(), to: lastWeekTodayEnd.toISOString() }
    }

    // 相对时间范围
    const to = now.toISOString()
    let ms = 0
    switch (timePreset) {
      case '5m': ms = 5 * 60 * 1000; break
      case '30m': ms = 30 * 60 * 1000; break
      case '1h': ms = 60 * 60 * 1000; break
      case '6h': ms = 6 * 60 * 60 * 1000; break
      case '12h': ms = 12 * 60 * 60 * 1000; break
      case '24h': ms = 24 * 60 * 60 * 1000; break
      case '2d': ms = 2 * 24 * 60 * 60 * 1000; break
      case '7d': ms = 7 * 24 * 60 * 60 * 1000; break
      case '30d': ms = 30 * 24 * 60 * 60 * 1000; break
      default: ms = 6 * 60 * 60 * 1000
    }
    const from = new Date(now.getTime() - ms).toISOString()
    return { from, to }
  }

  const handleTimePresetSelect = (preset: TimePreset) => {
    setTimePreset(preset)
    setTimePickerOpen(false)
    // 非自定义预设：立即刷新预览
    handleRefreshPreview()
  }

  // 应用自定义时间并关闭下拉、刷新预览
  const handleApplyCustomTime = () => {
    if (!draftCustomFrom || !draftCustomTo) return
    applyCustomTime()
    setTimePickerOpen(false)
    handleRefreshPreview()
  }

  // 点击外部关闭时间选择器
  useEffect(() => {
    if (!timePickerOpen) return
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (!target.closest('.time-picker-dropdown') && !target.closest('.time-picker-button')) {
        setTimePickerOpen(false)
      }
    }
    const timer = setTimeout(() => {
      document.addEventListener('click', handleClickOutside)
    }, 0)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('click', handleClickOutside)
    }
  }, [timePickerOpen])

  // 构建变量值映射（用户变量 + 系统变量）
  const getVariableMap = (): Record<string, string | string[]> => {
    const varMap: Record<string, string | string[]> = {}
    variables.forEach((v) => {
      if (v.current && (v.current as any).value) {
        varMap[v.name] = (v.current as any).value
      } else if (v.default) {
        varMap[v.name] = v.default
      } else if (v.type === 'custom' && v.options?.length > 0) {
        const firstOpt = v.options.find((o) => o.selected) || v.options[0]
        varMap[v.name] = firstOpt.value
      }
    })
    // 合并系统内置变量
    const tr = getTimeRange()
    if (tr) Object.assign(varMap, api.getSystemVars(tr.from, tr.to))
    return varMap
  }

  // 处理变量值变化
  const handleVariableChange = async (variableId: string, value: string | string[], isManual?: boolean) => {
    if (isManual) {
      setManuallyTouchedVarIds((prev) => new Set(prev).add(variableId))
    }
    const updatedVars = variables.map((v) => {
      if (v.id !== variableId) return v
      const text = Array.isArray(value)
        ? value.map((val) => v.options.find((o) => o.value === val)?.text || val)
        : (v.options.find((o) => o.value === value)?.text || value)
      return {
        ...v,
        current: { text: text as any, value: value as any },
      }
    })
    setVariables(updatedVars)
    setVariableReloadKey((k) => k + 1)

    // 保存变量当前值到后端
    try {
      await api.updateVariable(variableId, {
        dashboard_id: dashboardId,
        current: Array.isArray(value)
          ? { text: value.join(','), value }
          : { text: value, value },
      } as any)
    } catch {}

    // 防抖合并预览刷新：多个变量变化时只发一次请求
    pendingVarsRef.current = updatedVars
    if (reloadTimerRef.current) clearTimeout(reloadTimerRef.current)
    reloadTimerRef.current = setTimeout(() => {
      const vars = pendingVarsRef.current
      if (vars) handleRefreshPreviewWithVars(vars)
    }, 200)
  }

  useEffect(() => { setP(clonePanel(panel)) }, [panel])

  // 加载变量列表（只有在没有传入初始变量时才从API加载）
  useEffect(() => {
    if (!initialVariables || initialVariables.length === 0) {
      api.listVariables(dashboardId).then((list) => setVariables(list.sort((a, b) => a.sort_order - b.sort_order))).catch(() => {})
    }
  }, [dashboardId, initialVariables])

  // 从 panelsData 中获取当前面板的数据用于预览
  useEffect(() => {
    const pd = panelsData?.find((d) => d.panel_id === panel.id)
    if (pd) {
      setLiveData(pd.target || [])
      setLiveColumns(pd.columns || [])
    }
  }, [panelsData, panel.id])

  // 标记有未保存的更改
  useEffect(() => { setHasUnsaved(true) }, [p])

  // ---- 快照状态 ----
  const [snapName, setSnapName] = useState('')
  const [snapshots, setSnapshots] = useState<api.SnapshotRes[]>([])
  const [snapLoading, setSnapLoading] = useState(false)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)

  useEffect(() => { if (sidebarTab === 'share') { loadSnapshots() } }, [sidebarTab])

  const loadSnapshots = async () => {
    setSnapLoading(true)
    try { setSnapshots(await api.listSnapshots(dashboardId, panel.id)) } catch {}
    finally { setSnapLoading(false) }
  }

  const handleCreateSnapshot = async () => {
    if (!draftJson) return
    try {
      // 1. 合并当前编辑状态到 dashboard_json
      const panels: any[] = (draftJson.panels || []).map((dp: any) =>
        dp.id === p.id ? { ...p } : dp
      )
      if (!panels.find((dp: any) => dp.id === p.id)) {
        panels.push({ ...p })
      }
      const mergedJson = { ...draftJson, panels }
      let latestData: MetricRow[][] = liveData

      // 2. 尝试获取最新的面板查询结果
      const tr = getTimeRange()
      const varMap = getVariableMap()
      try {
        const dr = await api.getDashboardData(dashboardId, tr?.from, tr?.to, mergedJson as DashboardJSON, varMap)
        const pd = dr.panels_data?.find((d) => d.panel_id === panel.id)
        if (pd && pd.target && pd.target.length > 0) {
          latestData = pd.target
          setLiveData(pd.target)
          setLiveColumns(pd.columns || [])
        }
      } catch {
        // API 查询失败，尝试使用已有的 liveData
      }

      // 3. 确保有数据才创建快照
      const hasData = latestData.length > 0 && latestData.some(series => series.length > 0)
      if (!hasData) {
        message.warning('暂无预览数据，请先点击工具栏的「刷新」按钮获取数据后再创建快照')
        return
      }

      // 4. 构建 panels_data
      const panelData: api.PanelDataRes = {
        panel_id: panel.id,
        panel_title: p.title || panel.title,
        panel_type: p.type,
        datasource_id: p.datasource_id || '',
        target: latestData,
        columns: liveColumns,
      }

      const snap = await api.createSnapshot({
        dashboard_id: dashboardId, panel_id: panel.id,
        name: snapName || `${panel.title} 快照`,
        dashboard_json: mergedJson as DashboardJSON,
        panels_data: [panelData],
      })
      setSnapshots((prev) => [snap, ...prev])
      setSnapName('')
      message.success('创建快照成功')
    } catch (e: any) { message.error('创建快照失败: ' + (e.message || '未知错误')) }
  }

  const handleDeleteSnapshot = async (key: string) => {
    Modal.confirm({
      title: '确认删除',
      content: '确认删除该快照？',
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        try {
          await api.deleteSnapshot(key)
          setSnapshots((prev) => prev.filter((s) => s.snapshot_key !== key))
          message.success('删除成功')
        } catch (e: any) { message.error('删除失败: ' + (e.message || '未知错误')) }
      },
    })
  }

  const shareLink = `${window.location.origin}/capacity_mgt_platform/snapshot/`

  // ---- 刷新预览数据 ----
  const handleRefreshPreview = async () => {
    if (!draftJson) return
    setQueryLoading(true)
    try {
      const panels: any[] = (draftJson.panels || []).map((dp: any) =>
        dp.id === p.id ? { ...p } : dp
      )
      if (!panels.find((dp: any) => dp.id === p.id)) {
        panels.push({ ...p })
      }
      const mergedJson = { ...draftJson, panels }
      const tr = getTimeRange()
      const varMap = getVariableMap()
      const dr = await api.getDashboardData(dashboardId, tr?.from, tr?.to, mergedJson as DashboardJSON, varMap)
      const pd = dr.panels_data?.find((d) => d.panel_id === panel.id)
      if (pd) {
        setLiveData(pd.target || [])
        setLiveColumns(pd.columns || [])
      }
    } catch (e: any) {
      message.error('查询失败: ' + (e.message || '未知错误'))
    } finally {
      setQueryLoading(false)
    }
  }

  // 刷新预览数据（带指定变量列表）
  const handleRefreshPreviewWithVars = async (vars: VariableRes[]) => {
    if (!draftJson) return
    setQueryLoading(true)
    try {
      const panels: any[] = (draftJson.panels || []).map((dp: any) =>
        dp.id === p.id ? { ...p } : dp
      )
      if (!panels.find((dp: any) => dp.id === p.id)) {
        panels.push({ ...p })
      }
      const mergedJson = { ...draftJson, panels }
      const tr = getTimeRange()
      const varMap: Record<string, string | string[]> = {}
      vars.forEach((v) => {
        if (v.current && (v.current as any).value) {
          varMap[v.name] = (v.current as any).value
        } else if (v.default) {
          varMap[v.name] = v.default
        }
      })
      if (tr) Object.assign(varMap, api.getSystemVars(tr.from, tr.to))
      const dr = await api.getDashboardData(dashboardId, tr?.from, tr?.to, mergedJson as DashboardJSON, varMap)
      const pd = dr.panels_data?.find((d) => d.panel_id === panel.id)
      if (pd) {
        setLiveData(pd.target || [])
        setLiveColumns(pd.columns || [])
      }
    } catch (e: any) {
      // 静默失败
    } finally {
      setQueryLoading(false)
    }
  }

  const handleSave = () => {
    setHasUnsaved(false)
    onSave(p)
  }

  const handleDiscard = () => {
    if (hasUnsaved) {
      Modal.confirm({
        title: '确认放弃',
        content: '确定要丢弃所有更改吗？',
        okText: '放弃',
        okType: 'danger',
        cancelText: '继续编辑',
        onOk: () => {
          setP(clonePanel(panel))
          setHasUnsaved(false)
        },
      })
    } else {
      setP(clonePanel(panel))
      setHasUnsaved(false)
    }
  }

  const update = (patch: Partial<PanelDef>) => setP((prev) => ({ ...prev, ...patch }))
  const updateGrid = (field: 'x' | 'y' | 'w' | 'h', value: number) => {
    setP((prev) => ({ ...prev, gridPos: { ...prev.gridPos, [field]: value || 0 } }))
  }

  const updateTarget = (ti: number, patch: Partial<TargetDef>) => {
    setP((prev) => ({
      ...prev,
      targets: prev.targets.map((t, i) => (i === ti ? { ...t, ...patch } : t)),
    }))
  }

  // 使用回调更新target的headers，确保基于最新state而非闭包中的旧数据
  const updateTargetHeaders = (ti: number, updater: (headers: Record<string, string>) => Record<string, string> | undefined) => {
    setP((prev) => ({
      ...prev,
      targets: prev.targets.map((t, i) => {
        if (i !== ti) return t
        const curHeaders = (t.http_headers as Record<string, string> | undefined) || {}
        return { ...t, http_headers: updater(curHeaders) }
      }),
    }))
  }

  const setAlias = (ti: number, col: string, alias: string) => {
    setP((prev) => ({
      ...prev,
      targets: prev.targets.map((t, i) => {
        if (i !== ti) return t
        const am = { ...(t.aliasMap || {}) }
        if (alias) am[col] = alias
        else delete am[col]
        return { ...t, aliasMap: am }
      }),
    }))
  }

  const addAliasPair = (ti: number) => {
    updateTarget(ti, { aliasMap: { ...(p.targets[ti]?.aliasMap || {}), '': '' } })
  }

  const addTarget = () => {
    const nextRef = refLabels[p.targets.length] || `Q${p.targets.length}`
    setP((prev) => ({
      ...prev,
      targets: [...prev.targets, { refId: nextRef, targetType: 'query', rawSql: '', aliasMap: {}, category: '', metricName: '' }],
    }))
  }

  const addExpression = () => {
    const nextRef = refLabels[p.targets.length] || `Q${p.targets.length}`
    setP((prev) => ({
      ...prev,
      targets: [...prev.targets, { refId: nextRef, targetType: 'expression', expression: '', rawSql: '', aliasMap: {}, category: '', metricName: '' }],
    }))
  }

  const removeTarget = (ti: number) => {
    setP((prev) => ({
      ...prev,
      targets: prev.targets.filter((_, i) => i !== ti),
    }))
  }

  const isMultiQuery = p.type === 'line' || p.type === 'timeseries' || p.type === 'bar'
  const panelType = (liveData || []).length > 0 ? p.type : 'table'
  const currentChartInfo = CHART_TYPES.find((c) => c.value === p.type)

  // 拖动分隔条处理函数
  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }

  useEffect(() => {
    if (!isDragging) return

    const handleMouseMove = (e: MouseEvent) => {
      if (!leftPanelRef.current) return
      const rect = leftPanelRef.current.getBoundingClientRect()
      const newRatio = (e.clientY - rect.top) / rect.height
      setLeftSplitRatio(Math.min(0.7, Math.max(0.3, newRatio)))
    }

    const handleMouseUp = () => {
      setIsDragging(false)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDragging])

  // 垂直拖动分隔条处理函数（左右宽度调整）
  const handleVerticalMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    setIsVerticalDragging(true)
  }

  useEffect(() => {
    if (!isVerticalDragging) return

    const handleMouseMove = (e: MouseEvent) => {
      if (!bodyRef.current) return
      const rect = bodyRef.current.getBoundingClientRect()
      const newRatio = (e.clientX - rect.left) / rect.width
      setLeftRightRatio(Math.min(0.75, Math.max(0.4, newRatio)))
    }

    const handleMouseUp = () => {
      setIsVerticalDragging(false)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isVerticalDragging])

  return (
    <div className="pe-root">
      {/* ── 顶部工具栏 ── */}
      <div className="pe-toolbar">
        <div className="pe-toolbar-left">
          <button className="btn-sm" onClick={onBack} title="返回仪表板">
            &lt; 返回
          </button>
          <div className="pe-breadcrumb">
            <span className="pe-breadcrumb-link" onClick={onBack}>仪表板</span>
            <span className="pe-breadcrumb-sep">/</span>
            <span className="pe-breadcrumb-current">{p.title || '未命名面板'}</span>
          </div>
        </div>
        <div className="pe-toolbar-right">
          {/* 时间范围选择器 */}
          <div style={{ position: 'relative' }}>
            <button
              className="btn-sm time-picker-button"
              onClick={() => setTimePickerOpen(!timePickerOpen)}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginTop: '2px' }}>
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
              <span>{getTimeRangeDisplay()}</span>
              <span style={{ fontSize: 10 }}>▼</span>
            </button>
            {timePickerOpen && (
              <div
                className="time-picker-dropdown"
                style={{
                  position: 'absolute',
                  top: '100%',
                  right: 0,
                  marginTop: 4,
                  background: 'var(--bg-card)',
                  border: '1px solid var(--border-color)',
                  borderRadius: 6,
                  boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                  zIndex: 1000,
                  minWidth: 200,
                  padding: 8,
                }}
              >
                {/* 快速选择 */}
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4, fontWeight: 500 }}>快速选择</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
                  {[
                    { key: '5m', label: '最近5分钟' },
                    { key: '30m', label: '最近30分钟' },
                    { key: '1h', label: '最近1小时' },
                    { key: '6h', label: '最近6小时' },
                    { key: '12h', label: '最近12小时' },
                    { key: '24h', label: '最近24小时' },
                    { key: '2d', label: '最近2天' },
                    { key: '7d', label: '最近7天' },
                    { key: '30d', label: '最近30天' },
                  ].map((opt) => (
                    <button
                      key={opt.key}
                      onClick={() => handleTimePresetSelect(opt.key as TimePreset)}
                      style={{
                        padding: '6px 8px',
                        fontSize: 11,
                        background: timePreset === opt.key ? 'var(--primary)' : 'transparent',
                        color: timePreset === opt.key ? '#fff' : 'var(--text-primary)',
                        border: 'none',
                        borderRadius: 4,
                        cursor: 'pointer',
                        textAlign: 'left',
                      }}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>

                {/* 分隔线 */}
                <div style={{ height: 1, background: 'var(--border-color)', margin: '8px 0' }} />

                {/* 绝对时间 */}
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4, fontWeight: 500 }}>绝对时间</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
                  {[
                    { key: 'today', label: '今天' },
                    { key: 'yesterday', label: '昨天' },
                    { key: 'day_before_yesterday', label: '前天' },
                    { key: 'last_week_today', label: '上周今天' },
                  ].map((opt) => (
                    <button
                      key={opt.key}
                      onClick={() => handleTimePresetSelect(opt.key as TimePreset)}
                      style={{
                        padding: '6px 8px',
                        fontSize: 11,
                        background: timePreset === opt.key ? 'var(--primary)' : 'transparent',
                        color: timePreset === opt.key ? '#fff' : 'var(--text-primary)',
                        border: 'none',
                        borderRadius: 4,
                        cursor: 'pointer',
                        textAlign: 'left',
                      }}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>

                {/* 分隔线 */}
                <div style={{ height: 1, background: 'var(--border-color)', margin: '8px 0' }} />

                {/* 自定义 */}
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4, fontWeight: 500 }}>自定义范围</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input
                      type="datetime-local"
                      value={draftCustomFrom}
                      onChange={(e) => setDraftCustomFrom(e.target.value)}
                      style={{
                        fontSize: 10,
                        padding: '4px 6px',
                        width: 140,
                        background: 'var(--bg-input)',
                        color: 'var(--text-primary)',
                        border: '1px solid var(--border-color)',
                        borderRadius: 4,
                      }}
                    />
                    <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>至</span>
                    <input
                      type="datetime-local"
                      value={draftCustomTo}
                      onChange={(e) => setDraftCustomTo(e.target.value)}
                      style={{
                        fontSize: 10,
                        padding: '4px 6px',
                        width: 140,
                        background: 'var(--bg-input)',
                        color: 'var(--text-primary)',
                        border: '1px solid var(--border-color)',
                        borderRadius: 4,
                      }}
                    />
                  </div>
                  <button
                    onClick={handleApplyCustomTime}
                    disabled={!draftCustomFrom || !draftCustomTo}
                    style={{
                      padding: '4px 8px',
                      fontSize: 10,
                      background: draftCustomFrom && draftCustomTo ? 'var(--primary)' : 'var(--bg-input)',
                      color: draftCustomFrom && draftCustomTo ? '#fff' : 'var(--text-muted)',
                      border: '1px solid var(--border-color)',
                      borderRadius: 4,
                      cursor: draftCustomFrom && draftCustomTo ? 'pointer' : 'not-allowed',
                    }}
                  >
                    应用时间范围
                  </button>
                </div>
              </div>
            )}
          </div>
          {hasUnsaved && (
            <button className="btn-sm" onClick={handleDiscard} title="丢弃更改">
              丢弃
            </button>
          )}
          <button className="btn-sm" onClick={handleRefreshPreview} disabled={queryLoading} title="刷新预览数据">
            {queryLoading ? (
              <span className="pe-spinner" />
            ) : (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="23 4 23 10 17 10" />
                <polyline points="1 20 1 14 7 14" />
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
              </svg>
            )}
          </button>
          <button className="btn-sm save-btn" onClick={handleSave}>
            保存
          </button>
        </div>
      </div>

      {/* ── 变量选择器 ── */}
      {variables.length > 0 && (
        <VariableSelector
          variables={variables}
          onChange={handleVariableChange}
          reloadKey={variableReloadKey}
          manuallyTouchedVarIds={manuallyTouchedVarIds}
        />
      )}

      {/* ── 主体区域：左侧（上下分割） + 右侧边栏 ── */}
      <div className="pe-body" ref={bodyRef}>
        {/* 左侧：上部预览 + 下部查询配置 */}
        <div className="pe-left-panel" ref={leftPanelRef} style={{ width: `${leftRightRatio * 100}%` }}>
          {/* 上部：可视化预览 */}
          <div className="pe-preview" style={{ height: `${leftSplitRatio * 100}%` }}>
            <div className="pe-preview-header">
              <span className="pe-preview-type-badge">
                {currentChartInfo?.icon} {currentChartInfo?.label}
              </span>
              <span className="pe-preview-hint">{currentChartInfo?.hint}</span>
            </div>
            <div className="pe-preview-canvas">
              <ChartPanel
                key={`${panel.id}-${panelType}`}
                type={panelType}
                title={p.title || '预览'}
                data={liveData}
                targets={p.targets || []}
                options={p.options}
                columns={liveColumns}
                dataLinks={p.dataLinks}
                menuOpen={false}
                onToggleMenu={() => {}}
                onEdit={() => {}}
                onRemove={() => {}}
                showMenu={false}
              />
            </div>
          </div>

          {/* 可拖动分隔条 */}
          <div
            className="pe-horizontal-resizer"
            onMouseDown={handleMouseDown}
            style={{ cursor: isDragging ? 'ns-resize' : 'row-resse' }}
          >
            <div className="pe-resizer-line" />
          </div>

          {/* 下部：查询配置 */}
          <div className="pe-query-panel" style={{ height: `${(1 - leftSplitRatio) * 100}%` }}>
            <div className="pe-query-panel-content">
              {/* 数据源和可用变量一行显示 */}
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '12px 16px',
                background: 'var(--bg-primary)',
                borderBottom: '1px solid var(--border-color)'
              }}>
                <label  style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>数据源</label>
                <select
                  value={p.datasource_id || ''}
                  onChange={(e) => update({ datasource_id: e.target.value || undefined, datasource: undefined } as any)}
                  className="pe-select"
                  style={{ minWidth:100}}
                >
                  <option value="">选择数据源...</option>
                  {datasources.map((ds) => (
                    <option key={ds.id} value={ds.id}>{ds.name} ({ds.type === 'mysql' ? 'MySQL' : 'HTTP'})</option>
                  ))}
                </select>
                <button
                  onClick={() => setShowVariablesModal(true)}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: '#1890ff',
                    fontSize: 13,
                    cursor: 'pointer',
                    padding: '2px 8px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    transition: 'color 0.2s',
                    whiteSpace: 'nowrap',
                    flexShrink: 0
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.color = '#40a9ff'}
                  onMouseLeave={(e) => e.currentTarget.style.color = '#1890ff'}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0 }}>
                    <circle cx="12" cy="12" r="10"/>
                    <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>
                    <line x1="12" y1="17" x2="12.01" y2="17"/>
                  </svg>
                  可用变量
                </button>
              </div>

              <div style={{ padding: '8px 16px 16px' }}>
                {p.targets.map((target, ti) => {
                  const isExpr = target.targetType === 'expression'
                  const isCollapsed = collapsedQueries.has(ti)
                  const toggleCollapse = () => {
                    setCollapsedQueries(prev => {
                      const next = new Set(prev)
                      if (next.has(ti)) {
                        next.delete(ti)
                      } else {
                        next.add(ti)
                      }
                      return next
                    })
                  }
                  return (
                  <div key={ti} className="pe-query-block">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 0', background: 'var(--bg-raised)' }}>
                      {/* 折叠按钮 */}
                      <button
                        onClick={toggleCollapse}
                        style={{
                          background: 'transparent',
                          border: 'none',
                          padding: '2px 4px',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          transition: 'transform 0.15s'
                        }}
                        title={isCollapsed ? '展开' : '折叠'}
                      >
                        <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" style={{
                          transform: isCollapsed ? 'rotate(0deg)' : 'rotate(90deg)',
                          transition: 'transform 0.15s',
                          color: 'var(--text-muted)'
                        }}>
                          <path d="M3 1L8 5L3 9z" />
                        </svg>
                      </button>
                      <input
                        value={target.refId || ''}
                        onChange={(e) => updateTarget(ti, { refId: e.target.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 2) })}
                        style={{ width: 36, textAlign: 'center', fontWeight: 700, fontSize: 13, border: '1px solid var(--border-color)', borderRadius: 4, padding: '2px 0', background: 'var(--bg-input)', color: isExpr ? '#7c3aed' : 'var(--text-primary)' }}
                        title="查询引用ID（如 $A）"
                        maxLength={2}
                      />
                      <input
                        value={target.metricName || ''}
                        onChange={(e) => updateTarget(ti, { metricName: e.target.value })}
                        placeholder="名称（可选）"
                        className="pe-input-sm"
                        style={{ flex: 1 }}
                      />
                      <span style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0 }}>{isExpr ? '表达式' : '查询'}</span>
                      {p.targets.length > 1 && (
                        <button className="pe-query-remove" onClick={() => removeTarget(ti)} title="移除" style={{ margin: 0 }}>
                          <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><path d="M2 2l8 8m0-8l-8 8" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round"/></svg>
                        </button>
                      )}
                    </div>

                    {!isCollapsed && (
                      <>
                    {isExpr ? (
                      <div style={{ padding: '12px', background: 'rgba(124,58,237,0.04)', borderRadius: '0 0 6px 6px' }}>
                        <div className="pe-field" style={{ marginBottom: 4 }}>
                          <label className="pe-label-sm">Math 表达式</label>
                          <input
                            value={target.expression || ''}
                            onChange={(e) => updateTarget(ti, { expression: e.target.value })}
                            placeholder="如：$A + $B 或 $A / $B * 100"
                            className="pe-input-sm"
                            style={{ fontFamily: 'monospace', fontSize: 13, width: '100%' }}
                          />
                        </div>
                        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>
                          可用引用：{p.targets.filter(t => t.targetType !== 'expression').map(t => '$' + t.refId).join('、') || '无'}
                        </div>
                      </div>
                    ) : (
<>

                      {/* 根据数据源类型显示不同的查询配置 */}
                      {(() => {
                        const selectedDs = datasources.find(ds => ds.id === p.datasource_id)
                        if (!p.datasource_id) {
                          // 未选择数据源 - 提示选择
                          return (
                            <div className="pe-hint-text" style={{ textAlign: 'center', padding: '30px 20px', background: 'var(--bg-input)', borderRadius: 4 }}>
                              请先在上方选择数据源
                            </div>
                          )
                        } else if (!selectedDs || selectedDs.type === 'mysql') {
                          // MySQL数据源 - 显示SQL查询
                          return (
                            <SqlEditor
                              value={target.rawSql || ''}
                              onChange={(value) => updateTarget(ti, { rawSql: value })}
                              placeholder="SELECT market, date, weekday FROM calendar LIMIT 100"
                              height="150px"
                              dialect="mysql"
                              variables={[
                                // 系统内置变量
                                { name: '__from', label: '开始时间（ISO格式）' },
                                { name: '__to', label: '结束时间（ISO格式）' },
                                { name: '__fromUnix', label: '开始时间（Unix秒）' },
                                { name: '__toUnix', label: '结束时间（Unix秒）' },
                                { name: '__fromMs', label: '开始时间（毫秒）' },
                                { name: '__toMs', label: '结束时间（毫秒）' },
                                // 仪表板变量
                                ...variables.map(v => ({ name: v.name, label: v.label || v.name })),
                              ]}
                            />
                          )
                        } else if (selectedDs.type === 'http') {
                          // HTTP数据源 - 显示HTTP配置
                          return (
                            <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 6, overflow: 'hidden' }}>
                              {/* 标题区域 */}
                              <div style={{
                                background: 'linear-gradient(135deg, rgba(87, 148, 242, 0.1), rgba(87, 148, 242, 0.05))',
                                padding: '10px 12px',
                                borderBottom: '1px solid var(--border-color)',
                                display: 'flex',
                                alignItems: 'center',
                                gap: 8
                              }}>
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--primary)' }}>
                                  <circle cx="12" cy="12" r="10"/>
                                  <line x1="2" y1="12" x2="22" y2="12"/>
                                  <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
                                </svg>
                                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>HTTP API 配置</span>
                              </div>

                              {/* 配置内容 */}
                              <div style={{ padding: '12px' }}>
                                {/* URL和方法 */}
                                <div style={{ marginBottom: 12 }}>
                                  <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
                                    <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', marginRight: 8 }}>请求配置</label>
                                    <span style={{ fontSize: 9, color: 'var(--text-muted)', background: 'var(--bg-input)', padding: '1px 6px', borderRadius: 3 }}>必填</span>
                                  </div>
                                  <div style={{ display: 'flex', gap: 8 }}>
                                    <div style={{ flex: 1 }}>
                                      <input
                                        value={target.http_path || ''}
                                        onChange={(e) => updateTarget(ti, { http_path: e.target.value })}
                                        placeholder="/api/v1/users"
                                        className="pe-input-sm"
                                        style={{ fontSize: 13 }}
                                      />
                                    </div>
                                    <div style={{ flex: 0.15, minWidth: 80 }}>
                                      <select
                                        value={target.http_method || 'GET'}
                                        onChange={(e) => updateTarget(ti, { http_method: e.target.value as any })}
                                        className="pe-select-sm"
                                        style={{ fontSize: 13, fontWeight: 600 }}
                                      >
                                        <option value="GET">GET</option>
                                        <option value="POST">POST</option>
                                      </select>
                                    </div>
                                  </div>
                                  {/* 完整URL预览 */}
                                  <div style={{
                                    marginTop: 6,
                                    padding: '6px 8px',
                                    background: 'var(--bg-input)',
                                    borderRadius: 3,
                                    fontSize: 11,
                                    color: 'var(--text-secondary)',
                                    fontFamily: 'monospace',
                                    border: '1px solid var(--border-color)'
                                  }}>
                                    <span style={{ color: 'var(--text-muted)' }}>完整URL: </span>
                                    <span style={{ color: 'var(--primary)', fontWeight: 600 }}>{selectedDs.url}</span>
                                    <span style={{ color: 'var(--text-primary)' }}>{target.http_path || '/'}</span>
                                  </div>
                                </div>

                                {/* 请求体（POST才显示） */}
                                {target.http_method === 'POST' && (
                                  <div style={{ marginBottom: 12 }}>
                                    <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6, gap: 12 }}>
                                      <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)' }}>请求体</label>
                                      <select
                                        value={target.http_body_type || 'raw'}
                                        onChange={(e) => updateTarget(ti, { http_body_type: e.target.value as any })}
                                        className="pe-select-sm"
                                        style={{ fontSize: 11 }}
                                      >
                                        <option value="raw">Raw (JSON)</option>
                                        <option value="form-data">Form Data</option>
                                        <option value="x-www-form-urlencoded">x-www-form-urlencoded</option>
                                        <option value="graphql">GraphQL</option>
                                      </select>
                                    </div>

                                    {/* Raw格式 - JSON文本 */}
                                    {(target.http_body_type === 'raw' || !target.http_body_type) && (
                                      <textarea
                                        value={target.http_body || ''}
                                        onChange={(e) => updateTarget(ti, { http_body: e.target.value })}
                                        placeholder='{"key": "value"}'
                                        className="pe-sql-editor"
                                        spellCheck={false}
                                        rows={3}
                                        style={{ fontSize: 12 }}
                                      />
                                    )}

                                    {/* GraphQL格式 */}
                                    {target.http_body_type === 'graphql' && (
                                      <div>
                                        <textarea
                                          value={target.http_body || ''}
                                          onChange={(e) => updateTarget(ti, { http_body: e.target.value })}
                                          placeholder='query { users { id name } }'
                                          className="pe-sql-editor"
                                          spellCheck={false}
                                          rows={3}
                                          style={{ fontSize: 12 }}
                                        />
                                        <div className="pe-hint-text" style={{ marginTop: 4, fontSize: 9 }}>
                                          GraphQL查询语句，会自动包装成 {"{ \"query\": \"...\" }"} 格式发送
                                        </div>
                                      </div>
                                    )}

                                    {/* Form Data 和 x-www-form-urlencoded - key-value列表 */}
                                    {(target.http_body_type === 'form-data' || target.http_body_type === 'x-www-form-urlencoded') && (
                                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                        {(() => {
                                          const formData = target.http_form_data || []
                                          return (
                                            <>
                                              {formData.map((field, idx) => (
                                                <div key={idx} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                                  <input
                                                    value={field.key}
                                                    onChange={(e) => {
                                                      const newData = [...formData]
                                                      newData[idx] = { ...newData[idx], key: e.target.value }
                                                      updateTarget(ti, { http_form_data: newData })
                                                    }}
                                                    placeholder="字段名"
                                                    className="pe-input-sm"
                                                    style={{ flex: 1, fontSize: 11 }}
                                                  />
                                                  <input
                                                    value={field.value}
                                                    onChange={(e) => {
                                                      const newData = [...formData]
                                                      newData[idx] = { ...newData[idx], value: e.target.value }
                                                      updateTarget(ti, { http_form_data: newData })
                                                    }}
                                                    placeholder="值"
                                                    className="pe-input-sm"
                                                    style={{ flex: 1, fontSize: 11 }}
                                                  />
                                                  <button
                                                    type="button"
                                                    onClick={() => {
                                                      const newData = formData.filter((_, i) => i !== idx)
                                                      updateTarget(ti, { http_form_data: newData.length > 0 ? newData : undefined })
                                                    }}
                                                    className="pe-link-btn"
                                                    style={{ fontSize: 10, padding: '2px 6px' }}
                                                  >
                                                    删除
                                                  </button>
                                                </div>
                                              ))}
                                              <button
                                                type="button"
                                                onClick={() => {
                                                  const newData = [...formData, { key: '', value: '' }]
                                                  updateTarget(ti, { http_form_data: newData })
                                                }}
                                                className="pe-link-btn"
                                                style={{ fontSize: 10 }}
                                              >
                                                + 添加字段
                                              </button>
                                            </>
                                          )
                                        })()}
                                      </div>
                                    )}
                                  </div>
                                )}

                                {/* 数据解析配置 */}
                                <div style={{ marginBottom: 8 }}>
                                  <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
                                    <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', marginRight: 8 }}>数据解析</label>
                                    <span style={{ fontSize: 9, color: 'var(--text-muted)', background: 'var(--bg-input)', padding: '1px 6px', borderRadius: 3 }}>可选</span>
                                  </div>
                                  <div style={{ display: 'flex', gap: 8 }}>
                                    <div style={{ flex: 0.3, minWidth: 100 }}>
                                      <label style={{ fontSize: 10, color: 'var(--text-muted)', display: 'block', marginBottom: 3 }}>数据格式</label>
                                      <select
                                        value={target.http_data_format || 'json'}
                                        onChange={(e) => updateTarget(ti, { http_data_format: e.target.value as any })}
                                        className="pe-select-sm"
                                        style={{ fontSize: 12 }}
                                      >
                                        <option value="json">JSON</option>
                                        <option value="xml">XML</option>
                                        <option value="csv">CSV</option>
                                      </select>
                                    </div>
                                    <div style={{ flex: 0.7 }}>
                                      <label style={{ fontSize: 10, color: 'var(--text-muted)', display: 'block', marginBottom: 3 }}>数据路径 (JSONPath)</label>
                                      <input
                                        value={target.http_data_path || ''}
                                        onChange={(e) => updateTarget(ti, { http_data_path: e.target.value })}
                                        placeholder="data.results 或 items[*]"
                                        className="pe-input-sm"
                                        style={{ fontSize: 12 }}
                                      />
                                    </div>
                                  </div>
                                </div>

                                {/* 自定义Headers */}
                                <div style={{ marginTop: 8 }}>
                                  <label style={{ fontSize: 10, color: 'var(--text-muted)', display: 'block', marginBottom: 3 }}>
                                    自定义Headers [可选]
                                  </label>
                                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                    {(() => {
                                      const headersObj = target.http_headers as Record<string, unknown> | undefined
                                      const entries = headersObj
                                        ? Object.entries(headersObj) as Array<[string, string]>
                                        : []
                                      return (
                                        <>
                                          {entries.map(([key, value], idx) => (
                                            <div key={idx} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                              <input
                                                value={key.startsWith('__new_') ? '' : key}
                                                onChange={(e) => {
                                                  const val = e.target.value
                                                  updateTargetHeaders(ti, (curHeaders) => {
                                                    const objEntries = Object.entries(curHeaders)
                                                    const newObj: Record<string, string> = {}
                                                    objEntries.forEach(([k, v], i) => {
                                                      if (i === idx) {
                                                        if (val) newObj[val] = v
                                                      } else {
                                                        newObj[k] = v
                                                      }
                                                    })
                                                    return newObj
                                                  })
                                                }}
                                                placeholder="Key"
                                                className="pe-input-sm"
                                                style={{ flex: 1, fontSize: 11 }}
                                              />
                                              <input
                                                value={value}
                                                onChange={(e) => {
                                                  const val = e.target.value
                                                  updateTargetHeaders(ti, (curHeaders) => {
                                                    const objEntries = Object.entries(curHeaders)
                                                    const newObj: Record<string, string> = {}
                                                    objEntries.forEach(([k, v], i) => {
                                                      newObj[k] = (i === idx) ? val : v
                                                    })
                                                    return newObj
                                                  })
                                                }}
                                                placeholder="Value"
                                                className="pe-input-sm"
                                                style={{ flex: 1, fontSize: 11 }}
                                              />
                                              <button
                                                type="button"
                                                onClick={() => {
                                                  updateTargetHeaders(ti, (curHeaders) => {
                                                    const objEntries = Object.entries(curHeaders)
                                                    const newObj: Record<string, string> = {}
                                                    objEntries.forEach(([k, v], i) => {
                                                      if (i !== idx) newObj[k] = v
                                                    })
                                                    return Object.keys(newObj).length > 0 ? newObj : undefined
                                                  })
                                                }}
                                                className="pe-link-btn"
                                                style={{ fontSize: 10, padding: '2px 6px' }}
                                              >
                                                删除
                                              </button>
                                            </div>
                                          ))}
                                          <button
                                            type="button"
                                            onClick={() => {
                                              updateTargetHeaders(ti, (curHeaders) => {
                                                const tempKey = `__new_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
                                                return { ...curHeaders, [tempKey]: '' }
                                              })
                                            }}
                                            className="pe-link-btn"
                                            style={{ fontSize: 10 }}
                                          >
                                            + 添加Header
                                          </button>
                                        </>
                                      )
                                    })()}
                                  </div>
                                  <div className="pe-hint-text" style={{ marginTop: 2, fontSize: 9 }}>
                                    优先级：认证Headers {'>'} 查询Headers {'>'} 数据源Headers
                                  </div>
                                </div>

                                {/* 变量支持提示 */}
                                <div style={{
                                  marginTop: 10,
                                  padding: '8px 10px',
                                  background: 'linear-gradient(135deg, rgba(255, 152, 48, 0.1), rgba(255, 152, 48, 0.05))',
                                  borderRadius: 4,
                                  border: '1px solid rgba(255, 152, 48, 0.2)',
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 6
                                }}>
                                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: '#ff9830' }}>
                                    <circle cx="12" cy="12" r="10"/>
                                    <line x1="12" y1="16" x2="12" y2="12"/>
                                    <line x1="12" y1="8" x2="12.01" y2="8"/>
                                  </svg>
                                  <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
                                    <span style={{ fontWeight: 600 }}>支持变量替换：</span>
                                    <span style={{ fontFamily: 'monospace', color: 'var(--primary)', marginLeft: 4 }}>$__from, $__to, $__fromMs</span>
                                    <span style={{ marginLeft: 8 }}>及自定义变量：</span>
                                    <span style={{ fontFamily: 'monospace', color: 'var(--primary)', marginLeft: 4 }}>$city, $user</span>
                                  </div>
                                </div>
                              </div>
                            </div>
                          )
                        }
                        return null
                      })()}

                      <div className="pe-alias-section">
                        <div className="pe-alias-header">
                          <span className="pe-label-sm">列别名映射</span>
                          <button className="pe-link-btn" onClick={() => addAliasPair(ti)}>+ 添加</button>
                        </div>
                        {target.aliasMap && Object.keys(target.aliasMap).length > 0 ? (
                          <div className="pe-alias-list">
                            {Object.entries(target.aliasMap).map(([col, alias], ai) => (
                              <div key={ai} className="pe-alias-row">
                                <input value={col} onChange={(e) => {
                                  const am = { ...(target.aliasMap || {}) }; delete am[col]
                                  am[e.target.value] = alias || e.target.value
                                  updateTarget(ti, { aliasMap: am })
                                }} placeholder="列名" className="pe-input-xs" />
                                <span className="pe-alias-arrow">→</span>
                                <input value={alias} onChange={(e) => setAlias(ti, col, e.target.value)}
                                  placeholder="别名" className="pe-input-xs" />
                                <button className="pe-alias-remove" onClick={() => setAlias(ti, col, '')}>
                                  <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><path d="M1 1l8 8m0-8l-8 8" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round"/></svg>
                                </button>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <span className="pe-hint-text">暂未配置别名</span>
                        )}
                      </div>

                      {/* Query Inspector */}
                      <QueryInspector
                        dashboardId={dashboardId}
                        datasourceId={p.datasource_id}
                        datasources={datasources}
                        rawSql={target.rawSql || ''}
                        httpPath={target.http_path || ''}
                        httpMethod={target.http_method || ''}
                        httpBodyType={target.http_body_type}
                        httpBody={target.http_body || ''}
                        httpFormData={target.http_form_data}
                        httpHeaders={target.http_headers}
                        httpDataFormat={target.http_data_format || ''}
                        httpDataPath={target.http_data_path || ''}
                        variables={variables}
                        from={getTimeRange()?.from}
                        to={getTimeRange()?.to}
                      />
                    </>
                  )}
                      </>
                    )}
                  </div>
                  )})}

                <div style={{ display: 'flex', gap: 8 }}>
                <button className="pe-add-query-btn" onClick={addTarget}>
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round"/></svg>
                  添加查询
                </button>
                <button className="pe-add-query-btn" onClick={addExpression}>
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><path d="M3 3h6M3 6h6M3 9h6" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round"/></svg>
                  添加表达式
                </button>
                </div>
                {isMultiQuery && (
                  <div className="pe-hint-block">
                    折线图和柱状图支持多条查询，每条查询作为图表中的一个数据系列。
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* 垂直分隔条 */}
        <div
          className="pe-vertical-resizer"
          onMouseDown={handleVerticalMouseDown}
          style={{ cursor: isVerticalDragging ? 'ew-resize' : 'col-resize' }}
        >
          <div className="pe-vertical-resizer-line" />
        </div>

        {/* 右侧：侧边栏 */}
        <div className="pe-sidebar" style={{ width: `${(1 - leftRightRatio) * 100}%` }}>
          {/* 侧边栏 Tab 切换 */}
          <div className="pe-sidebar-tabs">
            {(['options', 'share'] as SidebarTab[]).map((t) => (
              <button
                key={t}
                className={`pe-sidebar-tab ${sidebarTab === t ? 'active' : ''}`}
                onClick={() => setSidebarTab(t)}
              >
                {t === 'options' && (
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><path d="M7 4.5a2.5 2.5 0 110 5 2.5 2.5 0 010-5zM7 3a4 4 0 100 8 4 4 0 000-8z" opacity=".7"/></svg>
                )}
                {t === 'share' && (
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><path d="M10.5 9a2.5 2.5 0 10-2.17-1.26L5.67 9.5a2.5 2.5 0 100 2l2.66-1.76A2.49 2.49 0 0010.5 9z" opacity=".7"/></svg>
                )}
                {t === 'options' ? '选项' : '共享'}
              </button>
            ))}
          </div>

          {/* 侧边栏内容 */}
          <div className="pe-sidebar-content">
            {/* ═══ 选项 Tab ═══ */}
            {sidebarTab === 'options' && (
              <>
                <Section title="面板标题" defaultOpen={true}>
                  <div className="pe-field">
                    <input value={p.title} onChange={(e) => update({ title: e.target.value })} placeholder="面板标题" className="pe-input" />
                  </div>
                </Section>

                <Section title="可视化类型" defaultOpen={true}>
                  <div className="pe-chart-type-grid">
                    {CHART_TYPES.map((ct) => (
                      <button
                        key={ct.value}
                        className={`pe-chart-type-card ${p.type === ct.value ? 'active' : ''}`}
                        onClick={() => update({ type: ct.value as PanelDef['type'] })}
                        title={ct.hint}
                      >
                        <span className="pe-chart-type-icon">{ct.icon}</span>
                        <span className="pe-chart-type-label">{ct.label}</span>
                      </button>
                    ))}
                  </div>
                  <div className="pe-hint-block" style={{ marginTop: 8 }}>
                    {currentChartInfo?.hint}
                  </div>
                </Section>

                {p.type === 'bar' && (
                  <Section title="柱状图方向" defaultOpen={true}>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        className={`pe-chart-type-card ${(p.options?.barOrientation || 'vertical') === 'vertical' ? 'active' : ''}`}
                        onClick={() => update({ options: { ...p.options, barOrientation: 'vertical' } })}
                        style={{ flex: 1, padding: '8px 12px' }}
                      >
                        <span style={{ fontSize: 18 }}>▐</span>
                        <span style={{ fontSize: 12, marginLeft: 8 }}>纵向柱状图</span>
                      </button>
                      <button
                        className={`pe-chart-type-card ${(p.options?.barOrientation || 'vertical') === 'horizontal' ? 'active' : ''}`}
                        onClick={() => update({ options: { ...p.options, barOrientation: 'horizontal' } })}
                        style={{ flex: 1, padding: '8px 12px' }}
                      >
                        <span style={{ fontSize: 18 }}>▬</span>
                        <span style={{ fontSize: 12, marginLeft: 8 }}>横向柱状图</span>
                      </button>
                    </div>
                    <div className="pe-hint-text" style={{ marginTop: 4, marginLeft: 0 }}>
                      纵向：分类在X轴，数值在Y轴。横向：分类在Y轴，数值在X轴。
                    </div>
                  </Section>
                )}

                {p.type === 'timeseries' && (() => {
                  const previewRows = liveData?.[0] || []
                  // 从预览数据中提取数值列名（排除时间/日期类列）
                  const sampleKeys = previewRows.length > 0 ? Object.keys(previewRows[0] || {}) : []
                  const valueFieldNames = sampleKeys.filter((k) => {
                    const kl = k.toLowerCase()
                    if (kl.includes('date') || kl.includes('time') || kl.includes('日期') || kl.includes('时间') || kl === 'day') return false
                    // 检查是否为纯数值
                    return previewRows.some((r: any) => {
                      const v = r[k]
                      return v !== undefined && v !== null && v !== '' && !isNaN(parseFloat(v))
                    })
                  })
                  const currentStyles = (p.options?.fieldStyles || {}) as Record<string, string>
                  const currentColors = (p.options?.fieldColors || {}) as Record<string, string>
                  const defaultPalette = ['#5470c6', '#73c0de', '#91cc75', '#55bd6a', '#b877d9', '#9a60b4', '#3ba272', '#5b8ff9']

                  return (
                    <Section title="Graph styles" defaultOpen={true}>
                      <div className="pe-hint-text" style={{ marginBottom: 8 }}>
                        为每个数值字段选择展示样式和颜色：Lines(折线) / Bars(柱状) / Points(散点)
                      </div>
                      {valueFieldNames.length === 0 && (
                        <div className="pe-hint-text">暂无预览数据，请先执行查询后再配置字段样式。</div>
                      )}
                      {valueFieldNames.map((field, fi) => {
                        const fieldColor = currentColors[field] || defaultPalette[fi % defaultPalette.length]
                        return (
                        <div key={field} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                          <span style={{ fontSize: 12, minWidth: 80, color: '#4e5969', fontWeight: 500 }}>{field}</span>
                          <div style={{ display: 'flex', gap: 0, background: '#f2f3f5', borderRadius: 4, padding: 2 }}>
                            {(/* lines */ ['lines', 'bars', 'points'] as const).map((style) => {
                              const active = (currentStyles[field] || 'lines') === style
                              const labels = { lines: 'Lines', bars: 'Bars', points: 'Points' }
                              const icons = { lines: '⌇', bars: '▐', points: '●' } as Record<string, string>
                              return (
                                <button
                                  key={style}
                                  onClick={() => {
                                    const next = { ...currentStyles, [field]: style }
                                    if (style === 'lines') delete next[field]
                                    update({ options: { ...p.options, fieldStyles: next } })
                                  }}
                                  style={{
                                    padding: '3px 12px',
                                    fontSize: 12,
                                    border: 'none',
                                    borderRadius: 3,
                                    cursor: 'pointer',
                                    background: active ? '#fff' : 'transparent',
                                    color: active ? '#1d2129' : '#86909c',
                                    fontWeight: active ? 600 : 400,
                                    boxShadow: active ? '0 1px 3px rgba(0,0,0,0.12)' : 'none',
                                  }}
                                >
                                  {icons[style]} {labels[style]}
                                </button>
                              )
                            })}
                          </div>
                          <input
                            type="color"
                            value={fieldColor}
                            onChange={(e) => {
                              const next = { ...currentColors, [field]: e.target.value }
                              update({ options: { ...p.options, fieldColors: next } })
                            }}
                            title={`选择 ${field} 的颜色`}
                            style={{ width: 28, height: 28, border: '1px solid var(--border-color)', borderRadius: 4, cursor: 'pointer', padding: 2, background: 'none' }}
                          />
                        </div>
                        )
                      })}
                    </Section>
                  )
                })()}

                {p.type === 'gauge' && (
                  <Section title="仪表板选项" defaultOpen={true}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                      <div className="pe-field">
                        <label className="pe-label-sm">最小值</label>
                        <input
                          type="number"
                          value={(p.options?.min as number) ?? 0}
                          onChange={(e) => update({ options: { ...p.options, min: Number(e.target.value) } })}
                          className="pe-input-xs"
                        />
                      </div>
                      <div className="pe-field">
                        <label className="pe-label-sm">最大值</label>
                        <input
                          type="number"
                          value={(p.options?.max as number) ?? 100}
                          onChange={(e) => update({ options: { ...p.options, max: Number(e.target.value) } })}
                          className="pe-input-xs"
                        />
                      </div>
                    </div>
                    <div className="pe-field" style={{ marginTop: 8 }}>
                      <label className="pe-label-sm">单位</label>
                      <input
                        type="text"
                        value={(p.options?.unit as string) ?? ''}
                        onChange={(e) => update({ options: { ...p.options, unit: e.target.value } })}
                        className="pe-input-xs"
                        placeholder="如 %、ms、bytes"
                        style={{ width: '100%' }}
                      />
                    </div>
                    <div className="pe-field" style={{ marginTop: 8 }}>
                      <label className="pe-label-sm">数值模式</label>
                      <select
                        value={(p.options?.valueMode as string) ?? 'absolute'}
                        onChange={(e) => update({ options: { ...p.options, valueMode: e.target.value } })}
                        className="pe-input-xs"
                        style={{ width: '100%' }}
                      >
                        <option value="absolute">绝对值 (Absolute)</option>
                        <option value="percentage">百分比 (Percentage 0-100)</option>
                      </select>
                    </div>

                    <div style={{ marginTop: 12 }}>
                      <label className="pe-label-sm" style={{ marginBottom: 4, display: 'block' }}>阈值</label>
                      <div className="pe-hint-text" style={{ marginBottom: 6 }}>
                        设置分界值和颜色，仪表带的颜色将根据阈值变化
                      </div>
                      {((p.options?.thresholds as Array<{ value: number; color: string }>) || [
                        { value: (p.options?.min as number) ?? 0, color: '#1F7A3F' },
                        { value: ((p.options?.max as number) ?? 100) * 0.5, color: '#1F7A3F' },
                        { value: (p.options?.max as number) ?? 100, color: '#1F7A3F' },
                      ]).map((t: { value: number; color: string }, i: number) => (
                        <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
                          <input
                            type="number"
                            value={t.value}
                            onChange={(e) => {
                              const thresholds = [...((p.options?.thresholds as Array<{ value: number; color: string }>) || [
                                { value: (p.options?.min as number) ?? 0, color: '#1F7A3F' },
                                { value: ((p.options?.max as number) ?? 100) * 0.5, color: '#1F7A3F' },
                                { value: (p.options?.max as number) ?? 100, color: '#1F7A3F' },
                              ])]
                              thresholds[i] = { ...thresholds[i], value: Number(e.target.value) }
                              update({ options: { ...p.options, thresholds } })
                            }}
                            className="pe-input-xs"
                            style={{ flex: 1 }}
                            placeholder="值"
                          />
                          <input
                            type="color"
                            value={t.color}
                            onChange={(e) => {
                              const thresholds = [...((p.options?.thresholds as Array<{ value: number; color: string }>) || [
                                { value: (p.options?.min as number) ?? 0, color: '#1F7A3F' },
                                { value: ((p.options?.max as number) ?? 100) * 0.5, color: '#1F7A3F' },
                                { value: (p.options?.max as number) ?? 100, color: '#1F7A3F' },
                              ])]
                              thresholds[i] = { ...thresholds[i], color: e.target.value }
                              update({ options: { ...p.options, thresholds } })
                            }}
                            style={{ width: 32, height: 32, border: 'none', cursor: 'pointer', background: 'none' }}
                          />
                          <button
                            onClick={() => {
                              const thresholds = ((p.options?.thresholds as Array<{ value: number; color: string }>) || [
                                { value: (p.options?.min as number) ?? 0, color: '#1F7A3F' },
                                { value: ((p.options?.max as number) ?? 100) * 0.5, color: '#1F7A3F' },
                                { value: (p.options?.max as number) ?? 100, color: '#1F7A3F' },
                              ]).filter((_: unknown, idx: number) => idx !== i)
                              update({ options: { ...p.options, thresholds } })
                            }}
                            className="pe-btn-xs"
                            style={{ color: 'var(--danger)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, padding: '0 4px' }}
                            title="删除阈值"
                          >
                            x
                          </button>
                        </div>
                      ))}
                      <button
                        onClick={() => {
                          const thresholds = [...((p.options?.thresholds as Array<{ value: number; color: string }>) || [
                            { value: (p.options?.min as number) ?? 0, color: '#1F7A3F' },
                            { value: ((p.options?.max as number) ?? 100) * 0.5, color: '#1F7A3F' },
                            { value: (p.options?.max as number) ?? 100, color: '#1F7A3F' },
                          ]), { value: 0, color: '#1F7A3F' }]
                          update({ options: { ...p.options, thresholds } })
                        }}
                        className="pe-btn-xs"
                        style={{ marginTop: 4 }}
                      >
                        + 添加阈值
                      </button>
                    </div>

                    <div style={{ marginTop: 12 }}>
                      <label className="pe-toggle">
                        <input
                          type="checkbox"
                          checked={(p.options?.showThresholdMarkers as boolean) ?? true}
                          onChange={(e) => update({ options: { ...p.options, showThresholdMarkers: e.target.checked } })}
                        />
                        <span className="pe-toggle-slider" />
                        <span className="pe-toggle-label">显示阈值标记</span>
                      </label>
                    </div>
                  </Section>
                )}

                <Section title="布局" defaultOpen={false}>
                  <div className="pe-grid-fields">
                    <div className="pe-field">
                      <label className="pe-label-sm">X</label>
                      <input type="number" value={p.gridPos?.x ?? 0} onChange={(e) => updateGrid('x', Number(e.target.value))} className="pe-input-xs" />
                    </div>
                    <div className="pe-field">
                      <label className="pe-label-sm">Y</label>
                      <input type="number" value={p.gridPos?.y ?? 0} onChange={(e) => updateGrid('y', Number(e.target.value))} className="pe-input-xs" />
                    </div>
                    <div className="pe-field">
                      <label className="pe-label-sm">宽</label>
                      <input type="number" value={p.gridPos?.w ?? 24} onChange={(e) => updateGrid('w', Number(e.target.value))} className="pe-input-xs" min={1} max={24} />
                    </div>
                    <div className="pe-field">
                      <label className="pe-label-sm">高</label>
                      <input type="number" value={p.gridPos?.h ?? 8} onChange={(e) => updateGrid('h', Number(e.target.value))} className="pe-input-xs" min={1} />
                    </div>
                  </div>
                  <div className="pe-hint-text" style={{ marginTop: 4 }}>24 栅格布局系统</div>
                </Section>

                {p.type === 'table' && (
                  <Section title="表格选项" defaultOpen={true}>
                    <label className="pe-toggle">
                      <input
                        type="checkbox"
                        checked={!!p.options?.enableColumnFilter}
                        onChange={(e) => update({ options: { ...p.options, enableColumnFilter: e.target.checked } })}
                      />
                      <span className="pe-toggle-slider" />
                      <span className="pe-toggle-label">启用列筛选</span>
                    </label>
                    <div className="pe-hint-text" style={{ marginTop: 4, marginLeft: 0 }}>
                      开启后，表格每列表头旁会出现筛选按钮，点击可按该列值过滤行。
                    </div>
                    <div style={{ marginTop: 12 }}>
                      <label style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4, display: 'block' }}>每页显示条数</label>
                      <input
                        type="number"
                        min={1}
                        max={500}
                        value={typeof p.options?.pageSize === 'number' ? p.options.pageSize : 5}
                        onChange={(e) => {
                          const v = Math.max(1, Math.min(500, parseInt(e.target.value) || 5))
                          update({ options: { ...p.options, pageSize: v } })
                        }}
                        style={{ width: 80, fontSize: 12, padding: '4px 8px' }}
                      />
                      <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 8 }}>范围 1-500，默认 5</span>
                    </div>
                    <label className="pe-toggle" style={{ marginTop: 12 }}>
                      <input
                        type="checkbox"
                        checked={!!p.options?.enableCellMerge}
                        onChange={(e) => {
                          const checked = e.target.checked
                          update({ options: { ...p.options, enableCellMerge: checked, mergeColumns: checked ? (p.options?.mergeColumns || '') : undefined } })
                        }}
                      />
                      <span className="pe-toggle-slider" />
                      <span className="pe-toggle-label">合并单元格</span>
                    </label>
                    <div className="pe-hint-text" style={{ marginTop: 4, marginLeft: 0 }}>
                      同一列中连续相同的值自动合并为一个单元格（类似 Excel 合并）。
                    </div>
                    {Boolean(p.options?.enableCellMerge) && (
                      <div style={{ marginTop: 8 }}>
                        <label style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6, display: 'block' }}>选择合并列</label>
                        {liveColumns.length > 0 ? (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                            {liveColumns.map((col) => {
                              const selected = ((p.options?.mergeColumns as string) || '').split(',').map((s: string) => s.trim()).filter(Boolean)
                              // 同时检查 aliasMap：如果 mergeColumns 存的是原始列名（如 node），也要匹配别名列（如 设备类型）
                              let checked = selected.includes(col)
                              if (!checked) {
                                for (const t of p.targets) {
                                  if (!t.aliasMap) continue
                                  // 找到 col 对应的原始列名，检查是否在 mergeColumns 中
                                  for (const [rawCol, alias] of Object.entries(t.aliasMap)) {
                                    if (alias === col && selected.includes(rawCol)) { checked = true; break }
                                    if (rawCol === col && selected.includes(alias)) { checked = true; break }
                                  }
                                  if (checked) break
                                }
                              }
                              return (
                                <label key={col} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12 }}>
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={() => {
                                      const next = checked
                                        ? selected.filter((s: string) => s !== col)
                                        : [...selected, col]
                                      update({ options: { ...p.options, mergeColumns: next.join(',') } })
                                    }}
                                  />
                                  {col}
                                </label>
                              )
                            })}
                          </div>
                        ) : (
                          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                            暂无列数据，请先点击「刷新」获取预览数据。
                          </div>
                        )}
                        <div className="pe-hint-text" style={{ marginTop: 6, marginLeft: 0 }}>
                          仅对勾选的列进行合并，未勾选则不合并。
                        </div>
                      </div>
                    )}

                    {/* 字段显示配置 */}
                    <div style={{ marginTop: 16, borderTop: '1px solid var(--border-color)', paddingTop: 12 }}>
                      <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8, display: 'block' }}>
                        字段显示配置
                      </label>
                      <div className="pe-hint-text" style={{ marginBottom: 8, marginLeft: 0 }}>
                        勾选要显示的字段，未勾选的字段将被隐藏（默认全显示）。可拖动调整显示顺序。
                      </div>
                      {liveColumns.length > 0 ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 250, overflowY: 'auto', padding: '4px 0' }}>
                          {/* 显示所有字段（包括隐藏的），方便用户重新勾选 */}
                          {(() => {
                            const hiddenColumns = (p.options?.hiddenColumns as string[] | undefined) || []
                            const columnOrder = (p.options?.columnOrder as string[] | undefined) || []
                            
                            // 计算显示顺序（包含所有字段）
                            let orderedColumns: string[] = []
                            if (columnOrder.length > 0) {
                              // 先按columnOrder的顺序
                              for (const orderedCol of columnOrder) {
                                if (liveColumns.includes(orderedCol)) {
                                  orderedColumns.push(orderedCol)
                                }
                              }
                              // 再添加不在columnOrder中的字段（保持原始顺序）
                              for (const col of liveColumns) {
                                if (!orderedColumns.includes(col)) {
                                  orderedColumns.push(col)
                                }
                              }
                            } else {
                              // 使用原始顺序（显示所有字段）
                              orderedColumns = liveColumns
                            }
                            
                            return orderedColumns.map((col, idx) => {
                              const checked = !hiddenColumns.includes(col)
                              return (
                                <div key={col} style={{ 
                                  display: 'flex', alignItems: 'center', gap: 6, 
                                  padding: '6px 8px', borderRadius: 4, 
                                  background: checked ? 'var(--bg-input)' : 'transparent',
                                  border: '1px solid var(--border-color)',
                                  transition: 'all 0.2s',
                                  opacity: checked ? 1 : 0.7
                                }}>
                                  {/* 排序按钮（仅对显示的字段有效） */}
                                  {checked && (
                                    <div style={{ display: 'flex', gap: 2 }}>
                                      <button
                                        onClick={() => {
                                          if (idx === 0) return
                                          const newOrder = [...orderedColumns]
                                          const temp = newOrder[idx - 1]
                                          newOrder[idx - 1] = newOrder[idx]
                                          newOrder[idx] = temp
                                          update({ options: { ...p.options, columnOrder: newOrder } })
                                        }}
                                        disabled={idx === 0}
                                        style={{
                                          width: 20, height: 20, fontSize: 10,
                                          background: idx === 0 ? 'transparent' : 'var(--bg-hover)',
                                          color: idx === 0 ? 'var(--text-muted)' : 'var(--text-primary)',
                                          border: 'none', borderRadius: 3, cursor: idx === 0 ? 'not-allowed' : 'pointer',
                                          display: 'flex', alignItems: 'center', justifyContent: 'center'
                                        }}
                                        title="上移"
                                      >
                                        ↑
                                      </button>
                                      <button
                                        onClick={() => {
                                          if (idx === orderedColumns.length - 1) return
                                          const newOrder = [...orderedColumns]
                                          const temp = newOrder[idx]
                                          newOrder[idx] = newOrder[idx + 1]
                                          newOrder[idx + 1] = temp
                                          update({ options: { ...p.options, columnOrder: newOrder } })
                                        }}
                                        disabled={idx === orderedColumns.length - 1}
                                        style={{
                                          width: 20, height: 20, fontSize: 10,
                                          background: idx === orderedColumns.length - 1 ? 'transparent' : 'var(--bg-hover)',
                                          color: idx === orderedColumns.length - 1 ? 'var(--text-muted)' : 'var(--text-primary)',
                                          border: 'none', borderRadius: 3, cursor: idx === orderedColumns.length - 1 ? 'not-allowed' : 'pointer',
                                          display: 'flex', alignItems: 'center', justifyContent: 'center'
                                        }}
                                        title="下移"
                                      >
                                        ↓
                                      </button>
                                    </div>
                                  )}
                                  
                                  {/* 占位符（隐藏字段不显示排序按钮） */}
                                  {!checked && <div style={{ width: 44 }} />}
                                  
                                  {/* checkbox */}
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={() => {
                                      const hiddenColumns = (p.options?.hiddenColumns as string[] | undefined) || []
                                      const columnOrder = (p.options?.columnOrder as string[] | undefined) || []
                                      const nextHidden = checked
                                        ? [...hiddenColumns, col]
                                        : hiddenColumns.filter((c) => c !== col)
                                      
                                      const nextOrder = checked
                                        ? columnOrder.filter(c => c !== col)
                                        : columnOrder
                                      
                                      update({ options: { ...p.options, hiddenColumns: nextHidden, columnOrder: nextOrder } })
                                    }}
                                    style={{ cursor: 'pointer' }}
                                  />
                                  
                                  {/* 列名 */}
                                  <span style={{ flex: 1, fontSize: 12, color: checked ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                                    {col}
                                  </span>
                                  
                                  {/* 状态指示 */}
                                  {checked && (
                                    <span style={{ fontSize: 9, color: 'var(--text-muted)', background: 'var(--bg-hover)', padding: '1px 4px', borderRadius: 2 }}>
                                      #{idx + 1}
                                    </span>
                                  )}
                                  {!checked && (
                                    <span style={{ fontSize: 9, color: 'var(--text-muted)', background: 'var(--bg-input)', padding: '1px 4px', borderRadius: 2 }}>
                                      已隐藏
                                    </span>
                                  )}
                                </div>
                              )
                            })
                          })()}
                        </div>
                      ) : (
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'center', padding: '12px 0' }}>
                          暂无列数据，请先点击「刷新」获取预览数据。
                        </div>
                      )}
                      {liveColumns.length > 0 && (
                        <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, fontSize: 10, color: 'var(--text-muted)', flexWrap: 'wrap' }}>
                          <span>显示: {liveColumns.length - ((p.options?.hiddenColumns as string[] | undefined) || []).length} / {liveColumns.length}</span>
                          <button
                            onClick={() => update({ options: { ...p.options, hiddenColumns: [], columnOrder: [] } })}
                            style={{ fontSize: 10, padding: '2px 8px', background: 'var(--bg-input)', color: 'var(--text-muted)', border: '1px solid var(--border-color)', borderRadius: 3, cursor: 'pointer' }}
                          >
                            全部显示（恢复默认顺序）
                          </button>
                          <button
                            onClick={() => update({ options: { ...p.options, hiddenColumns: liveColumns, columnOrder: [] } })}
                            style={{ fontSize: 10, padding: '2px 8px', background: 'var(--bg-input)', color: 'var(--text-muted)', border: '1px solid var(--border-color)', borderRadius: 3, cursor: 'pointer' }}
                          >
                            全部隐藏
                          </button>
                        </div>
                      )}
                    </div>
                  </Section>
                )}

                {(p.type === 'table' || p.type === 'bar' || p.type === 'line' || p.type === 'timeseries' || p.type === 'pie') && (
                  <Section title="条件告警" defaultOpen={false}>
                    <label className="pe-toggle">
                      <input
                        type="checkbox"
                        checked={!!p.options?.enableCellAlert}
                        onChange={(e) => {
                          const checked = e.target.checked
                          update({ options: { ...p.options, enableCellAlert: checked, cellAlerts: checked ? (p.options?.cellAlerts || []) : undefined, alertMode: checked ? (p.options?.alertMode || 'absolute') : undefined } })
                        }}
                      />
                      <span className="pe-toggle-slider" />
                      <span className="pe-toggle-label">启用条件告警</span>
                    </label>
                    <div className="pe-hint-text" style={{ marginTop: 4, marginLeft: 0 }}>
                      {p.type === 'table'
                        ? '当单元格数值满足条件时，以指定颜色高亮显示。'
                        : '当数据点数值满足条件时，以指定颜色高亮对应区域。'}
                    </div>
                    {Boolean(p.options?.enableCellAlert) && (
                      <div style={{ marginTop: 10 }}>
                        {/* 模式选择 */}
                        <div style={{ marginBottom: 8 }}>
                          <label style={{ fontSize: 11, color: 'var(--text-muted)', marginRight: 8 }}>比较模式</label>
                          <select
                            value={(p.options?.alertMode as string) || 'absolute'}
                            onChange={(e) => update({ options: { ...p.options, alertMode: e.target.value } })}
                            style={{ fontSize: 11, padding: '3px 6px', background: '#f8f9fa', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: 3 }}
                          >
                            <option value="absolute">绝对值</option>
                            <option value="percentage">百分比（该列最大值=100%）</option>
                          </select>
                        </div>

                        {/* 规则列表 */}
                        {((p.options?.cellAlerts as any[]) || []).map((rule: any, idx: number) => {
                          // 解析列名：从 aliasMap 获取别名对应的原始名，供下拉框值匹配
                          const resolvedCol = (() => {
                            const rc = rule.column || ''
                            if (!rc || liveColumns.includes(rc)) return rc
                            for (const t of p.targets) {
                              if (!t.aliasMap) continue
                              for (const [rawCol, alias] of Object.entries(t.aliasMap)) {
                                if (rc === rawCol && alias && liveColumns.includes(alias)) return alias
                                if (rc === alias && liveColumns.includes(rawCol)) return rawCol
                              }
                            }
                            return rc
                          })()
                          return (
                          <div key={idx} style={{
                            display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6,
                            padding: '6px 8px', background: '#f8f9fa', borderRadius: 4, flexWrap: 'wrap',
                          }}>
                            <select
                              value={resolvedCol}
                              onChange={(e) => {
                                const alerts = [...((p.options?.cellAlerts as any[]) || [])]
                                alerts[idx] = { ...alerts[idx], column: e.target.value }
                                update({ options: { ...p.options, cellAlerts: alerts } })
                              }}
                              style={{ fontSize: 11, padding: '3px 6px', background: '#f8f9fa', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: 3 }}
                            >
                              <option value="">选择列</option>
                              {liveColumns.map((col) => (
                                <option key={col} value={col}>{col}</option>
                              ))}
                            </select>
                            <select
                              value={rule.op || '>'}
                              onChange={(e) => {
                                const alerts = [...((p.options?.cellAlerts as any[]) || [])]
                                alerts[idx] = { ...alerts[idx], op: e.target.value }
                                update({ options: { ...p.options, cellAlerts: alerts } })
                              }}
                              style={{ fontSize: 11, padding: '3px 6px', background: '#f8f9fa', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: 3 }}
                            >
                              <option value=">">&gt;</option>
                              <option value=">=">&gt;=</option>
                              <option value="<">&lt;</option>
                              <option value="<=">&lt;=</option>
                              <option value="=">=</option>
                              <option value="!=">!=</option>
                            </select>
                            <input
                              type="number"
                              value={rule.value ?? ''}
                              onChange={(e) => {
                                const alerts = [...((p.options?.cellAlerts as any[]) || [])]
                                alerts[idx] = { ...alerts[idx], value: e.target.value === '' ? '' : Number(e.target.value) }
                                update({ options: { ...p.options, cellAlerts: alerts } })
                              }}
                              placeholder="阈值"
                              style={{ width: 60, fontSize: 11, padding: '3px 6px', background: '#f8f9fa', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: 3 }}
                            />
                            <input
                              type="color"
                              value={rule.color || '#5470c6'}
                              onChange={(e) => {
                                const alerts = [...((p.options?.cellAlerts as any[]) || [])]
                                alerts[idx] = { ...alerts[idx], color: e.target.value }
                                update({ options: { ...p.options, cellAlerts: alerts } })
                              }}
                              title="选择颜色"
                              style={{ width: 24, height: 24, border: 'none', borderRadius: 3, cursor: 'pointer', padding: 0, background: 'transparent' }}
                            />
                            <button
                              onClick={() => {
                                const alerts = ((p.options?.cellAlerts as any[]) || []).filter((_: any, i: number) => i !== idx)
                                update({ options: { ...p.options, cellAlerts: alerts } })
                              }}
                              title="删除规则"
                              style={{ fontSize: 11, padding: '2px 6px', background: 'transparent', color: 'var(--text-muted)', border: '1px solid var(--border-color)', borderRadius: 3, cursor: 'pointer' }}
                            >
                              ✕
                            </button>
                          </div>
                          )})}

                        <button
                          onClick={() => {
                            const alerts = [...((p.options?.cellAlerts as any[]) || []), { column: '', op: '>', value: 1, color: '#5470c6' }]
                            update({ options: { ...p.options, cellAlerts: alerts } })
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.borderColor = '#5470c6'
                            e.currentTarget.style.color = '#5470c6'
                            e.currentTarget.style.background = 'rgba(84,112,198,0.05)'
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.borderColor = 'var(--border-color)'
                            e.currentTarget.style.color = 'var(--text-muted)'
                            e.currentTarget.style.background = 'none'
                          }}
                          style={{
                            fontSize: 11, padding: '4px 12px', marginTop: 4,
                            background: 'none', color: 'var(--text-muted)',
                            border: '1px dashed var(--border-color)', borderRadius: 4, cursor: 'pointer',
                            transition: 'all 0.15s',
                          }}
                        >
                          + 添加告警规则
                        </button>
                      </div>
                    )}
                  </Section>
                )}

                {isMultiQuery && (p.targets || []).length > 1 && (
                  <Section title="多查询提示" defaultOpen={false}>
                    <div className="pe-hint-block">
                      多个查询分别对应图表中的不同数据系列，请为每个查询设置图例名称。
                    </div>
                  </Section>
                )}

                {/* Data Links 配置 */}
                <Section title="Data Links" defaultOpen={false}>
                  <p className="pe-section-desc" style={{ marginBottom: 12 }}>
                    配置字段链接，表格中该字段会显示为超链接，点击可跳转。
                  </p>
                  {/* 可用变量提示 */}
                  <div className="pe-hint-block" style={{ marginBottom: 12 }}>
                    <div style={{ fontWeight: 600, marginBottom: 6 }}>可用变量：</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 11, lineHeight: 1.6 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' }}><code style={{ background: '#fef2f2', padding: '3px 8px', borderRadius: 4, color: '#e53935', fontSize: 11, fontWeight: 500, fontFamily: 'monospace' }}>${"{"}__value{"}"}</code><span style={{ color: 'var(--text-muted)', fontSize: 11 }}>当前字段的值</span></div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' }}><code style={{ background: '#fef2f2', padding: '3px 8px', borderRadius: 4, color: '#e53935', fontSize: 11, fontWeight: 500, fontFamily: 'monospace' }}>${"{"}__field.name{"}"}</code><span style={{ color: 'var(--text-muted)', fontSize: 11 }}>当前字段名</span></div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' }}><code style={{ background: '#fef2f2', padding: '3px 8px', borderRadius: 4, color: '#e53935', fontSize: 11, fontWeight: 500, fontFamily: 'monospace' }}>${"{"}__row.field{"}"}</code><span style={{ color: 'var(--text-muted)', fontSize: 11 }}>当前行其他字段的值（如 ${"{"}__row.id{"}"}）</span></div>
                    </div>
                  </div>
                  {/* 链接列表 */}
                  {((p.dataLinks || []) as DataLinkDef[]).map((link, idx) => (
                    <div key={idx} style={{
                      padding: '8px 10px',
                      background: 'var(--bg-input)',
                      borderRadius: 6,
                      marginBottom: 8,
                    }}>
                      {/* 字段选择 */}
                      <div style={{ marginBottom: 6 }}>
                        <label style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4, display: 'block' }}>目标字段</label>
                        <select
                          value={link.field || ''}
                          onChange={(e) => {
                            const links = [...(p.dataLinks || [])]
                            links[idx] = { ...links[idx], field: e.target.value }
                            update({ dataLinks: links })
                          }}
                          style={{
                            width: '100%',
                            fontSize: 12,
                            padding: '4px 8px',
                            background: 'var(--bg-card)',
                            color: 'var(--text-primary)',
                            border: '1px solid var(--border-color)',
                            borderRadius: 4,
                          }}
                        >
                          <option value="">选择字段</option>
                          {liveColumns.map((col) => (
                            <option key={col} value={col}>{col}</option>
                          ))}
                        </select>
                      </div>
                      {/* 标题和打开方式 */}
                      <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
                        <input
                          value={link.title}
                          onChange={(e) => {
                            const links = [...(p.dataLinks || [])]
                            links[idx] = { ...links[idx], title: e.target.value }
                            update({ dataLinks: links })
                          }}
                          placeholder="链接标题（可选，默认显示字段值）"
                          style={{
                            flex: 1,
                            fontSize: 12,
                            padding: '4px 8px',
                            background: 'var(--bg-card)',
                            color: 'var(--text-primary)',
                            border: '1px solid var(--border-color)',
                            borderRadius: 4,
                          }}
                        />
                        <select
                          value={link.target || '_blank'}
                          onChange={(e) => {
                            const links = [...(p.dataLinks || [])]
                            links[idx] = { ...links[idx], target: e.target.value as '_blank' | '_self' }
                            update({ dataLinks: links })
                          }}
                          style={{
                            fontSize: 11,
                            padding: '4px 6px',
                            background: 'var(--bg-card)',
                            color: 'var(--text-primary)',
                            border: '1px solid var(--border-color)',
                            borderRadius: 4,
                          }}
                        >
                          <option value="_blank">新标签页</option>
                          <option value="_self">当前页</option>
                        </select>
                        <button
                          onClick={() => {
                            const links = (p.dataLinks || []).filter((_: any, i: number) => i !== idx)
                            update({ dataLinks: links })
                          }}
                          title="删除链接"
                          style={{
                            fontSize: 11,
                            padding: '4px 8px',
                            background: 'transparent',
                            color: 'var(--text-muted)',
                            border: '1px solid var(--border-color)',
                            borderRadius: 4,
                            cursor: 'pointer',
                          }}
                        >
                          ✕
                        </button>
                      </div>
                      {/* URL */}
                      <input
                        value={link.url}
                        onChange={(e) => {
                          const links = [...(p.dataLinks || [])]
                          links[idx] = { ...links[idx], url: e.target.value }
                          update({ dataLinks: links })
                        }}
                        placeholder="URL（如 https://example.com?id=${__value}）"
                        style={{
                          width: '100%',
                          fontSize: 11,
                          padding: '4px 8px',
                          background: 'var(--bg-card)',
                          color: 'var(--text-primary)',
                          border: '1px solid var(--border-color)',
                          borderRadius: 4,
                        }}
                      />
                    </div>
                  ))}
                  {/* 添加链接按钮 */}
                  <button
                    onClick={() => {
                      const links = [...(p.dataLinks || []), { field: '', title: '', url: '', target: '_blank' as '_blank' }]
                      update({ dataLinks: links })
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.borderColor = '#e53935'
                      e.currentTarget.style.color = '#e53935'
                      e.currentTarget.style.background = 'rgba(229, 57, 53, 0.05)'
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.borderColor = 'var(--border-color)'
                      e.currentTarget.style.color = 'var(--text-muted)'
                      e.currentTarget.style.background = 'none'
                    }}
                    style={{
                      fontSize: 11,
                      padding: '6px 12px',
                      background: 'none',
                      color: 'var(--text-muted)',
                      border: '1px dashed var(--border-color)', borderRadius: 4, cursor: 'pointer',
                      width: '100%',
                      transition: 'all 0.15s',
                    }}
                  >
                    + 添加 Data Link
                  </button>
                </Section>
              </>
            )}

            {/* ═══ 共享 Tab ═══ */}
            {sidebarTab === 'share' && (
              <>
                <Section title="创建快照" defaultOpen={true}>
                  <p className="pe-section-desc">
                    创建快照后，可复制链接分享给其他人查看当前的报表状态和数据。
                  </p>
                  <div className="pe-field">
                    <input value={snapName} onChange={(e) => setSnapName(e.target.value)}
                      placeholder="快照名称（可选）" className="pe-input" />
                  </div>
                  <button className="pe-btn-primary-sm" onClick={handleCreateSnapshot}>
                    <span style={{ position: 'relative', top: '-1px' }}>+</span> 创建快照
                  </button>
                </Section>

                <Section title="已有快照" defaultOpen={true} badge={snapshots.length > 0 ? `${snapshots.length}` : undefined}>
                  {snapLoading ? (
                    <div className="pe-empty-state">加载中...</div>
                  ) : snapshots.length === 0 ? (
                    <div className="pe-empty-state">暂无快照，点击上方"创建快照"保存当前状态</div>
                  ) : (
                    <div className="pe-snapshot-list">
                      {snapshots.map((snap) => (
                        <div key={snap.snapshot_key} className="pe-snapshot-item">
                          <div className="pe-snapshot-info">
                            <div className="pe-snapshot-name">{snap.name || '未命名快照'}</div>
                            <div className="pe-snapshot-link" title={`${shareLink}${snap.snapshot_key}`}>
                              {shareLink}{snap.snapshot_key}
                            </div>
                          </div>
                          <div className="pe-snapshot-actions">
                            <button className="pe-icon-btn" title="查看快照"
                              onClick={() => window.open(`/capacity_mgt_platform/snapshot/${snap.snapshot_key}`, '_blank')}>
                              <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><path d="M7 3a4 4 0 100 8 4 4 0 000-8zm0 1a3 3 0 110 6 3 3 0 010-6z" opacity=".7"/><path d="M7 1C3.5 1 .5 3.5 0 7c.5 3.5 3.5 6 7 6s6.5-2.5 7-6c-.5-3.5-3.5-6-7-6zm0 1.5C10 2.5 12.5 4.5 13 7c-.5 2.5-3 4.5-6 4.5S1.5 9.5 1 7c.5-2.5 3-4.5 6-4.5z" opacity=".7"/></svg>
                            </button>
                            <button className="pe-icon-btn" title="复制链接"
                              onClick={() => { navigator.clipboard.writeText(`${shareLink}${snap.snapshot_key}`); setCopiedKey(snap.snapshot_key); setTimeout(() => setCopiedKey(null), 2000) }}>
                              {copiedKey === snap.snapshot_key ? (
                                <svg width="14" height="14" viewBox="0 0 14 14" fill="var(--green)"><path d="M3 7l3 3 5-6" stroke="var(--green)" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
                              ) : (
                                <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><path d="M4 1a1 1 0 00-1 1v1H2a1 1 0 00-1 1v8a1 1 0 001 1h7a1 1 0 001-1v-1h1a1 1 0 001-1V2a1 1 0 00-1-1H4zm5 10H2V4h7v7zm2-2h-1V4a1 1 0 00-1-1H4V2h7v7z" opacity=".7"/></svg>
                              )}
                            </button>
                            <button className="pe-icon-btn pe-icon-btn-danger" title="删除快照"
                              onClick={() => handleDeleteSnapshot(snap.snapshot_key)}>
                              <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><path d="M4 3V2a1 1 0 011-1h4a1 1 0 011 1v1h2a.5.5 0 010 1h-.5l-.5 7.5a1 1 0 01-1 .5H4a1 1 0 01-1-.5L2.5 4H2a.5.5 0 010-1h2zm1-1v1h4V2H5z" opacity=".7"/></svg>
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </Section>
              </>
            )}
          </div>
        </div>
      </div>

      {/* 变量弹框 */}
      <Modal
        open={showVariablesModal}
        onCancel={() => setShowVariablesModal(false)}
        footer={null}
        width={560}
        title={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 16 }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#1890ff" strokeWidth="2">
              <circle cx="12" cy="12" r="10"/>
              <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>
              <line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
            可用变量
          </div>
        }
      >
        <div style={{ maxHeight: 500, overflow: 'auto' }}>
          {/* 系统内置变量 */}
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 4, height: 16, background: '#1890ff', borderRadius: 2 }} />
              系统内置变量（时间范围）
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {[
                { name: '$__from', desc: '开始时间（ISO格式，自动加引号）' },
                { name: '$__to', desc: '结束时间（ISO格式，自动加引号）' },
                { name: '$__fromUnix', desc: '开始时间（Unix秒，数字）' },
                { name: '$__toUnix', desc: '结束时间（Unix秒，数字）' },
                { name: '$__fromMs', desc: '开始时间（毫秒，数字）' },
                { name: '$__toMs', desc: '结束时间（毫秒，数字）' },
                { name: '$__timeFilter(column)', desc: '时间过滤宏' },
              ].map((item) => (
                <div key={item.name} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 10px', background: 'var(--bg-input)', borderRadius: 6, border: '1px solid var(--border-color)' }}>
                  <code style={{ background: '#fef2f2', padding: '4px 10px', borderRadius: 4, color: '#e53935', fontSize: 12, fontWeight: 500, fontFamily: 'monospace' }}>{item.name}</code>
                  <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{item.desc}</span>
                </div>
              ))}
            </div>
            <div className="pe-hint-text" style={{ marginTop: 8, padding: '6px 10px', background: '#fffbe6', border: '1px solid #ffe58f', borderRadius: 4 }}>
              示例：WHERE date &gt; $__from（自动替换为 WHERE date &gt; '2026-06-21T10:00:00Z'）
            </div>
          </div>
          {/* 用户自定义变量 */}
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 4, height: 16, background: '#52c41a', borderRadius: 2 }} />
              仪表板变量
            </div>
            {variables.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {variables.map((v) => (
                  <div key={v.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 10px', background: 'var(--bg-input)', borderRadius: 6, border: '1px solid var(--border-color)' }}>
                    <code style={{ background: '#fef2f2', padding: '4px 10px', borderRadius: 4, color: '#e53935', fontSize: 12, fontWeight: 500, fontFamily: 'monospace' }}>${v.name}</code>
                    <span style={{ color: 'var(--text-secondary)', fontSize: 12, flex: 1 }}>{v.label || v.name}</span>
                    {v.multi && <span style={{ fontSize: 11, color: '#52c41a', background: '#f6ffed', padding: '2px 8px', borderRadius: 3, border: '1px solid #b7eb8f' }}>(多选)</span>}
                  </div>
                ))}
              </div>
            ) : (
              <div className="pe-hint-text" style={{ background: 'var(--bg-input)', borderLeft: 'none', padding: '10px', borderRadius: 4, textAlign: 'center' }}>
                暂无自定义变量，可在仪表板设置中添加
              </div>
            )}
          </div>
        </div>
      </Modal>
    </div>
  )
}

function clonePanel(p: PanelDef): PanelDef {
  return JSON.parse(JSON.stringify(p))
}