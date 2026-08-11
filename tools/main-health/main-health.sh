#!/usr/bin/env bash
# main-health — post-merge full-suite verification of a repo's main tip.
#
# Usage: main-health.sh <configName> <repoPath> "<app1 app2 ...>"
#   configName  var-dir name under $AGENT_TOOLS_HOME/var/<name>/main-health/
#   repoPath    primary checkout (only `git fetch` runs against it directly;
#               all work happens in a dedicated worktree)
#   apps        space-separated app dirs (apps/<name>) that get build +
#               screenshots runs; repo-wide typecheck/lint/test always run.
#
# The gate is the pre-merge union check; this runner is the ALARM verifying
# what actually landed. Green = silence (state.json refreshed). Red = a
# monotonic event marker `events/main-health-<sha8>.red` in the config's
# gh-status events dir, which agent sessions already watch.
#
# Reentrancy: pid lockfile (concurrent fire exits quietly). Staleness: skips
# when state.json already records the current origin/main sha; self-reruns
# once when main moved while a run was in flight (a mid-run merge would
# otherwise go unchecked until the next merge event).
#
# Load discipline: this runner is an alarm, so it must never starve real work
# or wedge silently. Three guards, all tunable by env:
#   MAIN_HEALTH_STEP_TIMEOUT  per-step watchdog seconds (default 1800): a step
#                             exceeding it has its process tree killed and the
#                             run goes red instead of hanging forever.
#   MAIN_HEALTH_SKIP_PATTERN  extended-regex of "can't affect the suite" paths
#                             (default '^docs/|\.md$'): when the previous run
#                             was green and every changed path since it matches,
#                             the run is skipped and stamped green.
#   (QoS)                     every step runs at background priority —
#                             `taskpolicy -b` on macOS, `nice -n 19` elsewhere.
set -u

CONFIG_NAME="${1:?usage: main-health.sh <configName> <repoPath> \"<apps>\"}"
REPO="${2:?repo path required}"
APPS="${3:-}"
REPO="${REPO/#\~/$HOME}"
HOME_DIR="${AGENT_TOOLS_HOME:-$HOME/.config/agent-tools}"
VAR="$HOME_DIR/var/$CONFIG_NAME/main-health"
EVENTS="$HOME_DIR/var/$CONFIG_NAME/gh-status/events"
WT="$(dirname "$REPO")/$(basename "$REPO")-worktrees/main-health"
mkdir -p "$VAR"

LOCK="$VAR/.lock"
if [ -f "$LOCK" ] && kill -0 "$(cat "$LOCK" 2>/dev/null)" 2>/dev/null; then
	exit 0
fi
printf '%s' $$ > "$LOCK"
trap 'rm -f "$LOCK"' EXIT

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >> "$VAR/run.log"; }

STEP_TIMEOUT="${MAIN_HEALTH_STEP_TIMEOUT:-1800}"
SKIP_PATTERN="${MAIN_HEALTH_SKIP_PATTERN:-^docs/|\.md$}"
# Background QoS — the alarm must lose CPU contests to real work.
if command -v taskpolicy >/dev/null 2>&1; then QOS="taskpolicy -b"; else QOS="nice -n 19"; fi

# Run "$@" with output to $1, killed after STEP_TIMEOUT. Kill covers the whole
# tree: test-runner children carry the worktree path in argv, so a scoped
# pkill -f "$WT" reaps what a parent-pid kill would orphan.
run_bounded() {
	local out="$1"; shift
	(cd "$WT" && $QOS "$@") > "$out" 2>&1 &
	local cmd=$!
	(sleep "$STEP_TIMEOUT" && kill -9 "$cmd" 2>/dev/null && pkill -9 -f "$WT" 2>/dev/null) &
	local wd=$!
	wait "$cmd"
	local rc=$?
	kill "$wd" 2>/dev/null
	wait "$wd" 2>/dev/null
	[ "$rc" -ge 128 ] && log "step killed by watchdog after ${STEP_TIMEOUT}s (wedge)"
	return "$rc"
}

