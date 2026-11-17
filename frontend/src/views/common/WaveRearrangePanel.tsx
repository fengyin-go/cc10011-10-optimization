import { useEffect, useMemo, useState } from 'react'

import { listEntries } from '@/api/local-service'
import {
  SPIDER_QUEUE_FIELDS,
  describeRuleScope,
  executeWaveRearrangement,
  listRearrangements,
  loadDispatchJobs,
  resumeWaveRearrangement,
} from '@/api/wave-service'
import { TIE_BY_EFFECTIVE_TIME, TIE_KEEP_ORIGINAL, TIE_POLICY_LABEL } from '@/api/wave-types'
import type { EntryRow } from '@/data/types'
import type { RearrangeCommand } from '@/api/wave-service'
import type { TiePolicy, WaveRearrangeResult } from '@/api/wave-types'

type PanelProps = {
  /** 任务编排页多选等待作业后整组重排时传入；为空表示一次覆盖全部等待作业 */
  selectedJobIds?: number[]
  /** 选择变化时通知父组件清空高亮等 */
  onSelectedChange?: (ids: number[]) => void
  /** 重排完成后通知父组件刷新作业表 */
  onAfterRearrange?: () => void
}

type WaitingRow = EntryRow & { id: number }

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * 调度波次重排面板：
 * 读取等待作业、运行中作业与新的优先级，按优先级重排待执行采集波次，
 * 生成并保存调度波次重排结果数据，运行中作业受保护不进新队列。
 */
