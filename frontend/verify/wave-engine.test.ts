import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  buildQueueLinkUpdates,
  computeQueueOrder,
  detectConflicts,
  rearrangeWaves,
  recoverRearrangement,
  waveNumberOf,
} from '../src/api/wave-engine'
import { TIE_BY_EFFECTIVE_TIME, TIE_KEEP_ORIGINAL } from '../src/api/wave-types'
import type { RearrangeRequest, RunningJobInput, WaitingJobInput } from '../src/api/wave-types'

// 与 seed 同构的等待作业：originalOrder 为原排队序号，enteredAt 为进入时间
const waiting: WaitingJobInput[] = [
  { id: 1, jobNo: 'SPID-0001', priority: 3, enteredAt: '2026-11-15T09:00:00.000Z', originalOrder: 1, enqueueSerial: 1, previousWaveNo: null },
  { id: 2, jobNo: 'SPID-0002', priority: 2, enteredAt: '2026-11-16T09:00:00.000Z', originalOrder: 2, enqueueSerial: 2, previousWaveNo: null },
  { id: 4, jobNo: 'SPID-0004', priority: 1, enteredAt: '2026-11-14T09:00:00.000Z', originalOrder: 3, enqueueSerial: 3, previousWaveNo: null },
  { id: 5, jobNo: 'SPID-0005', priority: 2, enteredAt: '2026-11-13T08:30:00.000Z', originalOrder: 4, enqueueSerial: 4, previousWaveNo: null },
  { id: 6, jobNo: 'SPID-0006', priority: 1, enteredAt: '2026-11-17T08:00:00.000Z', originalOrder: 5, enqueueSerial: 5, previousWaveNo: null },
  { id: 7, jobNo: 'SPID-0007', priority: 1, enteredAt: '2026-11-12T08:00:00.000Z', originalOrder: 6, enqueueSerial: 6, previousWaveNo: null },
]

const running: RunningJobInput[] = [
  { id: 3, jobNo: 'SPID-0003', waveNo: 1 },
]

function request(overrides: Partial<RearrangeRequest> = {}): RearrangeRequest {
  return {
    rule: {
      ruleNo: 'SCHE-0003',
      ruleName: '任务编排样例站点',
      maxConcurrency: 2,
      priority: 3,
      effectiveAt: '2026-11-17T00:00:00.000Z',
    },
    tiePolicy: TIE_KEEP_ORIGINAL,
    occurredAt: '2026-11-17T10:00:00.000Z',
    ...overrides,
  }
}

test('同优先级沿用原排队顺序：优先级降序，同级按 originalOrder 稳定排列', () => {
  const order = computeQueueOrder(waiting, TIE_KEEP_ORIGINAL).map((j) => j.id)
  assert.deepEqual(order, [1, 2, 5, 4, 6, 7])
})

test('波次按最大并发切分，排队序号连续、波次编号连续', () => {
  assert.equal(waveNumberOf(1, 2), 1)
  assert.equal(waveNumberOf(2, 2), 1)
  assert.equal(waveNumberOf(3, 2), 2)
  assert.equal(waveNumberOf(6, 2), 3)
  assert.equal(waveNumberOf(4, 3), 2)

  const result = rearrangeWaves(waiting, running, request())
  assert.deepEqual(result.waves, [
    { waveNo: 1, jobNos: ['SPID-0001', 'SPID-0002'] },
    { waveNo: 2, jobNos: ['SPID-0005', 'SPID-0004'] },
    { waveNo: 3, jobNos: ['SPID-0006', 'SPID-0007'] },
  ])
  assert.deepEqual(result.positions.map((p) => p.queuePosition), [1, 2, 3, 4, 5, 6])
})

test('运行中作业不进入新队列，只登记保护并保留原波次编号', () => {
  const result = rearrangeWaves(waiting, running, request())
  assert.equal(result.coveredWaitingCount, 6)
  assert.equal(result.protectedRunningCount, 1)
  assert.deepEqual(result.protectedRunningJobs, [{ id: 3, jobNo: 'SPID-0003', waveNo: 1 }])
  assert.ok(!result.positions.some((p) => p.id === 3))
  assert.ok(!result.waves.some((w) => w.jobNos.includes('SPID-0003')))
})

test('同优先级按新配置生效时间重排：进入时间早的在前，其余回退原顺序', () => {
  const order = computeQueueOrder(waiting, TIE_BY_EFFECTIVE_TIME).map((j) => j.id)
  // prio3: 1；prio2: 5(11-13) 在 2(11-16) 前；prio1: 7(11-12),4(11-14),6(11-17)
  assert.deepEqual(order, [1, 5, 2, 7, 4, 6])
})

