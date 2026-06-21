---
name: codex-support
description: cc-market 双宿主 (Claude Code + Codex) 支持设计与分阶段实施 — 单一来源生成派生工件、运行时归一、能力降级,含阶段 0 Codex CLI 调研发现
metadata:
  type: design
---

# cc-market 双宿主支持设计 (Claude Code + Codex)

> 状态:阶段 0 完成 + 阶段 1 落地 (manifest/marketplace 生成器 + takeover E2E) · 2026-06-21
> 范围:让 cc-market 的插件在 Claude Code 和 Codex 两个宿主上运行。
> 本文是方案文档,不含实现。实现按"分阶段"章节推进。

## 1. 背景与结论

Codex 已内置一套与 Claude Code **高度同构**的插件 / 技能系统。因此"同时支持 Codex"
不是重写,而是**适配 + 派生生成**:以现有 Claude 版插件为唯一权威来源 (single source
of truth),通过 setup/migrate 步骤生成 Codex 工件,并对少数深绑 Claude 运行时的部分
做适配层或降级。

核心判断:**清单与技能基本同构,鸿沟集中在 4 处** —— 清单目录名、插件 root 变量、
hook 事件契约、个别插件的运行时假设。

## 2. 宿主能力对照

| 维度 | Claude Code (现状) | Codex | 差异级别 |
|---|---|---|---|
| 插件清单 | `.claude-plugin/plugin.json` | `.codex-plugin/plugin.json`(同 schema + `interface` 块) | 低(机械转译) |
| 市场清单 | `cc-market/.claude-plugin/marketplace.json` | `~/.agents/plugins/marketplace.json` 或 `<repo>/.agents/plugins/marketplace.json` | 低 |
| 技能 | `skills/<n>/SKILL.md` | `skills/<n>/SKILL.md`(frontmatter 几乎一致;可选 `metadata.short-description` + `agents/openai.yaml` 接口文件) | 低 |
| MCP | `.mcp.json` | `.mcp.json` | 无 |
| 插件 root 变量 | `${CLAUDE_PLUGIN_ROOT}`(26 处) | 无同名变量;Codex 用 `CODEX_HOME` 作为家目录,插件 root 注入变量待核实 | 中 |
| Hooks | `hooks/hooks.json` + Claude 事件名/payload | 支持 `hooks/` 目录,但**事件名与 payload 契约未在系统技能中公开** | 高(最大未知数) |
| Workflow 原语 | `Workflow` 工具 + subagent | 无对应原语 | 高(需降级) |
| 会话/transcript 存储 | JSONL transcript | sqlite (`logs_2.sqlite`/`state_5.sqlite` 等) | 高(需独立 ingester) |
| 安装迭代 | marketplace 引用 + symlink | marketplace 引用 + `update_plugin_cachebuster.py` cachebuster | 中 |

## 3. 总体策略:单一来源 + 生成派生物

不维护两套插件目录。`scripts/setup/setup.js`(及 `/migrate`)新增一个 **codex 生成步骤**,
从权威的 Claude 版插件产出 Codex 工件。理由:cc-market 已是"一处编辑、symlink 分发"模式,
扩展为"一处编辑 → 生成 → 分发到两个宿主"代价最小,且避免双份漂移。

分三层落地:

### 3.1 清单层(纯机械,低风险)
- 每个插件:从 `.claude-plugin/plugin.json` 生成 `.codex-plugin/plugin.json`,补 `interface`
  字段(`displayName`/`shortDescription`/`category`/`defaultPrompt` 等)。
- 生成 `<repo>/.agents/plugins/marketplace.json`,从现有 `marketplace.json` 转译,
  `source.path` 指向各插件目录。
- 迭代时跑 Codex 的 `update_plugin_cachebuster.py` 触发重新摄取。
- 完全可自动化,纳入 setup。

