# Prompt Studio 架构

版本：2.0  
状态：协作治理阶段已实现

## 1. 定位

Prompt Studio 是多人角色对话团队的 PromptOps、评测与发布治理平台。当前主链路只比较同一个 Prompt 的旧版本和新版本，其他条件必须一致。

平台与多人聊天房分层：

- Studio 管理资产、版本、受控评测和证据。
- 多人房间负责真实在线群聊、@ 唤起、主动发言和记忆运行。
- Studio 的账号、会话和项目授权由服务端处理；浏览器只保存不透明会话令牌。
- 前端品牌、颜色、组件状态和响应式约束统一遵循 [视觉设计系统](视觉设计系统.md)，业务组件不再自行定义产品标识。

## 2. 模块结构

```text
src/pages/StudioPage.tsx
  -> PromptLibrary
  -> PromptDebugger
  -> ResourceLibrary
  -> EvaluationWorkspace
  -> EvaluationResults
  -> TeamWorkspace
  -> ReviewWorkspace
      -> ReviewCaseAssessment
  -> src/studio/api.ts
  -> /api/studio
  -> studio-repository.ts
  -> studio-evaluation.ts
  -> prompt-evaluation.ts
  -> data/prompt-studio.db
```

### 前端职责

- 项目概览：资产、版本、运行和回收站状态。
- Prompt 调试器：左右双窗口独立选择模型卡、编辑最终 System Prompt、覆盖采样参数，使用同一用户输入实时对比回复。
- Prompt 版本：元数据 CRUD、不可变版本、发布和回滚。
- 共享资源：角色、世界观、测试集、评分卡、模型卡、调度和记忆策略 CRUD。
- 评测：旧版/新版选择、模型横评、共享条件预检、调用量估算和运行。
- 结果：总分差、十维差异、逐案例对比与原始数据。
- 团队与权限：组织成员、项目成员、角色分配、项目切换与本地身份模拟。
- 版本评审：以已完成评测为入口冻结逐案例证据，指定评审人逐条对比、打分、复核和协作评论。
- 回收站：恢复和受依赖约束的永久删除。

### 服务端职责

- `studio-repository.ts`：SQLite schema、初始资源导入、项目隔离、角色授权、事务、CRUD、依赖检查和审计。
- `studio-evaluation.ts`：冻结共享配置，同时运行旧版和新版并计算差值。
- `prompt-evaluation.ts`：真实回复生成、评分卡驱动的 AI 评分和原始数据采集。
- `studio.ts`：REST API。
- `auth.ts`：负责人初始化、登录、退出、账号创建与会话验证。

## 3. 数据模型

SQLite 文件为 `data/prompt-studio.db`，使用 WAL 与外键约束。

| 表 | 作用 | 修改规则 |
| --- | --- | --- |
| `projects` | 项目基础信息 | 可更新 |
| `organizations` | 团队级组织信息 | 可更新 |
| `members` | 组织成员、状态与默认角色 | 可更新、可停用 |
| `accounts` | 成员账号与 `scrypt` 密码哈希 | 不保存明文密码 |
| `auth_sessions` | 已哈希的浏览器会话令牌与有效期 | 过期或退出后删除 |
| `project_members` | 项目成员与项目角色 | 可更新、保留审计 |
| `resources` | Prompt 与共享资源元数据和配置 | 可更新、归档、软删除 |
| `prompt_versions` | Prompt 正文及变量规则快照 | 正文不可修改 |
| `evaluations` | 对比定义、冻结配置和运行结果 | 运行后结果不可覆盖 |
| `model_comparisons` | 固定 Prompt 版本下的多模型横评定义、快照与结果 | 运行后结果不可覆盖 |
| `audit_logs` | 写操作审计 | 只追加 |
| `review_requests` | 不可变版本的评审请求与证据引用 | 状态可更新 |
| `review_comments` | 评审评论和结论 | 只追加 |
| `review_cases` | 发起评审时冻结的测试输入、期望行为、Baseline / Candidate 回复与原始数据 | 创建后不可修改 |
| `review_case_assessments` | 评审人针对单条案例的十维分数、结论、依据与修订历史 | 只追加；状态取每个评审人和案例的最新结论 |
| `manual_assessments` | 成员针对 Prompt 版本的十维体验评分与文字证据 | 只追加；团队汇总取成员最新修订 |
| `meta` | 迁移版本和内部元数据 | 系统维护 |

