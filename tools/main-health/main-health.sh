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
#   (QoS)                     every step runs at background priority via
#                             `nice -n 19` on every platform. NOT `taskpolicy
#                             -b` on macOS: that maps to Darwin's DARWIN_BG
#                             QoS class, which is a hard throttle rather than
#                             nice's proportional-share deprioritization — on
#                             a machine that's *continuously* near its core
#                             count in interactive load (the normal state
#                             here, many parallel worker sessions), DARWIN_BG
#                             starves the pool-workers parent (vitest/node)
#                             to a near-zero CPU duty cycle indefinitely. Its
#                             already-spawned workerd pool children idle
#                             correctly (near-0% CPU, waiting on a parent
#                             handshake) but the starved parent never gets
#                             enough scheduling to complete that handshake,
#                             so pool startup times out or hangs to the step
#                             watchdog — confirmed live against the real
#                             on-merge run's process tree (#2120): orchestrator
#                             parents at ~3% CPU duty cycle over 20+ minutes,
#                             workerd children frozen at ~0.2s CPU each since
#                             spawn. nice -n 19 still yields to interactive
#                             work without that catastrophic-starvation mode.
set -u

# Gate-context CPU bound: caps workerd parallelism per workspace (test +
# screenshots read this in their vitest configs). scripts/verify-gate.sh
# exports the same var, but that export only reaches ITS OWN process tree —
# main-health.sh is a wholly separate invocation (launchd -> on-merge ->
# this script), never a child of verify-gate.sh, so it does NOT inherit it
# despite verify-gate.sh's own comment assuming it would. Left unset, each
# vitest.config falls back to an unbounded pool (~ncpu-1 workerd processes
# PER workspace on this box), and `bun run test` below fans out every
# pool-backed workspace at once — ~5-6 heavy workspaces x that many workerd
# processes each, all needing to complete a startup handshake with their
# (already CPU-constrained, see the QoS note below) parent concurrently.
# That aggregate fan-out, not the QoS class alone, is the dominant driver of
# `[vitest-pool]: Timeout starting cloudflare-pool runner` (#2120/#2121).
export EZOPD_TEST_POOL_MAX="${EZOPD_TEST_POOL_MAX:-6}"

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
# Background QoS — the alarm must lose CPU contests to real work. See the
# (QoS) note in the header: nice, not taskpolicy -b, on every platform.
QOS="nice -n 19"

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

	# Enumerate testable workspaces the same way verify-plan.mjs does (apps/,
	# packages/, platform/, plus scripts/ as a special case) — reimplemented
	# in bash rather than shelling out to that module, since it also derives
	# a diff-scoped dependent closure this runner has no use for (main-health
	# always verifies everything at the current tip, never a diff).
	test_workspaces() {
		local group d w
		for group in apps packages platform; do
			[ -d "$WT/$group" ] || continue
			for d in "$WT/$group"/*/; do
				w="$group/$(basename "$d")"
				[ -f "$WT/$w/package.json" ] || continue
				grep -q '"test"' "$WT/$w/package.json" 2>/dev/null && printf '%s\n' "$w"
			done
		done
		if [ -f "$WT/scripts/package.json" ] && grep -q '"test"' "$WT/scripts/package.json" 2>/dev/null; then
			printf '%s\n' "scripts"
		fi
	}

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

	# test runs ONE workspace at a time — not the plain `bun run test`
	# (`--filter '*' test`) this used to be, which fanned out every
	# pool-backed workspace's own workerd pool concurrently: ~5-6 heavy
	# workspaces x up to EZOPD_TEST_POOL_MAX workerd processes each, all
	# starting up at once. That aggregate fan-out is the residual risk the
	# QoS + POOL_MAX fixes above don't fully close under peak interactive
	# load (#2120/#2121 follow-up: a run still wedged its test step at 1800s
	# with both fixes in place, under a machine saturated by other worker
	# suites). Serializing removes the aggregate entirely: at most ONE
	# workspace's (already EZOPD_TEST_POOL_MAX-capped) pool is ever starting
	# up at a time.
	#
	# Watchdog: run_bounded is now called once PER WORKSPACE instead of once
	# for the whole step, so STEP_TIMEOUT (1800s) becomes a per-workspace
	# ceiling for free — a wedged workspace no longer burns the full budget
	# twice (this step's old single-command retry) before any OTHER
	# workspace even gets a turn, and the retry-once below is scoped to just
	# the workspace that failed. Deliberately NOT a shorter per-workspace
	# timeout: 1800s matches every other step's ceiling here, and now that
	# the dominant failure mode (aggregate fan-out) is gone, it's a rare
	# backstop rather than the expected path — a real pathological worst
	# case (every workspace wedges) would still be bounded by however many
	# workspaces exist, same as any other sequential step loop below.
	{
		: > "$VAR/step-test.log"
		test_ok=true
		test_retried=false
		while IFS= read -r ws; do
			[ -z "$ws" ] && continue
			tmp="$VAR/.step-test-${ws//\//-}.log"
			printf '\n=== %s ===\n' "$ws" >> "$VAR/step-test.log"
			if run_bounded "$tmp" bun run --cwd "$ws" test; then
				cat "$tmp" >> "$VAR/step-test.log"
				log "test $ws: ok"
			else
				cat "$tmp" >> "$VAR/step-test.log"
				log "test $ws: fail — retrying once"
				printf -- '--- %s retry ---\n' "$ws" >> "$VAR/step-test.log"
				if run_bounded "$tmp" bun run --cwd "$ws" test; then
					cat "$tmp" >> "$VAR/step-test.log"
					test_retried=true
					log "test $ws: ok on retry"
				else
					cat "$tmp" >> "$VAR/step-test.log"
					test_ok=false
					log "test $ws: FAIL (retried)"
				fi
			fi
			rm -f "$tmp"
		done < <(test_workspaces)
		if [ "$test_ok" = true ]; then
			if [ "$test_retried" = true ]; then
				STEPS="$STEPS\"test\": \"ok(retry)\", "
			else
				STEPS="$STEPS\"test\": \"ok\", "
			fi
		else
			STEPS="$STEPS\"test\": \"FAIL\", "
			GREEN=false
		fi
	}

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
