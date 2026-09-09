#!/usr/bin/env bash
# main-health — post-merge verification of a repo's default-branch tip.
#
# Usage: main-health.sh <configName>
#   Reads the "mainHealth" block of $AGENT_TOOLS_HOME/config/<configName>.json:
#     repo         main checkout; only `git fetch` runs there
#     worktree     optional; default <repo>-worktrees/main-health
#     steps        [{ "name": "test", "cmd": "bun run test" }, ...], in order
#     env          optional map exported to every step
#     skipPattern  optional ERE of paths that cannot affect the suite
#                  (default '^docs/|\.md$')
#     stepTimeout  optional seconds per step (default 1800)
#
# The verdict is state.json (`green` true or false, one entry per step);
# boot-report prints it at every PM and TL boot. Runs in a dedicated locked
# worktree at the fetched
# default tip; skips when state.json already records that sha, or when every
# change since the last green run matches skipPattern; reruns once when the
# tip moved during the run. Steps run under nice -n 19 (not taskpolicy -b:
# DARWIN_BG starves test-runner pools under sustained load) with a watchdog
# that kills the step's process tree, and a failed step is retried once.
set -u

CONFIG_NAME="${1:?usage: main-health.sh <configName>}"
HOME_DIR="${AGENT_TOOLS_HOME:-$HOME/.config/agent-tools}"
CONFIG="$HOME_DIR/config/$CONFIG_NAME.json"
[ -f "$CONFIG" ] || { echo "main-health: no config at $CONFIG" >&2; exit 2; }
jq -e '.mainHealth.repo and (.mainHealth.steps | length > 0)' "$CONFIG" >/dev/null 2>&1 \
	|| { echo "main-health: $CONFIG needs mainHealth.repo and mainHealth.steps" >&2; exit 2; }
cfg() { jq -r "$1" "$CONFIG"; }
expand_home() { printf '%s' "${1/#\~/$HOME}"; }

REPO=$(expand_home "$(cfg '.mainHealth.repo')")
WT=$(cfg '.mainHealth.worktree // empty')
WT=${WT:+$(expand_home "$WT")}
WT=${WT:-"$(dirname "$REPO")/$(basename "$REPO")-worktrees/main-health"}
STEP_TIMEOUT=$(cfg '.mainHealth.stepTimeout // 1800')
SKIP_PATTERN=$(cfg '.mainHealth.skipPattern // "^docs/|\\.md$"')
VAR="$HOME_DIR/var/$CONFIG_NAME/main-health"
mkdir -p "$VAR"
while IFS='=' read -r key value; do
	[ -n "$key" ] && export "$key=$value"
done < <(jq -r '.mainHealth.env // {} | to_entries[] | "\(.key)=\(.value)"' "$CONFIG")

LOCK="$VAR/.lock"
if [ -f "$LOCK" ] && kill -0 "$(cat "$LOCK" 2>/dev/null)" 2>/dev/null; then
	exit 0
fi
printf '%s' $$ > "$LOCK"
trap 'rm -f "$LOCK"' EXIT

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >> "$VAR/run.log"; }

default_branch() {
	local ref
	ref=$(git -C "$REPO" symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null || true)
	printf '%s' "${ref:-origin/main}"
}

# Run one step command in the worktree with output to $1, killed with its
# process tree after STEP_TIMEOUT (children carry the worktree path in argv).
run_bounded() {
	local out="$1" cmd="$2"
	(cd "$WT" && nice -n 19 bash -c "$cmd") > "$out" 2>&1 &
	local pid=$!
	(sleep "$STEP_TIMEOUT" && kill -9 "$pid" 2>/dev/null && pkill -9 -f "$WT" 2>/dev/null) &
	local watchdog=$!
	wait "$pid"
	local rc=$?
	kill "$watchdog" 2>/dev/null
	wait "$watchdog" 2>/dev/null
	[ "$rc" -ge 128 ] && log "step killed by watchdog after ${STEP_TIMEOUT}s"
	return "$rc"
}

run_pass() {
	local base
	git -C "$REPO" fetch origin -q
	base=$(default_branch)
	SHA=$(git -C "$REPO" rev-parse "$base")
	if [ -f "$VAR/state.json" ] && grep -q "\"sha\": \"$SHA\"" "$VAR/state.json"; then
		return 0
	fi

	# Every change since the last green run matches the skip pattern: nothing
	# the suite could newly prove, so stamp green without running.
	if [ -f "$VAR/state.json" ] && grep -q '"green": true' "$VAR/state.json"; then
		PREV=$(sed -n 's/.*"sha": "\([0-9a-f]*\)".*/\1/p' "$VAR/state.json" | head -1)
		if [ -n "$PREV" ] && git -C "$REPO" rev-parse -q --verify "$PREV^{commit}" >/dev/null 2>&1 \
			&& ! git -C "$REPO" diff --name-only "$PREV..$SHA" | grep -qvE "$SKIP_PATTERN"; then
			printf '{ "sha": "%s", "finishedAt": "%s", "green": true, "steps": { "skipped": "skip-pattern-only since %s", "_": "end" } }\n' \
				"$SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${PREV:0:8}" > "$VAR/state.json"
			log "run skipped sha=$SHA (skip-pattern-only since ${PREV:0:8})"
			return 0
		fi
	fi
	log "run start sha=$SHA"

	if [ ! -d "$WT" ]; then
		# --lock: a sibling cleanup step reaps unlocked trees.
		git -C "$REPO" worktree add "$WT" --detach --lock --reason main-health "$base" >/dev/null 2>&1 \
			|| { log "worktree add FAILED"; return 1; }
	fi
	git -C "$WT" checkout --detach "$base" -q 2>/dev/null
	git -C "$WT" reset --hard "$base" -q
	git -C "$WT" clean -fd -e node_modules -q 2>/dev/null

	GREEN=true
	STEPS=""
	while IFS=$'\t' read -r name cmd; do
		[ -n "$name" ] || continue
		if run_bounded "$VAR/step-$name.log" "$cmd"; then
			STEPS="$STEPS\"$name\": \"ok\", "
			log "$name: ok"
		elif log "$name: fail — retrying once" && run_bounded "$VAR/step-$name.log" "$cmd"; then
			STEPS="$STEPS\"$name\": \"ok(retry)\", "
			log "$name: ok on retry"
		else
			STEPS="$STEPS\"$name\": \"FAIL\", "
			GREEN=false
			log "$name: FAIL (retried)"
		fi
	done < <(jq -r '.mainHealth.steps[] | "\(.name)\t\(.cmd)"' "$CONFIG")

	printf '{ "sha": "%s", "finishedAt": "%s", "green": %s, "steps": { %s"_": "end" } }\n' \
		"$SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$GREEN" "$STEPS" > "$VAR/state.json"

	if [ "$GREEN" = false ]; then log "run RED sha=$SHA"; else log "run green sha=$SHA"; fi
}

run_pass
# The tip moved during the run: one rerun catches the mid-run merge.
NEW=$(git -C "$REPO" fetch origin -q && git -C "$REPO" rev-parse "$(default_branch)")
if [ -f "$VAR/state.json" ] && ! grep -q "\"sha\": \"$NEW\"" "$VAR/state.json"; then
	run_pass
fi
