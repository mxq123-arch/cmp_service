import { useState, useEffect } from 'react'
import { BrowserRouter, Routes, Route, useParams, useNavigate, useLocation } from 'react-router-dom'
import DashboardView from './components/DashboardView'
import BrowsePage from './components/BrowsePage'
import DataSourcesPage from './components/DataSourcesPage'
import SnapshotView from './components/SnapshotView'
import SnapshotList from './components/SnapshotList'
import PanelEditPage from './components/PanelEditPage'

import type { PanelDef, DatasourceRes, PanelDataRes, VariableRes } from './api'
import { initTheme } from './themes'
import './App.css'
import logo from './assets/logo.png'

type Page = 'browse' | 'snapshots' | 'datasources' | 'settings'

interface EditingPanelCtx {
  panel: PanelDef
  dashboardId: string
  datasources: DatasourceRes[]
  draftJson: any
  panelsData?: PanelDataRes[]
  variables?: VariableRes[]
  timePreset?: string
  customFrom?: string
  customTo?: string
  onSave: (updated: PanelDef) => void
}

/** Dashboard 页面包装器：从 URL 参数读取 dashboardId */
function DashboardPageWrapper() {
  const { uid } = useParams<{ uid: string }>()
  const navigate = useNavigate()
  const [editingPanel, setEditingPanel] = useState<EditingPanelCtx | null>(null)

  if (!uid) {
    navigate('/capacity_mgt_platform/', { replace: true })
    return null
  }

  const handleBack = () => navigate('/capacity_mgt_platform/')
  const handleEditPanel = (ctx: any) => setEditingPanel(ctx)

  return (
    <>
      <div style={{ display: editingPanel ? 'none' : undefined, height: '100%' }}>
        <DashboardView
          dashboardId={uid}
          onBack={handleBack}
          onEditPanel={handleEditPanel}
        />
      </div>
      {editingPanel && (
        <PanelEditPage
          panel={editingPanel.panel}
          datasources={editingPanel.datasources}
          dashboardId={editingPanel.dashboardId}
          draftJson={editingPanel.draftJson}
          panelsData={editingPanel.panelsData}
          variables={editingPanel.variables}
          timePreset={editingPanel.timePreset}
          customFrom={editingPanel.customFrom}
          customTo={editingPanel.customTo}
          onSave={(updated) => {
            editingPanel.onSave(updated)
            setEditingPanel(null)
          }}
          onBack={() => setEditingPanel(null)}
        />
      )}
    </>
  )
}

/** Snapshot 页面包装器：从 URL 参数读取 snapshotKey */
function SnapshotPageWrapper() {
  const { key } = useParams<{ key: string }>()
  const navigate = useNavigate()

  if (!key) {
    navigate('/capacity_mgt_platform/', { replace: true })
    return null
  }

  const handleClose = () => {
    navigate('/capacity_mgt_platform/')
  }

  return <SnapshotView snapshotKey={key} onClose={handleClose} />
}

function App() {
  const [currentPage, setCurrentPage] = useState<Page>('browse')
  const [snapshotListKey, setSnapshotListKey] = useState(0)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const location = useLocation()

  // 判断当前是否在仪表板详情页或快照页
  const isInDashboard = location.pathname.startsWith('/capacity_mgt_platform/d/')
  const isInSnapshot = location.pathname.startsWith('/capacity_mgt_platform/snapshot/')

  // 初始化主题
  useEffect(() => {
    initTheme()
  }, [])

  return (
    <div className="app">
      <header className="top-header">
        <div
          className="top-header-logo"
          onClick={() => { setCurrentPage('browse') }}
        >
          <img src={logo} alt="Logo" className="top-header-logo-img" />
          <span className="top-header-title">容量管理平台</span>
        </div>
        <div className="top-header-user">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
            <circle cx="12" cy="7" r="4" />
          </svg>
          <span className="user-name">黄知林</span>
        </div>
      </header>

      <div className="app-body">
        {!isInSnapshot && !isInDashboard && (
        <aside className={`sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}>
          <button
            className="sidebar-toggle-btn"
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            title={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {sidebarCollapsed ? (
                <path d="M9 18l6-6-6-6" />
              ) : (
                <path d="M15 18l-6-6 6-6" />
              )}
            </svg>
          </button>
        <nav className="sidebar-nav">
          <div
            className={`nav-item ${currentPage === 'browse' ? 'active' : ''}`}
            onClick={() => setCurrentPage('browse')}
            title="仪表板"
          >
            <span className="nav-icon">
              <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor"><rect x="2" y="2" width="7" height="16" rx="1" /><rect x="11" y="8" width="7" height="10" rx="1" /></svg>
            </span>
            <span className="nav-label">仪表板</span>
          </div>
          <div
            className={`nav-item ${currentPage === 'snapshots' ? 'active' : ''}`}
            onClick={() => { setCurrentPage('snapshots'); setSnapshotListKey(k => k + 1) }}
            title="快照"
          >
            <span className="nav-icon">
              <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor"><path d="M5 2a1 1 0 00-1 1v14a1 1 0 001 1h10a1 1 0 001-1V7l-5-5H5z" /><path d="M13 2v5h5" fill="none" stroke="currentColor" strokeWidth="1.5" /><circle cx="10" cy="11" r="3" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>
            </span>
            <span className="nav-label">快照</span>
          </div>
          <div
            className={`nav-item ${currentPage === 'datasources' ? 'active' : ''}`}
            onClick={() => setCurrentPage('datasources')}
            title="数据源"
          >
            <span className="nav-icon">
              <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor"><ellipse cx="10" cy="5" rx="8" ry="3" /><path d="M2 5v5c0 1.66 3.58 3 8 3s8-1.34 8-3V5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M2 10v5c0 1.66 3.58 3 8 3s8-1.34 8-3v-5" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
            </span>
            <span className="nav-label">数据源</span>
          </div>
        </nav>
      </aside>
      )}

      <div className="main-wrapper">
        <main className="main-content" style={{ padding: isInSnapshot ? 0 : undefined }}>
          <Routes>
            <Route path="/capacity_mgt_platform/" element={
              currentPage === 'browse' ? <BrowsePage /> :
              currentPage === 'snapshots' ? <SnapshotList key={snapshotListKey} /> :
              <DataSourcesPage />
            } />
            <Route path="/capacity_mgt_platform/d/:uid/:slug?" element={<DashboardPageWrapper />} />
            <Route path="/capacity_mgt_platform/snapshot/:key" element={<SnapshotPageWrapper />} />
          </Routes>
        </main>
      </div>
      </div>
    </div>
  )
}

/** 根组件：包裹 BrowserRouter */
function Root() {
  return (
    <BrowserRouter>
      <App />
    </BrowserRouter>
  )
}

export default Root
