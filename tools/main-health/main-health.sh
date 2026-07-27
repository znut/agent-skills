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

run_pass() {
	git -C "$REPO" fetch origin -q
	SHA=$(git -C "$REPO" rev-parse origin/main)
	if [ -f "$VAR/state.json" ] && grep -q "\"sha\": \"$SHA\"" "$VAR/state.json"; then
		return 0
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
		if (cd "$WT" && "$@") > "$VAR/step-$name.log" 2>&1; then
			STEPS="$STEPS\"$name\": \"ok\", "
			log "$name: ok"
		else
			# retry once — concurrent worker suites contend for chromium/CPU and
			# time out; a red alarm must survive an isolated second attempt
			log "$name: fail — retrying once"
			if (cd "$WT" && "$@") > "$VAR/step-$name.log" 2>&1; then
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
