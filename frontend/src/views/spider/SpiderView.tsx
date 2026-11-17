import { useCallback, useEffect, useMemo, useState } from 'react'

import { downloadEntries, listEntries, moduleMeta, runAction as applyAction } from '@/api/local-service'
import WaveRearrangePanel from '@/views/common/WaveRearrangePanel'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('spider')
const columns = [
  "作业编号",
  "目标站点",
  "抽取模板",
  "起始地址",
  "并发线程数",
  "请求间隔秒",
  "每日上限条数",
  "超时秒数",
  "优先级",
  "进入时间",
  "入队序号",
  "排队序号",
  "波次编号",
  "重排口径"
]
const queueColumns = ["优先级", "进入时间", "入队序号", "排队序号", "波次编号", "重排口径"]
const actions = [
  "提交执行",
  "启动采集",
  "终止采集",
  "归档结果"
]
const statuses = [
  "草稿",
  "待执行",
  "运行中",
  "已完成",
  "已失败"
]
const stats = [
  {
    "label": "采集作业总数",
    "value": 0
  },
  {
    "label": "运行中作业",
    "value": 0
  },
  {
    "label": "已完成作业",
    "value": 0
  }
]

function displayValue(row: EntryRow, column: string): string {
  const value = row[column]
  if (value === undefined || value === null || value === '') {
    return column === '重排口径' ? '—' : '—'
  }
  if (column === '进入时间') {
    return String(value).replace('T', ' ').replace('.000Z', ' UTC')
  }
  return String(value)
}

export default function SpiderView() {
  const [rows, setRows] = useState<EntryRow[]>([])
  const [total, setTotal] = useState(0)
  const [errorMessage, setErrorMessage] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [selectedIds, setSelectedIds] = useState<number[]>([])
  const filterFields = useMemo(() => ["作业编号", "目标站点", "抽取模板"], [])

  const reload = useCallback(() => {
    setErrorMessage('')
    try {
      const payload = listEntries(meta.key, filters)
      // 等待队列按排队序号联动展示；运行中作业保持自身波次编号、不参与排序
      const sorted = payload.items.slice().sort((a, b) => {
        const aWaiting = String(a.status) === '待执行'
        const bWaiting = String(b.status) === '待执行'
        if (aWaiting !== bWaiting) {
          return aWaiting ? -1 : 1
        }
        if (aWaiting && bWaiting) {
          const aPos = Number(a['排队序号'])
          const bPos = Number(b['排队序号'])
          if (Number.isFinite(aPos) && Number.isFinite(bPos) && aPos !== bPos) {
            return aPos - bPos
          }
        }
        return Number(a.id) - Number(b.id)
      })
      setRows(sorted)
      setTotal(payload.total)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '任务编排列表读取失败')
    }
  }, [filters])

  useEffect(() => {
    reload()
  }, [reload])

  // 重排后部分作业可能已离开等待队列，清掉失效选择
  useEffect(() => {
    const waitingIds = new Set(
      rows.filter((row) => String(row.status) === '待执行').map((row) => Number(row.id)),
    )
    setSelectedIds((prev) => prev.filter((id) => waitingIds.has(id)))
  }, [rows])

  function runAction(action: string, row: EntryRow) {
    setErrorMessage('')
    const result = applyAction(meta.key, Number(row.id), action)
    if (!result.ok) {
      setErrorMessage(result.message)
      return
    }
    reload()
  }

  function toggleSelect(id: number) {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]))
  }

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds])

  return (
    <section className="page" data-module="spider">
      <header className="page-head">
        <div>
          <h2>任务编排管理</h2>
          <p className="page-desc">维护采集作业的输入、执行约束与结果记录；等待队列按调度波次重排结果联动更新，已启动采集保持原波次编号。</p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" onClick={() => setErrorMessage('采集作业登记入口尚未接入审批流')}>
            登记采集作业
          </button>
          <button className="btn" type="button" onClick={() => downloadEntries(meta.key)}>
            导出任务编排清单
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
            <th>多选</th>
            {columns.map((column) => <th key={column}>{column}</th>)}
            <th>当前状态</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const isWaiting = String(row.status) === '待执行'
            const isRunning = String(row.status) === '运行中'
            return (
              <tr
                key={String(row.id)}
                className={[
                  selectedSet.has(Number(row.id)) ? 'row-selected' : '',
                  isRunning ? 'row-running' : '',
                ].join(' ').trim() || undefined}
              >
                <td>
                  {isWaiting ? (
                    <input
                      type="checkbox"
                      aria-label={`选择 ${String(row['作业编号'])}`}
                      checked={selectedSet.has(Number(row.id))}
                      onChange={() => toggleSelect(Number(row.id))}
                    />
                  ) : (
                    <span title="仅等待作业可整组重排">—</span>
                  )}
                </td>
                {columns.map((column) => (
                  <td key={column} className={queueColumns.includes(column) ? 'cell-queue' : undefined}>
                    {displayValue(row, column)}
                  </td>
                ))}
                <td>{row.status}</td>
                <td className="row-actions">
                  {actions.map((action) => (
                    <button key={action} className="link" type="button" onClick={() => runAction(action, row)}>
                      {action}
                    </button>
                  ))}
                </td>
              </tr>
            )
          })}
          {rows.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={columns.length + 3}>暂无任务编排数据，可先登记采集作业</td>
            </tr>
          )}
        </tbody>
      </table>

      <p className="wave-selection-hint">
        已选等待作业 {selectedIds.length} 条（可多选后在下方整组重排，一次提交逐条返回新位置）；
        运行中作业不可选，重排时不抢占、保持原波次编号。
      </p>

      <WaveRearrangePanel
        selectedJobIds={selectedIds}
        onSelectedChange={setSelectedIds}
        onAfterRearrange={reload}
      />

      <footer className="page-foot">
        <span>共 {total} 条任务编排记录</span>
        {errorMessage && <span className="error-text">{errorMessage}</span>}
      </footer>
    </section>
  )
}
