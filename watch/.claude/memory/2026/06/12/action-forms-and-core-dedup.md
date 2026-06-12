---
name: action-forms-and-core-dedup
description: Declarative action forms (kill_port/start_cmd/steps) so config drops inline python-c glob boilerplate; + core dedup (pid_alive/log_event/_project_dir). Plugin commit 5e1082f.
metadata:
  type: project
---

cc-market `watch` commit **5e1082f**. Predecessor to [[reorg-and-deploy-hardening]].

### 新增声明式 action 形式(`components/base.py` + `core/actions.py`)
`Action` 加字段,执行器在 `_execute_action` 处理,**向后兼容**旧 `kill`/`start`/`command`:
- **managed-service**:`kill_port`(int|str|list)、`kill_pattern`、`start_cmd`、`start_dir`、
  `start_log`(后两者相对 project-dir)。执行器从 `Path(__file__).parents[..]/'scripts'/'helpers'`
  解析 bundled `kill-server.py`/`start-server.py`,**不再** glob `~/.claude/plugins/...`
  (安装根 / 缓存布局脆弱)。新增 `_SCRIPTS_DIR`、`_run_script()`、`_exec_managed()`。
- **composition**:`steps: [action_name, ...]` 按序跑其它具名 action(`registry.get_action`)。
- 配置解析无需改:`registry.py` 已 `Action(**{k:v ... if k in __dataclass_fields__})`,新字段自动认。
- deploy gate 也走 `_execute_action`(`git_version_deploy._run_restart` / test_start/kill_action),
  故 managed/steps 在部署链同样可用。
- 测试 `tests/test_actions.py`(5)。

### 消除的重复
- `scripts/watch.py:_pid_alive` 删 → import `core.pidfile.pid_alive`(原逐字复制)。
- `daemon.py:_log` 与 `trigger-watch.py:_log` 的 body 抽到 `core/log.py:log_event(
  project_dir, log_file, level, msg)`;两处留瘦签名适配。
- `daemon.py:_load_config` 包装删;`_project_dir` 注入上移到 `core/config.py:load_config`
  (所有调用方统一拿到,旧版仅 daemon 注入)。
- README「Actions」段记录三种形式。

> 路径以 commit 5e1082f 时为准;[[reorg-and-deploy-hardening]] 之后脚本移到
> `scripts/cli|daemon|helpers`、组件移到 `components/health|resources|versioning|progress`。