### 3.2 运行时归一层(中风险,关键)
- **插件 root 变量**:不要硬替换 26 处 `${CLAUDE_PLUGIN_ROOT}`。在脚本入口读
  `process.env.CLAUDE_PLUGIN_ROOT || process.env.<CODEX_PLUGIN_ROOT>`,或在 hook 命令串里
  用一个归一化前缀。**前置任务:核实 Codex 注入的插件 root 变量名**(`CODEX_HOME` 是家目录,
  非插件 root)。
- **Hook 适配(最大不确定性)**:`rem-hook.js` 依赖 Claude 的 `SessionStart`/`Stop` 事件,
  以及输入里的 `session_id`、`background_tasks`、`taskActiveUntil` 等字段。必须先验证 Codex 的
  事件名与 payload 形态,再写一个 **thin adapter** 把 Codex payload 翻译成现有脚本期望的形状
  —— **改适配层,不改脚本核心逻辑**。

### 3.3 能力降级层(按插件区分,见第 4 节)

## 4. 各插件可移植性评估

| 插件 | 可移植性 | 关键障碍 | 建议路径 |
|---|---|---|---|
| **takeover** | 高 | 纯 MCP server,`.mcp.json` 两边通用 | 几乎零改;**首个验证目标** |
| **watch** | 高 | Python,宿主无关;仅看守逻辑 | 清单转译即可 |
| **rem** | 中 | hook payload 适配 + 内存路径 | hook adapter;`.claude/memory` 作为唯一权威库,codex hook 也指向它(不要分叉成 `.codex/memory`) |
| **sharp-review** | 中低(**必做**) | 依赖 `Workflow` 工具 + 并行 reviewer | skill 降级为顺序执行 reviewer;hook 分类逻辑可复用 |
| **evolve** | 中低(**必做**) | 依赖 Workflow / subagent fan-out | 同上,降级为顺序 review→fix 轮次 |
| **traceme** | 部分 | 读 Claude transcript JSONL;Codex 会话在 sqlite | 清单**已生成**(`gen-codex.mjs` 一并产出,保持市场完整),但**运行时观测未移植**:Codex 会话存 sqlite,需新写 ingester,留待后续独立立项 |

设计原则:**能力降级要显式 `log`**,不要静默砍功能(与 cc-market 现有"no silent caps"约定一致)。

## 5. 分阶段实施

**阶段 0 — 消除未知数(阻塞项)**
- 核实 Codex 插件 root 注入变量名。
- 核实 Codex hook 事件名集合与 payload schema(是否有 SessionStart/Stop 对应物、字段命名)。
- 产出:一页 hook 契约对照表,补进本文第 2 节。

**阶段 1 — 管线打通(✅ 已完成)**
- ✅ `scripts/gen-codex.mjs`:从权威 Claude 清单生成每插件 `.codex-plugin/plugin.json`
  (裁掉 `commands`/`hooks`,合成 `interface`,接 `mcpServers`/`skills`)+
  `.agents/plugins/marketplace.json`。单元测试 `tests/gen-codex.test.mjs`(9 例)。
- ✅ `scripts/codex-e2e.sh`:隔离 `CODEX_HOME` 下校验全部 6 个清单 → `marketplace add` →
  `plugin add takeover` 全通过;`.mcp.json` 的 `${CLAUDE_PLUGIN_ROOT}` 原样保留。
- ✅ 顺带修复 `takeover/skills/codex-image-result/SKILL.md` 缺失的 `name`(Codex 严校验暴露)。
- 待办:`codex exec` 实跑验证 MCP tool 可发现性(需 codex 登录)。

**阶段 2 — hook 适配**
- 写 hook adapter,验证 **rem** 在 Codex 下的 SessionStart/Stop 行为。
- ✅ **`.claude/rules` 注入**(Codex 不原生加载 Claude 自动注入的 `.claude/rules/`):
  rem 新增 SessionStart hook `scripts/inject-rules.js` —— 插件级通用机制(随 rem 的
  `hooks.json` 一次性下发,对 Codex 打开的**任意**项目生效,读取该项目自身的
  `.claude/rules/**/*.md` 并经 `hookSpecificOutput.additionalContext` 注入),**非逐项目插入**。
  宿主探测用已替换的 `${CLAUDE_PLUGIN_ROOT}`(Codex 在 `.codex/plugins/…` 下,Claude 在
  `.claude/plugins/…` 下);Claude 宿主下为 no-op(避免与原生自动加载重复)。测试
  `rem/tests/inject-rules.test.mjs`(9 例)。

