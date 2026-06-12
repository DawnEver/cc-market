---
name: hook-feedback-channel-hygiene
description: Stop/SessionEnd hooks must not leak slow network ops or git stderr into the feedback channel
metadata:
  type: project
---

Claude Code surfaces a hook's stderr (and a cancelled/timed-out hook) as user-visible
"Stop hook feedback" / "Hook cancelled" noise. Two fixes on 2026-06-12 both stem from this:

**1. traceme SessionEnd "Hook cancelled".** `traceme-hook.js` forced an inline `git commit`
+ network `git push` on `SessionEnd`. The session is tearing down, Claude Code won't wait, so
the hook is killed → "Hook cancelled". Fix: on `SessionEnd`, spawn the push as a detached,
unref'd background process (`node traceme-cli.mjs sync push`, `detached:true, stdio:'ignore',
windowsHide:true`) and return immediately. Stamp `last_push_ms` *before* detaching so a
crashed child doesn't re-push-loop. `Stop` keeps the inline throttled push (session continues).

**2. sharp-review CRLF warning leak.** On Windows with `core.autocrlf`, read-only
`git status --porcelain` / `git diff --shortstat` print "LF will be replaced by CRLF" to
stderr while refreshing the index; `execSync` let it surface as Stop-hook feedback. Fix:
`stdio: ['ignore','pipe','ignore']` on output-capturing git execSync calls — keep stdout,
drop stderr.

**Rule of thumb:** any `execSync` in a hook that captures stdout should also discard stderr;
any slow/network work on `SessionEnd` must be detached, never awaited inline.