test('进入时间相同时生效时间口径回退原排队顺序，结果仍稳定', () => {
  const sameTime: WaitingJobInput[] = [
    { id: 10, jobNo: 'J10', priority: 2, enteredAt: '2026-11-17T00:00:00.000Z', originalOrder: 2, enqueueSerial: 2, previousWaveNo: null },
    { id: 11, jobNo: 'J11', priority: 2, enteredAt: '2026-11-17T00:00:00.000Z', originalOrder: 1, enqueueSerial: 1, previousWaveNo: null },
  ]
  assert.deepEqual(computeQueueOrder(sameTime, TIE_BY_EFFECTIVE_TIME).map((j) => j.id), [11, 10])
})

test('连续保存两次：相同输入的排队结果完全一致，不抖动、不遗漏（记录主键各自唯一）', () => {
  const first = rearrangeWaves(waiting, running, request())
  const second = rearrangeWaves(waiting, running, request())
  assert.notEqual(second.id, first.id)
  assert.deepEqual(second.positions, first.positions)
  assert.deepEqual(second.waves, first.waves)
  assert.deepEqual(second.conflicts, first.conflicts)
  assert.equal(second.positions.length, waiting.length)
  assert.deepEqual(second.receipts, first.receipts)
})

test('冲突判定：两种口径交界改变顺序且前两位变化时给出边界说明', () => {
  const conflicts = detectConflicts(waiting)
  assert.ok(conflicts.length >= 1)
  const hit = conflicts.find((c) => c.earlierJob.id === 5 && c.laterJob.id === 2)
  assert.ok(hit, 'SPID-0005 与 SPID-0002 同优先级不同进入时间应构成交界冲突')
  assert.deepEqual(hit!.keepOriginalFront, ['SPID-0001', 'SPID-0002'])
  assert.deepEqual(hit!.effectiveTimeFront, ['SPID-0001', 'SPID-0005'])
  assert.match(hit!.boundary, /前两位发生变化/)

  const result = rearrangeWaves(waiting, running, request({ tiePolicy: TIE_BY_EFFECTIVE_TIME }))
  // 只标记真正构成相邻逆序的两个交界：(5,2) 与 (4,7)
  const marked = result.positions.filter((p) => p.boundaryConflict).map((p) => p.id).sort((a, b) => a - b)
  assert.deepEqual(marked, [2, 4, 5, 7])
  const p2 = result.positions.find((p) => p.id === 2)!
  assert.equal(p2.keepOriginalPosition, 2)
  assert.equal(p2.effectiveTimePosition, 3)
})

test('多选整组重排：结果仍覆盖全部等待作业，回执逐条返回选中作业，组内同优先级顺序稳定', () => {
  const req = request({ selectedJobIds: [2, 5], rule: { ...request().rule, priority: 5 } })
  const scoped = waiting.map((j) => ([2, 5].includes(j.id) ? { ...j, priority: 5 } : j))
  const result = rearrangeWaves(scoped, running, req)
  // 全量覆盖、不遗漏；选中作业升到优先级 5 后按原排队顺序排在最前
  assert.equal(result.coveredWaitingCount, 6)
  assert.deepEqual(result.scopedJobIds, [2, 5])
  assert.deepEqual(result.positions.map((p) => p.id), [2, 5, 1, 4, 6, 7])
  // 回执只逐条返回本次提交的两条
  assert.deepEqual(result.receipts, [
    { jobId: 2, jobNo: 'SPID-0002', queuePosition: 1, waveNo: 1 },
    { jobId: 5, jobNo: 'SPID-0005', queuePosition: 2, waveNo: 1 },
  ])
  assert.throws(() => rearrangeWaves(waiting, running, request({ selectedJobIds: [999] })), /不在等待队列/)
})

test('中断后恢复：从完整位置继续，恢复结果与一次跑完一致', () => {
  const interrupted = rearrangeWaves(waiting, running, request(), { interruptAfterPosition: 3 })
  assert.equal(interrupted.status, 'INTERRUPTED')
  assert.equal(interrupted.positions.length, 3)
  assert.equal(interrupted.resumedFromPosition, 3)

  const resumed = recoverRearrangement(waiting, running, request(), interrupted)
  assert.equal(resumed.status, 'COMPLETE')
  assert.equal(resumed.recovered, true)
  assert.equal(resumed.recoveredFromId, interrupted.id)
  assert.equal(resumed.resumedFromPosition, 3)

  const full = rearrangeWaves(waiting, running, request(), { resultId: interrupted.id })
  assert.deepEqual(resumed.positions, full.positions)
  assert.deepEqual(resumed.waves, full.waves)
  assert.throws(() => recoverRearrangement(waiting, running, request(), full), /不是中断态/)
})

test('待处理清单联动数据与重排结果一一对应', () => {
  const result = rearrangeWaves(waiting, running, request())
  const updates = buildQueueLinkUpdates(result)
  assert.deepEqual(updates.map((u) => u.jobId), [1, 2, 5, 4, 6, 7])
  assert.deepEqual(updates.map((u) => u.waveNo), [1, 1, 2, 2, 3, 3])
  assert.ok(updates.every((u) => u.priority >= 1))
})
