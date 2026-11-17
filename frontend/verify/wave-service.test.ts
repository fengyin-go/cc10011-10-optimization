import assert from 'node:assert/strict'
import { test, beforeEach } from 'node:test'

// localStorage 垫片：服务层与存储层都走浏览器存储接口
class MemoryStorage {
  private map = new Map<string, string>()
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value)
  }
  removeItem(key: string): void {
    this.map.delete(key)
  }
  clear(): void {
    this.map.clear()
  }
}
;(globalThis as unknown as { window: { localStorage: Storage } }).window = {
  localStorage: new MemoryStorage() as unknown as Storage,
}

import { listRows, resetCache, resetRows } from '../src/data/local-store'
import { runAction } from '../src/api/local-service'
import {
  describeRuleScope,
  executeWaveRearrangement,
  listRearrangements,
  loadDispatchJobs,
  resumeWaveRearrangement,
} from '../src/api/wave-service'
import { TIE_BY_EFFECTIVE_TIME, TIE_KEEP_ORIGINAL } from '../src/api/wave-types'

const OCCURRED = '2026-11-17T10:00:00.000Z'

beforeEach(() => {
  ;(globalThis as unknown as { window: { localStorage: MemoryStorage } }).window.localStorage.clear()
  resetCache()
})

test('取数入口：等待作业与运行中作业按状态拆分，运行中不参与重排', () => {
  const { waiting, running } = loadDispatchJobs()
  assert.equal(waiting.length, 5)
  assert.equal(running.length, 1)
  assert.deepEqual(running, [{ id: 3, jobNo: 'SPID-0003', waveNo: 1 }])
  // originalOrder 沿用已登记的排队序号
  assert.deepEqual(waiting.map((j) => j.originalOrder), [1, 2, 3, 4, 5])
})

test('规则编号识别调度编排记录，规则快照可与调度规则核对', () => {
  const scope = describeRuleScope(3)
  assert.equal(scope.ruleNo, 'SCHE-0003')
  assert.equal(scope.maxConcurrency, 2)
  assert.equal(scope.priority, 3)
})

test('全量重排：结果一次覆盖全部等待作业并落盘，等待队列按新波次联动更新', () => {
  const result = executeWaveRearrangement({ ruleId: 3, occurredAt: OCCURRED })
  assert.equal(result.status, 'COMPLETE')
  assert.equal(result.coveredWaitingCount, 5)
  assert.equal(result.protectedRunningCount, 1)
  assert.equal(result.ruleNo, 'SCHE-0003')
  assert.equal(result.tiePolicy, TIE_KEEP_ORIGINAL)

  const saved = listRearrangements()
  assert.equal(saved.length, 1)
  assert.equal(saved[0].id, result.id)

  const rows = listRows('spider')
  const waitingRows = rows.filter((r) => String(r.status) === '待执行')
  // 全部等待作业都拿到连续排队序号，无遗漏
  const positions = waitingRows.map((r) => Number(r['排队序号'])).sort((a, b) => a - b)
  assert.deepEqual(positions, [1, 2, 3, 4, 5])
  const byId = new Map(waitingRows.map((r) => [Number(r.id), r]))
  // 同优先级沿用原排队顺序：SPID-0002(原2) 在 SPID-0005(原4) 前
  assert.ok(Number(byId.get(2)!['排队序号']) < Number(byId.get(5)!['排队序号']))
  // 最大并发 2：前两位同波次1，SPID-0005 在第 3 位进入波次2
  assert.equal(byId.get(2)!['波次编号'], 1)
  assert.equal(byId.get(5)!['波次编号'], 2)
  // 入队序号不可变，重排后保持首次登记值
  assert.equal(byId.get(5)!['入队序号'], 4)
  assert.equal(String(byId.get(1)!['重排口径']), '同优先级沿用原排队顺序')

  // 运行中作业行原样保留，波次编号还是 1，且没有排队序号
  const runningRow = rows.find((r) => Number(r.id) === 3)!
  assert.equal(runningRow['波次编号'], 1)
  assert.equal(runningRow['排队序号'], null)
})