**阶段 3 — 宿主自适应并行 fan-out(✅ 已落地)** —— ⚠️ 原"顺序降级"前提已被 §7.5.3 推翻:
Codex 有原生并行 `spawn_agent`,**不降级**。设计要点:
- **不是降级**:Claude 走 `Workflow`/`Agent`,Codex 走 `spawn_agent`(并行)或 takeover
  `call_model`。两者都并行,无能力损失。
- **唯一真实差异 = Workflow VM**:Claude 的 `sharp-review-workflow.js` 在沙箱 VM 里跑
  (无 import/FS,这正是 `buildDedupKey` 内联而非 import 的原因)。Codex 无此 VM,主 agent
  直接 `spawn_agent` + 跑普通 node 脚本。
- **共用化改造(enabler)**:把 merge+render 纯逻辑从 Workflow VM 抽进 `sharp-review/lib.mjs`
  (`mergeFindings`/`renderReviewMarkdown`/`buildDedupKey`,可单测)。两条路径都把"每 reviewer
  的原始 findings"喂给同一套合并逻辑(经 `post-review.js`):
  - Claude:Workflow 并行 reviewer → 返回原始 findings → `post-review.js` 合并+渲染+写盘。
  - Codex:`spawn_agent` 并行 reviewer → 原始 findings → 同一 `post-review.js`。
  - 唯一宿主差异是 fan-out 工具名;merge/render/写盘 100% 共用,且终于可单测。
- evolve 同理:fix-agent fan-out 在 Codex 用 `spawn_agent`,纯 JS(groupFindings/
  checkTermination)不变。

**阶段 3 落地清单(2026-06-21):**
- ✅ `post-review.js --raw`:接收每 reviewer 原始 findings + reviewer 元数据,经共享
  `mergeFindings`/`renderReviewMarkdown` 合并渲染写盘 —— 宿主无关入口(Codex / 任何无 Workflow
  VM 的宿主走此路);`--findings`/`--markdown` 保留给 Claude Workflow 与外部 content 调用方。
  测试 `tests/post-review-raw.test.mjs`(2 例 E2E)+ 既有 `merge-render.test.mjs`(8 例)。
- ✅ `sharp-review/SKILL.md`:Step 3 拆为 **3a(Claude Workflow)/ 3b(Codex 直接并行
  `spawn_agent`/takeover `call_model` → `post-review.js --raw`)**;Step 4 双形态写盘。
- ✅ `evolve/reference/round-protocol.md` + `AGENTS.md`:evolve 仅 **step 2 fan-out fix** 宿主
  感知(`Agent`→`spawn_agent`,这是 evolve 自有的子代理编排原语,不可约)。**step 1 critique
  宿主无关** —— evolve 只"跑 sharp-review skill + 读 backlog OPEN findings"(`seedFromSharpReview`),
  Workflow-vs-raw-fan-out 的分叉只活在 sharp-review 一处,不泄漏到 evolve。
- ✅ Codex E2E 提示词 `scripts/codex-e2e-prompts.md`(需 codex 登录的手动 `codex exec` 部分:
  MCP 工具可发现性、`.claude/rules` 注入、sharp-review/evolve 宿主分支、跨宿主产物对齐)。
  → 留给用户实跑(本期 headless 不验证)。

> **traceme 本期不做**(见第 4 节),不在阶段计划内 —— Codex 工件已移除,README 标注 Claude-only。

## 6. 测试与约束

### 6.1 分层测试
- **单元/集成**:沿用 cc-market 的 per-plugin 约定(`node --test`)。新增 codex 清单/hook
  生成器需配套测试 —— 转译正确性、idempotence、TOML 格式、路径绝对化。
