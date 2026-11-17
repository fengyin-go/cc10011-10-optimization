/**
 * 调度波次重排服务层。
 *
 * 沿现有调用链取数：视图 -> local-service / wave-service -> local-store(localStorage)。
 * 业务判断只出现在这一层与 wave-engine，页面组件不做判断，与项目约定一致。
 *
 * 关键保证：
 * - 只读取「待执行」作业作为等待作业，「运行中」作业只登记保护、不进新队列、不改波次编号；
 * - 重排结果整体保存到独立存储键，一次一份、全量覆盖等待作业；
 * - 任务编排待处理清单按结果批量联动更新，运行中作业行保持原样。
 */
import { listRows, readKey, saveRows, writeKey } from '@/data/local-store'
import type { EntryRow } from '@/data/types'
import {
  buildQueueLinkUpdates,
  recoverRearrangement,
  rearrangeWaves,
  toPositiveInt,
} from './wave-engine'
import {
  TIE_KEEP_ORIGINAL,
} from './wave-types'
import type {
  RearrangeRequest,
  RunningJobInput,
  TiePolicy,
  WaitingJobInput,
  WaveRearrangeResult,
} from './wave-types'

const SPIDER_KEY = 'spider'
const SCHEDULE_KEY = 'schedule'
const RESULT_STORAGE_KEY = 'scraper-strategy-studio:wave-rearrangements'

const WAITING_STATUS = '待执行'
const RUNNING_STATUS = '运行中'

// 老数据缺字段时的确定性兜底，保证同输入同输出、不抖动
const FALLBACK_ENTERED_AT = '2026-01-01T00:00:00.000Z'

export const SPIDER_QUEUE_FIELDS = ['作业编号', '优先级', '进入时间', '入队序号', '排队序号', '波次编号', '重排口径'] as const