资源类型：

- `prompt`
- `character`
- `world`
- `test-suite`
- `scorecard`
- `model-config`
- `scheduler-policy`
- `memory-policy`

## 4. 不可变边界

### Prompt

Prompt 名称、说明、负责人和标签可原地更新。Prompt 正文、变量任务、输出格式和对话规则只能通过“新建版本”修改。

发布只改变版本状态，不覆盖快照。重新发布历史版本就是回滚，新版本仍保留。

### 评测

创建评测时冻结：

- 旧版和新版 Prompt 快照
- 角色列表与完整人设
- 世界观
- 测试案例
- 模型和采样参数
- 历史窗口与调度策略
- 记忆策略
- 评分卡

运行结果包含旧版、新版、分差、逐案例评分和生成/评分原文。模型失败、评分解析失败或十维字段不完整时使用 `null`，页面显示“待复核”，不使用 0 分。总分和维度差只使用旧版、新版均成功评分的成对案例，并显示可比案例数。

### 模型横评

模型横评固定一个 Prompt 版本、测试集、角色、世界观、调度、记忆、评分卡和裁判模型，同时选择 2--8 个被测模型。被测模型彼此并行生成；所有回复由同一个冻结裁判模型评分，避免将被测模型的自评混入排名。每个模型独立保存逐案例回复、评分、原始请求与失败原因；服务失败和评分缺失保留为 `null`，不会按 0 分参与排名。

模型卡包含供应商显示名、调用协议、Base URL、模型、消息内容格式、采样参数、可禁用的标准参数、停止序列、供应商扩展参数和凭据来源。凭据可以引用服务端环境变量，也可以通过模型卡表单提交后在服务端加密保存；原始 API Key 不进入前端、审计、评测快照或共享响应。调试和评测运行时只通过资源 ID 在服务端解析凭据。

模型调用层按协议构造请求：OpenAI 兼容接口使用 Chat Completions 字段，Anthropic Messages 使用 `max_tokens`、`top_p`、`top_k` 和 `stop_sequences`。Cloudsway 使用独立的 `cloudsway-chat-completions` 适配器，接受 Base URL 或完整端点，固定使用 Bearer AK、文本块数组消息和 `stream_options.include_usage=true`，并兼容字符串或文本块数组形式的响应内容。

消息内容可以按模型卡选择纯文本字符串或文本块数组。Anthropic 不支持的 `presence_penalty`、`frequency_penalty` 和 OpenAI `response_format` 会被自动忽略；对于兼容接口包装的模型，模型卡可逐项关闭标准参数，平台会在调试结果中记录忽略原因。无法通过协议自动判断的供应商专属参数由模型卡的 JSON 扩展参数承载，平台过滤保留字段后透传。OpenRouter 继续复用 OpenAI 兼容适配器，并通过模型卡扩展请求头支持 `HTTP-Referer` 和 `X-Title`；认证、Cookie、Content-Type 和 API Key 请求头由服务端统一管理，不能被模型卡覆盖。

模型卡密钥使用 `PROMPT_STUDIO_ENCRYPTION_KEY` 派生的 AES-256-GCM 密钥加密保存。浏览器只接收 `apiKeyConfigured` 状态，不接收明文或密文；调试、评测、快照、审计和导出同样剔除密钥。卡片密钥与环境变量是严格互斥的凭据来源，不允许调用时静默回退。生产环境必须配置主密钥，否则拒绝保存或读取卡片密钥；本地开发保留当前数据库路径派生密钥的兼容模式。生产迁移必须同时保留数据库和主密钥。