- **E2E(关键,覆盖宿主集成)**:用**真实 CLI** 驱动,验证生成的工件能被两个宿主真正摄取与触发,
  而非只测生成器输出的字符串:
  - **Codex**:`codex exec`(非交互)+ `codex plugin add/list` 验证插件被发现;在临时
    `CODEX_HOME` 下注入生成的 marketplace + 插件,跑一个最小 prompt,断言 SessionStart/Stop
    hook 确实执行(hook 脚本落地一个 sentinel 文件 / 退出码),并处理 7.3 的信任登记。
  - **Claude Code**:`claude -p "<prompt>"`(headless / print 模式)在临时 `CLAUDE_HOME`
    或临时项目下挂载同一插件,断言对应 hook 触发 —— 保证"单一来源"在两宿主上行为对齐。
  - **takeover** 走 MCP:两宿主都用 `codex mcp` / Claude 的 MCP 注册各起一次,断言 tool 可发现可调用。
  - E2E 用临时 `CODEX_HOME`/`CLAUDE_HOME` 隔离,**绝不污染用户真实配置**;CLI 缺失时 skip(类似
    Python 测试在无 `python` 时 skip)。
  - 所有子进程遵守 `windowsHide: true`(见下);CLI 调用设超时,避免交互式挂起
    (`codex exec` / `claude -p` 均非交互)。

### 6.2 约束
- 遵守 `cc-market/.claude/rules/invariants.md` 的 dev/runtime 边界。
- 遵守 `no-terminal-flash`(任何新 spawn 加 `windowsHide: true`)。
- cc-market 是独立 git 仓库:相关改动用 `git -C cc-market` 提交。

## 7. 阶段 0 调研发现 (Codex CLI 0.140.0)

> 数据来源:本地 Codex 原生二进制
> (`@openai/codex-darwin-arm64/.../bin/codex`)的内嵌 schema/字符串 + 系统技能
> `plugin-creator`。以下为可据以设计的事实,推翻了第 2 节"hook 契约未知"的悲观假设。

### 7.1 Hook 系统:与 Claude 高度同构 ✅
- **事件全集(10 个)**:`PreToolUse`、`PermissionRequest`、`PostToolUse`、`PreCompact`、
  `PostCompact`、`SessionStart`、`UserPromptSubmit`、`SubagentStart`、`SubagentStop`、`Stop`。
  → **rem 依赖的 `SessionStart` + `Stop` 两个都在,基本 1:1 对应 Claude。**
- **Hook 输入 payload 字段**(与 Claude 几乎同名,经 stdin JSON 传入):
  `session_id`、`transcript_path`、`cwd`、`hook_event_name`、`permission_mode`、`source`、
  `turn_id`、`agent_transcript_path`、`agent_type`、`last_assistant_message`、`prompt`。
- **Hook 输出**:`SessionStartHookSpecificOutputWire` / `PreToolUseDecisionWire` /
  `PreToolUsePermissionDecisionWire` 等 —— 与 Claude 的 `hookSpecificOutput` / decision 模式同构。
- **⚠️ 注意**:Codex payload **未见 `background_tasks` 字段**。`rem-hook.js` 的
  "pending-work guard"依赖它 → Codex 路径需退回 `taskActiveUntil` 时间窗,或用 `turn_id` 近似。

### 7.2 重大发现:Codex 内建 Claude 插件兼容层 ✅(推翻原"障碍 1/2")
原先担心的"无 `${PLUGIN_ROOT}` 变量""hook 必须手写 TOML"**均不成立**。二进制字符串证实
Codex 刻意做了 Claude 兼容摄取:
- **直接读 `hooks.json`**(Claude 格式),内部再归一化为 TOML
  (`"normalized hook identity should serialize to TOML"`)。无需手写 Codex TOML。
