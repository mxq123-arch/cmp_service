import { useRef, useEffect, useMemo, useState, memo } from 'react'
import * as echarts from 'echarts'
import type { MetricRow, TargetDef, DataLinkDef } from '../api'

/**
 * 判断值是否为毫秒时间戳。
 * 毫秒时间戳范围：1000000000000 (2001-09-09) 到 2000000000000 (2033-05-18)
 */
function isMillisecondTimestamp(val: unknown): boolean {
  if (typeof val !== 'number') return false
  return val > 1000000000000 && val < 2000000000000
}

/**
 * 时间格式配置（参考 Grafana）
 */
interface TimeFormatConfig {
  format: string
  splitType: 'second' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year'
  interval: number // 建议的刻度间隔（单位取决于 splitType）
}

/**
 * 根据时间范围和数据点数量确定时间格式和刻度间隔（参考 Grafana）
 */
function getTimeFormatConfig(rangeMs: number, _dataPoints: number): TimeFormatConfig {
  const SECOND = 1000
  const MINUTE = 60 * SECOND
  const HOUR = 60 * MINUTE
  const DAY = 24 * HOUR
  const WEEK = 7 * DAY
  const MONTH = 30 * DAY
  const YEAR = 365 * DAY

  // 根据时间范围选择基础格式
  if (rangeMs <= 1 * MINUTE) {
    // 1分钟内：秒级精度
    return { format: '{HH}:{mm}:{ss}', splitType: 'second', interval: Math.max(1, Math.ceil(rangeMs / SECOND / 10)) }
  } else if (rangeMs <= 15 * MINUTE) {
    // 15分钟内：秒级精度
    return { format: '{HH}:{mm}:{ss}', splitType: 'second', interval: Math.max(5, Math.ceil(rangeMs / SECOND / 10)) }
  } else if (rangeMs <= 1 * HOUR) {
    // 1小时内：分钟级精度
    return { format: '{HH}:{mm}', splitType: 'minute', interval: Math.max(1, Math.ceil(rangeMs / MINUTE / 10)) }
  } else if (rangeMs <= 6 * HOUR) {
    // 6小时内：分钟级精度
    return { format: '{HH}:{mm}', splitType: 'minute', interval: Math.max(5, Math.ceil(rangeMs / MINUTE / 10)) }
  } else if (rangeMs <= 12 * HOUR) {
    // 12小时内：小时级精度
    return { format: '{HH}:{mm}', splitType: 'hour', interval: 1 }
  } else if (rangeMs <= 1 * DAY) {
    // 24小时内：小时级精度
    return { format: '{HH}:{mm}', splitType: 'hour', interval: Math.max(2, Math.ceil(rangeMs / HOUR / 10)) }
  } else if (rangeMs <= 2 * DAY) {
    // 2天内：小时级精度，显示日期
    return { format: '{MM}/{dd} {HH}:{mm}', splitType: 'hour', interval: Math.max(4, Math.ceil(rangeMs / HOUR / 10)) }
  } else if (rangeMs <= 7 * DAY) {
    // 7天内：小时级精度
    return { format: '{MM}/{dd} {HH}:{mm}', splitType: 'hour', interval: Math.max(6, Math.ceil(rangeMs / HOUR / 10)) }
  } else if (rangeMs <= 30 * DAY) {
    // 30天内：天级精度
    return { format: '{MM}/{dd}', splitType: 'day', interval: Math.max(1, Math.ceil(rangeMs / DAY / 10)) }
  } else if (rangeMs <= 90 * DAY) {
    // 90天内：天级精度
    return { format: '{MM}/{dd}', splitType: 'day', interval: Math.max(3, Math.ceil(rangeMs / DAY / 10)) }
  } else if (rangeMs <= 1 * YEAR) {
    // 1年内：周级精度
    return { format: '{MM}/{dd}', splitType: 'week', interval: Math.max(1, Math.ceil(rangeMs / WEEK / 10)) }
  } else {
    // 超过1年：月级精度
    return { format: '{yyyy}-{MM}', splitType: 'month', interval: Math.max(1, Math.ceil(rangeMs / MONTH / 10)) }
  }
}

/**
 * 将毫秒时间戳转换为指定格式的日期字符串。
 */
