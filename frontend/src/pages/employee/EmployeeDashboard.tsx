import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { employeeSelfApi as employeeApi } from '../../services/api'
import { Wallet, CalendarDays, TrendingUp, Download, Bell, CheckCircle, AlertCircle, Clock } from 'lucide-react'
import toast from 'react-hot-toast'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts'

const LEAVE_STATUS_COLORS: any = {
  Pending: 'bg-amber-100 text-amber-700',
  Approved: 'bg-emerald-100 text-emerald-700',
  Rejected: 'bg-red-100 text-red-700',
}

export default function EmployeeDashboard() {
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [kpi, setKpi] = useState<any[]>([])

  const info = (() => {
    try { return JSON.parse(localStorage.getItem('employee_info') || '{}') } catch { return {} }
  })()

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    try {
      const [dashRes, kpiRes] = await Promise.all([
        employeeApi.dashboard(),
        employeeApi.kpi()
      ])
      setData(dashRes.data)
      // Build 6-month chart
      const months = Array.from({ length: 6 }, (_, i) => {
        const d = new Date()
        d.setMonth(d.getMonth() - (5 - i))
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
      })
      const kpiMap: Record<string, any> = {}
      kpiRes.data.forEach((k: any) => { kpiMap[k.month] = k })
      setKpi(months.map(m => ({
        month: m.slice(5),
        score: kpiMap[m]?.performance_score || 0,
        target: kpiMap[m]?.kpi_target || 80,
      })))
    } catch { toast.error('Failed to load dashboard') }
    finally { setLoading(false) }
  }

  async function downloadSlip(id: number, month: string) {
    try {
      const res = await employeeApi.downloadSlip(id)
      const url = URL.createObjectURL(new Blob([res.data], { type: 'application/pdf' }))
      const a = document.createElement('a'); a.href = url; a.download = `SalarySlip-${month}.pdf`; a.click()
      toast.success('Downloading...')
    } catch { toast.error('Download failed') }
  }

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <div className="w-8 h-8 border-4 border-emerald-500 border-t-transparent rounded-full animate-spin" />
    </div>
  )

  if (!data) return null

  const { stats, recentSalaries, recentLeaves } = data
  const lb = stats.leaveBalance || {}
  const annualRemaining = Math.max(0, (lb.annual_total || 14) - (lb.annual_used || 0))
  const sickRemaining = Math.max(0, (lb.sick_total || 7) - (lb.sick_used || 0))
  const casualRemaining = Math.max(0, (lb.casual_total || 3) - (lb.casual_used || 0))

  return (
    <div className="space-y-5 max-w-6xl mx-auto">
      {/* Welcome */}
      <div className="bg-gradient-to-r from-emerald-600 to-teal-600 rounded-2xl p-5 text-white">
        <p className="text-emerald-100 text-sm">Welcome back,</p>
        <h1 className="text-2xl font-bold mt-0.5">{info.employeeName}</h1>
        <p className="text-emerald-200 text-sm mt-0.5">{info.employeePosition}{info.department ? ` · ${info.department}` : ''}</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl p-4 border border-slate-100 shadow-sm">
          <div className="flex items-center gap-2 mb-2">
            <Wallet size={15} className="text-emerald-500" />
            <p className="text-xs text-slate-500">Total Earned</p>
          </div>
          <p className="text-xl font-bold text-slate-700">Rs. {Number(stats.totalEarned || 0).toLocaleString()}</p>
          <p className="text-xs text-slate-400 mt-0.5">lifetime</p>
        </div>
        <div className="bg-white rounded-xl p-4 border border-slate-100 shadow-sm">
          <div className="flex items-center gap-2 mb-2">
            <Wallet size={15} className="text-indigo-500" />
            <p className="text-xs text-slate-500">Last Salary</p>
          </div>
          <p className="text-xl font-bold text-slate-700">Rs. {Number(stats.lastNetSalary || 0).toLocaleString()}</p>
          <p className="text-xs text-slate-400 mt-0.5">{stats.lastPaymentMonth || '—'}</p>
        </div>
        <div className="bg-white rounded-xl p-4 border border-slate-100 shadow-sm">
          <div className="flex items-center gap-2 mb-2">
            <CalendarDays size={15} className="text-amber-500" />
            <p className="text-xs text-slate-500">Annual Leave</p>
          </div>
          <p className="text-xl font-bold text-slate-700">{annualRemaining} <span className="text-sm font-normal text-slate-400">/ {lb.annual_total || 14}</span></p>
          <p className="text-xs text-slate-400 mt-0.5">days remaining</p>
        </div>
        <div className="bg-white rounded-xl p-4 border border-slate-100 shadow-sm">
          <div className="flex items-center gap-2 mb-2">
            <TrendingUp size={15} className="text-purple-500" />
            <p className="text-xs text-slate-500">KPI This Month</p>
          </div>
          <p className="text-xl font-bold text-slate-700">
            {stats.kpiThisMonth !== null ? `${stats.kpiThisMonth}%` : '—'}
          </p>
          <p className="text-xs text-slate-400 mt-0.5">target {stats.kpiTarget}%</p>
        </div>
      </div>

      <div className="grid lg:grid-cols-3 gap-5">
        {/* KPI Chart */}
        <div className="lg:col-span-2 bg-white rounded-xl border border-slate-100 shadow-sm p-5">
          <h3 className="text-sm font-semibold text-slate-700 mb-4">KPI Performance (Last 6 Months)</h3>
          {kpi.every(k => k.score === 0) ? (
            <div className="flex items-center justify-center h-36 text-slate-300 text-sm">No KPI data yet</div>
          ) : (
            <ResponsiveContainer width="100%" height={150}>
              <BarChart data={kpi} barSize={24}>
                <XAxis dataKey="month" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                <Tooltip formatter={(v) => [`${v}%`, 'Score']} />
                <Bar dataKey="score" radius={[4, 4, 0, 0]}>
                  {kpi.map((k, i) => (
                    <Cell key={i} fill={k.score >= k.target ? '#10b981' : k.score >= 60 ? '#6366f1' : '#f59e0b'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Leave Balance */}
        <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-5">
          <h3 className="text-sm font-semibold text-slate-700 mb-4">Leave Balance</h3>
          <div className="space-y-3">
            {[
              { label: 'Annual', used: lb.annual_used || 0, total: lb.annual_total || 14, color: 'bg-emerald-500' },
              { label: 'Sick', used: lb.sick_used || 0, total: lb.sick_total || 7, color: 'bg-blue-500' },
              { label: 'Casual', used: lb.casual_used || 0, total: lb.casual_total || 3, color: 'bg-purple-500' },
            ].map(l => (
              <div key={l.label}>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-slate-600 font-medium">{l.label}</span>
                  <span className="text-slate-500">{l.total - l.used} / {l.total} left</span>
                </div>
                <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                  <div className={`h-full ${l.color} rounded-full transition-all`} style={{ width: `${Math.min(100, (l.used / l.total) * 100)}%` }} />
                </div>
              </div>
            ))}
            <Link to="/employee/leaves" className="block text-center text-xs text-emerald-600 hover:text-emerald-700 font-medium pt-1">
              Request Leave →
            </Link>
          </div>
        </div>
      </div>

      <div className="grid lg:grid-cols-2 gap-5">
        {/* Recent Salaries */}
        <div className="bg-white rounded-xl border border-slate-100 shadow-sm overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-slate-50">
            <h3 className="text-sm font-semibold text-slate-700">Recent Salary Payments</h3>
            <Link to="/employee/salaries" className="text-xs text-emerald-600 hover:text-emerald-700 font-medium">View all</Link>
          </div>
          {recentSalaries.length === 0 ? (
            <div className="py-10 text-center text-slate-400 text-sm">No salary records yet</div>
          ) : (
            <div className="divide-y divide-slate-50">
              {recentSalaries.map((s: any) => (
                <div key={s.id} className="flex items-center justify-between px-5 py-3">
                  <div>
                    <p className="text-sm font-medium text-slate-700">{s.payment_month}</p>
                    <p className="text-xs text-slate-400 mt-0.5">{s.status}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <p className="text-sm font-bold text-slate-800">Rs. {Number(s.net_salary).toLocaleString()}</p>
                    {s.status === 'Paid' && (
                      <button onClick={() => downloadSlip(s.id, s.payment_month)} className="p-1.5 text-slate-400 hover:text-emerald-600 bg-slate-50 hover:bg-emerald-50 rounded-lg transition-colors">
                        <Download size={13} />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Recent Leave Requests */}
        <div className="bg-white rounded-xl border border-slate-100 shadow-sm overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-slate-50">
            <h3 className="text-sm font-semibold text-slate-700">Leave Requests</h3>
            <Link to="/employee/leaves" className="text-xs text-emerald-600 hover:text-emerald-700 font-medium">View all</Link>
          </div>
          {recentLeaves.length === 0 ? (
            <div className="py-10 text-center text-slate-400 text-sm">No leave requests yet</div>
          ) : (
            <div className="divide-y divide-slate-50">
              {recentLeaves.map((lr: any) => (
                <div key={lr.id} className="flex items-center justify-between px-5 py-3">
                  <div>
                    <p className="text-sm font-medium text-slate-700">{lr.leave_type} Leave</p>
                    <p className="text-xs text-slate-400 mt-0.5">{lr.start_date} → {lr.end_date} ({lr.days_count}d)</p>
                  </div>
                  <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium ${LEAVE_STATUS_COLORS[lr.status]}`}>
                    {lr.status === 'Approved' && <CheckCircle size={10} />}
                    {lr.status === 'Pending' && <Clock size={10} />}
                    {lr.status === 'Rejected' && <AlertCircle size={10} />}
                    {lr.status}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