run_pass() {
	git -C "$REPO" fetch origin -q
	SHA=$(git -C "$REPO" rev-parse origin/main)
	if [ -f "$VAR/state.json" ] && grep -q "\"sha\": \"$SHA\"" "$VAR/state.json"; then
		return 0
	fi

	# Every change since the last GREEN run matches the skip pattern → nothing
	# the suite could newly prove; stamp green without running.
	if [ -f "$VAR/state.json" ] && grep -q '"green": true' "$VAR/state.json"; then
		PREV=$(sed -n 's/.*"sha": "\([0-9a-f]*\)".*/\1/p' "$VAR/state.json" | head -1)
		if [ -n "$PREV" ] && git -C "$REPO" rev-parse -q --verify "$PREV^{commit}" >/dev/null 2>&1; then
			if ! git -C "$REPO" diff --name-only "$PREV..$SHA" | grep -qvE "$SKIP_PATTERN"; then
				printf '{ "sha": "%s", "finishedAt": "%s", "green": true, "steps": { "skipped": "skip-pattern-only since %s", "_": "end" } }\n' \
					"$SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${PREV:0:8}" > "$VAR/state.json"
				log "run skipped sha=$SHA (skip-pattern-only since ${PREV:0:8})"
				return 0
			fi
		fi
	fi
	log "run start sha=$SHA"

	if [ ! -d "$WT" ]; then
		# --lock: sibling on-merge step cleanup-worktrees.sh --apply reaps unlocked trees
		git -C "$REPO" worktree add "$WT" --detach --lock --reason main-health origin/main >/dev/null 2>&1 || { log "worktree add FAILED"; return 1; }
	fi
	git -C "$WT" checkout --detach origin/main -q 2>/dev/null
	git -C "$WT" reset --hard origin/main -q
	git -C "$WT" clean -fd -e node_modules -q 2>/dev/null

	GREEN=true
	STEPS=""
	step() {
		local name="$1"; shift
		if run_bounded "$VAR/step-$name.log" "$@"; then
			STEPS="$STEPS\"$name\": \"ok\", "
			log "$name: ok"
		else
			# retry once — concurrent worker suites contend for chromium/CPU and
			# time out; a red alarm must survive an isolated second attempt
			log "$name: fail — retrying once"
			if run_bounded "$VAR/step-$name.log" "$@"; then
				STEPS="$STEPS\"$name\": \"ok(retry)\", "
				log "$name: ok on retry"
			else
				STEPS="$STEPS\"$name\": \"FAIL\", "
				GREEN=false
				log "$name: FAIL (retried)"
			fi
		fi
	}

	step install bun install --frozen-lockfile
	step typecheck bun run typecheck
	step lint bun run lint
	step test bun run test
	for app in $APPS; do
		step "build-$app" bun run --cwd "apps/$app" build
		if grep -q '"screenshots"' "$WT/apps/$app/package.json" 2>/dev/null; then
			step "screenshots-$app" bun run --cwd "apps/$app" screenshots
		fi
	done

	printf '{ "sha": "%s", "finishedAt": "%s", "green": %s, "steps": { %s"_": "end" } }\n' \
		"$SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$GREEN" "$STEPS" > "$VAR/state.json"

	if [ "$GREEN" = false ]; then
		mkdir -p "$EVENTS"
		printf 'main RED at %s — see %s/state.json + run.log\n' "$SHA" "$VAR" > "$EVENTS/main-health-${SHA:0:8}.red"
		log "run RED sha=$SHA"
	else
		log "run green sha=$SHA"
	fi
}

run_pass
# main moved while we ran? one self-rerun covers the mid-run merge.
NEW=$(git -C "$REPO" fetch origin -q && git -C "$REPO" rev-parse origin/main)
if [ -f "$VAR/state.json" ] && ! grep -q "\"sha\": \"$NEW\"" "$VAR/state.json"; then
	run_pass
fi
