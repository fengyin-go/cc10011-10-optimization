/**
 * 调度波次重排纯计算引擎。
 *
 * 不触碰 localStorage / DOM，输入确定则输出确定：
 * 1. 同优先级沿用原排队顺序 => priority 降序 + originalOrder 升序（稳定）；
 * 2. 同优先级按新配置生效时间重排 => priority 降序 + enteredAt 升序，
 *    进入时间仍相同再回退 originalOrder，保证连续保存两次不会来回抖动；
 * 3. 波次按规则最大并发切分，排队序号在全部等待作业内连续编号；
 * 4. 运行中作业只登记保护，不进入新队列。
 */
import {
  TIE_BY_EFFECTIVE_TIME,
  TIE_KEEP_ORIGINAL,
} from './wave-types'
import type {
  BoundaryConflict,
  QueueLinkUpdate,
  RearrangedPosition,
  RearrangeRequest,
  RearrangeRuleSnapshot,
  RunningJobInput,
  WaitingJobInput,
  WaveRearrangeResult,
} from './wave-types'

export function toPositiveInt(value: unknown, fallback = 1): number {
  const num = Number(value)
  if (!Number.isFinite(num) || num <= 0) {
    return fallback
  }
  return Math.trunc(num)
}

function compareKeepOriginal(a: WaitingJobInput, b: WaitingJobInput): number {
  if (b.priority !== a.priority) {
    return b.priority - a.priority
  }
  // 同优先级沿用原排队顺序：原序号小的在前
  return a.originalOrder - b.originalOrder
}

function compareByEffectiveTime(a: WaitingJobInput, b: WaitingJobInput): number {
  if (b.priority !== a.priority) {
    return b.priority - a.priority
  }
  const timeA = Date.parse(a.enteredAt)
  const timeB = Date.parse(b.enteredAt)
  if (Number.isFinite(timeA) && Number.isFinite(timeB) && timeA !== timeB) {
    // 同优先级按新配置生效时间重排：进入时间更早（生效更早）的在前
    return timeA - timeB
  }
  // 进入时间相同（或不可解析）时回退原排队顺序，保证稳定、可重复
  return a.originalOrder - b.originalOrder
}

/** 计算某种口径下的完整排队顺序，返回按排队序号升序的作业列表。 */
export function computeQueueOrder(
  jobs: WaitingJobInput[],
  tiePolicy: RearrangeRequest['tiePolicy'],
): WaitingJobInput[] {
  const comparator = tiePolicy === TIE_BY_EFFECTIVE_TIME ? compareByEffectiveTime : compareKeepOriginal
  // Array.prototype.sort 在 ES2019+ 为稳定排序，比较器再带 originalOrder 兜底，双保险
  return [...jobs].sort(comparator)
}

/** 按最大并发把排队序号映射成采集波次编号（1 起，连续）。 */
export function waveNumberOf(queuePosition: number, maxConcurrency: number): number {
  const capacity = toPositiveInt(maxConcurrency)
  return Math.floor((queuePosition - 1) / capacity) + 1
}

type OrderedIndex = {
  job: WaitingJobInput
  keepOriginalPosition: number
  effectiveTimePosition: number
}

/** 同时计算两种口径的位置，用于冲突边界判定与复核留痕。 */
function buildOrderedIndex(jobs: WaitingJobInput[]): Map<number, OrderedIndex> {
  const keepOrder = computeQueueOrder(jobs, TIE_KEEP_ORIGINAL)
  const effectiveOrder = computeQueueOrder(jobs, TIE_BY_EFFECTIVE_TIME)
  const index = new Map<number, OrderedIndex>()
  keepOrder.forEach((job, i) => {
    index.set(job.id, {
      job,
      keepOriginalPosition: i + 1,
      effectiveTimePosition: effectiveOrder.findIndex((item) => item.id === job.id) + 1,
    })
  })
  return index
}

/**
 * 冲突判定：批量调级后出现相同优先级、进入时间不同的作业，
 * 两种口径交界会改变排队结果。前两位发生变化的冲突单独登记边界说明。
 */