### 人工评测

团队成员可在任意 Prompt 版本详情中提交实际体验结论。每条记录包含十个维度的 1--5 分、按当前评分卡权重计算的 0--100 分总分、体验场景、实际体验轮数和文字证据。成员重新提交不会改写历史，而是创建递增的个人修订；版本页的团队均分和有效结论人数只使用每位有效项目成员最新的一条记录。提交身份从当前认证上下文解析，客户端不能代填其他成员 ID；所有提交均追加审计日志。

### 基于证据的版本评审

版本评审不把一个 Prompt 版本当成唯一评审粒度。新评审必须关联一条已完成的新旧版本对比评测；创建时将测试集中的每条案例复制到 `review_cases`，同时冻结玩家输入、期望行为、Baseline / Candidate 完整回复、自动评分、缺陷、评分依据和 `rawData`。后续重跑评测或修改共享资源不会污染已经发出的评审任务。

指定评审人分别对每条案例提交十个维度的 1--5 分、`comment` / `approve` / `changes_requested` 结论和可复核依据。每次提交递增 revision，不覆盖上一版。系统按每个“案例 × 指定评审人”的最新结论汇总：有任一 `changes_requested` 就要求修改；所有组合均为 `approve` 才整单通过；其余保持进行中。绑定案例证据的评审禁止通过旧的整单审批接口绕过逐条复核，普通协作评论仍可追加。

### 删除

- 普通删除设置 `deleted_at`，资源进入回收站。
- 恢复清除 `deleted_at`。
- 永久删除仅允许未被 Prompt 版本或评测快照引用的资源。
- Prompt 创建后即存在版本，因此不能通过回收站破坏版本链。
- 历史评测保存完整配置快照，后续资源编辑不会改变旧结果。

## 5. 初始资源导入

数据库首次初始化时：

1. 创建默认项目。
2. 从 `data/config.json` 导入当前多人房间的 Prompt、角色与世界观。
3. 创建初始 Prompt 版本、测试集和十维评分卡。
4. 创建默认模型、调度和无记忆基线。
5. 创建默认组织、默认项目负责人与项目成员关系。

Studio 仅使用 SQLite 保存版本、评测、评审与协作数据；`/room`、`/memory` 和 `/config` 保持各自的运行配置。

## 6. 受控评测流程

```text
选择同一 Prompt
  -> 选择旧版本和新版本
  -> 选择测试集
  -> 锁定角色 / 世界 / 模型 / 调度 / 记忆 / 评分卡
  -> 冻结评测快照
  -> 两侧使用相同案例并行运行
  -> 每条回复独立评分
  -> 排除缺失评分并计算总分与维度差
  -> 保存逐案例原始证据
```

当前调用量为：

```text
案例数 x 2 个版本 x（1 次生成 + 1 次评分）
```

## 7. 协作与授权

项目是隔离边界：资源、Prompt 版本、评测、评审和审计只在当前项目可见。组织成员激活并加入项目后才能访问项目。

| 项目角色 | 能力 |
| --- | --- |
| `owner` | 管理项目与成员、编辑资产、运行评测、发起/参与评审、发布版本、提交人工评测 |
| `editor` | 编辑资产、创建版本、运行评测、发起评审、评论、提交人工评测 |
| `reviewer` | 查看证据、评论、对被指派评审提交通过或要求修改、提交人工评测 |
| `viewer` | 只读查看项目、版本、评测与评审；可提交个人人工评测 |

首次启动时没有账号，首位访问者需初始化负责人账号。账号仅支持 3 至 40 位字母或数字，密码至少 3 个字符；负责人可以在“团队与权限”中创建成员账号，并同时指定组织默认角色和当前项目角色。登录成功后，浏览器本地保存不透明令牌，刷新页面会调用 `/api/auth/me` 自动恢复会话；Studio API 仅从 `Authorization: Bearer` 会话解析成员身份，不信任客户端传入的成员 ID。历史数据库启动时会自动从原邮箱字段生成唯一账号，不影响已有成员和会话数据。