function numberOrNull(value: unknown): number | null {
  if (value === '' || value === undefined || value === null) {
    return null
  }
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

function textOr(value: unknown, fallback: string): string {
  const text = String(value ?? '').trim()
  return text === '' ? fallback : text
}

/** 取数入口：从任务编排（spider）行构造等待作业与受保护的运行中作业视图。 */
export function loadDispatchJobs(): {
  waiting: WaitingJobInput[]
  running: RunningJobInput[]
  waitingRows: EntryRow[]
  runningRows: EntryRow[]
} {
  const rows = listRows(SPIDER_KEY)
  const waitingRows = rows.filter((row) => String(row.status) === WAITING_STATUS)
  const runningRows = rows.filter((row) => String(row.status) === RUNNING_STATUS)

  const waiting: WaitingJobInput[] = waitingRows.map((row, index) => {
    // 入队序号不可变：首次出现时按存储顺序登记，重排只改「排队序号」不改它
    const enqueueSerial = numberOrNull(row['入队序号']) ?? index + 1
    return {
      id: Number(row.id),
      jobNo: textOr(row['作业编号'], `SPID-${row.id}`),
      priority: numberOrNull(row['优先级']) ?? 0,
      enteredAt: textOr(row['进入时间'], FALLBACK_ENTERED_AT),
      // 先核对同优先级沿用原排队顺序：以稳定的存储数组顺序为基准
      originalOrder: index + 1,
      previousWaveNo: numberOrNull(row['波次编号']),
      enqueueSerial,
    }
  })

  const running: RunningJobInput[] = runningRows.map((row) => ({
    id: Number(row.id),
    jobNo: textOr(row['作业编号'], `SPID-${row.id}`),
    waveNo: numberOrNull(row['波次编号']),
  }))

  return { waiting, running, waitingRows, runningRows }
}

function loadRule(ruleId: number) {
  const rows = listRows(SCHEDULE_KEY)
  const rule = rows.find((row) => Number(row.id) === ruleId)
  if (!rule) {
    throw new Error(`没有找到编号为 ${ruleId} 的调度规则`)
  }
  return rule
}

export type RearrangeCommand = {
  /** 调度规则行 id，规则编号用于识别调度编排记录 */
  ruleId: number
  /** 覆盖最大并发（规则修改后批量重排时传新值） */
  maxConcurrency?: number
  /** 覆盖优先级（批量调级时传新值） */
  priority?: number
  tiePolicy?: TiePolicy
  /** 新配置生效时间，缺省取规则行的生效时段 */
  effectiveAt?: string
  /** 多选整组重排：为空表示一次覆盖全部等待作业 */
  selectedJobIds?: number[]
  /** 演示/测试：登记到该序号后中断 */
  interruptAfterPosition?: number
  occurredAt?: string
}

function buildRequest(command: RearrangeCommand): RearrangeRequest {
  const ruleRow = loadRule(command.ruleId)
  const request: RearrangeRequest = {
    rule: {
      ruleNo: textOr(ruleRow['规则编号'], `SCHE-${ruleRow.id}`),
      ruleName: textOr(ruleRow['关联站点'], ''),
      maxConcurrency: toPositiveInt(command.maxConcurrency ?? numberOrNull(ruleRow['最大并发']), 2),
      priority: toPositiveInt(command.priority ?? numberOrNull(ruleRow['优先级']), 0),
      effectiveAt: textOr(command.effectiveAt ?? ruleRow['生效时段'], FALLBACK_ENTERED_AT),
    },
    tiePolicy: command.tiePolicy ?? TIE_KEEP_ORIGINAL,
    selectedJobIds: command.selectedJobIds,
    occurredAt: command.occurredAt,
  }
  return request
}
function readResults(): WaveRearrangeResult[] {
  return readKey<WaveRearrangeResult[]>(RESULT_STORAGE_KEY, [])
}

function writeResults(results: WaveRearrangeResult[]): void {
  // 新记录在前，操作当日回看时最新的在最上面
  writeKey(RESULT_STORAGE_KEY, results)
}

/** 重排结果 -> 任务编排待处理清单联动更新；运行中作业行保持原波次编号不动。 */
function applyQueueLinkUpdate(result: WaveRearrangeResult): EntryRow[] {
  const updates = buildQueueLinkUpdates(result)
  const updateById = new Map(updates.map((item) => [item.jobId, item]))
  const rows = listRows(SPIDER_KEY)
  const next = rows.map((row) => {
    const update = updateById.get(Number(row.id))
    if (!update) {
      return row
    }
    if (String(row.status) !== WAITING_STATUS) {
      // 保护：运行中（及其他态）作业不进入新队列，原样返回
      return row
    }
    return {
      ...row,
      优先级: update.priority,
      // 入队序号首次登记后不再变化，作为「同优先级沿用原排队顺序」的回看基准
      入队序号: numberOrNull(row['入队序号']) ?? update.queuePosition,
      排队序号: update.queuePosition,
      波次编号: update.waveNo,
      重排口径: result.tiePolicyLabel,
    }
  })
  saveRows(SPIDER_KEY, next)
  return next
}

/**
 * 调度波次重排：读取等待作业、运行中作业和新优先级，
 * 按优先级重排待执行采集波次并保存结果数据。
 */
export function executeWaveRearrangement(command: RearrangeCommand): WaveRearrangeResult {
  const request = buildRequest(command)
  const { waiting, running } = loadDispatchJobs()

  // 批量调级：新优先级只落到本次提交的作业上；重排结果仍一次覆盖全部等待作业
  const scopedIds = command.selectedJobIds ?? []
  const effectiveWaiting: WaitingJobInput[] = waiting.map((job) =>
    scopedIds.includes(job.id) ? { ...job, priority: request.rule.priority } : job,
  )

  const result = rearrangeWaves(effectiveWaiting, running, request, {
    interruptAfterPosition: command.interruptAfterPosition,
  })

  const results = readResults()
  writeResults([result, ...results])

  // 中断态只登记已完成片段，不联动清单；恢复完成后再整体更新
  if (result.status === 'COMPLETE') {
    applyQueueLinkUpdate(result)
  }
  return result
}

/** 中断恢复：从完整位置继续，先记录同优先级沿用原排队顺序的核对结果。 */
export function resumeWaveRearrangement(resultId: string): WaveRearrangeResult {
  const results = readResults()
  const interrupted = results.find((item) => item.id === resultId)
  if (!interrupted) {
    throw new Error(`没有找到重排记录 ${resultId}`)
  }
  const request = buildRequest({
    ruleId: ruleIdOf(interrupted.ruleNo),
    maxConcurrency: interrupted.ruleSnapshot.maxConcurrency,
    priority: interrupted.ruleSnapshot.priority,
    tiePolicy: interrupted.tiePolicy,
    effectiveAt: interrupted.ruleSnapshot.effectiveAt,
    // 恢复时保留整组重排范围，回执仍逐条返回原提交作业
    selectedJobIds: interrupted.scopedJobIds.length > 0 ? interrupted.scopedJobIds : undefined,
    occurredAt: new Date().toISOString(),
  })

  // 中断态没有联动清单，作业行仍保留中断前的优先级；按当时范围重建引擎输入
  const { waiting, running } = loadDispatchJobs()
  const scopedSet = new Set(interrupted.scopedJobIds)
  const effectiveWaiting: WaitingJobInput[] = waiting.map((job) => {
    // 全量重排（无多选）：所有作业采用快照优先级；多选：仅选中作业采用
    const inScope = interrupted.scopedJobIds.length === 0 || scopedSet.has(job.id)
    return inScope ? { ...job, priority: interrupted.ruleSnapshot.priority } : job
  })
  const resumed = recoverRearrangement(effectiveWaiting, running, request, interrupted)

  writeResults(results.map((item) => (item.id === resultId ? resumed : item)))
  applyQueueLinkUpdate(resumed)
  return resumed
}

function ruleIdOf(ruleNo: string): number {
  const rows = listRows(SCHEDULE_KEY)
  const hit = rows.find((row) => textOr(row['规则编号'], '') === ruleNo)
  if (!hit) {
    throw new Error(`规则编号 ${ruleNo} 在调度规则中已不存在，无法核对数据范围`)
  }
  return Number(hit.id)
}

/** 重排记录回看：可按操作日期过滤，默认返回全部（新的在前）。 */
export function listRearrangements(operationDate?: string): WaveRearrangeResult[] {
  const results = readResults()
  if (!operationDate) {
    return results
  }
  return results.filter((item) => item.operationDate === operationDate)
}

export function getRearrangement(resultId: string): WaveRearrangeResult | undefined {
  return readResults().find((item) => item.id === resultId)
}

/** 调度规则当前数据范围核对：规则编号 + 调度规则字段快照。 */
export function describeRuleScope(ruleId: number): {
  ruleId: number
  ruleNo: string
  maxConcurrency: number | null
  priority: number | null
  effectiveAt: string
} {
  const ruleRow = loadRule(ruleId)
  return {
    ruleId,
    ruleNo: textOr(ruleRow['规则编号'], `SCHE-${ruleRow.id}`),
    maxConcurrency: numberOrNull(ruleRow['最大并发']),
    priority: numberOrNull(ruleRow['优先级']),
    effectiveAt: textOr(ruleRow['生效时段'], FALLBACK_ENTERED_AT),
  }
}