export function detectConflicts(jobs: WaitingJobInput[]): BoundaryConflict[] {
  if (jobs.length < 2) {
    return []
  }
  const keepOrder = computeQueueOrder(jobs, TIE_KEEP_ORIGINAL)
  const effectiveOrder = computeQueueOrder(jobs, TIE_BY_EFFECTIVE_TIME)

  const keepFront = keepOrder.slice(0, 2).map((job) => job.jobNo)
  const effectiveFront = effectiveOrder.slice(0, 2).map((job) => job.jobNo)
  const frontChanged =
    keepFront.length === effectiveFront.length && keepFront.some((no, i) => no !== effectiveFront[i])

  const conflicts: BoundaryConflict[] = []
  // 在生效时间口径上扫描相邻作业：同优先级且两种口径顺序不一致，即交界冲突
  for (let i = 0; i < effectiveOrder.length - 1; i += 1) {
    const earlier = effectiveOrder[i]
    const later = effectiveOrder[i + 1]
    if (earlier.priority !== later.priority) {
      continue
    }
    if (earlier.enteredAt === later.enteredAt) {
      continue
    }
    const earlierKeepPos = keepOrder.findIndex((item) => item.id === earlier.id)
    const laterKeepPos = keepOrder.findIndex((item) => item.id === later.id)
    if (earlierKeepPos < laterKeepPos) {
      continue // 两种口径顺序一致，不构成冲突
    }
    conflicts.push({
      earlierJob: { id: earlier.id, jobNo: earlier.jobNo, enteredAt: earlier.enteredAt },
      laterJob: { id: later.id, jobNo: later.jobNo, enteredAt: later.enteredAt },
      priority: earlier.priority,
      keepOriginalFront: keepFront,
      effectiveTimeFront: effectiveFront,
      boundary: frontChanged
        ? `同优先级 ${earlier.priority} 下两作业进入时间不同，两种口径交界使等待队列前两位发生变化`
        : `同优先级 ${earlier.priority} 下两作业进入时间不同，两种口径交界改变队中顺序（前两位未变）`,
    })
  }
  return conflicts
}

function operationDateOf(iso: string): string {
  return iso.slice(0, 10)
}

function makeResultId(ruleNo: string, occurredAt: string): string {
  const stamp = occurredAt.replace(/[-:T.Z]/g, '').slice(0, 14)
  // 同秒连续保存也不能撞键，保证两条记录都可回看
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase()
  return `WAVE-${ruleNo}-${stamp}-${suffix}`
}

export type RearrangeOptions = {
  /** 模拟中断：登记到该排队序号后停止，结果标 INTERRUPTED（恢复流程演示/测试用） */
  interruptAfterPosition?: number
  /** 恢复时传入，表示从哪条完整记录继续 */
  recoveredFromId?: string
  /** 结果 id 注入，默认按规则编号+时间生成 */
  resultId?: string
}

/**
 * 调度波次重排主入口：读取等待作业、运行作业与新优先级，
 * 生成一次覆盖全部等待作业的重排结果。
 */
