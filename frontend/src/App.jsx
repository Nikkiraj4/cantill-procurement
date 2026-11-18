


import { useEffect, useState } from 'react'
import {
  Activity, ArrowUpRight, Bell, Boxes, CheckCircle2, ChevronDown, ChevronRight,
  CircleDollarSign, ClipboardList, FileText, LayoutDashboard, Package,
  RefreshCw, Search, Settings2, ShieldCheck, ShoppingCart, Sparkles,
  Truck, Upload,
} from 'lucide-react'
import {
  Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts'
import './App.css'

const API = import.meta.env.VITE_API_URL || 'http://localhost:5000'

const ROUTE_COLORS = {
  CONTRACT_PO: '#23856d',
  EMERGENCY_PO: '#d97736',
  SPOT_PO: '#4f73c8',
  RFQ: '#8a68c5',
  RFP: '#bd8a35',
  CAPEX_SOURCING: '#547d91',
  NEW_ITEM_SOURCING: '#a66b82',
}

const ROUTE_LABELS = {
  CONTRACT_PO: 'Contract PO',
  EMERGENCY_PO: 'Emergency PO',
  SPOT_PO: 'Spot PO',
  RFQ: 'RFQ',
  RFP: 'RFP',
  CAPEX_SOURCING: 'Capex sourcing',
  NEW_ITEM_SOURCING: 'New item sourcing',
}

function money(value, compact = false) {
  const number = Number(value || 0)
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: compact ? 1 : 0,
    notation: compact ? 'compact' : 'standard',
  }).format(number)
}

function date(value) {
  if (!value) return '—'
  return new Date(value).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })
}

function routeName(route) {
  return ROUTE_LABELS[route] || (route || '—').replaceAll('_', ' ')
}

function StatusPill({ value }) {
  const normalized = (value || 'PENDING').toLowerCase().replaceAll('_', '-')
  return <span className={`status-pill status-${normalized}`}>{(value || 'Pending').replaceAll('_', ' ')}</span>
}

function RoutePill({ route }) {
  return (
    <span className="route-pill">
      <span className="route-dot" style={{ background: ROUTE_COLORS[route] || '#8993a3' }} />
      {routeName(route)}
    </span>
  )
}

function MetricCard({ icon: Icon, label, value, note, tone = 'blue' }) {
  return (
    <article className="metric-card">
      <div className={`metric-icon metric-${tone}`}><Icon size={19} strokeWidth={1.8} /></div>
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
      <div className="metric-note">{note}</div>
    </article>
  )
}

function EmptyState({ message }) {
  return <div className="empty-state"><Package size={22} /><span>{message}</span></div>
}