- **识别并替换 `${CLAUDE_PLUGIN_ROOT}`、`${PLUGIN_ROOT}`、`${CLAUDE_PLUGIN_DATA}`、
  `${PLUGIN_DATA}`** —— 现有 26 处 `${CLAUDE_PLUGIN_ROOT}` 与 `.mcp.json` 里的同名变量
  **大概率原样可用,无需绝对化路径**。
- Hook 事件 JSON 名(snake_case,与 Claude 一致):`pre_tool_use`、`permission_request`、
  `post_tool_use`、`pre_compact`、`post_compact`、`session_start`、`user_prompt_submit`、
  `subagent_start`、`subagent_stop`、`stop`(camelCase 为内部 TOML 形式)。

### 7.3 hook 信任 + 清单字段差异(仅剩的真实差异)
- **信任机制**:`HookStateToml.trusted_hash`、`HookMetadata.trustStatus`/`currentHash`
  → 插件 hook 仍需一次**信任批准(hash 比对)**才执行;E2E 需处理(交互或可脚本化,待实测)。
- **清单字段裁剪**(validator 实测,见 7.4):`.codex-plugin/plugin.json` 拒绝 `commands`、
  `hooks` 字段 —— 但 `hooks.json` 走**自动发现**(无需在清单声明),`.mcp.json` 同理。
  takeover 的 `commands` 字段需在 Codex 清单中删去(Codex 用 skills 暴露能力)。

### 7.4 清单/市场 E2E 实测通过 ✅(隔离 `CODEX_HOME`,`codex` 0.140.0)
用 `scripts/codex-e2e.sh` 在临时 `CODEX_HOME` 跑通了完整链路(零污染用户配置):
1. `validate_plugin.py` 通过 —— 确认 `.codex-plugin/plugin.json` **必填**:`name`、`version`
   (严格 semver)、`description`、`author.name`、`interface.{displayName, shortDescription,
   longDescription, developerName, category, capabilities[], defaultPrompt[]}`。
   **允许字段集**:`id, name, version, description, skills, apps, mcpServers, interface,
   author, homepage, repository, license, keywords` —— `commands`/`hooks` **不在内,会被拒**。
2. 市场布局:`marketplace add <root>` 期望 `<root>/.agents/plugins/marketplace.json`;
   插件 `source: {source:"local", path:"./plugins/<n>"}` 相对 `<root>` 解析;每条 entry 必须含
   `policy.{installation, authentication}` + `category`。
3. `codex plugin add <n>@<market>` 把插件装到
   `$CODEX_HOME/plugins/cache/<market>/<n>/<version>/`,`.mcp.json` 一并落地;
   `config.toml` 写入 `[marketplaces.<m>]` 与 `[plugins."<n>@<m>"] enabled=true`。
- 技能:`skills/<n>/SKILL.md` 同构;Codex 额外读 `agents/openai.yaml`(interface)与可选
  `SKILL.json`(优先于 frontmatter 的 `short_description`)。

### 7.5 仍待实测确认的开放问题
1. ✅ **已确认**:hook 信任流程存在 —— 二进制 TUI 字符串可见 `FetchHooksList`、`TrustHook`、
   `current_hash`、`SetHookTrusted`、`HookEnabled`,说明插件 hook 需经一次 hash 信任批准。
   仍待 `codex exec` 实跑验证 session_start/stop 端到端触发(需 codex 登录)。
2. 插件 MCP server 的 `${CLAUDE_PLUGIN_ROOT}` 在运行时是否解析到安装 cache 根(`codex exec`
   + MCP tool 可发现性验证;需 codex 登录,headless 无法验证)。