export function rearrangeWaves(
  waitingJobs: WaitingJobInput[],
  runningJobs: RunningJobInput[],
  request: RearrangeRequest,
  options: RearrangeOptions = {},
): WaveRearrangeResult {
  const rule: RearrangeRuleSnapshot = {
    ...request.rule,
    maxConcurrency: toPositiveInt(request.rule.maxConcurrency),
    priority: toPositiveInt(request.rule.priority, 0),
  }
  const occurredAt = request.occurredAt ?? new Date().toISOString()
  const tiePolicy = request.tiePolicy

  // 重排结果一次覆盖全部等待作业；多选只决定哪些作业吃到新优先级，不缩小覆盖范围
  const scope = [...waitingJobs]
  const scopedJobIds = request.selectedJobIds?.length ? [...request.selectedJobIds] : []
  if (scopedJobIds.length > 0) {
    const known = new Set(waitingJobs.map((job) => job.id))
    const unknown = scopedJobIds.filter((id) => !known.has(id))
    if (unknown.length > 0) {
      throw new Error(`等待作业不存在或已不在等待队列：${unknown.join(', ')}`)
    }
  }

  const orderedIndex = buildOrderedIndex(scope)
  const ordered = computeQueueOrder(scope, tiePolicy)
  const conflicts = detectConflicts(scope)
  // 只标记真正构成交界（相邻逆序）的作业对，不扩大到整个同优先级组
  const conflictJobIds = new Set<number>()
  conflicts.forEach((conflict) => {
    conflictJobIds.add(conflict.earlierJob.id)
    conflictJobIds.add(conflict.laterJob.id)
  })
  const interruptAt = options.interruptAfterPosition
  const interrupted =
    typeof interruptAt === 'number' && interruptAt >= 0 && interruptAt < ordered.length

  const positions: RearrangedPosition[] = []
  const limit = interrupted ? interruptAt : ordered.length
  for (let i = 0; i < limit; i += 1) {
    const job = ordered[i]
    const queuePosition = i + 1
    const indexed = orderedIndex.get(job.id)!
    positions.push({
      id: job.id,
      jobNo: job.jobNo,
      priority: job.priority,
      enteredAt: job.enteredAt,
      originalOrder: job.originalOrder,
      queuePosition,
      waveNo: waveNumberOf(queuePosition, rule.maxConcurrency),
      previousWaveNo: job.previousWaveNo,
      tiePolicy,
      boundaryConflict: conflictJobIds.has(job.id),
      keepOriginalPosition: indexed.keepOriginalPosition,
      effectiveTimePosition: indexed.effectiveTimePosition,
    })
  }

  const wavesMap = new Map<number, string[]>()
  positions.forEach((position) => {
    const list = wavesMap.get(position.waveNo) ?? []
    list.push(position.jobNo)
    wavesMap.set(position.waveNo, list)
  })
  const waves = [...wavesMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([waveNo, jobNos]) => ({ waveNo, jobNos }))

  // 多选整组重排时回执只逐条返回本次提交的作业；全量重排返回全部
  const receiptScope = scopedJobIds.length > 0 ? new Set(scopedJobIds) : null
  const receipts = positions
    .filter((position) => receiptScope === null || receiptScope.has(position.id))
    .map((position) => ({
      jobId: position.id,
      jobNo: position.jobNo,
      queuePosition: position.queuePosition,
      waveNo: position.waveNo,
    }))

  return {
    id: options.resultId ?? makeResultId(rule.ruleNo, occurredAt),
    ruleNo: rule.ruleNo,
    ruleSnapshot: rule,
    tiePolicy,
    tiePolicyLabel:
      tiePolicy === TIE_KEEP_ORIGINAL
        ? '同优先级沿用原排队顺序'
        : '同优先级按新配置生效时间重排',
    occurredAt,
    operationDate: operationDateOf(occurredAt),
    protectedRunningJobs: runningJobs.map((job) => ({ ...job })),
    positions,
    scopedJobIds,
    waves,
    conflicts,
    coveredWaitingCount: scope.length,
    protectedRunningCount: runningJobs.length,
    status: interrupted ? 'INTERRUPTED' : 'COMPLETE',
    resumedFromPosition: interrupted ? interruptAt : null,
    recovered: Boolean(options.recoveredFromId),
    recoveredFromId: options.recoveredFromId ?? null,
    receipts,
  }
}

/**
 * 中断恢复：从完整位置（已登记的最后一条）的下一条继续，
 * 先用同一输入重新计算完整顺序，再把已登记部分原样接回，
 * 保证恢复结果与一次跑完完全一致。
 */
export function recoverRearrangement(
  waitingJobs: WaitingJobInput[],
  runningJobs: RunningJobInput[],
  request: RearrangeRequest,
  interrupted: WaveRearrangeResult,
): WaveRearrangeResult {
  if (interrupted.status !== 'INTERRUPTED') {
    throw new Error(`记录 ${interrupted.id} 不是中断态，无需恢复`)
  }
  // 先按同优先级沿用原排队顺序的口径核对已登记片段（复核依据）
  const full = rearrangeWaves(waitingJobs, runningJobs, request, {
    resultId: interrupted.id,
  })
  const safePosition = interrupted.resumedFromPosition ?? interrupted.positions.length
  const already = full.positions.slice(0, safePosition)
  const registeredIds = new Set(interrupted.positions.map((item) => item.id))
  const samePrefix =
    already.length === registeredIds.size && already.every((item) => registeredIds.has(item.id))
  if (!samePrefix) {
    throw new Error('中断前已登记片段与当前计算不一致，不能从完整位置继续')
  }

  const resumed = rearrangeWaves(waitingJobs, runningJobs, request, {
    resultId: interrupted.id,
    recoveredFromId: interrupted.id,
  })
  resumed.resumedFromPosition = safePosition
  resumed.recovered = true
  return resumed
}

/** 重排结果 -> 任务编排待处理清单联动更新数据。 */
export function buildQueueLinkUpdates(result: WaveRearrangeResult): QueueLinkUpdate[] {
  return result.positions.map((position) => ({
    jobId: position.id,
    queuePosition: position.queuePosition,
    waveNo: position.waveNo,
    priority: position.priority,
  }))
}