test('连续保存两次不抖动：同输入产生同位置、同波次，记录不串位', () => {
  const first = executeWaveRearrangement({ ruleId: 3, occurredAt: OCCURRED })
  const snapshot = listRows('spider').map((r) => [r.id, r['排队序号'], r['波次编号']])
  const second = executeWaveRearrangement({ ruleId: 3, occurredAt: OCCURRED })
  const again = listRows('spider').map((r) => [r.id, r['排队序号'], r['波次编号']])

  assert.deepEqual(
    second.positions.map((p) => [p.id, p.queuePosition, p.waveNo]),
    first.positions.map((p) => [p.id, p.queuePosition, p.waveNo]),
  )
  assert.deepEqual(again, snapshot)
  assert.equal(listRearrangements().length, 2)
})

test('批量调级多选：新优先级只作用于选中作业，重排仍全量覆盖，逐条回执新位置', () => {
  const result = executeWaveRearrangement({
    ruleId: 3,
    selectedJobIds: [4, 6],
    priority: 5,
    occurredAt: OCCURRED,
  })
  assert.equal(result.coveredWaitingCount, 5)
  assert.deepEqual(result.scopedJobIds, [4, 6])
  // 全量覆盖：全部 5 条等待作业都有新位置，调级作业按原排队顺序占据前两位
  assert.deepEqual(result.positions.map((p) => p.id), [4, 6, 1, 2, 5])
  // 回执只逐条返回本次提交的两条
  assert.deepEqual(result.receipts.map((r) => r.jobId), [4, 6])
  assert.deepEqual(result.receipts.map((r) => r.queuePosition), [1, 2])
  assert.deepEqual(result.receipts.map((r) => r.waveNo), [1, 1])

  const rows = new Map(listRows('spider').map((r) => [Number(r.id), r]))
  assert.equal(rows.get(4)!['优先级'], 5)
  assert.equal(rows.get(6)!['优先级'], 5)
  // 未选中的作业优先级不动
  assert.equal(rows.get(2)!['优先级'], 2)
  // 入队序号不可变
  assert.equal(rows.get(4)!['入队序号'], 3)
  // 运行中作业不受影响
  assert.equal(rows.get(3)!['波次编号'], 1)
})

test('口径切换：生效时间重排改变前两位，冲突留痕可复核，再切回原顺序可还原', () => {
  const effective = executeWaveRearrangement({
    ruleId: 3,
    tiePolicy: TIE_BY_EFFECTIVE_TIME,
    occurredAt: OCCURRED,
  })
  // 同优先级 2：SPID-0005 进入更早，生效时间口径排在 SPID-0002 前
  const order = effective.positions.map((p) => p.jobNo)
  assert.ok(order.indexOf('SPID-0005') < order.indexOf('SPID-0002'))
  assert.ok(effective.conflicts.length > 0)
  const conflict = effective.conflicts.find((c) => c.earlierJob.jobNo === 'SPID-0005')!
  // 题面场景：两个不同进入时间的作业同优先级后，两种口径交界使等待队列前两位变化
  assert.deepEqual(conflict.keepOriginalFront, ['SPID-0001', 'SPID-0002'])
  assert.deepEqual(conflict.effectiveTimeFront, ['SPID-0001', 'SPID-0005'])
  assert.match(conflict.boundary, /前两位发生变化/)

  const restored = executeWaveRearrangement({
    ruleId: 3,
    tiePolicy: TIE_KEEP_ORIGINAL,
    occurredAt: OCCURRED,
  })
  const restoredOrder = restored.positions.map((p) => p.jobNo)
  assert.ok(restoredOrder.indexOf('SPID-0002') < restoredOrder.indexOf('SPID-0005'))
})

test('中断恢复：中断记录不联动清单，恢复后从完整位置继续且结果完整', () => {
  const interrupted = executeWaveRearrangement({
    ruleId: 3,
    interruptAfterPosition: 2,
    occurredAt: OCCURRED,
  })
  assert.equal(interrupted.status, 'INTERRUPTED')
  // 中断态不写等待队列字段
  const rowsDuring = listRows('spider')
  assert.ok(rowsDuring.every((r) => r['排队序号'] === null || typeof r['排队序号'] === 'number'))
  const stillSeedPositions = rowsDuring
    .filter((r) => String(r.status) === '待执行')
    .map((r) => Number(r['排队序号']))
  assert.deepEqual(stillSeedPositions.sort((a, b) => a - b), [1, 2, 3, 4, 5])

  const resumed = resumeWaveRearrangement(interrupted.id)
  assert.equal(resumed.status, 'COMPLETE')
  assert.equal(resumed.recovered, true)
  assert.equal(resumed.positions.length, 5)
  assert.equal(resumed.coveredWaitingCount, 5)

  const after = listRows('spider').filter((r) => String(r.status) === '待执行')
  assert.deepEqual(
    after.map((r) => Number(r['排队序号'])).sort((a, b) => a - b),
    [1, 2, 3, 4, 5],
  )
  // 历史记录里同一条记录状态被更新为 COMPLETE
  const history = listRearrangements()
  const same = history.filter((h) => h.id === interrupted.id)
  assert.equal(same.length, 1)
  assert.equal(same[0].status, 'COMPLETE')
})