3. ✅ **已确认 — Codex 有原生并行 subagent**(推翻"降级为顺序"前提)。二进制证据:
   - **`spawn_agent` 工具**:`"Spawns an agent to work on the specified task. If your current
     task is /root/task1 and you spawn_agent with task_name "task_3" the agent will have
     canonical task name /root/task1/task_3"`,并带 `Available models:`(可指定模型)。
   - **并行**:`"there may be multiple workers making changes in parallel … be aware of each
     other's work"` + 委派指引(`Designing delegated subtasks` / `After you delegate` /
     `Do not redo delegated subagent tasks yourself`);另见 `SubAgentSource`、
     `subAgentThreadSpawn`、`process/spawn`。
   - **takeover MCP `call_model` 在 Codex 下同样可用**(takeover 本就是 Codex 首验目标)。
   → **结论:sharp-review / evolve 不需要"顺序降级"。** Phase 3 改为"宿主自适应并行 fan-out":
     Claude 用 `Workflow`/`Agent`,Codex 用 `spawn_agent`(仍并行)或 takeover `call_model`。
     唯一真实差异:Codex 无 Workflow **VM**(沙箱无 import/FS),故 merge/render 纯逻辑须以普通
     Node 步骤运行(Codex 主 agent 直接跑 node 脚本即可,无沙箱限制)—— 这正是把 merge/render
     抽进 `sharp-review/lib.mjs`(宿主无关、可单测)的动因,两宿主共用。
4. 同一目录并存 `.claude-plugin/` 与 `.codex-plugin/` 时两宿主是否互不干扰(实测验证)。

### 7.6 Codex 兼容性边界(已确认,gen-codex 已处理)

**(a) 插件 slash-command 不是 Codex 概念。** Codex 的插件组件只有 skills / hooks / mcpServers /
apps(`commands` 字段被 validator 拒绝,二进制中也无插件命令自动发现)。因此 `gen-codex.mjs`
丢弃 `commands` 字段。影响:
- takeover(`/takeover:continue|models|summary`)、watch(`/watch:watch|check|setup`)的
  **slash 入口在 Codex 下不存在**;但其底层能力仍可达 —— takeover 经 MCP 工具
  (`call_model`/`list_models`/`codex_status`),技能经 `skills/`。
- Codex 另有用户级 `~/.codex/prompts` 自定义提示,与插件命令是不同机制,不在本期映射范围。

**(b) Hook 事件兼容性。** Codex 支持 10 个 hook 事件(`PreToolUse`、`PermissionRequest`、
`PostToolUse`、`PreCompact`、`PostCompact`、`SessionStart`、`UserPromptSubmit`、
`SubagentStart`、`SubagentStop`、`Stop`)。Claude 独有、**Codex 不支持**的 `Notification`、
`SessionEnd` 在 Codex 下静默不触发。各插件实测:

| 插件 | hooks.json 事件 | Codex 兼容 |
|---|---|---|
| rem | SessionStart, Stop | ✅ 全兼容 |
| sharp-review | Stop | ✅ |
| takeover / evolve | (无 hooks.json) | ✅ |
| watch | **Notification**, Stop | ⚠️ Notification 不触发(告警退化为 Stop-only) |
| traceme | SessionStart, Stop, **SessionEnd** | ⚠️ SessionEnd 不触发(本就 out-of-scope) |

→ **本期必做的 4 个插件(takeover/rem/sharp-review/evolve)hook 全兼容。** `gen-codex.mjs`
现在在生成时对 watch/traceme 的不支持事件**打印 warning**(`unsupportedHookEvents()`),把
静默运行时退化前置为生成期可见警告。watch/traceme 的 Codex hook 适配留待各自后续工作。

**(c) `background_tasks` 缺失。** Codex hook payload 无此字段(见 7.1)。rem 的 pending-work
guard 退回 `taskActiveUntil` 时间窗;在 Codex 下运行的多轮技能(evolve/sharp-review)须在起始
设 `taskActiveUntil`(evolve 已遵守),否则 Stop hook 可能中途触发。

> 状态:清单/市场契约由 E2E 锁定(7.4),`${CLAUDE_PLUGIN_ROOT}` 兼容性由二进制证实(7.2),
> 命令/hook 事件兼容边界已厘清并由 gen-codex 自动告警(7.6)。剩余 §7.5 第 2–4 项需 codex 登录
> 实跑,非 headless 可关闭。
