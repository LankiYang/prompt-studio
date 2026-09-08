# Prompt Studio

这是一个面向多人 AI 角色对话团队的 PromptOps 平台。首页用于管理 Prompt 版本、共享评测资源、旧版/新版受控评测和不可变运行证据；原有多人聊天房与记忆实验室继续保留。

## 已实现能力

- Prompt 资产增删改查、软删除与恢复。
- Prompt 正文通过不可变版本管理，支持从任意版本继续编辑、发布和切回旧版。
- 固定“旧版 / 新版”双版本评测，不向用户暴露 Builder A/B/C。
- 两侧锁定同一组角色、世界观、测试集、模型参数、历史窗口、调度、记忆和评分卡。
- 角色、世界观、测试集、评分卡、模型、调度和记忆策略的结构化资源管理。
- AI 真实生成与十维评分：指令遵循、相关性、玩家行动权、剧情合理性、剧情有趣性、人设边界、语气差异、世界观、群像协作和表达节奏。
- 模型横评：固定一个 Prompt 版本、测试集和裁判模型，并行比较 2--8 个被测模型；每个模型的回复、评分、失败状态和原始请求均可回看。
- Prompt 调试器：左右双窗口独立选择模型卡、修改 System Prompt 和采样参数，用同一条输入实时对比两侧回复；调试历史仅保留在当前浏览器会话。
- 多供应商模型卡：支持 OpenAI 兼容接口、Anthropic Messages 和 Cloudsway 专用协议；模型卡可引用服务端环境变量或保存服务端加密密钥，原始密钥不返回浏览器、不进入快照和审计。内置 Cloudsway 与 OpenRouter 预设，OpenRouter 可配置安全扩展请求头。
- 保存逐案例回复、生成请求、生成响应、评分请求和评分原文。
- 模型或评分失败显示为“待复核”，不把缺失数据伪装成 0 分；总分只使用两侧都成功评分的成对案例。
- 回收站支持恢复；永久删除前检查版本和评测证据依赖。
- 组织、项目与成员协作：项目级资产隔离、成员邀请/激活、项目角色与本地身份切换。
- 版本评审：以“Prompt 版本 + AI 生成对话”的评测证据为粒度，发起时冻结每条案例的 Baseline / Candidate、自动评分和原始数据；指定评审人逐条对比、十维打分、写证据并提交结论，所有修订进入审计日志。
- 团队人工评测：每位项目成员可针对任一 Prompt 版本提交十维体验评分、体验场景、实际轮数和证据；重复提交保留个人修订，团队均分只采用每人的最新结论。
- 服务端项目角色校验：负责人、编辑者、评审者和观察者拥有不同的查看、编辑、运行、评审与发布权限。
- 账号与持久登录：首次访问初始化负责人账号；后续成员由负责人创建账号。账号仅支持 3 至 40 位字母或数字，密码至少 3 个字符；密码使用服务端 `scrypt` 哈希，会话令牌在浏览器本地保存并自动恢复，权限只由服务端会话解析。
- 首次启动自动从当前多人聊天房配置导入角色、世界观和初始 Prompt。
- 原多人聊天房、@ 唤起、随机角色发言、主动发言和记忆双栏评测保持可用。

## 启动

```bash
npm install
npm run dev
```

访问：

- PromptOps 工作区：`http://localhost:5173/`
- 兼容入口：`http://localhost:5173/workspace`
- 多人聊天加入页：`http://localhost:5173/join`
- 多人聊天房：`http://localhost:5173/room`
- 记忆实验室：`http://localhost:5173/memory`
- 房间配置：`http://localhost:5173/config`

## 使用流程

1. 在“Prompt 调试器”选择参考配置与候选配置，用同一条输入确认改动方向。调试草稿、参数和对话会在当前浏览器会话中保留。
2. 在“Prompt 版本”把候选内容保存为新版本，不覆盖旧版；正式对比至少需要两个不可变版本。
3. 在“共享资源”补齐角色、世界观、测试集、评分卡、模型卡、调度策略和记忆策略。页面会显示 7 类正式评测条件的就绪数量。
4. 在“评测与结果”选择同一 Prompt 的旧版和新版，锁定共享条件并运行受控评测；缺失配置会直接链接到对应维护入口。
5. 在“版本评审”指定评审人，逐条对比旧版与新版回复，填写十维人工分数和证据。
6. 由项目负责人发布已确认的版本；低分、回退和“待复核”案例进入下一轮迭代。

