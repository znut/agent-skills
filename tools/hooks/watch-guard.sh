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
# .agent/orchestrate.md.

input=$(cat)

case "$input" in
	*'"stop_hook_active":true'*) exit 0 ;;
esac

cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)
[ -n "$cwd" ] && [ -f "$cwd/scripts/watch-lane.sh" ] || exit 0

command grep -qE '^[[:space:]]*-[[:space:]]*watch_guard:[[:space:]]*off' "$cwd/.agent/orchestrate.md" 2>/dev/null && exit 0

# Role-scoping: this session's role marker decides WHICH watcher must be
# alive. A bare `pgrep watch-lane.sh` false-passes on a PEER session's
# watcher (all role sessions share the machine), and non-role sessions
# (workers, ad-hoc) own no watcher at all — no marker → out of scope.
sid=$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)
role=""
case "$sid" in ""|*/*|*..*) ;; *) role=$(cat "/tmp/cc-session-roles/$sid" 2>/dev/null || true) ;; esac
# A registered generation must match its own watcher, even without a role marker.
script_dir=$(cd "$(dirname "$(realpath "${BASH_SOURCE[0]}")")" && pwd)
if [ -n "$sid" ]; then
	if named=$(cd "$cwd" && bun "$script_dir/../agent-session.mjs" current --session-id "$sid" --harness claude 2>&1); then
		generation=$(printf '%s' "$named" | jq -r .session.generation)
		name=$(printf '%s' "$named" | jq -r .session.name)
		if ps -axo command= | awk -v generation="$generation" '
			{ watch=0; owner=0; for(i=1;i<=NF;i++) {
				if($i ~ /(^|\/)watch-lane\.sh$/) watch=1;
				if($i == "--generation" && $(i+1) == generation) owner=1;
			} if(watch && owner) found=1 } END {exit !found}'; then exit 0; fi
		echo "watch-guard: no watcher armed for $name generation $generation; re-arm with --generation $generation after consuming its inbox" >&2
		exit 2
	else
		code=$?
		if [ "$code" -ne 3 ]; then printf '%s\n' "$named" >&2; exit 2; fi
	fi
fi
[ -n "$role" ] || exit 0

if pgrep -f "watch-lane.sh $role" > /dev/null 2>&1; then
	exit 0
fi

echo "watch-guard: no '$role' watcher alive. Before stopping, arm one persistent Monitor task running 'bash scripts/watch-lane.sh $role [pr#...]'; on fire, sweep and archive, then re-arm. Never loop-wrap it: a re-fire before the sweep kills the watcher." >&2
exit 2