生产接入 SSO/OIDC 时只替换会话认证层，项目成员关系、授权检查和审计结构保持不变。

版本评审不会修改版本正文。历史无案例快照的版本级评审继续按旧评论流程展示；新评审必须绑定已完成评测并固定逐案例证据。评论和案例复核只追加，审批汇总与每次修订均写入审计日志。发布仍由项目负责人执行。

## 8. API

主要接口：

```text
GET    /api/studio/bootstrap
POST   /api/studio/projects
PATCH  /api/studio/projects/:id
POST   /api/studio/projects/:projectId/members/:memberId
DELETE /api/studio/projects/:projectId/members/:memberId
POST   /api/studio/members
PATCH  /api/studio/members/:memberId
GET    /api/studio/resources
POST   /api/studio/resources
PATCH  /api/studio/resources/:id
DELETE /api/studio/resources/:id
POST   /api/studio/resources/:id/restore
DELETE /api/studio/resources/:id/permanent

GET    /api/studio/prompts/:id/versions
POST   /api/studio/prompts/:id/versions
POST   /api/studio/prompts/:id/versions/:versionId/publish

GET    /api/studio/manual-assessments?projectId=&versionId=
POST   /api/studio/manual-assessments

GET    /api/studio/evaluations
POST   /api/studio/evaluations
GET    /api/studio/evaluations/:id
POST   /api/studio/evaluations/:id/run
POST   /api/studio/evaluations/:id/archive

GET    /api/studio/model-comparisons
POST   /api/studio/model-comparisons
POST   /api/studio/model-comparisons/:id/run
POST   /api/studio/model-comparisons/:id/archive

POST   /api/studio/debug/chat

GET    /api/studio/reviews
POST   /api/studio/reviews
POST   /api/studio/reviews/:id/comments
POST   /api/studio/reviews/:id/cases/:caseId/assessments
```

## 9. 自测要求

完成前至少执行：

```bash
npm run check
npm run build
npm run test:studio
npm run test:studio:ai
npm run test:workspace
```

浏览器验收还应覆盖：

- 首页正常加载且不会自动滚到底部。
- Prompt 历史版本可查看，新建版本表单可滚动。
- 共享资源可创建和编辑。
- 旧版与新版默认使用不同版本。
- 共享条件预检与调用量正确。
- 真实评测结束后可查看分差、案例和原始数据。
- 模型横评需要至少两个被测模型，固定裁判模型；各模型的排名、逐案例回复与原始数据可回看。
- 缺失评分显示“待复核”。
- 软删除、恢复和永久删除依赖阻断生效。
- 创建项目后，资产、版本、评测和审计与其他项目隔离。
- 编辑者、评审者和观察者的服务端权限拒绝符合角色矩阵。
- 指定评审人可提交结论，评论和关联评测证据可回看。
- 新版本评审必须从已完成评测创建，案例输入、两侧回复、自动评分和原始数据在发起时冻结。
- 指定评审人可逐条打开 Baseline / Candidate 对比，提交十维人工分数、依据和结论；重复提交保留 revision。
- 任一案例要求修改时整单显示“需要修改”；所有评审人完成所有案例且均通过后整单才显示“已通过”。
- 任一项目成员可打开版本人工评测表单；十维分数、体验场景、轮数和证据可填写，取消不会创建记录。
- 同一成员重提人工评测生成新的修订，历史保留且团队汇总只采用该成员最新结论。

## 10. 后续阶段

协作治理阶段后仍需继续扩展：

- Prompt Diff、自动保存草稿和多人编辑冲突。
- 连续 20/60 轮对话测试集与任务队列。
- AI 评分批次和人工结论的仲裁。
- 报告生成、导出、审批、发布申请与生产回滚事件。
- 运行取消、重试、成本和 token 统计。
- PostgreSQL 迁移适配器与服务端任务队列。