模型横评、多人聊天房和记忆实验室属于独立实验入口，不打断上面的 Prompt 版本主流程。团队与权限、回收站集中在“项目管理”导航组。

## 易用性约定

- 工作区导航按“开始、设计与调试、验证与协作、项目管理、体验实验”分组。
- 当前工作区页面写入 `?view=` 查询参数，刷新、前进后退和分享地址时不会丢失当前模块。
- 项目概览用五步状态显示下一项建议动作；高级采样和协议参数默认折叠。
- 只读成员不会看到资源编辑、评测运行等无权限操作入口，服务端仍执行最终权限校验。
- 配置页和记忆实验室会标记未保存设置；重启会话、重启实验和删除已有内容前会明确确认影响。
- Prompt 调试器只把聊天记录清空，Prompt 草稿和参数继续保留；多人聊天房的“重启会话”会真正清空聊天历史与 AI 上下文。

## 数据

- 新平台数据库：`data/prompt-studio.db`
- SQLite 使用 WAL 模式，运行时可能出现 `-wal` 和 `-shm` 文件。
- 多人房间运行配置：`data/config.json`

新平台的版本快照、评测共享条件和原始结果不可原地修改。业务资源默认软删除；被不可变证据引用的资源不能永久删除。

本地与生产环境均使用服务端会话验证。Studio API 只接受 `Authorization: Bearer <token>`，不会信任客户端传入的成员 ID。

## 环境变量

```env
DEEPSEEK_API_KEY=your_api_key
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-flash
DEEPSEEK_TEMPERATURE=0.95
DEEPSEEK_PRESENCE_PENALTY=0.25
OPENAI_API_KEY=your_api_key
ANTHROPIC_API_KEY=your_api_key
CLOUDSWAY_API_KEY=your_api_key
OPENROUTER_API_KEY=your_api_key
PROMPT_STUDIO_ENCRYPTION_KEY=use-a-stable-secret-in-production
```

`DEEPSEEK_TEMPERATURE` 范围为 `0` 至 `2`，`DEEPSEEK_PRESENCE_PENALTY` 范围为 `-2` 至 `2`。模型卡会冻结到每次评测中；模型横评和调试器可使用 OpenAI、DeepSeek、Qwen、SiliconFlow、Moonshot、Anthropic、Cloudsway、OpenRouter 或其他 OpenAI 兼容供应商。API Key 只在服务端解析，浏览器只看到是否已配置。

Cloudsway 预设使用专用 `cloudsway-chat-completions` 适配器，Base URL 可填写 `https://genaiapi.cloudsway.net/v1` 或完整的 `/v1/chat/completions` 地址。适配器通过 Bearer AK 调用，将全部消息固定转换为文本块数组，并强制发送 `stream_options.include_usage=true`。OpenRouter 预设使用 `https://openrouter.ai/api/v1` 和 `OPENROUTER_API_KEY`；模型卡的扩展请求头可填写 `HTTP-Referer`、`X-Title`，服务端会过滤 `Authorization`、`Cookie`、`Content-Type`、`X-API-Key` 等保留或敏感请求头。

模型卡可将 API Key 以 AES-256-GCM 密文保存到服务端。前端只显示是否已配置，原始密钥和密文均不会进入浏览器、调试响应、评测快照、审计或导出。选择“加密保存到模型卡”后，密钥来源严格使用该卡片；未填写时不会回退到同名环境变量。

生产环境必须设置稳定的 `PROMPT_STUDIO_ENCRYPTION_KEY`；未设置时保存或读取卡片密钥会被拒绝。本地开发仍保留数据库路径派生密钥的兼容模式。迁移数据库时必须同时迁移该环境变量，否则历史模型卡中的加密 API Key 无法解密。

## 自测

```bash
npm run check
npm run build
npm run test:studio
npm run test:studio:ai
```

- `test:studio` 使用临时 SQLite 数据库验证迁移、资源 CRUD、回收站、版本发布、评测快照、模型横评快照、项目隔离、成员权限、人工评测修订、逐案例评审快照、案例评分修订和整单状态汇总。
- `test:studio:ai` 额外执行真实旧版/新版与多模型横评生成和评分，并检查各侧原始数据。

详细需求、交互和架构见：

- [综合 Prompt 评测平台重构需求](docs/综合Prompt评测平台重构需求.md)
- [综合 Prompt 评测平台 UX 与交互设计](docs/综合Prompt评测平台UX与交互设计.md)
- [Prompt Studio 架构](docs/PromptStudio架构.md)
- [Prompt Studio 视觉设计系统](docs/视觉设计系统.md)
