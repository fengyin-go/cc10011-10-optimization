/**
 * 调度波次重排领域类型。
 *
 * 设计约束（对应业务复核口径）：
 * - 运行中作业受保护，不进入新队列，保留原波次编号；
 * - 一次重排覆盖全部等待（待执行）作业，结果数据全量覆盖、不遗漏；
 * - 同优先级默认沿用原排队顺序（稳定排序），也可按新配置生效时间重排；
 * - 连续保存两次：同一输入必须得到同一输出（幂等），不允许来回抖动。
 */

/** 同优先级次序口径：复核依据为「同优先级沿用原排队顺序」。 */
export const TIE_KEEP_ORIGINAL = 'KEEP_ORIGINAL'
/** 同优先级按新配置生效时间重排：进入时间更早的排在前面。 */
export const TIE_BY_EFFECTIVE_TIME = 'BY_EFFECTIVE_TIME'

export type TiePolicy = typeof TIE_KEEP_ORIGINAL | typeof TIE_BY_EFFECTIVE_TIME

export const TIE_POLICY_LABEL: Record<TiePolicy, string> = {
  [TIE_KEEP_ORIGINAL]: '同优先级沿用原排队顺序',
  [TIE_BY_EFFECTIVE_TIME]: '同优先级按新配置生效时间重排',
}

/** 等待中作业的重排输入视图，只从采集作业（spider）行里取重排需要的字段。 */
export type WaitingJobInput = {
  /** spider 行主键 */
  id: number
  /** 作业编号，如 SPID-0002 */
  jobNo: string
  /** 重排采用的新优先级（数值越大越靠前） */
  priority: number
  /** 作业进入等待队列的时间（ISO 字符串），用于生效时间口径与冲突判定 */
  enteredAt: string
  /** 重排前的排队序号，1 起；沿用原顺序时以它为准 */
  originalOrder: number
  /** 入队序号：作业进入等待队列时一次性登记，重排不修改，用于回看原排队顺序 */
  enqueueSerial: number
  /** 重排前所在波次编号；没有进过波次时为 null */
  previousWaveNo: number | null
}

/** 运行中作业：受保护对象，只登记、不参与重排。 */
export type RunningJobInput = {
  id: number
  jobNo: string
  /** 启动采集时分配的波次编号，重排后保持不变 */
  waveNo: number | null
}

export type RearrangeRuleSnapshot = {
  /** 规则编号，用于识别调度编排记录（如 SCHE-0003） */
  ruleNo: string
  /** 规则名称/关联站点，方便人读 */
  ruleName: string
  /** 新配置的最大并发，决定每个采集波次容量 */
  maxConcurrency: number
  /** 新配置优先级（规则级默认值，作业级调整可覆盖） */
  priority: number
  /** 新配置生效时间（ISO 字符串） */
  effectiveAt: string
}

export type RearrangeRequest = {
  rule: RearrangeRuleSnapshot
  tiePolicy: TiePolicy
  /** 调度员多选后整组重排时传入；为空表示覆盖全部等待作业 */
  selectedJobIds?: number[]
  /** 调度发生时间（ISO 字符串），默认取当前时间，测试可注入 */
  occurredAt?: string
}

/** 单条等待作业重排后的新位置，逐条返回。 */
export type RearrangedPosition = {
  id: number
  jobNo: string
  priority: number
  enteredAt: string
  originalOrder: number
  /** 重排后的排队序号，1 起，在全部等待作业内连续编号 */
  queuePosition: number
  /** 重排后的采集波次编号 */
  waveNo: number
  previousWaveNo: number | null
  /** 本条采用的同优先级次序口径（整条重排一致，登记便于回看） */
  tiePolicy: TiePolicy
  /** 是否与「沿用原排队顺序」口径结果不一致（业务冲突标记） */
  boundaryConflict: boolean
  /** 若发生冲突，沿用原顺序口径下本作业的排队序号，供复核 */
  keepOriginalPosition: number
  /** 若发生冲突，生效时间口径下本作业的排队序号，供复核 */
  effectiveTimePosition: number
}

/** 业务冲突：两种口径交界导致等待队列前两位发生变化的作业对。 */
export type BoundaryConflict = {
  /** 冲突涉及的两个作业，按生效时间口径的先后排列 */
  earlierJob: { id: number; jobNo: string; enteredAt: string }
  laterJob: { id: number; jobNo: string; enteredAt: string }
  priority: number
  /** 沿用原顺序口径下两位的作业编号（前两位变化时才登记） */
  keepOriginalFront: string[]
  /** 生效时间口径下两位的作业编号 */
  effectiveTimeFront: string[]
  /** 冲突边界说明 */
  boundary: string
}

/** 调度波次重排结果数据：一次重排一份，全量覆盖等待作业。 */
export type WaveRearrangeResult = {
  /** 结果主键 */
  id: string
  /** 关联规则编号，调度编排经规则编号计算后保存于此，可与调度规则再次核对 */
  ruleNo: string
  ruleSnapshot: RearrangeRuleSnapshot
  tiePolicy: TiePolicy
  /** 本次采用口径的中文描述，操作当日回看时直接可读 */
  tiePolicyLabel: string
  /** 调度发生时间（ISO 字符串） */
  occurredAt: string
  /** 操作日期（YYYY-MM-DD），按操作当日回看 */
  operationDate: string
  /** 受保护的运行中作业，不进入新队列 */
  protectedRunningJobs: RunningJobInput[]
  /** 全量等待作业的新位置，按 queuePosition 升序 */
  positions: RearrangedPosition[]
  /** 本次整组重排提交的作业 id；空数组表示一次覆盖全部等待作业 */
  scopedJobIds: number[]
  /** 波次编号 -> 该波次作业编号，波次按编号升序 */
  waves: { waveNo: number; jobNos: string[] }[]
  /** 冲突判定结果（两种口径交界） */
  conflicts: BoundaryConflict[]
  /** 覆盖的等待作业总数；要求与当时全部等待作业数一致 */
  coveredWaitingCount: number
  /** 运行中作业数（保护数） */
  protectedRunningCount: number
  /** 状态：COMPLETE 一次写完；INTERRUPTED 中断后可从完整位置恢复 */
  status: 'COMPLETE' | 'INTERRUPTED'
  /** 中断时已登记到的排队序号（完整位置），恢复从它的下一条继续 */
  resumedFromPosition: number | null
  /** 本次是否由中断恢复产生 */
  recovered: boolean
  /** 来源记录 id：恢复时指向被中断的那一份 */
  recoveredFromId: string | null
  /** 逐条返回的提交回执（多选整组重排时用） */
  receipts: { jobId: number; jobNo: string; queuePosition: number; waveNo: number }[]
}

/** 任务编排待处理清单联动更新后的作业行视图。 */
export type QueueLinkUpdate = {
  jobId: number
  queuePosition: number
  waveNo: number
  priority: number
}
