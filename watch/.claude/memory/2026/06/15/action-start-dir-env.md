---
name: action-start-dir-env
description: New managed-action field start_dir_env — env-var-named absolute cwd overriding static start_dir, so dynamic staging paths need no inline python. v1.0.40.
metadata:
  type: project
---

watch **v1.0.40**. 延续 [[action-forms-and-core-dedup]](managed kill_port/start_cmd/steps 形式)。

### 动机
managed 形式的 `start_dir` 是静态相对 project-dir 的路径,**表达不了运行期才知道的 cwd**
(部署门禁导出动态 staging 路径到 env)。消费方(wdg-lab)因此被迫给 test-instance action
保留内联 `python -c "...glob(start-server.py)...Popen(...)"`,既难测又会在 Windows 漏开终端窗口。

### 改动
- `components/base.py`:`Action` 加 `start_dir_env: str | None`。
- `core/actions.py`:`_exec_managed` 解析 cwd —— `start_dir_env` 命中 env 则
  `Path(os.environ[var]).resolve()` 优先;否则回退 `start_dir`(相对 project-dir);再否则 project-dir。
  加 `import os`。**向后兼容**:不设该字段行为不变。
- `tests/test_actions.py`:两例(override / fallback),断言 start-server.py 收到的 `--project-dir`。
  全套 162 passed。
- README Actions 段 + plugin.json 1.0.39→1.0.40。

### 注意
旧版插件不认新字段(registry 按 `__dataclass_fields__` 静默丢弃)→ 消费方 config 必须在升级到
1.0.40 之后才启用 `start_dir_env`,否则 cwd 静默回退。
