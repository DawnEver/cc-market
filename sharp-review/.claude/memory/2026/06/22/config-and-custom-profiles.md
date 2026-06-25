---
name: config-and-custom-profiles
description: sharp-review 评审配置迁出 gitignored runtime state 进 tracked .claude/sharp-review.json;新增 config-driven customProfiles 扩展点;架构 profile 内置文件体积阈值
metadata:
  type: design
---

# sharp-review 配置外置 + 自定义 profile + 文件体积阈值 (2026-06-22)

## 1. 配置与运行时状态分离(关键设计)
评审**静态配置**(`profileWeights`、`customProfiles`、`thresholds`、`inlineDiffLimit`、
`docsThreshold`、`codebaseIntervalMin`)从 gitignored 的 `.claude/.rem-state.json → reviewGate`
迁到 **tracked 的 `.claude/sharp-review.json`** —— 这样"某仓库偏重架构梳理 / 自定义评审模板"
等团队决策随仓库走,不再 device-local。

- 读取入口:`scripts/lib/config.mjs` `loadReviewConfig(root)`(返回 {},缺省由各调用方兜底)。
- 读者已切:`pick-profile.js`、`diff-manifest.js`、`hooks/sharp-review-hook.js`。运行时状态
  (sessionId/wave/lastReviewRef…)仍留 `.rem-state.json reviewGate`,**hook 不再把 config 键回写
  进 runtime state**(避免漂移)。
- 迁移:`migrations/migrate.mjs` 把旧 reviewGate 里的 config 键搬进 `sharp-review.json`(幂等;
  已存在的 config 键不被覆盖)。`.gitignore` 加 `!**/.claude/sharp-review.json` 例外(cc-market
  本仓库 `**/.claude/**` 全忽略,需放行)。

## 2. config-driven 自定义 profile(扩展点)
仓库可在 `customProfiles`(数组)声明评审模板,**不改插件代码**。`pick-profile.js` 经
`mergeProfiles`/`normalizeCustomProfile` 把它们并入 `PROFILES`,按 source 门控 + 权重参与选取。
条目:`{ key, source(必填,已知 trigger), weight?, mode?, promptKind?, framing?, reviewScope? }`。
重用内置 key 即覆盖该内置。cc-market 自身 `.claude/sharp-review.json` 首用:`arch-hygiene`
(整洁锐评)挂 `codebase` source,并把 `architecture` 权重调低,使本仓库偏重整洁度评审。

## 3. 文件体积阈值(全局,内置进 architecture profile)
内置 `architecture` profile 的 reviewScope 现含硬阈值,**每个仓库**生效:
- 代码:> 300 行值得警惕;> 600 行**必须**拆分。
- 文档:单个 SKILL.md / AGENTS.md / CLAUDE.md > 100 行值得警惕 → 机制/schema/边角下沉
  `reference/*`(渐进式披露)。
diff 评审默认 scope 原"~400 行"已同步对齐到 300/600,避免两 profile 矛盾。

## 关联
- 测试:`profiles.test.mjs`(normalizeCustomProfile/mergeProfiles)、`pick-profile.test.mjs`
  (config 文件读取 + 自定义 profile 选取)、`migrations.test.mjs`(config 迁移幂等/不覆盖)。
- 渐进式披露同批:SKILL.md 295→168、rem SKILL 157→114,机制下沉 `reference/profiles-and-modes.md`
  与 `reference/crystallize.md`。
