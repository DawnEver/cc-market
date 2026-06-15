---
name: cli-utf8-stdio
description: bootstrap.ensure() forces UTF-8 stdio so CLI report glyphs (✓, —) don't crash on Windows cp1252 — fixed empty /watch:check output. v1.0.42.
metadata:
  type: project
---

watch **v1.0.42**. 同 commit 与 [[action-start-dir-env]] 同期。

### 症状
`/watch:check`(跑 `watch.py --json`)在 Windows 控制台**产出空白**。`--json` 与人类
`_print_report` 都受影响。

### 根因
打印状态字形 `✓`(✓)/ em-dash `—` 到默认 **cp1252** stdout 时抛 `UnicodeEncodeError`
→ 进程崩溃,捕获 stdout 的调用方(Bash 工具)只见空串。

### 修复
`scripts/bootstrap.py` 新增 `_force_utf8_io()`,在 `ensure()` 顶部调用一次:
对 `sys.stdout`/`sys.stderr` 做 `reconfigure(encoding='utf-8', errors='replace')`,
`(AttributeError, ValueError)` 降级为 no-op。因**所有** CLI + daemon 入口都
`import bootstrap; bootstrap.ensure()`(且 re-exec 进 venv 后再次执行),一处修全部。
`errors='replace'` 保证即使遇不可映射字符也不再崩。

### 测试
`tests/test_bootstrap.py`(3):重配为 utf-8 / 不可映射字形写入不抛 / 无 reconfigure 属性时降级。
> fixture 替换 `sys.stdout` 会干扰 pytest 全量跑的输出捕获 —— 单独跑该文件,或全量跑时
> `--ignore=tests/test_bootstrap.py` 再单跑它。

### 旁注
`test_components_progress.py::test_complete_status_end_to_end` 为 order/timing flaky(隔离通过)。