function App() {
  const [page, setPage] = useState('Overview')
  const [summary, setSummary] = useState(null)
  const [requirements, setRequirements] = useState([])
  const [purchaseOrders, setPurchaseOrders] = useState([])
  const [sourcingRequests, setSourcingRequests] = useState([])
  const [batches, setBatches] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)
  const [search, setSearch] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [uploading, setUploading] = useState(false)
  const [uploadFeedback, setUploadFeedback] = useState(null)
  const [policies, setPolicies] = useState([])
  const [policyLoading, setPolicyLoading] = useState(false)
  const [policyUploading, setPolicyUploading] = useState(false)
  const [policyFeedback, setPolicyFeedback] = useState(null)
  const [policyDraft, setPolicyDraft] = useState(null)
  const [policyApprover, setPolicyApprover] = useState('')
  const [policyApproving, setPolicyApproving] = useState(false)
  const [selectedRequirementId, setSelectedRequirementId] = useState('')
  const [buyerName, setBuyerName] = useState('')
  const [buyerComment, setBuyerComment] = useState('')
  const [overrideRoute, setOverrideRoute] = useState('SPOT_PO')
  const [overrideSupplierId, setOverrideSupplierId] = useState('')
  const [overrideUnitPrice, setOverrideUnitPrice] = useState('')
  const [buyerBusy, setBuyerBusy] = useState(false)
  const [buyerFeedback, setBuyerFeedback] = useState(null)
  const [selectedBatchId, setSelectedBatchId] = useState('')
  const [poGenerationBusy, setPoGenerationBusy] = useState(false)
  const [poGenerationFeedback, setPoGenerationFeedback] = useState(null)

  useEffect(() => {
    let cancelled = false

    async function loadDashboard() {
      setLoading(true)
      setError('')

      try {
        const query = searchQuery ? `&search=${encodeURIComponent(searchQuery)}` : ''
        const endpoints = [
          `${API}/api/dashboard/summary`,
          `${API}/api/dashboard/requirements?page=1&pageSize=100${query}`,
          `${API}/api/dashboard/purchase-orders?page=1&pageSize=100`,
          `${API}/api/dashboard/sourcing-requests?page=1&pageSize=100`,
          `${API}/api/dashboard/batches`,
        ]

        const responses = await Promise.all(endpoints.map((url) => fetch(url, { cache: 'no-store' })))
        const failed = responses.find((response) => !response.ok)
        if (failed) throw new Error(`API request failed (${failed.status}). Check that the backend is running.`)

        const results = await Promise.all(responses.map((response) => response.json()))
        if (results.some((result) => !result.success)) {
          throw new Error('The API returned an unsuccessful response.')
        }

        if (!cancelled) {
          setSummary(results[0].data)
          setRequirements(results[1].data || [])
          setPurchaseOrders(results[2].data || [])
          setSourcingRequests(results[3].data || [])
          setBatches(results[4].data || [])
        }
      } catch (err) {
        if (!cancelled) setError(err.message || 'Unable to connect to the backend.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    loadDashboard()
    return () => { cancelled = true }
  }, [refreshKey, searchQuery])

  async function loadPolicies() {
    setPolicyLoading(true)
    try {
      const response = await fetch(`${API}/api/policies`, { cache: 'no-store' })
      const result = await response.json()
      if (!response.ok || !result.success) {
        throw new Error(result.message || 'Unable to load policy versions.')
      }
      setPolicies(result.data || [])
    } catch (err) {
      setPolicyFeedback({ type: 'error', message: err.message })
    } finally {
      setPolicyLoading(false)
    }
  }

  async function handlePolicyUpload(event) {
    event.preventDefault()
    const form = event.currentTarget
    const formData = new FormData(form)
    const file = formData.get('policyPdf')

    if (!(file instanceof File) || !file.name) {
      setPolicyFeedback({ type: 'error', message: 'Please select a policy PDF.' })
      return
    }

    setPolicyUploading(true)
    setPolicyFeedback(null)
    setPolicyDraft(null)

    try {
      const response = await fetch(`${API}/api/policies/upload`, {
        method: 'POST',
        body: formData,
      })
      const result = await response.json()

      if (!response.ok || !result.success) {
        throw new Error(result.message || 'Policy upload failed.')
      }

      setPolicyDraft(result.data)
      setPolicyFeedback({
        type: 'success',
        message: result.message || 'Policy amendment saved as a draft.',
      })
      form.reset()
      await loadPolicies()
    } catch (err) {
      setPolicyFeedback({ type: 'error', message: err.message })
    } finally {
      setPolicyUploading(false)
    }
  }

  async function handlePolicyApproval() {
    if (!policyDraft?.id || !policyApprover.trim()) {
      setPolicyFeedback({ type: 'error', message: 'Enter the approver name before approval.' })
      return
    }

    const confirmed = window.confirm(
      `Activate policy v${policyDraft.version}? This immediately retires the current active policy.`
    )
    if (!confirmed) return

    setPolicyApproving(true)
    setPolicyFeedback(null)

    try {
      const response = await fetch(`${API}/api/policies/${policyDraft.id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approvedBy: policyApprover.trim() }),
      })
      const result = await response.json()

      if (!response.ok || !result.success) {
        throw new Error(result.message || 'Policy approval failed.')
      }

      setPolicyFeedback({ type: 'success', message: result.message })
      setPolicyDraft(null)
      setPolicyApprover('')
      await loadPolicies()
      setRefreshKey((current) => current + 1)
    } catch (err) {
      setPolicyFeedback({ type: 'error', message: err.message })
    } finally {
      setPolicyApproving(false)
    }
  }

  async function handleBatchUpload(event) {
    const file = event.target.files?.[0]
    event.target.value = ''

    if (!file) return

    if (!file.name.toLowerCase().endsWith('.csv')) {
      setUploadFeedback({
        type: 'error',
        message: 'Please select a CSV file.',
      })
      return
    }

    setUploading(true)
    setUploadFeedback(null)

    try {
      const content = await file.text()

      const response = await fetch(`${API}/api/process-batch`, {
  method: 'POST',
  headers: {
    'Content-Type': 'text/csv',
    'X-File-Name': file.name,
  },
  body: content,
})

      const result = await response.json()

      if (!response.ok || !result.success) {
        throw new Error(result.message || 'CSV upload failed.')
      }

      const imported = result.data

     setUploadFeedback({
  type: 'success',
  message:
    `${imported.fileName}: ${imported.lineCount} lines imported; ` +
    `${imported.requirementCount} requirements created; ` +
    `${imported.decisionCount} decisions processed; ` +
    `${imported.sourcingRequestCount} sourcing requests created. ` +
    'Direct PO decisions are awaiting buyer approval.',
})

      setRefreshKey((current) => current + 1)
    } catch (err) {
      setUploadFeedback({
        type: 'error',
        message: err.message || 'Unable to upload the CSV file.',
      })
    } finally {
      setUploading(false)
    }
  }

  async function submitBuyerAction(action) {
    if (!selectedRequirement) {
      setBuyerFeedback({ type: 'error', message: 'Select a requirement first.' })
      return
    }

    if (!buyerName.trim()) {
      setBuyerFeedback({ type: 'error', message: 'Enter the buyer name.' })
      return
    }

    if (action === 'OVERRIDE' && !buyerComment.trim()) {
      setBuyerFeedback({ type: 'error', message: 'An override comment is required.' })
      return
    }

    if (action === 'OVERRIDE' && ['CONTRACT_PO', 'EMERGENCY_PO', 'SPOT_PO'].includes(overrideRoute)) {
      if (!overrideSupplierId || !overrideUnitPrice || Number(overrideUnitPrice) <= 0) {
        setBuyerFeedback({ type: 'error', message: 'Select a supplier and enter a valid unit price.' })
        return
      }
    }

    const actionLabel = action.toLowerCase()
    if (!window.confirm(`Confirm ${actionLabel} for ${selectedRequirement.groupCode}?`)) return

    setBuyerBusy(true)
    setBuyerFeedback(null)

    try {
      const response = await fetch(
        `${API}/api/buyer/requirements/${selectedRequirement.id}/action`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action,
            performedBy: buyerName.trim(),
            comment: buyerComment.trim(),
            route: overrideRoute,
            supplierId: overrideSupplierId,
            unitPrice: overrideUnitPrice,
          }),
        }
      )

      const result = await response.json()
      if (!response.ok || !result.success) {
        throw new Error(result.message || `Buyer ${actionLabel} failed.`)
      }

      setBuyerFeedback({ type: 'success', message: result.message })
      setBuyerComment('')
      setRefreshKey((current) => current + 1)
    } catch (err) {
      setBuyerFeedback({ type: 'error', message: err.message })
    } finally {
      setBuyerBusy(false)
    }
  }

  async function generateBatchPurchaseOrders() {
    if (!selectedBatchId) {
      setPoGenerationFeedback({ type: 'error', message: 'Select a batch first.' })
      return
    }

    const batch = batches.find((item) => item.id === selectedBatchId)
    const batchLabel = batch?.fileName || batch?.filename || selectedBatchId

    if (!window.confirm(
      `Generate purchase orders for ${batchLabel}? This creates real PO records in the database and cannot be undone from this screen.`
    )) return

    setPoGenerationBusy(true)
    setPoGenerationFeedback(null)

    try {
      const response = await fetch(
        `${API}/api/buyer/batches/${selectedBatchId}/generate-purchase-orders`,
        { method: 'POST' }
      )
      const result = await response.json()

      if (!response.ok || !result.success) {
        throw new Error(result.message || 'Purchase-order generation failed.')
      }

      setPoGenerationFeedback({
        type: 'success',
        message: result.message,
      })
      setRefreshKey((current) => current + 1)
    } catch (err) {
      setPoGenerationFeedback({ type: 'error', message: err.message })
    } finally {
      setPoGenerationBusy(false)
    }
  }

  function refreshDashboard() {
    setError('')
    setLoading(true)
    setRefreshKey((current) => current + 1)
  }

  const navigation = [
    { label: 'Overview', icon: LayoutDashboard, group: 'WORKSPACE' },
    { label: 'Requirements', icon: ClipboardList },
    { label: 'Purchase orders', icon: ShoppingCart },
    { label: 'Sourcing requests', icon: Truck },
    { label: 'Policy management', icon: ShieldCheck, group: 'CONFIGURATION' },
  ]

  const routeData = (summary?.decisionsByRoute || []).map((item) => ({
    name: routeName(item.route),
    route: item.route,
    count: item.count,
  }))

  const selectedRequirement =
    requirements.find((item) => item.id === selectedRequirementId) || null

  const totalDecisions = summary?.decisions || 0
  const poDecisions = (summary?.decisionsByRoute || [])
    .filter((item) => ['CONTRACT_PO', 'EMERGENCY_PO', 'SPOT_PO'].includes(item.route))
    .reduce((total, item) => total + item.count, 0)
  const sourcingDecisions = Math.max(0, totalDecisions - poDecisions)

  function runSearch(event) {
    event.preventDefault()
    setSearchQuery(search.trim())
    if (page !== 'Requirements') setPage('Requirements')
  }

  function changePage(nextPage) {
    setPage(nextPage)
    setSearch('')
    setSearchQuery('')

    if (nextPage === 'Policy management') {
      loadPolicies()
    }
  }

  function renderRequirements(rows, compact = false) {
    if (!rows.length) return <EmptyState message="No requirements found." />

    return (
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Requirement</th>
              <th>Item</th>
              <th>Plant</th>
              <th>Quantity</th>
              <th>Value</th>
              <th>Decision</th>
              <th>Route</th>
              {!compact && <th>Buyer review</th>}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, compact ? 6 : 100).map((item) => (
              <tr key={item.id}>
                <td>
                  <div className="primary-cell">{item.groupCode}</div>
                  <div className="secondary-cell">{date(item.firstCreatedAt)}</div>
                </td>
                <td>
                  <div className="primary-cell">{item.item?.description || 'New item'}</div>
                  <div className="secondary-cell">{item.itemCode || 'Unmatched item'}</div>
                </td>
                <td><span className="plant-tag">{item.plantCode}</span></td>
                <td className="number-cell">{Number(item.totalQuantity || 0).toLocaleString('en-IN')}</td>
                <td className="number-cell">{money(item.totalValue)}</td>
                <td><StatusPill value={item.decision?.decisionType || item.status} /></td>
                <td>{item.decision?.route ? <RoutePill route={item.decision.route} /> : '—'}</td>
                {!compact && (
                  <td>
                    {item.decision ? (
                      <button
                        type="button"
                        className="text-button buyer-review-button"
                        onClick={() => {
                          setSelectedRequirementId(item.id)
                          setBuyerFeedback(null)
                          setOverrideSupplierId(item.decision?.supplierId || item.decision?.suggestions?.[0]?.supplierId || '')
                          setOverrideUnitPrice(item.decision?.unitPrice?.toString?.() || '')
                        }}
                      >
                        {selectedRequirementId === item.id ? 'Selected' : 'Review'}
                      </button>
                    ) : '—'}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  function renderPurchaseOrders(rows) {
    if (!rows.length) return <EmptyState message="No purchase orders found." />

    return (
      <div className="table-scroll">
        <table>
          <thead>
            <tr><th>PO number</th><th>Supplier</th><th>Plant</th><th>Route</th><th>Lines</th><th>Created</th></tr>
          </thead>
          <tbody>
            {rows.map((po) => (
              <tr key={po.id}>
                <td><div className="primary-cell">{po.poNumber}</div><div className="secondary-cell">{po.supplierId}</div></td>
                <td><div className="primary-cell">{po.supplier?.name || po.supplierId}</div><div className="secondary-cell">{po.supplier?.city || '—'}</div></td>
                <td><span className="plant-tag">{po.plantCode}</span></td>
                <td><RoutePill route={po.route} /></td>
                <td className="number-cell">{po.lines?.length || 0}</td>
                <td>{date(po.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  function renderSourcingRequests(rows) {
    if (!rows.length) return <EmptyState message="No sourcing requests found." />

    return (
      <div className="table-scroll">
        <table>
          <thead>
            <tr><th>Requirement</th><th>Item</th><th>Plant</th><th>Value</th><th>Route</th><th>Status</th><th>Suggested suppliers</th></tr>
          </thead>
          <tbody>
            {rows.map((request) => {
              const requirement = request.requirement
              const suggestions = requirement?.decision?.suggestions || []
              return (
                <tr key={request.id}>
                  <td><div className="primary-cell">{requirement?.groupCode || '—'}</div><div className="secondary-cell">{date(request.createdAt)}</div></td>
                  <td><div className="primary-cell">{requirement?.item?.description || 'New item'}</div><div className="secondary-cell">{requirement?.itemCode || 'Unmatched item'}</div></td>
                  <td><span className="plant-tag">{requirement?.plantCode || '—'}</span></td>
                  <td className="number-cell">{money(requirement?.totalValue)}</td>
                  <td>{requirement?.decision?.route ? <RoutePill route={requirement.decision.route} /> : '—'}</td>
                  <td><StatusPill value={request.status} /></td>
                  <td>
                    {suggestions.length
                      ? <span className="supplier-count">{suggestions.length} suppliers</span>
                      : <span className="secondary-cell">Not applicable</span>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    )
  }

  const pageTitle = page === 'Overview' ? 'Procurement overview' : page
  const pageDescription = {
    Overview: 'A live view of procurement activity, policy decisions and purchase commitments.',
    Requirements: 'Review consolidated requirements and the policy decision applied to each one.',
    'Purchase orders': 'Purchase orders generated from eligible procurement requirements.',
    'Sourcing requests': 'Requirements routed to RFQ, RFP, capex or new-item sourcing.',
    'Policy management': 'Review policy versions, upload amendments and manage draft approvals.',
  }[page]

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><Boxes size={22} /></div>
          <div><div className="brand-name">corvo<span>.</span></div><div className="brand-caption">PROCUREMENT INTELLIGENCE</div></div>
        </div>

        <div className="workspace-switch">
          <div className="workspace-avatar">C</div>
          <div className="workspace-copy"><strong>Corvo Engineering</strong><span>Procurement workspace</span></div>
          <ChevronDown size={15} />
        </div>

        <nav className="side-nav">
          <div className="nav-label">WORKSPACE</div>
          {navigation.map(({ label, icon: Icon }) => (
            <button key={label} className={`nav-item ${page === label ? 'active' : ''}`} onClick={() => changePage(label)}>
              <Icon size={18} strokeWidth={1.8} /><span>{label}</span>
              {label === 'Sourcing requests' && <span className="nav-count">{summary?.sourcingRequests ?? '—'}</span>}
            </button>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className="policy-card">
            <div className="policy-card-top"><ShieldCheck size={17} /><span>ACTIVE POLICY</span><span className="live-dot" /></div>
            <strong>{summary?.activePolicy?.documentCode || 'CORVO-PROC-POL-04'}</strong>
            <div className="policy-version">Version {summary?.activePolicy?.version || '—'} · Effective {date(summary?.activePolicy?.effectiveFrom)}</div>
          </div>
          <button className="nav-item muted-nav"><Settings2 size={18} /><span>Settings</span></button>
          <div className="profile">
            <div className="profile-avatar">NK</div>
            <div className="profile-copy"><strong>Procurement team</strong><span>Buyer workspace</span></div>
            <ChevronDown size={15} />
          </div>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumb"><span>Workspace</span><ChevronRight size={14} /><strong>{page}</strong></div>
          <div className="topbar-actions">
            <span className="connection-status"><span className="live-dot" /> API connected</span>
            <button className={`icon-button ${loading ? "is-refreshing" : ""}`} aria-label="Refresh dashboard" title={loading ? "Refreshing dashboard…" : "Refresh dashboard"} aria-busy={loading} onClick={refreshDashboard}><RefreshCw size={17} /></button>
            <button className="icon-button notification-button" aria-label="Notifications"><Bell size={17} /><i /></button>
            <div className="top-avatar">NK</div>
          </div>
        </header>

        <div className="content-area">
          <section className="page-heading">
            <div>
              <div className="eyebrow"><Sparkles size={13} /> PROCUREMENT CONTROL CENTER</div>
              <h1>{pageTitle}</h1>
              <p>{pageDescription}</p>
            </div>
            <div className="heading-actions">
              <button className={`button-secondary ${loading ? "is-refreshing" : ""}`} onClick={refreshDashboard} disabled={loading} aria-busy={loading}><RefreshCw size={15} /> {loading ? "Refreshing…" : "Refresh"}</button>
              <button className="button-primary" onClick={() => changePage('Requirements')}><ClipboardList size={16} /> View requirements</button>
            </div>
          </section>

          {error && (
            <div className="error-banner">
              <Activity size={18} />
              <div><strong>Could not load dashboard data</strong><span>{error} Confirm the backend is running on port 5000.</span></div>
              <button onClick={() => setRefreshKey((value) => value + 1)}>Retry</button>
            </div>
          )}

          {loading && !summary ? (
            <div className="loading-panel"><RefreshCw size={20} className="spin" /><span>Connecting to procurement data…</span></div>
          ) : (
            <>
              {page === 'Overview' && (
                <>
                  <section className="metrics-grid">
                    <MetricCard icon={FileText} label="Purchase requests" value={(summary?.purchaseRequests || 0).toLocaleString('en-IN')} note={`${summary?.batches || 0} imported batch`} tone="blue" />
                    <MetricCard icon={ClipboardList} label="Consolidated requirements" value={(summary?.requirements || 0).toLocaleString('en-IN')} note="After item and plant matching" tone="violet" />
                    <MetricCard icon={CheckCircle2} label="Policy decisions" value={(summary?.decisions || 0).toLocaleString('en-IN')} note="Evaluated under active policy" tone="green" />
                    <MetricCard icon={ShoppingCart} label="Purchase orders" value={(summary?.purchaseOrders || 0).toLocaleString('en-IN')} note={money(summary?.totalPurchaseOrderValue, true) + ' committed value'} tone="orange" />
                  </section>

                  <section className="overview-grid">
                    <article className="panel decision-panel">
                      <div className="panel-heading">
                        <div><h2>Decision distribution</h2><p>How requirements were routed by policy</p></div>
                        <span className="panel-period">POLICY {summary?.activePolicy?.version || '—'}</span>
                      </div>
                      <div className="decision-content">
                        <div className="donut-wrap">
                          <ResponsiveContainer width="100%" height={210}>
                            <PieChart>
                              <Pie data={routeData} dataKey="count" nameKey="name" innerRadius={62} outerRadius={88} paddingAngle={3} stroke="none">
                                {routeData.map((entry) => <Cell key={entry.route} fill={ROUTE_COLORS[entry.route] || '#8993a3'} />)}
                              </Pie>
                              <Tooltip formatter={(value, name) => [value, name]} />
                            </PieChart>
                          </ResponsiveContainer>
                          <div className="donut-center"><strong>{totalDecisions}</strong><span>Decisions</span></div>
                        </div>
                        <div className="route-legend">
                          {routeData.map((item) => (
                            <div className="legend-row" key={item.route}>
                              <span className="legend-swatch" style={{ background: ROUTE_COLORS[item.route] || '#8993a3' }} />
                              <span className="legend-name">{item.name}</span>
                              <strong>{item.count}</strong>
                            </div>
                          ))}
                        </div>
                      </div>
                    </article>

                    <article className="panel value-panel">
                      <div className="panel-heading"><div><h2>Procurement value</h2><p>Requirement valuation and PO commitments</p></div><div className="value-icon"><CircleDollarSign size={19} /></div></div>
                      <div className="value-block">
                        <span className="value-caption">TOTAL REQUIREMENT VALUE</span>
                        <strong>{money(summary?.totalRequirementValue)}</strong>
                        <div className="value-subtext">Across {summary?.requirements || 0} consolidated requirements</div>
                      </div>
                      <div className="value-divider" />
                      <div className="value-comparison">
                        <div><span className="comparison-dot committed" /><span>PO value created</span><strong>{money(summary?.totalPurchaseOrderValue)}</strong></div>
                        <div><span className="comparison-dot pending" /><span>Sourcing requirements</span><strong>{sourcingDecisions}</strong></div>
                      </div>
                      <div className="value-footnote"><ArrowUpRight size={14} /> PO value reflects generated purchase orders only</div>
                    </article>
                  </section>

                  <section className="panel table-panel">
                    <div className="panel-heading">
                      <div><h2>Latest requirements</h2><p>Recently consolidated procurement requirements</p></div>
                      <button className="text-button" onClick={() => changePage('Requirements')}>View all <ChevronRight size={15} /></button>
                    </div>
                    {renderRequirements(requirements, true)}
                  </section>

                  <section className="bottom-grid">
                    <article className="panel route-panel">
                      <div className="panel-heading"><div><h2>Decision routes</h2><p>Requirement count by procurement route</p></div></div>
                      <div className="bar-chart">
                        <ResponsiveContainer width="100%" height={210}>
                          <BarChart data={routeData} margin={{ top: 8, right: 8, left: -20, bottom: 5 }}>
                            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#edf0f4" />
                            <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#7c8798' }} interval={0} angle={-15} textAnchor="end" height={52} />
                            <YAxis tick={{ fontSize: 11, fill: '#7c8798' }} allowDecimals={false} />
                            <Tooltip />
                            <Bar dataKey="count" name="Requirements" radius={[5, 5, 0, 0]}>
                              {routeData.map((entry) => <Cell key={entry.route} fill={ROUTE_COLORS[entry.route] || '#8993a3'} />)}
                            </Bar>
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    </article>

                    <article className="panel batch-panel">
                      <div className="panel-heading">
                        <div>
                          <h2>Imported batches</h2>
                          <p>Purchase request files processed</p>
                        </div>
                        <label className={`batch-upload-button ${uploading ? 'is-uploading' : ''}`}>
                          <Upload size={15} />
                          <span>{uploading ? 'Uploading…' : 'Upload CSV'}</span>
                          <input
                            type="file"
                            accept=".csv,text/csv"
                            onChange={handleBatchUpload}
                            disabled={uploading}
                            aria-label="Upload purchase request CSV"
                          />
                        </label>
                      </div>

                      {uploadFeedback && (
                        <div className={`upload-feedback ${uploadFeedback.type}`} role="status">
                          {uploadFeedback.message}
                        </div>
                      )}

                      {batches.length ? batches.map((batch) => (
                        <div className="batch-row" key={batch.id}>
                          <div className="batch-file-icon"><FileText size={19} /></div>
                          <div className="batch-info">
                            <strong>{batch.fileName}</strong>
                            <span>{batch.rowCount} rows · {date(batch.importedAt)}</span>
                          </div>
                          <StatusPill value={batch.status} />
                        </div>
                      )) : <EmptyState message="No imported batches yet." />}

                      <div className="batch-foot">
                        <span>Import history</span>
                        <strong>{batches.length} batch{batches.length === 1 ? '' : 'es'}</strong>
                      </div>
                    </article>
                  </section>
                </>
              )}

              {page === 'Requirements' && (
                <section className="panel full-table-panel">
                  <div className="panel-heading">
                    <div><h2>All requirements</h2><p>{requirements.length} records loaded from the procurement database</p></div>
                    <form className="table-search" onSubmit={runSearch}><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search item or requirement" /><button type="submit">Search</button></form>
                  </div>
                  {renderRequirements(requirements)}

                  <section className="buyer-workspace">
                    <div className="buyer-heading">
                      <div>
                        <span className="buyer-eyebrow">PROCUREMENT CONTROL</span>
                        <h3>Buyer review</h3>
                        <p>Select a requirement above to inspect its decision and record an action.</p>
                      </div>
                      {selectedRequirement && (
                        <StatusPill value={selectedRequirement.status} />
                      )}
                    </div>

                    {!selectedRequirement ? (
                      <div className="buyer-empty">
                        Select a requirement with a procurement decision to begin review.
                      </div>
                    ) : (
                      <>
                        <div className="buyer-requirement-summary">
                          <div>
                            <span>REQUIREMENT</span>
                            <strong>{selectedRequirement.groupCode}</strong>
                          </div>
                          <div>
                            <span>ITEM</span>
                            <strong>{selectedRequirement.item?.description || selectedRequirement.itemCode || 'New item'}</strong>
                          </div>
                          <div>
                            <span>QUANTITY</span>
                            <strong>{Number(selectedRequirement.totalQuantity || 0).toLocaleString('en-IN')}</strong>
                          </div>
                          <div>
                            <span>ESTIMATED VALUE</span>
                            <strong>{money(selectedRequirement.totalValue)}</strong>
                          </div>
                        </div>

                        <div className="buyer-evidence">
                          <div>
                            <h4>Automated decision evidence</h4>
                            <p><strong>Decision:</strong> {selectedRequirement.decision?.decisionType || '—'}</p>
                            <p><strong>Route:</strong> {selectedRequirement.decision?.route || '—'}</p>
                            <p><strong>Policy clause:</strong> {selectedRequirement.decision?.appliedClause || '—'}</p>
                            <p><strong>Policy version:</strong> {selectedRequirement.policyVersion?.version || '—'}</p>
                            <p><strong>Reason:</strong> {selectedRequirement.decision?.reason || 'No decision reason recorded.'}</p>
                            {selectedRequirement.decision?.supplier && (
                              <p><strong>Selected supplier:</strong> {selectedRequirement.decision.supplier.name}</p>
                            )}
                            {selectedRequirement.decision?.unitPrice != null && (
                              <p><strong>Current unit price:</strong> {money(selectedRequirement.decision.unitPrice)}</p>
                            )}
                          </div>

                          <div>
                            <h4>Supplier recommendations</h4>
                            {selectedRequirement.decision?.suggestions?.length ? (
                              <ol className="buyer-suggestions">
                                {selectedRequirement.decision.suggestions.map((suggestion) => (
                                  <li key={suggestion.id}>
                                    <strong>{suggestion.supplier?.name || suggestion.supplierId}</strong>
                                    <span>Rank {suggestion.rank}</span>
                                    {suggestion.reason && <p>{suggestion.reason}</p>}
                                  </li>
                                ))}
                              </ol>
                            ) : (
                              <p>No alternative supplier recommendations recorded.</p>
                            )}
                          </div>
                        </div>

                        <div className="buyer-history">
                          <h4>Buyer action history</h4>
                          {selectedRequirement.decision?.overrides?.length ? (
                            <ul>
                              {selectedRequirement.decision.overrides.map((entry) => (
                                <li key={entry.id}>
                                  <strong>{entry.action}</strong> by {entry.performedBy}
                                  <span>{date(entry.performedAt)}</span>
                                  {entry.comment && <p>{entry.comment}</p>}
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <p>No buyer actions recorded yet.</p>
                          )}
                        </div>

                        <div className="buyer-form">
                          <h4>Record buyer decision</h4>
                          <label className="policy-field">
                            <span>Buyer name</span>
                            <input
                              value={buyerName}
                              onChange={(event) => setBuyerName(event.target.value)}
                              placeholder="Enter your name"
                            />
                          </label>

                          <label className="policy-field">
                            <span>Override route</span>
                            <select
                              value={overrideRoute}
                              onChange={(event) => setOverrideRoute(event.target.value)}
                            >
                              <option value="CONTRACT_PO">Contract PO</option>
                              <option value="EMERGENCY_PO">Emergency PO</option>
                              <option value="SPOT_PO">Spot PO</option>
                              <option value="RFQ">RFQ</option>
                              <option value="RFP">RFP</option>
                              <option value="CAPEX_SOURCING">Capex sourcing</option>
                              <option value="NEW_ITEM_SOURCING">New item sourcing</option>
                            </select>
                          </label>

                          {['CONTRACT_PO', 'EMERGENCY_PO', 'SPOT_PO'].includes(overrideRoute) && (
                            <>
                              <label className="policy-field">
                                <span>Override supplier</span>
                                <select
                                  value={overrideSupplierId}
                                  onChange={(event) => setOverrideSupplierId(event.target.value)}
                                >
                                  <option value="">Select an active recommended supplier</option>
                                  {[
                                    ...(selectedRequirement.decision?.supplier
                                      ? [{ supplier: selectedRequirement.decision.supplier }]
                                      : []),
                                    ...(selectedRequirement.decision?.suggestions || []),
                                  ].map((suggestion, index) => (
                                    <option
                                      key={`${suggestion.supplier?.id || index}-${index}`}
                                      value={suggestion.supplier?.id || ''}
                                      disabled={suggestion.supplier?.status !== 'ACTIVE'}
                                    >
                                      {suggestion.supplier?.name || 'Unknown supplier'}
                                      {suggestion.supplier?.status !== 'ACTIVE' ? ' (inactive)' : ''}
                                    </option>
                                  ))}
                                </select>
                              </label>

                              <label className="policy-field">
                                <span>Override unit price (INR)</span>
                                <input
                                  type="number"
                                  min="0.01"
                                  step="0.01"
                                  value={overrideUnitPrice}
                                  onChange={(event) => setOverrideUnitPrice(event.target.value)}
                                  placeholder="Enter approved unit price"
                                />
                              </label>
                            </>
                          )}

                          <label className="policy-field policy-field-wide">
                            <span>Comment (mandatory for override)</span>
                            <textarea
                              rows="3"
                              value={buyerComment}
                              onChange={(event) => setBuyerComment(event.target.value)}
                              placeholder="Explain the buyer decision or reason for overriding the recommendation."
                            />
                          </label>

                          {buyerFeedback && (
                            <div className={`upload-feedback ${buyerFeedback.type}`}>
                              {buyerFeedback.message}
                            </div>
                          )}

                          <div className="buyer-actions">
                            <button
                              type="button"
                              className="button-secondary"
                              disabled={buyerBusy || selectedRequirement.status !== 'DECIDED'}
                              onClick={() => submitBuyerAction('REJECT')}
                            >
                              Reject
                            </button>
                            <button
                              type="button"
                              className="button-secondary"
                              disabled={buyerBusy || selectedRequirement.status !== 'DECIDED'}
                              onClick={() => submitBuyerAction('OVERRIDE')}
                            >
                              Override
                            </button>
                            <button
                              type="button"
                              className="button-primary"
                              disabled={buyerBusy || selectedRequirement.status !== 'DECIDED'}
                              onClick={() => submitBuyerAction('APPROVE')}
                            >
                              {buyerBusy ? 'Saving…' : 'Approve'}
                            </button>
                          </div>
                          {selectedRequirement.status !== 'DECIDED' && (
                            <p className="buyer-locked-note">
                              This requirement has already been reviewed. Its buyer actions are read-only.
                            </p>
                          )}
                        </div>
                      </>
                    )}
                  </section>

                  <section className="buyer-workspace">
                    <div className="buyer-heading">
                      <div>
                        <span className="buyer-eyebrow">PURCHASE ORDER CONTROL</span>
                        <h3>Generate approved purchase orders</h3>
                        <p>Choose a batch after its direct-PO requirements have been reviewed.</p>
                      </div>
                    </div>
                    <div className="buyer-batch-controls">
                      <select
                        value={selectedBatchId}
                        onChange={(event) => setSelectedBatchId(event.target.value)}
                      >
                        <option value="">Select an imported batch</option>
                        {batches.map((batch) => (
                          <option key={batch.id} value={batch.id}>
                            {batch.fileName || batch.filename || batch.id} — {batch.id}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="button-primary"
                        disabled={poGenerationBusy || !selectedBatchId}
                        onClick={generateBatchPurchaseOrders}
                      >
                        {poGenerationBusy ? 'Generating…' : 'Generate purchase orders'}
                      </button>
                    </div>
                    {poGenerationFeedback && (
                      <div className={`upload-feedback ${poGenerationFeedback.type}`}>
                        {poGenerationFeedback.message}
                      </div>
                    )}
                    <p className="buyer-locked-note">
                      Generation is manual. The backend blocks batches with unreviewed direct-PO decisions and refuses duplicate PO creation.
                    </p>
                  </section>
                </section>
              )}

              {page === 'Purchase orders' && (
                <section className="panel full-table-panel">
                  <div className="panel-heading"><div><h2>Generated purchase orders</h2><p>{purchaseOrders.length} purchase orders loaded</p></div><span className="panel-period">PO VALUE {money(summary?.totalPurchaseOrderValue, true)}</span></div>
                  {renderPurchaseOrders(purchaseOrders)}
                </section>
              )}

              {page === 'Sourcing requests' && (
                <section className="panel full-table-panel">
                  <div className="panel-heading"><div><h2>Open sourcing work</h2><p>{sourcingRequests.length} sourcing requests loaded with supplier recommendations where applicable</p></div><span className="panel-period">{summary?.sourcingRequests || 0} TOTAL REQUESTS</span></div>
                  {renderSourcingRequests(sourcingRequests)}
                </section>
              )}

              {page === 'Policy management' && (
                <div className="policy-workspace">
                  <section className="panel">
                    <div className="panel-heading">
                      <div>
                        <h2>Upload policy amendment</h2>
                        <p>Upload a readable PDF and enter the supported rule changes for a new draft version.</p>
                      </div>
                      <span className="panel-period">PDF · MAX 10 MB</span>
                    </div>

                    {policyFeedback && (
                      <div className={`upload-feedback ${policyFeedback.type}`} role="status">
                        {policyFeedback.message}
                      </div>
                    )}

                    <form className="policy-form" onSubmit={handlePolicyUpload}>
                      <label className="policy-field policy-field-wide">
                        <span>Policy document (PDF)</span>
                        <input type="file" name="policyPdf" accept="application/pdf,.pdf" required />
                      </label>

                      <label className="policy-field">
                        <span>Effective from</span>
                        <input type="date" name="effectiveFrom" required />
                      </label>

                      <label className="policy-field policy-field-wide">
                        <span>Summary of changes</span>
                        <textarea name="changeSummary" rows="3" maxLength="2000" required placeholder="Describe the policy amendment and the business reason for the change." />
                      </label>

                      <div className="policy-section-label">Decision thresholds (INR)</div>

                      <label className="policy-field">
                        <span>Emergency PO limit</span>
                        <input type="number" name="emergencyLimitINR" min="1" step="0.01" defaultValue="500000" required />
                      </label>

                      <label className="policy-field">
                        <span>Spot PO limit</span>
                        <input type="number" name="spotLimitINR" min="1" step="0.01" defaultValue="200000" required />
                      </label>

                      <label className="policy-field">
                        <span>RFQ upper limit</span>
                        <input type="number" name="rfqLimitINR" min="1" step="0.01" defaultValue="1000000" required />
                      </label>

                      <div className="policy-section-label">Supplier recommendation counts</div>

                      <label className="policy-field">
                        <span>Capex suppliers</span>
                        <input type="number" name="capexSupplierCount" min="1" max="20" step="1" defaultValue="5" required />
                      </label>

                      <label className="policy-field">
                        <span>RFQ suppliers</span>
                        <input type="number" name="rfqSupplierCount" min="1" max="20" step="1" defaultValue="3" required />
                      </label>

                      <label className="policy-field">
                        <span>RFP suppliers</span>
                        <input type="number" name="rfpSupplierCount" min="1" max="20" step="1" defaultValue="5" required />
                      </label>

                      <div className="policy-form-note">
                        The PDF text is extracted and stored for review. The fields above update the five supported decision rules; arbitrary new clauses are not automatically interpreted.
                      </div>

                      <div className="policy-form-actions">
                        <button className="button-primary" type="submit" disabled={policyUploading}>
                          <Upload size={15} />
                          {policyUploading ? 'Creating draft…' : 'Upload and create draft'}
                        </button>
                      </div>
                    </form>
                  </section>

                  {policyDraft && (
                    <section className="panel">
                      <div className="panel-heading">
                        <div>
                          <h2>Draft amendment preview · v{policyDraft.version}</h2>
                          <p>{policyDraft.sourceFileName} · {policyDraft.extractedCharacters?.toLocaleString('en-IN')} extracted characters</p>
                        </div>
                        <StatusPill value={policyDraft.status} />
                      </div>

                      <p className="policy-summary-text">{policyDraft.changeSummary}</p>

                      <div className="policy-change-grid">
                        <div><span>Emergency limit</span><strong>{money(policyDraft.changes.emergencyLimitINR)}</strong></div>
                        <div><span>Spot limit</span><strong>{money(policyDraft.changes.spotLimitINR)}</strong></div>
                        <div><span>RFQ upper limit</span><strong>{money(policyDraft.changes.rfqLimitINR)}</strong></div>
                        <div><span>Capex suppliers</span><strong>{policyDraft.changes.capexSupplierCount}</strong></div>
                        <div><span>RFQ suppliers</span><strong>{policyDraft.changes.rfqSupplierCount}</strong></div>
                        <div><span>RFP suppliers</span><strong>{policyDraft.changes.rfpSupplierCount}</strong></div>
                      </div>

                      <div className="policy-form-note">
                        {policyDraft.rulesCopied} existing policy rules were copied into this draft. Approval activates this version and retires the current active version. It does not automatically reprocess existing batches.
                      </div>

                      <label className="policy-field policy-approver">
                        <span>Approver name</span>
                        <input value={policyApprover} onChange={(event) => setPolicyApprover(event.target.value)} placeholder="Enter authorised approver name" />
                      </label>

                      <div className="policy-form-actions">
                        <button className="button-primary" type="button" onClick={handlePolicyApproval} disabled={policyApproving || !policyApprover.trim()}>
                          <ShieldCheck size={15} />
                          {policyApproving ? 'Approving…' : 'Approve and activate policy'}
                        </button>
                      </div>
                    </section>
                  )}

                  <section className="panel">
                    <div className="panel-heading">
                      <div><h2>Policy version history</h2><p>Stored policy versions and their approval status</p></div>
                      <button className="button-secondary" type="button" onClick={loadPolicies} disabled={policyLoading}>
                        <RefreshCw size={14} /> {policyLoading ? 'Loading…' : 'Refresh versions'}
                      </button>
                    </div>

                    {policies.length ? (
                      <div className="policy-version-list">
                        {policies.map((policy) => (
                          <article className="policy-version-row" key={policy.id}>
                            <div className="policy-version-icon"><FileText size={18} /></div>
                            <div className="policy-version-copy">
                              <strong>{policy.documentCode} · v{policy.version}</strong>
                              <span>{policy.sourceFileName || 'Policy record'} · Effective {date(policy.effectiveFrom)}</span>
                              {policy.changeSummary && <p>{policy.changeSummary}</p>}
                              <small>{policy._count?.rules ?? 0} rules · {policy._count?.decisions ?? 0} linked decisions</small>
                            </div>
                            <StatusPill value={policy.status} />
                          </article>
                        ))}
                      </div>
                    ) : (
                      <EmptyState message={policyLoading ? 'Loading policy versions…' : 'No policy versions found.'} />
                    )}
                  </section>
                </div>
              )}

              <footer className="page-footer">
                <span>Corvo Procurement Intelligence</span>
                <span><span className="live-dot" /> Live data · Active policy {summary?.activePolicy?.version || '—'}</span>
              </footer>
            </>
          )}
        </div>
      </main>
    </div>
  )
}

export default App
