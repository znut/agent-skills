#!/usr/bin/env bash
# Stop hook: in a repo that ships scripts/watch-lane.sh, refuse to end the
# turn while NO watcher (watch-lane.sh) process is alive — the standing-
# watcher pairing rule (re-arm after every fire) enforced mechanically.
# Self-scoping: the gate keys on scripts/watch-lane.sh existing in the
# session's cwd; every other repo exits 0 immediately. Fail-open: missing
# cwd, unreadable input, or stop_hook_active -> allow.
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

if pgrep -f "watch-lane.sh" > /dev/null 2>&1; then
	exit 0
fi

echo "watch-guard: NO watcher armed (no watch-lane.sh process alive). Re-arm before stopping: bash scripts/watch-lane.sh <role> [pr#...] via run_in_background — arm every lane this session owns." >&2
exit 2