function formatTimestamp(ms: number, format?: string): string {
  const date = new Date(ms)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  const seconds = String(date.getSeconds()).padStart(2, '0')

  if (!format) {
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`
  }

  return format
    .replace('{yyyy}', String(year))
    .replace('{MM}', month)
    .replace('{dd}', day)
    .replace('{HH}', hours)
    .replace('{mm}', minutes)
    .replace('{ss}', seconds)
}

/**
 * 格式化数值，最多保留两位小数。
 */
function formatNumber(val: number | string): string {
  const num = typeof val === 'string' ? parseFloat(val) : val
  if (isNaN(num)) return String(val)
  // 如果是整数，不显示小数
  if (Number.isInteger(num)) return String(num)
  // 最多保留两位小数
  return num.toFixed(2).replace(/\.?0+$/, '')
}

/**
 * 格式化超长数字：使用省略号截断，返回显示文本和完整值
 */
function formatLargeNumber(val: number | string, maxDigits: number = 10): { display: string; full: string } {
  const num = typeof val === 'string' ? parseFloat(val) : val
  if (isNaN(num)) return { display: String(val), full: String(val) }

  const fullStr = formatNumber(num)

  // 如果数字长度在允许范围内，返回原始格式
  if (fullStr.length <= maxDigits) {
    return { display: fullStr, full: fullStr }
  }

  // 数字太长，使用省略号截断（保留前 maxDigits-3 位 + '...'）
  const truncated = fullStr.slice(0, maxDigits - 3) + '...'
  return { display: truncated, full: fullStr }
}

/**
 * 格式化值：如果是毫秒时间戳则转换为日期字符串，否则返回原值。
 */
function formatValue(val: unknown): string {
  if (isMillisecondTimestamp(val)) {
    return formatTimestamp(val as number)
  }
  // 如果是数值，格式化并保留两位小数
  if (typeof val === 'number') {
    return formatNumber(val)
  }
  // 尝试解析为数值
  if (typeof val === 'string' && val !== '') {
    const num = parseFloat(val)
    if (!isNaN(num) && String(num) === val) {
      return formatNumber(num)
    }
  }
  return String(val ?? '')
}

interface ChartPanelProps {
  type: 'bar' | 'line' | 'timeseries' | 'pie' | 'gauge' | 'table'
  title: string
  /** 多查询数据：data[i] 是第 i 个 target 的结果行 */
  data: MetricRow[][]
  /** target 定义，用于读取图例名称 (metricName) */
  targets: TargetDef[]
  menuOpen: boolean
  onToggleMenu: () => void
  onEdit: () => void
  onRemove: () => void
  /** 是否显示右上角菜单按钮，默认 true */
  showMenu?: boolean
  /** 面板选项，如 { enableColumnFilter: true } */
  options?: Record<string, unknown>
  /** 面板 key（用于强制重新挂载） */
  panelKey?: string
  /** 后端返回的列名顺序，用于保持表头与 SQL 查询一致 */
  columns?: string[]
  /** Data Links 配置（仿照 Grafana） */
  dataLinks?: DataLinkDef[]
}

/**
 * 从数据行中自动探测「名称列」和「数值列」。
 * - 名称列：优先取值为时间格式的列 > 日期/时间类列名 > 第一个非数值列
 * - 数值列：所有可解析为数字的列，排除行号列和时间值列
 */

/** 判断字符串值是否为时间/日期格式 */
function isTimeValue(v: unknown): boolean {
  const s = String(v ?? '').trim()
  if (!s) return false
  // YYYY-MM-DD HH:mm:ss 或 YYYY-MM-DD 或 YYYY-MM 等
  if (/^\d{4}-\d{2}(-\d{2})?(\s+\d{2}:\d{2}(:\d{2})?)?$/.test(s)) return true
  // YYYY/MM/DD 等
  if (/^\d{4}\/\d{2}(\/\d{2})?$/.test(s)) return true
  // 纯毫秒时间戳 (13位数字，年份2000-2100)
  if (/^1[3-9]\d{11}$/.test(s)) return true
  return false
}

/** 判断列名是否为日期/时间类型 */
function isDateColumn(colName: string): boolean {
  const kl = colName.toLowerCase()
  return kl.includes('date') || kl.includes('time') || kl.includes('日期') || kl.includes('时间') || kl === 'day'
}

/** 判断列是否为行号列（列名 # 或值从1开始连续递增） */
function isRowNumberCol(rows: MetricRow[], col: string): boolean {
  const kl = col.trim().toLowerCase()
  if (kl === '#' || kl === 'no' || kl === '序号' || kl === '行号') return true
  // 检查值是否为 1, 2, 3, ... 连续递增
  const vals = rows.map((r) => r[col])
  if (vals.length < 2) return false
  for (let i = 0; i < vals.length; i++) {
    const v = Number(vals[i])
    if (isNaN(v) || v !== i + 1) return false
  }
  return true
}

function detectColumns(rows: MetricRow[], _chartType?: string): { nameCol: string | null; valueCols: string[] } {
  if (rows.length === 0) return { nameCol: null, valueCols: [] }
  const keys = Object.keys(rows[0])
  const sample = rows.slice(0, 5)

  // 1. 分类：日期值列、日期名列、行号列、数值列
  const dateValueCols: string[] = []   // 值像时间格式的列
  const dateNameCols: string[] = []    // 列名是时间关键词的列
  const rowNumCols: string[] = []      // 行号列（需排除）
  const numericCols: string[] = []     // 真正的数值列

  for (const k of keys) {
    if (isRowNumberCol(rows, k)) {
      rowNumCols.push(k)
      continue
    }
    // 检查值是否全为时间格式
    const allTimeVals = sample.every((r) => {
      const v = r[k]
      return v !== undefined && v !== null && v !== '' && isTimeValue(v)
    })
    if (allTimeVals) {
      dateValueCols.push(k)
      continue
    }
    // 检查是否全为数值
    const allNumeric = sample.every((r) => {
      const v = r[k]
      if (v === undefined || v === null || v === '') return false
      return !isNaN(parseFloat(v))
    })
    if (allNumeric && sample.some((r) => r[k] !== '' && r[k] !== undefined)) {
      numericCols.push(k)
      continue
    }
    // 非数值列中，记录时间关键词列
    if (isDateColumn(k)) {
      dateNameCols.push(k)
    }
  }

  // 2. 确定名称列：优先时间值列 > 时间名列 > 第一个非数值非行号列
  let nameCol: string | null = null
  if (dateValueCols.length > 0) {
    nameCol = dateValueCols[0]
  } else if (dateNameCols.length > 0) {
    nameCol = dateNameCols[0]
  } else {
    const nonNumericKeys = keys.filter((k) => !numericCols.includes(k) && !rowNumCols.includes(k))
    nameCol = nonNumericKeys.length > 0 ? nonNumericKeys[0] : (keys.length > 0 ? keys[0] : null)
  }

  // 3. 数值列排除行号列和时间值列（时间值列如果已被选为名称列，就不要重复当数值）
  const valueCols = numericCols.filter((k) => !rowNumCols.includes(k) && !dateValueCols.includes(k))

  return { nameCol, valueCols }
}

/** 截取简化名称 */
function shortName(name: string): string {
  return name
    .replace('威新机房-', '威新-')
    .replace('南方机房-', '南方-')
    .replace('带宽使用率（', '')
    .replace('）', '')
}

// 冷色调配色方案，避免红色/黄色引发告警误解
const SERIES_COLORS = ['#5470c6', '#73c0de', '#91cc75', '#55bd6a', '#b877d9', '#9a60b4', '#3ba272', '#5b8ff9']

export default memo(function ChartPanel({ type, title, data, targets, menuOpen, onToggleMenu, onEdit, onRemove, showMenu = true, options, columns, dataLinks }: ChartPanelProps) {
  const chartRef = useRef<HTMLDivElement>(null)
  const chartInstanceRef = useRef<echarts.ECharts | null>(null)
  // 多查询模式：每个查询独立渲染一个 ECharts 图表
  const chartContainersRef = useRef<Map<number, HTMLDivElement>>(new Map())
  const chartInstancesRef = useRef<Map<number, echarts.ECharts>>(new Map())
  const [chartError, setChartError] = useState<string | null>(null)
  const [linkMenu, setLinkMenu] = useState<{ x: number; y: number; links: DataLinkDef[]; data: Record<string, any> } | null>(null)

  // 合并所有 target 数据为扁平数组（用于表格和列探测）
  const allData = useMemo(() => {
    try { return data.flat() } catch { return [] }
  }, [data])

  const { nameCol, valueCols } = useMemo(() => {
    // 用第一个 target 的数据探测列结构
    return detectColumns(data[0] || [], type)
  }, [data, type])

  // 构建单个 target 的 Gauge option（用于多查询独立渲染）
  const buildGaugeChartOption = (
    targetRows: MetricRow[],
    ti: number,
    containerWidth?: number,
    containerHeight?: number,
  ): echarts.EChartsOption => {
    const { nameCol: tNameCol, valueCols: tValCols } = detectColumns(targetRows, type)
    const primaryValues = tValCols.length > 0 ? targetRows.map((m) => parseFloat(m[tValCols[0]]) || 0) : []
    const gaugeValue = primaryValues.length > 0 ? primaryValues[0] : 0
    const tNames = tNameCol ? targetRows.map((m) => formatValue(m[tNameCol!])) : []
    const gaugeName = (tNameCol && tValCols.length > 0 && tNameCol === tValCols[0])
      ? tNameCol
      : (tNames.length > 0 ? tNames[0] : (targets[ti]?.metricName || targets[ti]?.refId || `查询${ti + 1}`))
    const gMin = (options?.min as number) ?? 0
    const gMax = (options?.max as number) ?? 100
    const gUnit = (options?.unit as string) ?? ''
    const gColor = (options?.color as string) ?? '#1F7A3F'
    const gBgColor = (options?.bgColor as string) ?? '#D9E8DC'
    const gValueMode = (options?.valueMode as string) ?? 'absolute'
    let displayValue = gaugeValue
    if (gValueMode === 'percentage') displayValue = gMax !== gMin ? ((gaugeValue - gMin) / (gMax - gMin)) * 100 : 0

    // 计算实际显示的字符串（智能格式化大数字）
    const formattedValue = gValueMode === 'percentage'
      ? { display: `${displayValue.toFixed(1)}%`, full: `${displayValue.toFixed(1)}%` }
      : formatLargeNumber(displayValue, 10)

    const displayStr = formattedValue.display + (gUnit && gValueMode !== 'percentage' ? ` ${gUnit}` : '')
    const fullDisplayStr = formattedValue.full + (gUnit && gValueMode !== 'percentage' ? ` ${gUnit}` : '')

    // 根据容器尺寸和字符串长度智能调整字体大小
    const minDim = Math.min(containerWidth || 200, containerHeight || 200)
    const gaugeRadius = minDim * 0.75 // 仪表盘半径（像素）
    const maxTextWidth = gaugeRadius * 1.6 // 最大文本宽度（稍大于直径）

    // 估算字符宽度（粗略估计：数字和单位字符平均宽度约为字体大小的0.6倍）
    const charCount = displayStr.length
    const maxFontSize = Math.max(16, Math.min(36, minDim * 0.15))
    const estimatedFontSize = Math.min(maxFontSize, maxTextWidth / (charCount * 0.6))
    const fontSize = Math.max(12, estimatedFontSize) // 最小字体12px

    const titleFontSize = Math.max(11, Math.min(16, minDim * 0.065)) // 标题字体，范围11-16

    return {
      backgroundColor: 'transparent',
      tooltip: {
        show: true,
        trigger: 'item',
        formatter: () => fullDisplayStr,
        backgroundColor: 'rgba(50, 50, 50, 0.9)',
        borderColor: '#333',
        borderWidth: 1,
        padding: [8, 12],
        textStyle: {
          color: '#fff',
          fontSize: 13,
          fontFamily: 'Inter, -apple-system, sans-serif',
        },
      },
      series: [{
        type: 'gauge',
        startAngle: 225, endAngle: -45, center: ['50%', '45%'], radius: '75%',
        min: gValueMode === 'percentage' ? 0 : gMin,
        max: gValueMode === 'percentage' ? 100 : gMax,
        progress: { show: true, width: 36, roundCap: true, itemStyle: { color: gColor } },
        axisLine: { lineStyle: { width: 36, color: [[1, gBgColor]] } },
        axisTick: { show: false }, splitLine: { show: false }, axisLabel: { show: false },
        anchor: { show: false }, pointer: { show: false },
        detail: {
          valueAnimation: true, fontSize, offsetCenter: [0, '-5%'],
          formatter: () => displayStr,
          color: gColor, fontWeight: 600, fontFamily: 'Inter, -apple-system, sans-serif',
        },
        title: { color: '#666', fontSize: titleFontSize, offsetCenter: [0, '100%'], fontFamily: 'Inter, -apple-system, sans-serif' },
        data: [{ value: displayValue, name: gaugeName || undefined }],
      }],
    }
  }

  useEffect(() => {
    if (type === 'table') return

    try {
      setChartError(null)

      // 清理旧的单图表实例
      if (chartInstanceRef.current) {
        chartInstanceRef.current.dispose()
        chartInstanceRef.current = null
      }
      // 清理旧的多图表实例
      chartInstancesRef.current.forEach((inst) => { try { inst.dispose() } catch {} })
      chartInstancesRef.current = new Map()

      if (data.length === 0) return

      // ---- 数据排序（共用） ----
      const firstRows = data[0] || []
      if (nameCol && firstRows.length > 1) {
        const sortByTime = firstRows.every((m) => isTimeValue(m[nameCol!]))
        if (sortByTime) {
          const getTimeOrder = (val: unknown): number => {
            const s = String(val ?? '').trim()
            const normalized = s.length === 7 ? s + '-01' : s
            return new Date(normalized).getTime()
          }
          const sortedIndices = firstRows
            .map((m, i) => ({ idx: i, t: getTimeOrder(m[nameCol!]) }))
            .sort((a, b) => a.t - b.t)
            .map((x) => x.idx)
          for (let ti = 0; ti < data.length; ti++) {
            if (data[ti].length === firstRows.length) {
              data[ti] = sortedIndices.map((i) => data[ti][i])
            }
          }
        }
      }

      // 排序后重新获取第一行数据（data[0] 可能已被排序替换）
      const sortedFirstRows = data[0] || []

      // ---- 时间序列检测（共用） ----
      const isTimeSeries = nameCol && sortedFirstRows.length > 0 && isMillisecondTimestamp(sortedFirstRows[0][nameCol!])
      let timeFormat = ''
      if (isTimeSeries && sortedFirstRows.length > 1) {
        const timestamps = sortedFirstRows.map((m) => m[nameCol!] as number).filter((t) => isMillisecondTimestamp(t))
        if (timestamps.length >= 2) {
          const minTs = Math.min(...timestamps)
          const maxTs = Math.max(...timestamps)
          const rangeMs = maxTs - minTs
          timeFormat = getTimeFormatConfig(rangeMs, timestamps.length).format
        }
      }

      const names = nameCol ? sortedFirstRows.map((m) => {
        const v = m[nameCol!]
        if (isMillisecondTimestamp(v)) return formatTimestamp(v as number, timeFormat)
        const str = String(v || '')
        return str.length > 15 ? shortName(str) : str
      }) : []

      // ---- 判断是否多查询独立渲染 ----
      const isMultiTarget = data.length > 1 && type === 'gauge'
      const isTimeseries = type === 'timeseries'
      const fieldStyles = (options?.fieldStyles || {}) as Record<string, 'lines' | 'bars' | 'points'>
      const fieldColors = (options?.fieldColors || {}) as Record<string, string>

      // ---- 单查询 / pie / gauge：走原有单图表路径 ----
      if (!isMultiTarget) {
        if (!chartRef.current) return
        const el = chartRef.current
        if (el.offsetWidth === 0 || el.offsetHeight === 0) return

        const chart = echarts.init(el, undefined, { renderer: 'canvas' })
        chartInstanceRef.current = chart

        let option: echarts.EChartsOption

        switch (type) {
          case 'bar':
          case 'line':
          case 'timeseries': {
            const series: echarts.SeriesOption[] = []
            const hasBars = isTimeseries && Object.values(fieldStyles).some((s) => s === 'bars')

            // 收集所有数值列，用于判断是否启用双Y轴
            const allValueColsSet: string[] = []
            data.forEach((targetRows) => {
              const { valueCols: tv } = detectColumns(targetRows, type)
              tv.forEach((c) => { if (!allValueColsSet.includes(c)) allValueColsSet.push(c) })
            })
            const useDualAxis = isTimeseries && allValueColsSet.length >= 2
            const firstValCol = allValueColsSet[0] || ''
            const secondValCol = allValueColsSet[1] || ''

            data.forEach((targetRows, ti) => {
              const tdef = targets[ti]
              const { valueCols: tValCols } = detectColumns(targetRows, type)
              const seriesBaseName = tdef?.metricName || tdef?.refId || (tValCols[0] || `查询${ti + 1}`)

              tValCols.forEach((col, ci) => {
                const colorIdx = (ti * tValCols.length + ci) % SERIES_COLORS.length
                const defaultColor = SERIES_COLORS[colorIdx]
                const color = (isTimeseries && fieldColors[col]) ? fieldColors[col] : defaultColor
                const fieldStyle: 'lines' | 'bars' | 'points' = isTimeseries
                  ? (fieldStyles[col] || 'lines')
                  : (type === 'bar' ? 'bars' : 'lines')
                const isBarStyle = fieldStyle === 'bars'
                const isPointsStyle = fieldStyle === 'points'
                const isHorizontal = type === 'bar' && ((options?.barOrientation as string) || 'vertical') === 'horizontal'

                // 双Y轴：第一个数值列用左轴(0)，其余用右轴(1)
                const yAxisIdx = useDualAxis ? (col === firstValCol ? 0 : 1) : 0

                const seriesData = targetRows.map((m) => {
                  const val = parseFloat(m[col]) || 0
                  const alertColor = getCellAlertColor(col, String(val))
                  return alertColor
                    ? { value: val, itemStyle: { color: alertColor, borderColor: alertColor, borderRadius: isBarStyle ? (isHorizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]) : 0 } }
                    : val
                })

                if (isBarStyle) {
                  series.push({
                    name: tValCols.length > 1 ? `${seriesBaseName}-${col}` : seriesBaseName,
                    type: 'bar',
                    data: seriesData,
                    yAxisIndex: yAxisIdx,
                    barMaxWidth: 36,
                    itemStyle: { color, borderRadius: isHorizontal ? [0, 4, 4, 0] : [4, 4, 0, 0] },
                    emphasis: { itemStyle: { shadowBlur: 8, shadowOffsetY: 2, shadowColor: 'rgba(0,0,0,0.12)' } },
                  })
                } else if (isPointsStyle) {
                  series.push({
                    name: tValCols.length > 1 ? `${seriesBaseName}-${col}` : seriesBaseName,
                    type: 'line',
                    data: seriesData,
                    yAxisIndex: yAxisIdx,
                    symbol: 'circle',
                    symbolSize: 7,
                    lineStyle: { width: 0 },
                    itemStyle: { color, borderColor: color, borderWidth: 1 },
                  })
                } else {
                  series.push({
                    name: tValCols.length > 1 ? `${seriesBaseName}-${col}` : seriesBaseName,
                    type: 'line',
                    data: seriesData,
                    yAxisIndex: yAxisIdx,
                    lineStyle: { color, width: 2.5 },
                    itemStyle: { color },
                    symbol: 'circle',
                    symbolSize: 5,
                    areaStyle: {
                      color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                        { offset: 0, color },
                        { offset: 1, color: 'rgba(255,255,255,0)' },
                      ]),
                      opacity: 0.12,
                    },
                  })
                }
              })
            })

            const barOrientation = (options?.barOrientation as string) || 'vertical'
            const isHorizontal = type === 'bar' && barOrientation === 'horizontal'
            const legendData = series.map((s) => s.name as string)

            const calculateLabelInterval = (): number => {
              const avgLabelWidth = 50
              const chartWidth = el.offsetWidth || 400
              const usableWidth = chartWidth * 0.85
              const maxLabels = Math.floor(usableWidth / avgLabelWidth)
              if (names.length > maxLabels && maxLabels > 0) return Math.ceil(names.length / maxLabels) - 1
              return 0
            }
            const calculateRotate = (): number => {
              if (isHorizontal) return 0
              if (isTimeSeries) {
                if (names.length > 20) return 45
                if (names.length > 10) return 30
                return 0
              }
              const avgLabelLen = names.reduce((sum, n) => sum + (n?.length || 0), 0) / names.length
              if (names.length > 15 || avgLabelLen > 8) return 30
              if (names.length > 10 || avgLabelLen > 5) return 15
              return 0
            }
            const labelRotate = calculateRotate()
            const labelInterval = calculateLabelInterval()

            // series → col 映射供 tooltip
            const seriesColMap: Map<number, string> = new Map()
            let sIdx = 0
            data.forEach((tRows) => {
              const { valueCols: tv } = detectColumns(tRows, type)
              tv.forEach((c) => { seriesColMap.set(sIdx, c); sIdx++ })
            })

            option = {
              backgroundColor: 'transparent',
              color: SERIES_COLORS,
              tooltip: {
                trigger: 'axis',
                backgroundColor: '#fff',
                borderColor: '#e8ecf1',
                borderWidth: 1,
                padding: [12, 16],
                extraCssText: 'border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,0.08);',
                textStyle: { color: '#1d2129', fontSize: 12, lineHeight: 20 },
                ...((isTimeseries && hasBars) || type === 'bar' ? { axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(0,0,0,0.04)' } } } : {}),
                formatter: (params: any) => {
                  if (!Array.isArray(params)) params = [params]
                  const parts = params.map((p: any) => {
                    const colName = seriesColMap.get(p.seriesIndex)
                    const alertColor = colName ? getCellAlertColor(colName, String(p.value)) : undefined
                    return `<div style="display:flex;align-items:center;gap:8px;margin:2px 0"><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${alertColor || p.color};flex-shrink:0"></span><span style="color:#86909c;min-width:80px">${p.seriesName}</span><span style="color:${alertColor ? alertColor : '#1d2129'};font-weight:600">${formatNumber(p.value)}${alertColor ? ' ⚠' : ''}</span></div>`
                  })
                  return `<div style="font-weight:600;color:#4e5969;margin-bottom:6px">${params[0].axisValueLabel}</div>${parts.join('')}`
                },
              },
              legend: (data.length > 1 || valueCols.length > 1 || data.some((_r, i) => (targets[i]?.metricName || '').length > 0))
                ? { data: legendData, bottom: 0, icon: 'roundRect', itemWidth: 10, itemHeight: 10, itemGap: 16, textStyle: { color: '#86909c', fontSize: 11 } }
                : undefined,
              grid: {
                left: '5%', right: '5%',
                bottom: legendData.length > 1 ? '14%' : (labelRotate > 30 ? '16%' : labelRotate > 0 ? '12%' : '8%'),
                top: 50,
                containLabel: true,
              },
              xAxis: isHorizontal
                ? { type: 'value', name: valueCols[0] || '', nameTextStyle: { color: '#86909c', fontSize: 11 }, axisLabel: { color: '#86909c', fontSize: 10 }, axisLine: { show: false }, axisTick: { show: false }, splitLine: { lineStyle: { color: '#f2f3f5', type: 'dashed' } } }
                : {
                    type: 'category', data: names,
                    ...(isTimeseries ? (hasBars ? { boundaryGap: true } : { boundaryGap: false }) : type === 'line' ? { boundaryGap: false } : {}),
                    axisLabel: { rotate: labelRotate, fontSize: 10, color: '#86909c', interval: labelInterval, hideOverlap: names.length > 25, formatter: (val: string) => val && val.length > 12 ? val.slice(0, 12) + '...' : val },
                    axisLine: { lineStyle: { color: '#e5e6eb' } },
                    axisTick: { show: false },
                  },
              yAxis: useDualAxis
                ? [
                    { type: 'value', name: firstValCol, position: 'left', nameTextStyle: { color: '#86909c', fontSize: 11 }, axisLabel: { color: '#86909c', fontSize: 10 }, axisLine: { show: false }, axisTick: { show: false }, splitLine: { lineStyle: { color: '#f2f3f5', type: 'dashed' } } },
                    { type: 'value', name: secondValCol, position: 'right', nameTextStyle: { color: '#86909c', fontSize: 11 }, axisLabel: { color: '#86909c', fontSize: 10, formatter: (val: number) => val + '%' }, axisLine: { show: false }, axisTick: { show: false }, splitLine: { show: false } },
                  ]
                : isHorizontal
                ? { type: 'category', data: names, axisLabel: { fontSize: 10, color: '#86909c' }, axisLine: { lineStyle: { color: '#e5e6eb' } }, axisTick: { show: false } }
                : {
                    type: 'value',
                    name: valueCols[0] || '',
                    nameTextStyle: { color: '#86909c', fontSize: 11 },
                    nameGap: 20,
                    axisLabel: {
                      color: '#86909c',
                      fontSize: 10,
                      margin: 15,
                      show: true,
                    },
                    axisLine: { show: false },
                    axisTick: { show: false },
                    splitLine: { lineStyle: { color: '#f2f3f5', type: 'dashed' } }
                  },
              series,
            }
            break
          }

          case 'pie': {
            const primaryValues = valueCols.length > 0 ? firstRows.map((m) => parseFloat(m[valueCols[0]]) || 0) : []
            const dataCount = names.length
            const isManyData = dataCount > 8
            const pieCenter = isManyData ? ['40%', '50%'] : ['55%', '50%']
            const pieRadius = isManyData ? ['35%', '55%'] : ['45%', '70%']
            const pieAlertCol = valueCols.length > 0 ? valueCols[0] : null

            option = {
              backgroundColor: 'transparent',
              tooltip: {
                trigger: 'item',
                backgroundColor: '#22252b',
                borderColor: '#33363d',
                textStyle: { color: '#d8d9da' },
                confine: true,
                formatter: (params: any) => {
                  const alertClr = pieAlertCol ? getCellAlertColor(pieAlertCol, String(params.value)) : undefined
                  return alertClr ? `<b>${params.name}</b>: ${formatNumber(params.value)} (${formatNumber(params.percent)}%) <span style="color:${alertClr}">⚠</span>` : `<b>${params.name}</b>: ${formatNumber(params.value)} (${formatNumber(params.percent)}%)`
                },
              },
              legend: isManyData ? {
                type: 'scroll', orient: 'vertical', right: 10, top: 'middle',
                textStyle: { color: '#a0a3a8', fontSize: 11 }, itemWidth: 12, itemHeight: 12, itemGap: 6,
                pageIconColor: '#a0a3a8', pageIconInactiveColor: '#4e5969', pageTextStyle: { color: '#a0a3a8' },
              } : {
                orient: 'vertical', left: 10, top: 'middle',
                textStyle: { color: '#a0a3a8', fontSize: 11 }, itemWidth: 12, itemHeight: 12, itemGap: 6,
              },
              series: [{
                type: 'pie', radius: pieRadius, center: pieCenter,
                data: names.map((n, i) => ({ name: n, value: primaryValues[i] || 0 })),
                emphasis: { itemStyle: { shadowBlur: 10, shadowOffsetX: 0, shadowColor: 'rgba(0,0,0,0.5)' }, label: { show: true, fontWeight: 'bold' } },
                label: {
                  show: !isManyData, position: 'outer', color: '#a0a3a8', fontSize: 10,
                  formatter: isManyData ? '{b}' : '{b}\n{c} ({d}%)', alignTo: 'labelLine', bleedMargin: 5,
                },
                labelLine: { show: !isManyData, length: 10, length2: 15, smooth: false, lineStyle: { color: '#4e5969', width: 1 } },
                labelLayout: { hideOverlap: true, moveOverlap: 'shiftY' },
                ...(isManyData ? {} : { blur: { label: { opacity: 0.3 } } }),
              }],
            }
            break
          }

          case 'gauge': {
            const primaryValues = valueCols.length > 0 ? firstRows.map((m) => parseFloat(m[valueCols[0]]) || 0) : []
            const gaugeValue = primaryValues.length > 0 ? primaryValues[0] : 0
            const gaugeName = (nameCol && valueCols.length > 0 && nameCol === valueCols[0]) ? nameCol : (names.length > 0 ? names[0] : '')
            const gMin = (options?.min as number) ?? 0
            const gMax = (options?.max as number) ?? 100
            const gUnit = (options?.unit as string) ?? ''
            const gColor = (options?.color as string) ?? '#1F7A3F'
            const gBgColor = (options?.bgColor as string) ?? '#D9E8DC'
            const gValueMode = (options?.valueMode as string) ?? 'absolute'
            let displayValue = gaugeValue
            if (gValueMode === 'percentage') displayValue = gMax !== gMin ? ((gaugeValue - gMin) / (gMax - gMin)) * 100 : 0

            // 计算实际显示的字符串（智能格式化大数字）
            const formattedValue = gValueMode === 'percentage'
              ? { display: `${displayValue.toFixed(1)}%`, full: `${displayValue.toFixed(1)}%` }
              : formatLargeNumber(displayValue, 10)

            const displayStr = formattedValue.display + (gUnit && gValueMode !== 'percentage' ? ` ${gUnit}` : '')
            const fullDisplayStr = formattedValue.full + (gUnit && gValueMode !== 'percentage' ? ` ${gUnit}` : '')

            // 根据容器尺寸和字符串长度智能调整字体大小
            const containerWidth = el?.offsetWidth || 200
            const containerHeight = el?.offsetHeight || 200
            const minDim = Math.min(containerWidth, containerHeight)
            const gaugeRadius = minDim * 0.75 // 仪表盘半径（像素）
            const maxTextWidth = gaugeRadius * 1.6 // 最大文本宽度（稍大于直径）

            // 估算字符宽度（粗略估计：数字和单位字符平均宽度约为字体大小的0.6倍）
            const charCount = displayStr.length
            const maxFontSize = Math.max(16, Math.min(36, minDim * 0.15))
            const estimatedFontSize = Math.min(maxFontSize, maxTextWidth / (charCount * 0.6))
            const fontSize = Math.max(12, estimatedFontSize) // 最小字体12px

            const titleFontSize = Math.max(11, Math.min(16, minDim * 0.065))

            option = {
              backgroundColor: 'transparent',
              tooltip: {
                show: true,
                trigger: 'item',
                formatter: () => fullDisplayStr,
                backgroundColor: 'rgba(50, 50, 50, 0.9)',
                borderColor: '#333',
                borderWidth: 1,
                padding: [8, 12],
                textStyle: {
                  color: '#fff',
                  fontSize: 13,
                  fontFamily: 'Inter, -apple-system, sans-serif',
                },
              },
              series: [{
                type: 'gauge',
                startAngle: 225, endAngle: -45, center: ['50%', '45%'], radius: '75%',
                min: gValueMode === 'percentage' ? 0 : gMin,
                max: gValueMode === 'percentage' ? 100 : gMax,
                progress: { show: true, width: 36, roundCap: true, itemStyle: { color: gColor } },
                axisLine: { lineStyle: { width: 36, color: [[1, gBgColor]] } },
                axisTick: { show: false }, splitLine: { show: false }, axisLabel: { show: false },
                anchor: { show: false }, pointer: { show: false },
                detail: {
                  valueAnimation: true, fontSize, offsetCenter: [0, '-5%'],
                  formatter: () => displayStr,
                  color: gColor, fontWeight: 600, fontFamily: 'Inter, -apple-system, sans-serif',
                },
                title: { color: '#666', fontSize: titleFontSize, offsetCenter: [0, '100%'], fontFamily: 'Inter, -apple-system, sans-serif' },
                data: [{ value: displayValue, name: gaugeName || undefined }],
              }],
            }
            break
          }

          default: option = {}
        }

        chart.setOption(option)

        // Data Links 点击事件
        if (dataLinks && dataLinks.length > 0) {
          chart.on('click', (params: any) => {
            if (!dataLinks || dataLinks.length === 0) return
            const linkData: Record<string, any> = {
              '__value': params.value, '__series.name': params.seriesName,
              '__series.index': params.seriesIndex, '__data.name': params.name,
              '__data.index': params.dataIndex,
            }
            setLinkMenu({ x: params.event?.event?.clientX || 0, y: params.event?.event?.clientY || 0, links: dataLinks, data: linkData })
          })
        }

        const handleResize = () => { try { chart.resize() } catch {} }
        window.addEventListener('resize', handleResize)
        const resizeObserver = new ResizeObserver(() => { try { chart.resize() } catch {} })
        if (el) resizeObserver.observe(el)

        return () => {
          resizeObserver.disconnect()
          window.removeEventListener('resize', handleResize)
          if (dataLinks && dataLinks.length > 0) chart.off('click')
          try { chart.dispose(); chartInstanceRef.current = null } catch {}
        }
      }

      // ---- 多查询独立渲染：每个 target 一个独立的 ECharts 图表 ----
      const disposers: (() => void)[] = []

      // 构建 refId → 首个数值的映射表（用于表达式计算）
      const refValues: Record<string, number> = {}
      data.forEach((targetRows, ti) => {
        const tdef = targets[ti]
        if (tdef?.targetType === 'expression') return
        const { valueCols: tvCols } = detectColumns(targetRows, type)
        if (tvCols.length > 0 && targetRows.length > 0) {
          refValues[tdef?.refId || String(ti)] = parseFloat(targetRows[0][tvCols[0]]) || 0
        }
      })

      /** 计算 Math 表达式的值 */
      const evaluateExpression = (expr: string): number => {
        try {
          let resolved = expr
          // 替换 $A, $B 等引用
          for (const [refId, val] of Object.entries(refValues)) {
            resolved = resolved.replace(new RegExp('\\$' + refId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), String(val))
          }
          // 安全的 Math 运算（只允许数字、运算符、括号、空格）
          if (!/^[\d\s+\-*/().%]+$/.test(resolved)) return 0
          const result = Function('"use strict"; return (' + resolved + ')')()
          return typeof result === 'number' && !isNaN(result) ? result : 0
        } catch { return 0 }
      }

      data.forEach((targetRows, ti) => {
        const tdef = targets[ti]
        const isExpr = tdef?.targetType === 'expression'

        const container = chartContainersRef.current.get(ti)
        if (!container || container.offsetWidth === 0 || container.offsetHeight === 0) return

        const targetChart = echarts.init(container, undefined, { renderer: 'canvas' })
        chartInstancesRef.current.set(ti, targetChart)

        // 表达式 query：计算值并构造虚拟行
        let effectiveRows = targetRows
        if (isExpr && tdef?.expression) {
          const computedVal = evaluateExpression(tdef.expression)
          const exprName = tdef.metricName || tdef.refId || `Expr${ti}`
          effectiveRows = [{ [exprName]: computedVal }]
        }

        const option = buildGaugeChartOption(effectiveRows, ti, container.offsetWidth, container.offsetHeight)
        targetChart.setOption(option)

        const handleResize = () => { try { targetChart.resize() } catch {} }
        window.addEventListener('resize', handleResize)
        const resizeObserver = new ResizeObserver(() => { try { targetChart.resize() } catch {} })
        resizeObserver.observe(container)
        disposers.push(() => {
          resizeObserver.disconnect()
          window.removeEventListener('resize', handleResize)
          try { targetChart.dispose() } catch {}
        })
      })

      return () => {
        disposers.forEach((d) => d())
        chartInstancesRef.current = new Map()
      }
    } catch (err: any) {
      console.error('ChartPanel init error:', err)
      setChartError(err.message || '图表初始化失败')
      try {
        if (chartInstanceRef.current) { chartInstanceRef.current.dispose(); chartInstanceRef.current = null }
      } catch {}
    }
  }, [type, data, nameCol, valueCols, targets, options])

  // 表格：合并所有 target 数据
  // 优先使用后端返回的列顺序（columns），保证与 SQL 查询一致
  const tableHeaders = useMemo(() => {
    if (allData.length === 0) return []
    let headers: string[] = []
    if (columns && columns.length > 0) {
      headers = columns
    } else {
      headers = Object.keys(allData[0])
    }
    // 根据options.hiddenColumns过滤隐藏的列（默认全显示）
    const hiddenColumns = (options?.hiddenColumns as string[] | undefined) || []
    headers = headers.filter(h => !hiddenColumns.includes(h))
    
    // 根据options.columnOrder重新排序（如果用户自定义了顺序）
    const columnOrder = (options?.columnOrder as string[] | undefined) || []
    if (columnOrder.length > 0) {
      // 只排序存在于headers中的列，保持其他列在后面
      const orderedHeaders: string[] = []
      const remainingHeaders: string[] = []
      
      // 先按columnOrder的顺序添加
      for (const orderedCol of columnOrder) {
        if (headers.includes(orderedCol)) {
          orderedHeaders.push(orderedCol)
        }
      }
      
      // 再添加不在columnOrder中的列（保持原始顺序）
      for (const h of headers) {
        if (!orderedHeaders.includes(h)) {
          remainingHeaders.push(h)
        }
      }
      
      headers = [...orderedHeaders, ...remainingHeaders]
    }
    
    return headers
  }, [allData, columns, options?.hiddenColumns, options?.columnOrder])

  // 表格排序与列筛选
  const [sortColumn, setSortColumn] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  // 每列筛选条件: 操作符 + 值
  interface ColFilter { op: '=' | '!=' | '>' | '>=' | '<' | '<=' | 'contains'; value: string }
  const [colFilters, setColFilters] = useState<Record<string, ColFilter>>({})
  // 当前打开筛选弹窗的列
  const [filterOpenCol, setFilterOpenCol] = useState<string | null>(null)
  // 分页
  const pageSize = typeof options?.pageSize === 'number' && options.pageSize > 0 ? options.pageSize : 5
  const [currentPage, setCurrentPage] = useState(1)

  const enableColFilter = options?.enableColumnFilter === true && type === 'table'

  // 构建 aliasMap 双向映射，供 mergeColumns 和 cellAlerts 共用
  const colAliasMap = useMemo(() => {
    const expanded: Map<string, Set<string>> = new Map()
    for (const t of targets) {
      if (!t.aliasMap) continue
      for (const [rawCol, alias] of Object.entries(t.aliasMap)) {
        if (!alias) continue
        let set = expanded.get(rawCol)
        if (!set) { set = new Set(); expanded.set(rawCol, set) }
        set.add(rawCol)
        set.add(alias)
        set = expanded.get(alias)
        if (!set) { set = new Set(); expanded.set(alias, set) }
        set.add(rawCol)
        set.add(alias)
      }
    }
    return expanded
  }, [targets])

  // 条件告警
  interface CellAlertRule { column: string; op: '>' | '>=' | '<' | '<=' | '=' | '!='; value: number; color: string }
  const supportsCellAlerts = type === 'table' || type === 'bar' || type === 'line' || type === 'timeseries' || type === 'pie'
  const cellAlertRules: CellAlertRule[] = useMemo(() => {
    if (!supportsCellAlerts) return []
    const raw = options?.cellAlerts
    if (!Array.isArray(raw)) return []
    const valid = raw.filter((r: any) => r && typeof r.column === 'string' && typeof r.op === 'string' && typeof r.value === 'number' && typeof r.color === 'string')
    // 为有 aliasMap 的列生成对应的别名规则，使 raw/alias 列名都能匹配
    const expanded: CellAlertRule[] = []
    for (const r of valid) {
      expanded.push(r)
      const names = colAliasMap.get(r.column as string)
      if (names) {
        for (const n of names) {
          if (n !== (r.column as string)) {
            expanded.push({ ...r, column: n })
          }
        }
      }
    }
    return expanded
  }, [type, options?.cellAlerts, colAliasMap])
  const alertMode = (options?.alertMode === 'percentage' ? 'percentage' : 'absolute') as 'absolute' | 'percentage'
  // 百分比模式下预计算每列最大值
  const columnMax = useMemo(() => {
    if (alertMode !== 'percentage' || cellAlertRules.length === 0) return {} as Record<string, number>
    const max: Record<string, number> = {}
    for (const rule of cellAlertRules) {
      if (max[rule.column] !== undefined) continue
      let m = -Infinity
      for (const row of allData) {
        const v = parseFloat(String(row[rule.column] ?? ''))
        if (!isNaN(v) && v > m) m = v
      }
      max[rule.column] = isFinite(m) ? m : 0
    }
    return max
  }, [alertMode, cellAlertRules, allData])
  // 获取某单元格的告警颜色（规则列表中的最后匹配项优先）
  const getCellAlertColor = (col: string, cellValue: unknown): string | undefined => {
    if (cellAlertRules.length === 0) return undefined
    const cellNum = parseFloat(String(cellValue ?? ''))
    if (isNaN(cellNum)) return undefined
    let matchColor: string | undefined
    for (const rule of cellAlertRules) {
      if (rule.column !== col) continue
      let compareVal = cellNum
      if (alertMode === 'percentage' && columnMax[col] && columnMax[col] > 0) {
        compareVal = (cellNum / columnMax[col]) * 100
      }
      let matched = false
      switch (rule.op) {
        case '>': matched = compareVal > rule.value; break
        case '>=': matched = compareVal >= rule.value; break
        case '<': matched = compareVal < rule.value; break
        case '<=': matched = compareVal <= rule.value; break
        case '=': matched = compareVal === rule.value; break
        case '!=': matched = compareVal !== rule.value; break
      }
      if (matched) {
        matchColor = rule.color
        break // 第一条匹配的规则生效，后续不再覆盖
      }
    }
    return matchColor
  }
  const enableCellMerge = options?.enableCellMerge === true && type === 'table'

  const mergeColumns = useMemo(() => {
    if (!enableCellMerge) return new Set<string>()
    const raw = options?.mergeColumns
    if (typeof raw !== 'string' || !raw.trim()) return new Set<string>()
    const names = new Set(raw.split(',').map((s: string) => s.trim()).filter(Boolean))
    // 也加入 aliasMap 的对应列名
    for (const col of [...names]) {
      const expanded = colAliasMap.get(col)
      if (expanded) expanded.forEach((n) => names.add(n))
    }
    return names
  }, [enableCellMerge, options?.mergeColumns, colAliasMap])

  const filteredSortedData = useMemo(() => {
    let rows = allData

    // 每列筛选：逐列过滤
    if (enableColFilter) {
      Object.entries(colFilters).forEach(([col, f]) => {
        if (!f.value.trim()) return
        const val = f.value.trim()
        const op = f.op
        rows = rows.filter((row) => {
          const cellVal = row[col]
          if (cellVal == null) return false
          const cellStr = String(cellVal)
          switch (op) {
            case '=': return cellStr.toLowerCase() === val.toLowerCase()
            case '!=': return cellStr.toLowerCase() !== val.toLowerCase()
            case 'contains': return cellStr.toLowerCase().includes(val.toLowerCase())
            case '>': case '>=': case '<': case '<=': {
              const nCell = parseFloat(cellStr)
              const nVal = parseFloat(val)
              if (isNaN(nCell) || isNaN(nVal)) return false
              switch (op) {
                case '>': return nCell > nVal
                case '>=': return nCell >= nVal
                case '<': return nCell < nVal
                case '<=': return nCell <= nVal
              }
              return false
            }
            default: return true
          }
        })
      })
    }

    // 排序
    if (sortColumn) {
      rows = [...rows].sort((a, b) => {
        const va = a[sortColumn]
        const vb = b[sortColumn]
        const na = parseFloat(va as string)
        const nb = parseFloat(vb as string)
        if (!isNaN(na) && !isNaN(nb)) {
          return sortDir === 'asc' ? na - nb : nb - na
        }
        const sa = va != null ? String(va) : ''
        const sb = vb != null ? String(vb) : ''
        const cmp = sa.localeCompare(sb, 'zh-CN')
        return sortDir === 'asc' ? cmp : -cmp
      })
    }

    return rows
  }, [allData, colFilters, sortColumn, sortDir, tableHeaders, enableColFilter])

  // 分页：数据变化时重置到第一页
  const totalPages = useMemo(() => Math.max(1, Math.ceil(filteredSortedData.length / pageSize)), [filteredSortedData, pageSize])
  useEffect(() => { setCurrentPage(1) }, [filteredSortedData.length, pageSize])
  // 确保 currentPage 在有效范围内
  const safePage = Math.min(currentPage, totalPages)
  const paginatedData = useMemo(() => {
    const start = (safePage - 1) * pageSize
    return filteredSortedData.slice(start, start + pageSize)
  }, [filteredSortedData, safePage, pageSize])

  // 预计算单元格合并信息：层级合并（类似 Excel）- 仅在分页数据上计算
  // 后续列的合并范围限制在前面列的合并范围内，不会跨组
  const cellMergeInfo = useMemo(() => {
    const data = paginatedData // 在当前页数据上合并，避免跨页边界
    if (!enableCellMerge || data.length === 0 || mergeColumns.size === 0) return null
    const info: { rowSpan: number; skip: boolean }[][] = data.map(() =>
      tableHeaders.map(() => ({ rowSpan: 1, skip: false }))
    )

    // 先收集所有参与合并的列索引（按表头顺序）
    const mergeColIndices: number[] = []
    for (let ci = 0; ci < tableHeaders.length; ci++) {
      if (mergeColumns.has(tableHeaders[ci])) {
        mergeColIndices.push(ci)
      }
    }
    if (mergeColIndices.length === 0) return info

    // 对每个合并列，在当前列及之前所有合并列的值都相同的范围内查找连续相同行
    for (let colRank = 0; colRank < mergeColIndices.length; colRank++) {
      const ci = mergeColIndices[colRank]
      const prevMergeIndices = mergeColIndices.slice(0, colRank)

      let i = 0
      while (i < data.length) {
        let j = i + 1
        while (j < data.length) {
          const curCol = tableHeaders[ci]
          if (String(data[j][curCol] ?? '') !== String(data[i][curCol] ?? '')) break
          let crossGroup = false
          for (const pc of prevMergeIndices) {
            const prevCol = tableHeaders[pc]
            if (String(data[j][prevCol] ?? '') !== String(data[i][prevCol] ?? '')) {
              crossGroup = true
              break
            }
          }
          if (crossGroup) break
          j++
        }
        const span = j - i
        if (span > 1) {
          info[i][ci].rowSpan = span
          for (let k = i + 1; k < j; k++) {
            info[k][ci].skip = true
          }
        }
        i = j
      }
    }
    return info
  }, [enableCellMerge, paginatedData, tableHeaders, mergeColumns])

  const handleSort = (col: string) => {
    if (sortColumn === col) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortColumn(col)
      setSortDir('asc')
    }
  }

  const setColFilter = (col: string, f: ColFilter) => {
    setColFilters((prev) => ({ ...prev, [col]: f }))
  }

  const hasAnyFilter = Object.values(colFilters).some((v) => v.value.trim())

  return (
    <div className="chart-panel">
      <div className="panel-title">
        <span className="panel-title-dot" />
        {title}
        <div style={{ flex: 1 }} />
        {showMenu && (
        <span
          style={{ cursor: 'pointer', padding: '2px 6px', borderRadius: 2, fontSize: 16, color: 'var(--text-muted)' }}
          onClick={(e) => { e.stopPropagation(); onToggleMenu() }}
        >
          &#x22EE;
        </span>
        )}
      </div>

      {showMenu && menuOpen && (
        <div className="panel-menu-dropdown" onClick={(e) => e.stopPropagation()}>
          <button className="panel-menu-item" onClick={onEdit}>编辑</button>
          <button className="panel-menu-item danger" onClick={onRemove}>删除</button>
        </div>
      )}

      {type === 'table' ? (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                {tableHeaders.map((h) => (
                  <th
                    key={h}
                    style={{ position: 'relative', userSelect: 'none' }}
                  >
                    <span
                      onClick={() => handleSort(h)}
                      style={{ cursor: 'pointer' }}
                      title={`点击按 ${h} 排序`}
                    >
                      {h}
                      {sortColumn === h && (
                        <span style={{ marginLeft: 4, fontSize: 10 }}>
                          {sortDir === 'asc' ? '▲' : '▼'}
                        </span>
                      )}
                    </span>
                    {enableColFilter && (
                      <>
                        <span
                          onClick={(e) => { e.stopPropagation(); setFilterOpenCol(filterOpenCol === h ? null : h) }}
                          style={{
                            cursor: 'pointer', marginLeft: 6, display: 'inline-flex', alignItems: 'center',
                            color: colFilters[h]?.value ? 'var(--primary)' : 'var(--text-muted)',
                            padding: '1px 3px', borderRadius: 2,
                          }}
                          title="列筛选"
                        >
                          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                            <path d="M1.5 1.5A.5.5 0 012 1h12a.5.5 0 01.5.5v2a.5.5 0 01-.128.334L10 8.692V13.5a.5.5 0 01-.342.474l-3 1A.5.5 0 016 14.5V8.692L1.628 3.834A.5.5 0 011.5 3.5v-2z"/>
                          </svg>
                        </span>
                        {filterOpenCol === h && (
                          <div
                            onClick={(e) => e.stopPropagation()}
                            style={{
                              position: 'absolute', top: '100%', left: 0, zIndex: 10,
                              background: 'var(--bg-card)', border: '1px solid var(--border-color)',
                              borderRadius: 4, padding: 6, minWidth: 200, boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
                              display: 'flex', flexDirection: 'column', gap: 4,
                            }}
                          >
                            {/* 操作符选择 */}
                            <select
                              value={colFilters[h]?.op || 'contains'}
                              onChange={(e) => {
                                e.stopPropagation()
                                const op = e.target.value as ColFilter['op']
                                const curVal = colFilters[h]?.value || ''
                                setColFilter(h, { op, value: curVal })
                              }}
                              onClick={(e) => e.stopPropagation()}
                              onMouseDown={(e) => e.stopPropagation()}
                              style={{
                                width: '100%', fontSize: 11, padding: '4px 6px',
                                background: 'var(--bg-input)', color: 'var(--text-primary)',
                                border: '1px solid var(--border-color)', borderRadius: 3, outline: 'none',
                              }}
                            >
                              <option value="=">=</option>
                              <option value="!=">!=</option>
                              <option value=">">&gt;</option>
                              <option value=">=">&gt;=</option>
                              <option value="<">&lt;</option>
                              <option value="<=">&lt;=</option>
                              <option value="contains">包含</option>
                            </select>
                            {/* 筛选值输入 */}
                            <input
                              type="text"
                              value={colFilters[h]?.value || ''}
                              onChange={(e) => {
                                const op = colFilters[h]?.op || 'contains'
                                setColFilter(h, { op, value: e.target.value })
                              }}
                              onClick={(e) => e.stopPropagation()}
                              onMouseDown={(e) => e.stopPropagation()}
                              placeholder={`筛选 ${h}...`}
                              autoFocus
                              style={{
                                width: '100%', fontSize: 11, padding: '4px 8px',
                                background: 'var(--bg-input)', color: 'var(--text-primary)',
                                border: '1px solid var(--border-color)', borderRadius: 3, outline: 'none',
                                boxSizing: 'border-box',
                              }}
                            />
                          </div>
                        )}
                      </>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {paginatedData.map((m, i) => (
                <tr key={i}>
                  {tableHeaders.map((h, ci) => {
                    if (cellMergeInfo && cellMergeInfo[i][ci].skip) return null
                    const rowSpan = cellMergeInfo ? cellMergeInfo[i][ci].rowSpan : 1
                    const alertColor = getCellAlertColor(h, m[h])

                    // 检查是否有 Data Link 配置
                    const dataLink = (dataLinks || []).find((link) => link.field === h)
                    if (dataLink && dataLink.url) {
                      // 替换 URL 变量
                      let url = dataLink.url
                      url = url.replace(/\$\{__value\}/g, String(m[h] ?? ''))
                      url = url.replace(/\$\{__field\.name\}/g, h)
                      // 替换 ${__row.xxx} 变量
                      url = url.replace(/\$\{__row\.(\w+)\}/g, (_, fieldName) => String(m[fieldName] ?? ''))

                      const linkTitle = dataLink.title || String(m[h] ?? '')
                      return (
                        <td key={h} rowSpan={rowSpan > 1 ? rowSpan : undefined}
                          style={alertColor ? { color: alertColor, fontWeight: 600 } : undefined}
                        >
                          <a
                            href={url}
                            target={dataLink.target || '_blank'}
                            rel="noopener noreferrer"
                            style={{
                              color: alertColor || 'var(--primary)',
                              textDecoration: 'none',
                              cursor: 'pointer',
                            }}
                            onClick={(e) => e.stopPropagation()}
                          >
                            {linkTitle}
                          </a>
                        </td>
                      )
                    }

                    return (
                      <td key={h} rowSpan={rowSpan > 1 ? rowSpan : undefined}
                        style={alertColor ? { color: alertColor, fontWeight: 600 } : undefined}
                      >
                        {formatValue(m[h])}
                      </td>
                    )
                  })}
                </tr>
              ))}
              {paginatedData.length === 0 && (
                <tr><td colSpan={tableHeaders.length || 1} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 20 }}>
                  {hasAnyFilter ? '无匹配结果' : '暂无数据'}
                </td></tr>
              )}
            </tbody>
          </table>
          {/* 分页控件 */}
          {totalPages > 1 && (
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              padding: '8px 0', borderTop: '1px solid var(--border-color)',
              fontSize: 12, color: 'var(--text-secondary)',
            }}>
              <button
                disabled={safePage <= 1}
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                style={{
                  padding: '2px 8px', fontSize: 11,
                  background: 'var(--bg-input)', color: 'var(--text-primary)',
                  border: '1px solid var(--border-color)', borderRadius: 3,
                  cursor: safePage <= 1 ? 'default' : 'pointer',
                  opacity: safePage <= 1 ? 0.4 : 1,
                }}
              >上一页</button>
              <span>第 {safePage} / {totalPages} 页</span>
              <button
                disabled={safePage >= totalPages}
                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                style={{
                  padding: '2px 8px', fontSize: 11,
                  background: 'var(--bg-input)', color: 'var(--text-primary)',
                  border: '1px solid var(--border-color)', borderRadius: 3,
                  cursor: safePage >= totalPages ? 'default' : 'pointer',
                  opacity: safePage >= totalPages ? 0.4 : 1,
                }}
              >下一页</button>
              <span style={{ marginLeft: 4 }}>共 {filteredSortedData.length} 条</span>
            </div>
          )}
        </div>
      ) : data.length > 1 && type === 'gauge' ? (
        <div style={{ display: 'flex', flexDirection: 'row', flex: 1, gap: 4, minHeight: '200px', alignItems: 'stretch' }}>
          {data.map((_, ti) => {
            return (
              <div key={ti} style={{ flex: 1, minHeight: 160, display: 'flex', flexDirection: 'column' }}>
                <div
                  ref={(el) => { if (el) chartContainersRef.current.set(ti, el); else chartContainersRef.current.delete(ti) }}
                  style={{ width: '100%', flex: 1, minHeight: 160}}
                />
              </div>
            )
          })}
        </div>
      ) : (
        <div ref={chartRef} style={{ width: '100%', flex: 1, minHeight: '200px' }}>
          {chartError && (
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              height: '100%', color: 'var(--text-muted)', fontSize: 12,
              padding: 16, textAlign: 'center',
            }}>
              <div>
                <div style={{ marginBottom: 8, color: 'var(--red)', fontSize: 20 }}>!</div>
                <div>图表渲染失败</div>
                <div style={{ fontSize: 10, marginTop: 4, opacity: 0.7 }}>{chartError}</div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Data Links 菜单 */}
      {linkMenu && (
        <div
          style={{
            position: 'fixed',
            left: linkMenu.x,
            top: linkMenu.y,
            background: 'var(--bg-card)',
            border: '1px solid var(--border-color)',
            borderRadius: 6,
            boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
            zIndex: 9999,
            minWidth: 150,
            padding: 4,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {linkMenu.links.map((link, idx) => {
            // 替换URL中的变量
            let url = link.url
            Object.entries(linkMenu.data).forEach(([key, value]) => {
              url = url.replace(`\${${key}}`, String(value))
            })

            return (
              <button
                key={idx}
                onClick={() => {
                  window.open(url, link.target || '_blank')
                  setLinkMenu(null)
                }}
                style={{
                  display: 'block',
                  width: '100%',
                  padding: '8px 12px',
                  fontSize: 12,
                  background: 'transparent',
                  color: 'var(--text-primary)',
                  border: 'none',
                  borderRadius: 4,
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                {link.title || link.url}
              </button>
            )
          })}
          <button
            onClick={() => setLinkMenu(null)}
            style={{
              display: 'block',
              width: '100%',
              padding: '6px 12px',
              fontSize: 11,
              background: 'transparent',
              color: 'var(--text-muted)',
              border: 'none',
              borderRadius: 4,
              cursor: 'pointer',
              textAlign: 'left',
              marginTop: 4,
            }}
          >
            关闭
          </button>
        </div>
      )}

      {/* 点击其他区域关闭链接菜单 */}
      {linkMenu && (
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 9998 }}
          onClick={() => setLinkMenu(null)}
        />
      )}
    </div>
  )
})
