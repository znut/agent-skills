#!/usr/bin/env bash
# Stop hook: in a repo that ships scripts/watch-lane.sh, refuse to end the
# turn while NO watcher (watch-lane.sh) process is alive — the standing-
# watcher pairing rule (re-arm after every fire) enforced mechanically.
# Self-scoping: the gate keys on scripts/watch-lane.sh existing in the
# session's cwd; every other repo exits 0 immediately. Role-scoping: only
# sessions with a /tmp/cc-session-roles marker are gated, each against ITS
# OWN role's watcher. Fail-open: missing cwd, unreadable input, or
# stop_hook_active -> allow.
# Repo opt-out: `- watch_guard: off` under `## Hook settings` in
# .agent/orchestrate.md (legacy: .claude/orchestrate.md).

input=$(cat)

case "$input" in
	*'"stop_hook_active":true'*) exit 0 ;;
esac

cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)
[ -n "$cwd" ] && [ -f "$cwd/scripts/watch-lane.sh" ] || exit 0

for f in "$cwd/.agent/orchestrate.md" "$cwd/.claude/orchestrate.md"; do
	command grep -qE '^[[:space:]]*-[[:space:]]*watch_guard:[[:space:]]*off' "$f" 2>/dev/null && exit 0
done

# Role-scoping: this session's role marker decides WHICH watcher must be
# alive. A bare `pgrep watch-lane.sh` false-passes on a PEER session's
# watcher (all role sessions share the machine), and non-role sessions
# (workers, ad-hoc) own no watcher at all — no marker → out of scope.
sid=$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)
role=""
case "$sid" in ""|*/*|*..*) ;; *) role=$(cat "/tmp/cc-session-roles/$sid" 2>/dev/null || true) ;; esac
[ -n "$role" ] || exit 0

if pgrep -f "watch-lane.sh $role" > /dev/null 2>&1; then
	exit 0
fi

echo "watch-guard: NO $role watcher armed (no 'watch-lane.sh $role' process alive). Re-arm before stopping: ONE persistent Monitor-tool task running single-shot 'bash scripts/watch-lane.sh $role [pr#...]' — on fire: sweep/archive, THEN re-arm a fresh one. Never loop-wrap it (presence-based bus fires re-fire pre-sweep and the rate-limiter kills the watcher); background-bash arming is reap-prone in remote-control sessions." >&2
exit 2
