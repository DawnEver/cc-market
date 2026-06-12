---
name: reorg-and-deploy-hardening
description: Plugin moved to functional subpackages (scripts/cli|daemon|helpers, components/health|resources|versioning|progress) + deploy-safety hardening (atomic writes, locks, fetch classification, audit). New launch paths. Commit d8265c0.
metadata:
  type: project
---

cc-market `watch` commit **d8265c0** (after [[action-forms-and-core-dedup]]). 文件重组 +
无人值守部署加固一并落地。144 tests pass(原 124,+20)。

### 新文件布局(旧平铺路径已失效)
```
scripts/bootstrap.py                 # 仍在 scripts/ 根(所有人 import)
scripts/cli/    watch.py  send_alert.py  trigger-emit.py
scripts/daemon/ daemon.py(原 watchd/daemon.py)  trigger-watch.py
scripts/helpers/ start-server.py  kill-server.py
components/base.py  registry.py     # 仍在根
components/health/    http_health  watchd_heartbeat  shell_probe
components/resources/ disk_usage  process_monitor  log_scanner
components/versioning/ git_version  git_version_deploy
components/progress/  progress_tracker
```
`watchd/` 已删。`registry.py` 发现改递归 `rglob('*.py')`(排除 `_*`/base/registry)。
**已同步的路径引用**:`core/actions._SCRIPTS_DIR`(→scripts/helpers)、
`trigger-watch.WATCH_PY`(→scripts/cli/watch.py)、**`hooks/alert-hook.js`**
(→scripts/cli/send_alert.py,漏改会让告警邮件静默失效)、commands/*.md、README、
skills/reference/*、tests sys.path。moved entrypoint 的 `parents[N]` 深度已修
(cli=3 parents,daemon=`_HERE.parent.parent`)。bootstrap 未移,`parent.parent`=root 不变。
plugin.json 仍 **v1.0.31** —— 结构变更,建议下次发布 bump。

### Deploy 安全加固(`core/state.py` + `components/versioning/*`)
- 所有 state JSON(known-good / deploy_failures / monitor)改 **原子写**(tmp+os.replace)
  + 跨平台 advisory 文件锁(O_CREAT|O_EXCL 重试),并发 watchd/trigger-watch/AI 不再丢更新。
- **deploy 进行中锁**:并发第二个 deploy 干净退出;stale 锁按 pid liveness 接管。
- worktree 清理幂等 + Windows 退避重试再回退 rmtree。
- git fetch 失败分类(auth/network/corrupt)写进 fetch_unreachable 消息。
- 每次 deploy 结构化审计 → `logs/deploy.jsonl`。
- start-server 加启动存活探针 + Windows STARTUPINFO;kill-server 杀后复核端口释放、netstat 解析健壮化。
- 测试:`tests/test_process_control.py` 等 +20。

### 仍未做(评审列出,本轮未改)
known-good 多快照历史回退;daemon 与 AI loop 重复 track 异常计数去重;
remedy 链双处声明(组件硬编码 vs config)优先级统一。
