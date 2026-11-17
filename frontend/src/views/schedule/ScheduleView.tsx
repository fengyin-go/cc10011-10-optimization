import { useCallback, useEffect, useMemo, useState } from 'react'

import { downloadEntries, listEntries, moduleMeta, runAction as applyAction } from '@/api/local-service'
import { listRearrangements } from '@/api/wave-service'
import WaveRearrangePanel from '@/views/common/WaveRearrangePanel'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('schedule')
const columns = [
  "规则编号",
  "关联站点",
  "调度表达式",
  "最大并发",
  "优先级",
  "生效时段",
  "执行超时",
  "漏触发补偿"
]
const actions = [
  "提交校验",
  "启用调度",
  "停用调度"
]
const statuses = [
  "草稿",
  "待校验",
  "已启用",
  "已停用"
]

export default function ScheduleView() {
  const [rows, setRows] = useState<EntryRow[]>([])
  const [total, setTotal] = useState(0)
  const [errorMessage, setErrorMessage] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [rearrangeCount, setRearrangeCount] = useState(0)
  const filterFields = useMemo(() => columns.slice(0, 3), [])

  const reload = useCallback(() => {
    setErrorMessage('')
    try {
      const payload = listEntries(meta.key, filters)
      setRows(payload.items)
      setTotal(payload.total)
      setRearrangeCount(listRearrangements().length)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '调度编排列表读取失败')
    }
  }, [filters])

  useEffect(() => {
    reload()
  }, [reload])

  function runAction(action: string, row: EntryRow) {
    setErrorMessage('')
    const result = applyAction(meta.key, Number(row.id), action)
    if (!result.ok) {
      setErrorMessage(result.message)
      return
    }
    reload()
  }

  const stats = useMemo(
    () => [
      { label: '调度规则总数', value: rows.length },
      { label: '已启用规则', value: rows.filter((row) => String(row.status) === '已启用').length },
      { label: '待校验规则', value: rows.filter((row) => String(row.status) === '待校验').length },
      { label: '波次重排结果数', value: rearrangeCount },
    ],
    [rows, rearrangeCount],
  )

  return (
    <section className="page" data-module="schedule">
      <header className="page-head">
        <div>
          <h2>调度编排管理</h2>
          <p className="page-desc">维护调度规则的输入、执行约束与结果记录；修改最大并发或优先级后在此重排采集波次，规则编号用于识别调度编排记录并与调度规则核对。</p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" onClick={() => setErrorMessage('调度规则登记入口尚未接入审批流')}>
            登记调度规则
          </button>
          <button className="btn" type="button" onClick={() => downloadEntries(meta.key)}>
            导出调度编排清单
          </button>
        </div>
      </header>

      <div className="stat-row">
        {stats.map((item) => (
          <article key={item.label} className="stat-card">
            <span className="stat-label">{item.label}</span>
            <strong className="stat-value">{item.value}</strong>
          </article>
        ))}
      </div>

      <p className="status-legend">
        {statuses.map((status: string) => (
          <span key={status} className="legend-item">
            {status}：{rows.filter((row) => String(row.status) === status).length}
          </span>
        ))}
      </p>

      <form className="filter-bar" onSubmit={(event) => { event.preventDefault(); reload() }}>
        {filterFields.map((field) => (
          <label key={field} className="filter-item">
            <span>{field}</span>
            <input
              value={filters[field] ?? ''}
              placeholder={`按${field}检索`}
              onChange={(event) => setFilters((prev) => ({ ...prev, [field]: event.target.value }))}
            />
          </label>
        ))}
        <button className="btn" type="submit">查询</button>
        <button className="btn ghost" type="button" onClick={() => setFilters({})}>重置条件</button>
      </form>

      <table className="data-table">
        <thead>
          <tr>
            {columns.map((column) => <th key={column}>{column}</th>)}
            <th>当前状态</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={String(row.id)}>
              {columns.map((column) => <td key={column}>{row[column] ?? '—'}</td>)}
              <td>{row.status}</td>
              <td className="row-actions">
                {actions.map((action) => (
                  <button key={action} className="link" type="button" onClick={() => runAction(action, row)}>
                    {action}
                  </button>
                ))}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={columns.length + 2}>暂无调度编排数据，可先登记调度规则</td>
            </tr>
          )}
        </tbody>
      </table>

      <WaveRearrangePanel onAfterRearrange={reload} />

      <footer className="page-foot">
        <span>共 {total} 条调度编排记录</span>
        {errorMessage && <span className="error-text">{errorMessage}</span>}
      </footer>
    </section>
  )
}
