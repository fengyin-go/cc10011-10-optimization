# 采集调度策略管理工具

离线版采集调度策略配置工具，涵盖站点登记、模板编排、代理轮换、限速调节、反爬策略、增量水位与结果校验规则，所有配置持久化到浏览器本地存储。

这是一个**纯前端**管理平台：React + Vite + TypeScript，仓库里没有后端服务。业务数据由
`frontend/src/data/` 下的本地数据层提供：首次打开用示例数据播种，之后的登记、筛选与状态流转
结果都持久化在浏览器 `localStorage` 里，刷新或重开浏览器都还在。dev server 已关掉自动打开页面，
启动后按终端打印的地址手工打开。

## 目录结构

```text
.
├── frontend/                 React + Vite + TypeScript 前端（唯一运行单元）
│   ├── src/views/            每个业务模块一个页面
│   ├── src/api/local-service.ts   本地数据服务：列表、筛选、动作流转、导出
│   ├── src/data/             模块元数据 / 示例数据 / localStorage 持久化
│   ├── src/stores/           会话与筛选状态
│   └── vite.config.ts        dev server 配置（open: false，无 /api 代理）
├── .gitignore
└── docker-compose.yml
```

## 启动

```bash
cd frontend
npm install
npm run dev
```

前端默认监听 `http://127.0.0.1:5173/`，dev server 不会自动打开浏览器，需要自己访问。

生产构建：

```bash
cd frontend
npm run build
```

## 业务模块

| 模块 | 目录 | 业务对象 | 主要字段 |
| --- | --- | --- | --- |
| 站点登记 | `site` | 采集站点 | 站点编号、域名地址、站点类型 |
| 模板编排 | `template` | 抽取模板 | 模板编号、入口地址、列表选择器 |
| 代理轮换 | `proxy` | 代理节点 | 节点编号、代理地址、代理协议 |
| 任务编排 | `spider` | 采集作业 | 作业编号、目标站点、抽取模板 |
| 调度编排 | `schedule` | 调度规则 | 规则编号、关联站点、调度表达式 |
| 反爬策略 | `antibot` | 对抗策略 | 策略编号、验证码类型、识别服务 |
| 限速调节 | `ratelimit` | 限速配置 | 配置编号、目标站点、每秒请求上限 |
| 重试机制 | `retry` | 重试策略 | 策略编号、关联任务、最大重试次数 |
| 字段映射 | `extractor` | 映射规则 | 规则编号、源字段名称、目标字段名称 |
| 采集流水线 | `pipeline` | 流水线步骤 | 步骤编号、步骤名称、输入数据源 |
| 结果校验 | `validator` | 校验规则 | 规则编号、校验对象、校验类型 |
| 数据落盘 | `storage` | 存储配置 | 配置编号、存储类型、输出路径 |
| 采集监控 | `monitor` | 监控指标 | 指标编号、关联任务、指标名称 |
| 数据清洗 | `cleanse` | 清洗规则 | 规则编号、目标字段、空值替换 |
| 增量水位 | `delta` | 增量游标 | 游标编号、目标站点、增量字段 |
| 数据分发 | `export` | 分发通道 | 通道编号、输出数据集、目标系统 |
| RPA流程 | `rpaflow` | 自动化流程 | 流程编号、目标页面、操作序列 |
| 登录凭证 | `auth` | 凭证配置 | 凭证编号、目标站点、认证方式 |

## 约定

- 每个模块的页面在 `frontend/src/views/<模块>/index.vue`，页面只负责渲染，读写统一走
  `frontend/src/api/local-service.ts`。
- 字段、状态、动作与流转目标集中在 `frontend/src/data/modules.ts`；示例数据在
  `frontend/src/data/seed.ts`。
- 状态流转只允许在 `local-service.ts` 里改，页面组件不做业务判断。
- 想回到初始数据：清掉浏览器里 `scraper-strategy-studio:entries` 这一项，或调用 `resetModule(模块)`。

## 调度波次重排

修改调度规则的最大并发或优先级后，在「任务编排」或「调度编排」页底部的「调度波次重排」面板
触发整批重排，避免整批重排时等待作业反复抖动。代码分层：

- `src/api/wave-types.ts`：重排领域类型（等待/运行作业、重排结果、冲突、回执）。
- `src/api/wave-engine.ts`：纯计算引擎，不碰 localStorage/DOM，输入确定则输出确定。
- `src/api/wave-service.ts`：沿现有取数入口读取 spider（任务编排）与 schedule（调度规则）行，
  调用引擎并把结果持久化到 `scraper-strategy-studio:wave-rearrangements`，再联动更新等待队列。
- `src/views/common/WaveRearrangePanel.tsx`：任务编排与调度编排共用的操作面板。

关键口径（也是复核依据）：

- 重排结果一次覆盖全部等待（待执行）作业；运行中作业只登记保护，不进新队列、保留原波次编号。
- 同优先级默认「沿用原排队顺序」（按稳定的存储顺序，配合不可变的「入队序号」回看），
  也可切换为「按新配置生效时间重排」（进入时间早的在前，时间相同回退原顺序），连续保存不抖动。
- 两种口径交界构成业务冲突，结果数据同时保留两种口径下的位置并标记前两位变化，供调度员复核取舍。
- 支持多选等待作业整组重排，一次提交后逐条回执新位置；模拟中断后可从完整位置恢复，恢复结果与一次跑完一致。
- 规则编号用于识别调度编排记录，结果内保存规则快照，可与调度规则再次核对数据范围；记录按操作日期回看。

验证（纯 Node，无需浏览器）：

```bash
cd frontend
npm run verify:wave
```

领域：数据工程
子方向：数据采集、爬虫与RPA