test('多选中断恢复：选中范围与新优先级在恢复后不丢，全量位置完整', () => {
  const interrupted = executeWaveRearrangement({
    ruleId: 3,
    selectedJobIds: [4, 6],
    priority: 5,
    interruptAfterPosition: 2,
    occurredAt: OCCURRED,
  })
  assert.equal(interrupted.status, 'INTERRUPTED')
  assert.deepEqual(interrupted.scopedJobIds, [4, 6])
  // 中断态不联动：选中作业的优先级仍保留中断前原值
  const before = new Map(listRows('spider').map((r) => [Number(r.id), r]))
  assert.equal(before.get(4)!['优先级'], 1)

  const resumed = resumeWaveRearrangement(interrupted.id)
  assert.deepEqual(resumed.scopedJobIds, [4, 6])
  assert.deepEqual(resumed.positions.map((p) => p.id), [4, 6, 1, 2, 5])
  assert.deepEqual(resumed.receipts.map((r) => r.jobId), [4, 6])

  const after = new Map(listRows('spider').map((r) => [Number(r.id), r]))
  assert.equal(after.get(4)!['优先级'], 5)
  assert.equal(after.get(6)!['优先级'], 5)
  // 未选中作业保持原优先级
  assert.equal(after.get(2)!['优先级'], 2)
  // 运行中作业仍受保护
  assert.equal(after.get(3)!['波次编号'], 1)
})

test('操作当日回看：按日期过滤重排记录', () => {
  executeWaveRearrangement({ ruleId: 3, occurredAt: OCCURRED })
  executeWaveRearrangement({ ruleId: 3, occurredAt: '2026-11-16T08:00:00.000Z' })
  assert.equal(listRearrangements('2026-11-17').length, 1)
  assert.equal(listRearrangements('2026-11-16').length, 1)
  assert.equal(listRearrangements().length, 2)
})

test('重置模块后示例数据带齐排队字段，取数入口仍可正常工作', () => {
  resetRows('spider')
  resetCache()
  const { waiting, running } = loadDispatchJobs()
  assert.equal(waiting.length, 5)
  assert.ok(waiting.every((j) => Number.isInteger(j.enqueueSerial) && j.enqueueSerial > 0))
  assert.deepEqual(waiting.map((j) => j.originalOrder), [1, 2, 3, 4, 5])
  assert.equal(running.length, 1)
})

test('启动采集后作业进入运行中：重排不抢占，原波次编号保持', () => {
  executeWaveRearrangement({ ruleId: 3, occurredAt: OCCURRED })
  // 取队首等待作业启动采集
  const before = listRows('spider')
  const head = before.find((r) => String(r.status) === '待执行' && Number(r['排队序号']) === 1)!
  const headWave = Number(head['波次编号'])
  const action = runAction('spider', Number(head.id), '启动采集')
  assert.equal(action.ok, true)

  const result = executeWaveRearrangement({ ruleId: 3, occurredAt: OCCURRED })
  // 新运行的作业进入保护名单，波次编号不变
  const protectedJob = result.protectedRunningJobs.find((j) => j.id === Number(head.id))!
  assert.ok(protectedJob)
  assert.equal(protectedJob.waveNo, headWave)
  assert.equal(result.coveredWaitingCount, 4)
  const rows = new Map(listRows('spider').map((r) => [Number(r.id), r]))
  assert.equal(rows.get(Number(head.id))!['波次编号'], headWave)
  assert.equal(String(rows.get(Number(head.id))!.status), '运行中')
})