export default function WaveRearrangePanel({ selectedJobIds, onSelectedChange, onAfterRearrange }: PanelProps) {
  const [rules, setRules] = useState<EntryRow[]>([])
  const [ruleId, setRuleId] = useState<number>(0)
  const [maxConcurrency, setMaxConcurrency] = useState('2')
  const [priority, setPriority] = useState('3')
  const [effectiveAt, setEffectiveAt] = useState(today())
  const [tiePolicy, setTiePolicy] = useState<TiePolicy>(TIE_KEEP_ORIGINAL)
  const [interruptAfterPosition, setInterruptAfterPosition] = useState('')
  const [waitingRows, setWaitingRows] = useState<WaitingRow[]>([])
  const [runningCount, setRunningCount] = useState(0)
  const [results, setResults] = useState<WaveRearrangeResult[]>([])
  const [lastResult, setLastResult] = useState<WaveRearrangeResult | null>(null)
  const [errorMessage, setErrorMessage] = useState('')
  const [notice, setNotice] = useState('')

  const selectedSet = useMemo(() => new Set(selectedJobIds ?? []), [selectedJobIds])

  const refreshJobs = () => {
    const { waiting, running } = loadDispatchJobs()
    setWaitingRows(
      waiting
        .slice()
        .sort((a, b) => a.enqueueSerial - b.enqueueSerial)
        .map((job) => ({
          id: job.id,
          status: '待执行',
          pending: true,
          abnormal: false,
          作业编号: job.jobNo,
          优先级: job.priority,
          进入时间: job.enteredAt,
          入队序号: job.enqueueSerial,
          排队序号: job.originalOrder,
          波次编号: job.previousWaveNo ?? '—',
          重排口径: '',
        })),
    )
    setRunningCount(running.length)
  }

  const refreshResults = () => {
    setResults(listRearrangements())
  }

  useEffect(() => {
    const scheduleRows = listEntries('schedule').items
    const enabled = scheduleRows.filter((row) => String(row.status) === '已启用')
    const candidate = enabled.length > 0 ? enabled : scheduleRows
    setRules(candidate)
    if (candidate.length > 0) {
      const first = candidate[0]
      setRuleId(Number(first.id))
      const scope = describeRuleScope(Number(first.id))
      setMaxConcurrency(String(scope.maxConcurrency ?? 2))
      setPriority(String(scope.priority ?? 3))
      setEffectiveAt(scope.effectiveAt.slice(0, 10) || today())
    }
    refreshJobs()
    refreshResults()
    // 仅在挂载时按现有取数入口初始化
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function switchRule(id: number) {
    setRuleId(id)
    const scope = describeRuleScope(id)
    setMaxConcurrency(String(scope.maxConcurrency ?? 2))
    setPriority(String(scope.priority ?? 3))
    setEffectiveAt(scope.effectiveAt.slice(0, 10) || today())
  }

  function toggleSelect(id: number) {
    const next = new Set(selectedSet)
    if (next.has(id)) {
      next.delete(id)
    } else {
      next.add(id)
    }
    onSelectedChange?.([...next])
  }

  function buildCommand(interrupt?: number): RearrangeCommand {
    return {
      ruleId,
      maxConcurrency: Number(maxConcurrency),
      priority: Number(priority),
      effectiveAt: new Date(`${effectiveAt}T00:00:00.000Z`).toISOString(),
      tiePolicy,
      selectedJobIds: selectedSet.size > 0 ? [...selectedSet] : undefined,
      interruptAfterPosition: interrupt,
    }
  }

  function handleRearrange(interrupt = false) {
    setErrorMessage('')
    setNotice('')
    try {
      if (!ruleId) {
        throw new Error('请先选择调度规则（规则编号用于识别调度编排记录）')
      }
      const interruptAt = interrupt
        ? Number(interruptAfterPosition) > 0
          ? Number(interruptAfterPosition)
          : Math.max(1, Math.floor(waitingRows.length / 2))
        : undefined
      const result = executeWaveRearrangement(buildCommand(interruptAt))
      setLastResult(result)
      refreshResults()
      refreshJobs()
      onAfterRearrange?.()
      if (result.status === 'INTERRUPTED') {
        setNotice(`已模拟中断：登记到排队序号 ${result.resumedFromPosition}，可在下方记录里恢复，从完整位置继续`)
      } else {
        setNotice(
          `重排完成：覆盖等待作业 ${result.coveredWaitingCount} 条，保护运行中作业 ${result.protectedRunningCount} 条，` +
            `共 ${result.waves.length} 个波次，口径：${result.tiePolicyLabel}`,
        )
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '调度波次重排失败')
    }
  }

  function handleResume(id: string) {
    setErrorMessage('')
    setNotice('')
    try {
      const resumed = resumeWaveRearrangement(id)
      setLastResult(resumed)
      refreshResults()
      refreshJobs()
      onAfterRearrange?.()
      setNotice(`已从完整位置（序号 ${resumed.resumedFromPosition}）恢复，重排结果与一次跑完一致`)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '中断恢复失败')
    }
  }

  const scopeLabel = selectedSet.size > 0 ? `整组重排已选 ${selectedSet.size} 条` : '覆盖全部等待作业'

  return (
    <section className="wave-panel">
      <header className="wave-panel-head">
        <h3>调度波次重排</h3>
        <p className="page-desc">
          读取等待中作业、运行中作业与新优先级，按优先级重排待执行采集波次；运行中作业不进入新队列、保留原波次编号。
        </p>
      </header>

      <div className="wave-grid">
        <form
          className="wave-form"
          onSubmit={(event) => {
            event.preventDefault()
            handleRearrange(false)
          }}
        >
          <label className="filter-item">
            <span>调度规则（规则编号识别记录）</span>
            <select value={ruleId} onChange={(event) => switchRule(Number(event.target.value))}>
              {rules.map((row) => (
                <option key={row.id} value={Number(row.id)}>
                  {String(row['规则编号'])}｜{String(row['关联站点'])}｜{String(row.status)}
                </option>
              ))}
            </select>
          </label>
          <label className="filter-item">
            <span>新最大并发（每波容量）</span>
            <input
              type="number"
              min={1}
              value={maxConcurrency}
              onChange={(event) => setMaxConcurrency(event.target.value)}
            />
          </label>
          <label className="filter-item">
            <span>新优先级（数值越大越靠前）</span>
            <input
              type="number"
              value={priority}
              onChange={(event) => setPriority(event.target.value)}
            />
          </label>
          <label className="filter-item">
            <span>新配置生效时间</span>
            <input
              type="date"
              value={effectiveAt}
              onChange={(event) => setEffectiveAt(event.target.value)}
            />
          </label>
          <label className="filter-item">
            <span>同优先级次序口径（复核依据）</span>
            <select value={tiePolicy} onChange={(event) => setTiePolicy(event.target.value as TiePolicy)}>
              <option value={TIE_KEEP_ORIGINAL}>{TIE_POLICY_LABEL[TIE_KEEP_ORIGINAL]}</option>
              <option value={TIE_BY_EFFECTIVE_TIME}>{TIE_POLICY_LABEL[TIE_BY_EFFECTIVE_TIME]}</option>
            </select>
          </label>
          <label className="filter-item">
            <span>模拟中断：登记到该序号后停止（可空）</span>
            <input
              type="number"
              min={1}
              placeholder="不填为一次跑完"
              value={interruptAfterPosition}
              onChange={(event) => setInterruptAfterPosition(event.target.value)}
            />
          </label>
          <div className="wave-form-actions">
            <button className="btn primary" type="submit">
              提交重排（{scopeLabel}）
            </button>
            <button className="btn" type="button" onClick={() => handleRearrange(true)}>
              模拟中断后保存
            </button>
            {selectedSet.size > 0 && (
              <button
                className="btn ghost"
                type="button"
                onClick={() => onSelectedChange?.([])}
              >
                清空多选
              </button>
            )}
          </div>
          {notice && <p className="wave-notice">{notice}</p>}
          {errorMessage && <p className="error-text">{errorMessage}</p>}
        </form>

        <div className="wave-queue">
          <h4>等待中作业（重排范围，共 {waitingRows.length} 条）</h4>
          <table className="data-table">
            <thead>
              <tr>
                <th>选择</th>
                {SPIDER_QUEUE_FIELDS.map((field) => (
                  <th key={field}>{field}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {waitingRows.map((row) => (
                <tr
                  key={row.id}
                  className={selectedSet.has(row.id) ? 'row-selected' : undefined}
                  onClick={() => toggleSelect(row.id)}
                >
                  <td>
                    <input
                      type="checkbox"
                      checked={selectedSet.has(row.id)}
                      onChange={() => toggleSelect(row.id)}
                      onClick={(event) => event.stopPropagation()}
                    />
                  </td>
                  {SPIDER_QUEUE_FIELDS.map((field) => {
                    const value = row[field]
                    if (field === '进入时间') {
                      return <td key={field}>{String(value).replace('T', ' ').replace('.000Z', ' UTC')}</td>
                    }
                    if (field === '波次编号' || field === '重排口径') {
                      return <td key={field}>{value === null || value === undefined || value === '' ? '—' : String(value)}</td>
                    }
                    return <td key={field}>{String(value)}</td>
                  })}
                </tr>
              ))}
              {waitingRows.length === 0 && (
                <tr>
                  <td className="empty-state" colSpan={SPIDER_QUEUE_FIELDS.length + 1}>
                    暂无等待作业
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <p className="wave-protected">运行中作业受保护：{runningCount} 条不进入新队列，保持原波次编号</p>
        </div>
      </div>

      {lastResult && <ResultDetail result={lastResult} onResume={handleResume} />}

      <div className="wave-history">
        <h4>重排结果记录（操作当日可回看，按时间倒序）</h4>
        <table className="data-table">
          <thead>
            <tr>
              <th>记录编号</th>
              <th>规则编号</th>
              <th>操作日期</th>
              <th>口径</th>
              <th>覆盖等待/保护运行</th>
              <th>波次数</th>
              <th>冲突</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {results.map((item) => (
              <tr key={item.id}>
                <td>{item.id}</td>
                <td>{item.ruleNo}</td>
                <td>{item.operationDate}</td>
                <td>{item.tiePolicyLabel}</td>
                <td>
                  {item.coveredWaitingCount} / {item.protectedRunningCount}
                </td>
                <td>{item.waves.length}</td>
                <td>{item.conflicts.length > 0 ? `${item.conflicts.length} 处交界冲突` : '无'}</td>
                <td>
                  {item.status}
                  {item.recovered ? `（从序号 ${item.resumedFromPosition} 恢复）` : ''}
                </td>
                <td className="row-actions">
                  <button className="link" type="button" onClick={() => setLastResult(item)}>
                    查看
                  </button>
                  {item.status === 'INTERRUPTED' && (
                    <button className="link" type="button" onClick={() => handleResume(item.id)}>
                      中断恢复
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {results.length === 0 && (
              <tr>
                <td className="empty-state" colSpan={9}>
                  暂无重排记录
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function ResultDetail({
  result,
  onResume,
}: {
  result: WaveRearrangeResult
  onResume: (id: string) => void
}) {
  return (
    <div className="wave-result">
      <h4>
        重排结果 {result.id}
        {result.status === 'INTERRUPTED' && (
          <button className="btn" type="button" onClick={() => onResume(result.id)}>
            从完整位置恢复
          </button>
        )}
      </h4>
      <p className="page-desc">
        规则 {result.ruleNo}｜{result.tiePolicyLabel}｜最大并发 {result.ruleSnapshot.maxConcurrency}｜
        生效 {result.ruleSnapshot.effectiveAt.slice(0, 10)}｜覆盖等待 {result.coveredWaitingCount} 条、
        保护运行 {result.protectedRunningCount} 条
      </p>

      {result.conflicts.length > 0 && (
        <div className="wave-conflict">
          <strong>业务冲突判定（两种口径交界，供复核）：</strong>
          <ul>
            {result.conflicts.map((conflict) => (
              <li key={`${conflict.earlierJob.id}-${conflict.laterJob.id}`}>
                {conflict.boundary}：{conflict.earlierJob.jobNo}（进入 {conflict.earlierJob.enteredAt}）
                与 {conflict.laterJob.jobNo}（进入 {conflict.laterJob.enteredAt}）同优先级 {conflict.priority}；
                沿用原顺序前两位 [{conflict.keepOriginalFront.join(' → ')}]，
                生效时间口径前两位 [{conflict.effectiveTimeFront.join(' → ')}]
              </li>
            ))}
          </ul>
        </div>
      )}

      {result.scopedJobIds.length > 0 && (
        <div className="wave-receipt">
          <strong>整组重排提交回执（一次提交，逐条返回新位置）：</strong>
          <ol>
            {result.receipts.map((receipt) => (
              <li key={receipt.jobId}>
                {receipt.jobNo} → 新排队序号 {receipt.queuePosition}，新波次 {receipt.waveNo}
              </li>
            ))}
          </ol>
        </div>
      )}

      <table className="data-table">
        <thead>
          <tr>
            <th>新排队序号</th>
            <th>作业编号</th>
            <th>优先级</th>
            <th>原排队序号</th>
            <th>新波次</th>
            <th>原波次</th>
            <th>沿用原顺序口径位置</th>
            <th>生效时间口径位置</th>
            <th>冲突标记</th>
          </tr>
        </thead>
        <tbody>
          {result.positions.map((position) => (
            <tr key={position.id} className={position.boundaryConflict ? 'row-conflict' : undefined}>
              <td>{position.queuePosition}</td>
              <td>{position.jobNo}</td>
              <td>{position.priority}</td>
              <td>{position.originalOrder}</td>
              <td>{position.waveNo}</td>
              <td>{position.previousWaveNo ?? '—'}</td>
              <td>{position.keepOriginalPosition}</td>
              <td>{position.effectiveTimePosition}</td>
              <td>{position.boundaryConflict ? '交界冲突' : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h5>波次划分（运行中作业不在此列）</h5>
      <div className="wave-chips">
        {result.waves.map((wave) => (
          <span key={wave.waveNo} className="wave-chip">
            波次 {wave.waveNo}：{wave.jobNos.join(' → ')}
          </span>
        ))}
      </div>

      <h5>受保护运行中作业（保持原波次编号）</h5>
      <ul className="wave-running">
        {result.protectedRunningJobs.map((job) => (
          <li key={job.id}>
            {job.jobNo}｜原波次 {job.waveNo ?? '—'}（不抢占、不重排）
          </li>
        ))}
        {result.protectedRunningJobs.length === 0 && <li>本次无运行中作业</li>}
      </ul>
    </div>
  )
}
