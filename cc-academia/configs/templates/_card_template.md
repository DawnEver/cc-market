# Paper Card Template — <ShortRef>

> 用法:复制本文件为 `<shortref>_card.md`(shortref 见 `papers_registry.md`),填满各节。
> 规则:文件名 = `<author-lastname>-<year>_card.md`(多名作者取首个,如 zhuang-2026);正文只用标题+作者,禁止 hash。

- **ShortRef**: `<AuthorLastname> et al. <year>` (e.g. Zhuang et al. 2026)
- **candidate_id** (仅内部,不写进叙述): `S2-<hash>`
- **Title**: <完整标题>
- **Authors**: <作者列表>
- **Year / Venue**: <year> / <venue>

---

## One sentence

<一句话:这篇论文的核心贡献是什么?>

## Verdict & confidence

- **verdict**: `include | targeted-read | background`
- **confidence**: 0.0–1.0

## Technical core

- <核心贡献 1>
- <核心贡献 2>
- <方法/实验要点>

## Evidence

- {claim: "<论文中的论断>", locator: "<章节/图表>"}
- {claim: "...", locator: "..."}

## Limitations

- <局限 1>
- <局限 2>

## Research use (相对当前 review 主题)

- {type: `mechanism | method | context | gap`, note: "<与本 review 论点的关系>"}
- {type: ..., note: "..."}

## Next action

<这篇论文下一步怎么用——实现、对比、或作为证据>

## Open questions

- <悬而未决的问题>
- <...>
