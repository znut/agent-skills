#!/usr/bin/env bash
# boot-report.sh — one-call session boot state collector for TL/PM roles.
#
# Usage: tools/boot-report.sh <pm|tl-product|tl-platform>
#
# Read-only. Prints bounded, labeled sections from the current project checkout.
# No cursors are advanced, no archives touched, no state written.
#
# Role scoping: the pm role reads only its own lane — gh-status and the
# comment-cursor delta cover issue logs + PRs labeled `pm` (bot-only logs
# dropped), Open PRs lists pm-labeled PRs plus a count of the rest, Worktree
# hygiene is a one-line count. TL roles get every section in full.
#
# Path resolution follows the repo's existing convention: parse
# .agent/orchestrate.local.md, else .pi/ or .claude/orchestrate.local.md (prefer the one
# matching the current harness env vars, else .pi), reading the second backtick
# field of lines shaped `- `key`: `value``.
set -euo pipefail

role="${1:-}"
case "$role" in
	pm) inbox_name="pm-inbox" ;;
	tl-product) inbox_name="tl-product-inbox" ;;
	tl-platform) inbox_name="tl-platform-inbox" ;;
	*)
		echo "usage: ${0##*/} <pm|tl-product|tl-platform>" >&2
		exit 2
		;;
esac

# Write pi session role marker for bgh self-log auto-derivation.
if [ -n "${PI_SESSION_ID:-}" ]; then
	case ${PI_SESSION_ID} in
		*/*|*..*) : ;; # path-unsafe session id: skip
		*)
			mkdir -p /tmp/pi-session-roles 2>/dev/null &&
				printf '%s\n' "$role" > "/tmp/pi-session-roles/${PI_SESSION_ID}" 2>/dev/null || true ;;
	esac
fi

repo_root=$(git rev-parse --show-toplevel)
cd "$repo_root"

# Single temp dir for all intermediate files; trap cleans it on exit.
tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

# --- helpers ---------------------------------------------------------------

section() { printf '\n## %s\n' "$*"; }

path_of() { # <key> <local_md>
	local v
	v=$(grep -m1 "^- \`$1\`" "$2" 2>/dev/null | sed -n 's/^- `[^`]*`: `\([^`]*\)`.*/\1/p')
	printf '%s' "${v/#\~/$HOME}"
}

find_local_md() {
	# .agent/orchestrate.local.md is the harness-neutral location (ez-opd #2444);
	# the per-harness files are the legacy fallback for un-migrated machines.
	local agent_md="$repo_root/.agent/orchestrate.local.md"
	local pi_md="$repo_root/.pi/orchestrate.local.md"
	local claude_md="$repo_root/.claude/orchestrate.local.md"
	if [ -f "$agent_md" ]; then
		printf '%s' "$agent_md"
	elif [ -f "$pi_md" ] && [ -f "$claude_md" ]; then
		if [ -n "${PI_CODING_AGENT:-}" ]; then
			printf '%s' "$pi_md"
		elif [ -n "${CLAUDE_CODE_SESSION_ID:-}" ]; then
			printf '%s' "$claude_md"
		else
			printf '%s' "$pi_md"
		fi
	elif [ -f "$pi_md" ]; then
		printf '%s' "$pi_md"
	elif [ -f "$claude_md" ]; then
		printf '%s' "$claude_md"
	fi
}

human_age() { # <seconds>
	local s=$1
	if [ "$s" -lt 60 ]; then printf '%ds' "$s"; return; fi
	if [ "$s" -lt 3600 ]; then printf '%dm' $((s / 60)); return; fi
	if [ "$s" -lt 86400 ]; then printf '%dh' $((s / 3600)); return; fi
	printf '%dd' $((s / 86400))
}

isodate_to_epoch() {
	# macOS date -j can't parse all ISO8601 variants; try GNU then BSD.
	local s=$1
	if date -d "$s" +%s >/dev/null 2>&1; then
		date -d "$s" +%s
	else
		local cleaned
		cleaned=$(printf '%s' "$s" | sed -E 's/\.[0-9]+(Z|[+-][0-9:]+)?$//')
		date -j -f '%Y-%m-%dT%H:%M:%S' "$cleaned" +%s 2>/dev/null || printf '0'
	fi
}

resolve_bot_login() {
	local login=""
	local ghw
	ghw=$(gh_bin)
	if [ "$ghw" = "bgh" ]; then
		login=$(bgh api user -q .login 2>/dev/null || true)
	fi
	[ -n "$login" ] || login=$(gh api user -q .login 2>/dev/null || true)
	[ -n "$login" ] || login=$(git config user.name 2>/dev/null || true)
	printf '%s' "$login"
}

gh_bin() {
	if [ "$(git config --get agent.gh-wrapper 2>/dev/null || true)" = "bgh" ]; then
		printf '%s' 'bgh'
	else
		printf '%s' 'gh'
	fi
}

file_mtime() {
	local f=$1
	# GNU first, then BSD.
	stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null || printf '0'
}

# --- resolve local paths ---------------------------------------------------

local_md=$(find_local_md)
if [ -n "$local_md" ]; then
	gh_status_dir=$(path_of gh_status_dir "$local_md")
	board_snapshot_file=$(path_of board_snapshot_file "$local_md")
	session_bus_dir=$(path_of session_bus_dir "$local_md")
	comment_cursor_dir=$(path_of comment_cursor_dir "$local_md")
else
	gh_status_dir=''
	board_snapshot_file=''
	session_bus_dir=''
	comment_cursor_dir=''
fi

printf '# boot-report — role: %s\n' "$role"

# 1. Identity
section Identity
ghw=$(gh_bin)
identity=""
if [ "$ghw" = "bgh" ]; then
	if identity=$(bgh api user -q .login 2>/dev/null); then
		printf 'identity: %s (via bgh)\n' "${identity:-(empty)}"
	else
		printf 'identity: unavailable (bgh call failed)\n'
	fi
else
	printf 'identity: no agent.gh-wrapper=bgh; using gh fallback\n'
	if identity=$(gh api user -q .login 2>/dev/null); then
		printf 'identity: %s (via gh)\n' "${identity:-(empty)}"
	else
		printf 'identity: unavailable (gh call failed)\n'
	fi
fi

bot="$identity"
[ -n "$bot" ] || bot=$(resolve_bot_login)

# 2. Base ancestry
section "Base ancestry"
if git fetch origin -q 2>/dev/null; then
	printf 'fetch:   ok\n'
else
	printf 'fetch:   FAILED (origin refs may be stale)\n'
fi
default_branch=$(git rev-parse --abbrev-ref --verify origin/HEAD 2>/dev/null || true)
default_branch=${default_branch#origin/}
if [ -z "$default_branch" ]; then
	default_branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)
fi

local_sha=$(git rev-parse --verify HEAD 2>/dev/null || true)
remote_sha=$(git rev-parse --verify "origin/${default_branch}" 2>/dev/null || true)
local_short=$(printf '%s' "$local_sha" | cut -c1-8)
remote_short=$(printf '%s' "$remote_sha" | cut -c1-8)

printf 'default: %s\n' "$default_branch"
printf 'local:   %s\n' "${local_short:-N/A}"
printf 'remote:  %s\n' "${remote_short:-N/A}"

if [ -z "$remote_sha" ]; then
	printf 'warn: cannot resolve origin/%s\n' "$default_branch"
elif [ "$local_sha" = "$remote_sha" ]; then
	printf 'state:   same as origin\n'
elif git merge-base --is-ancestor HEAD "origin/${default_branch}" 2>/dev/null; then
	printf 'state:   local is ancestor of remote (behind)\n'
elif git merge-base --is-ancestor "origin/${default_branch}" HEAD 2>/dev/null; then
	printf 'warn: local ahead of origin/%s — unpublished commits\n' "$default_branch"
else
	printf 'warn: local and origin/%s diverged\n' "$default_branch"
fi

# 2b. Rules freshness — skip the full rules read when nothing under .agent/ moved.
# Stamp is written by the AGENT after it reads (this script stays read-only);
# the exact command is printed so the stamp is one paste away.
section "Rules freshness"
var_dir=''
if [ -n "$session_bus_dir" ]; then var_dir=$(dirname "$session_bus_dir"); fi
if [ -z "$var_dir" ]; then var_dir="$HOME/.config/agent-tools/var/$(basename "$repo_root")"; fi
rules_tree=$(git rev-parse --verify "origin/${default_branch}:.agent" 2>/dev/null || true)
rules_stamp="$var_dir/rules-read/${role}.stamp"
if [ -z "$rules_tree" ]; then
	printf 'rules:   no .agent/ tree on origin/%s (legacy .claude/orchestrate.md — read it)\n' "$default_branch"
else
	rules_short=$(printf '%s' "$rules_tree" | cut -c1-8)
	if [ -f "$rules_stamp" ]; then
		read -r stamp_tree stamp_date < "$rules_stamp" || true
		if [ "$stamp_tree" = "$rules_tree" ]; then
			printf 'rules:   .agent/@%s UNCHANGED since %s → skip the rules read; grep one section only when a rule is in doubt\n' "$rules_short" "${stamp_date:-?}"
		else
			printf 'rules:   .agent/@%s CHANGED since %s (was %s) → read the changed files only:\n' "$rules_short" "${stamp_date:-?}" "$(printf '%s' "$stamp_tree" | cut -c1-8)"
			git diff-tree --name-only -r "$stamp_tree" "$rules_tree" 2>/dev/null | sed 's/^/  .agent\//' || true
			printf 'stamp:   mkdir -p %s && echo "%s %s" > %s\n' "$(dirname "$rules_stamp")" "$rules_tree" "$(date +%F)" "$rules_stamp"
		fi
	else
		printf 'rules:   .agent/@%s never read by role %s → read .agent/orchestrate.md + the files it names, then stamp:\n' "$rules_short" "$role"
		printf 'stamp:   mkdir -p %s && echo "%s %s" > %s\n' "$(dirname "$rules_stamp")" "$rules_tree" "$(date +%F)" "$rules_stamp"
	fi
fi

# 2c. Handoff note — the previous same-role session's note (harness-neutral,
# ez-opd #2445 shape). Printed bounded; the agent folds it into the ready report.
section "Handoff note"
handoff="$var_dir/notes/${role}.md"
if [ -f "$handoff" ]; then
	printf 'file:    %s (modified %s)\n' "$handoff" "$(date -r "$handoff" '+%Y-%m-%d %H:%M' 2>/dev/null || stat -c %y "$handoff" 2>/dev/null | cut -c1-16)"
	head -80 "$handoff"
	if [ "$(wc -l < "$handoff")" -gt 80 ]; then printf '… (truncated at 80 lines; note should stay shorter)\n'; fi
else
	printf '(none at %s)\n' "$handoff"
fi

# 2d. Memory index — Claude Code auto-memory index for this checkout, if any.
# It is loaded into EVERY session's context, so size is a standing cost;
# flag a prune when it grows past ~100 lines or the last prune is > 7 days old.
section "Memory index"
mem_slug=$(printf '%s' "$repo_root" | sed 's|/|-|g')
mem_index="$HOME/.claude/projects/${mem_slug}/memory/MEMORY.md"
if [ -f "$mem_index" ]; then
	mem_lines=$(wc -l < "$mem_index" | tr -d ' ')
	mem_bytes=$(wc -c < "$mem_index" | tr -d ' ')
	mem_stamp="$(dirname "$mem_index")/.prune-stamp"
	stale=0
	if [ -f "$mem_stamp" ]; then
		if [ -n "$(find "$mem_stamp" -mtime +7 2>/dev/null)" ]; then stale=1; fi
		last_prune=$(date -r "$mem_stamp" +%F 2>/dev/null || echo '?')
	else
		stale=1; last_prune='never'
	fi
	verdict='ok'
	if [ "$mem_lines" -gt 100 ] || [ "$stale" -eq 1 ]; then verdict='PRUNE DUE — one line per memory, hooks ≤ ~80 chars, delete consumed handoffs, then: touch '"$mem_stamp"; fi
	printf 'index:   %s lines · %s bytes · last prune %s · %s\n' "$mem_lines" "$mem_bytes" "$last_prune" "$verdict"
else
	printf '(no Claude memory index for this checkout)\n'
fi

# 3. Bus inbox
section "Bus inbox"
if [ -z "$session_bus_dir" ]; then
	printf 'skipped: session_bus_dir not declared (no orchestrate.local.md)\n'
else
	inbox="$session_bus_dir/$inbox_name"
	if [ ! -d "$inbox" ]; then
		printf 'missing: %s\n' "$inbox"
	else
		# unread = *.md directly in inbox, excluding archive/
		mail_tmp="$tmpdir/mails"
		find "$inbox" -maxdepth 1 -name '*.md' -type f | sort | head -20 > "$mail_tmp"
		mail_count=$(wc -l < "$mail_tmp" | tr -d ' ')
		if [ "$mail_count" -eq 0 ]; then
			printf 'empty\n'
		else
			while IFS= read -r m; do
				[ -n "$m" ] || continue
				printf -- '---\n'
				printf 'file: %s\n' "${m##*/}"
				# frontmatter (if marked) + first ~5 body lines, bounded
				head -n 12 "$m"
			done < "$mail_tmp"
		fi
		left=$(find "$inbox" -maxdepth 1 -name '*.md' -type f | wc -l | tr -d ' ')
		[ "$left" -gt 20 ] && printf '(showing 20 of %s)\n' "$left" || true
	fi
fi

# Open PRs are fetched once here: the pm role scopes gh-status, the
# comment-cursor delta, and the Open PRs list to its own lane (label `pm`)
# plus issue logs — TL-lane PR churn is the TL sessions' state, not the PM's.
prs_json=''
prs_failed=0
if ! prs_json=$("$ghw" pr list --state open --json number,title,labels,headRefName,isDraft,updatedAt 2>/dev/null); then
	prs_failed=1
	prs_json=''
fi
lane_logs_tmp="$tmpdir/lane-logs"
touch "$lane_logs_tmp"
lane_scoped=0
if [ "$role" = "pm" ]; then
	lane_scoped=1
	lane_pr_numbers=$(printf '%s' "$prs_json" | jq -r '.[] | select(.labels | map(.name) | index("pm")) | .number' 2>/dev/null || true)
fi
# lane_log_ok <path>: 0 when the role reads this event log at boot.
lane_log_ok() {
	[ "$lane_scoped" -eq 1 ] || return 0
	case "${1##*/}" in
		issue-*.log) return 0 ;;
		pr-*.log)
			n=${1##*/pr-}; n=${n%.log}
			printf '%s\n' "$lane_pr_numbers" | grep -qx "$n"
			;;
		*) return 1 ;;
	esac
}

# 4. gh-status
section "gh-status"
if [ -z "$gh_status_dir" ]; then
	printf 'skipped: gh_status_dir not declared (no orchestrate.local.md)\n'
elif [ ! -d "$gh_status_dir" ]; then
	printf 'missing: %s — fall back to plain gh\n' "$gh_status_dir"
else
	state_file="$gh_status_dir/status/state.json"
	if [ ! -f "$state_file" ]; then
		printf 'missing: %s/status/state.json — poller may not have run yet\n' "$gh_status_dir"
	else
		now=$(date +%s)
		mtime=$(file_mtime "$state_file")
		age=$((now - mtime))
		if [ "$age" -gt 300 ]; then
			printf 'state: %s old (stale)\n' "$(human_age "$age")"
		else
			printf 'state: %s old\n' "$(human_age "$age")"
		fi
		# Role lane PRs are not determinable from state.json alone; show recent events.
		events_dir="$gh_status_dir/events"
		if [ -d "$events_dir" ]; then
			printf 'recent events (last 3 per log; body shown only for non-bot comments):\n'
			event_tmp="$tmpdir/events"
			# GNU find -printf path
			event_all_tmp="$tmpdir/events-all"
			find "$events_dir" -maxdepth 1 -type f \( -name 'pr-*.log' -o -name 'issue-*.log' \) -printf '%T@ %p\n' 2>/dev/null | sort -rn | cut -d' ' -f2- > "$event_all_tmp" || true
			if [ ! -s "$event_all_tmp" ]; then
				# BSD fallback: sort by mtime via stat.
				find "$events_dir" -maxdepth 1 -type f \( -name 'pr-*.log' -o -name 'issue-*.log' \) -exec stat -f '%m %N' {} + 2>/dev/null | sort -rn | cut -d' ' -f2- > "$event_all_tmp" || true
			fi
			omitted=0
			bot_only=0
			while IFS= read -r log; do
				[ -n "$log" ] || continue
				if ! lane_log_ok "$log"; then
					omitted=$((omitted + 1))
					continue
				fi
				# pm lane: a log whose last 3 events are all bot-authored is the
				# bot's own ticket churn — nothing for the PM to act on.
				if [ "$lane_scoped" -eq 1 ] && ! tail -3 "$log" 2>/dev/null | grep '"actor":"' | grep -qv "\"actor\":\"$bot\""; then
					bot_only=$((bot_only + 1))
					continue
				fi
				printf '%s\n' "$log" >> "$event_tmp"
			done < "$event_all_tmp"
			head -20 "$event_tmp" > "$event_tmp.top" && mv "$event_tmp.top" "$event_tmp"
			if [ "$lane_scoped" -eq 1 ]; then
				printf '  (pm lane: issue logs + PRs labeled pm; %s TL-lane PR logs + %s bot-only lane logs omitted)\n' "$omitted" "$bot_only"
			fi
			while IFS= read -r log; do
				[ -n "$log" ] || continue
				[ -f "$log" ] || continue
				log_mtime=$(file_mtime "$log")
				printf '  %s (last %s): ' "${log##*/}" "$(human_age $((now - log_mtime)) )"
				tail -3 "$log" 2>/dev/null | jq -r --arg bot "$bot" '
					"\(.type)@\(.at[0:16]) \(.actor // "-")"
					+ (if .type == "commented" and (.actor // "") != $bot
					   then " — " + ((.body // "") | gsub("\n"; " ") | .[0:120])
					   else "" end)' 2>/dev/null | paste -sd ';' - | cut -c1-400 | tr -d '\n' || true
				printf '\n'
			done < "$event_tmp"
		else
			printf 'missing: events dir\n'
		fi
	fi
fi

# 5. Open PRs
section "Open PRs"
if [ "$prs_failed" -eq 1 ]; then
	printf 'unavailable (%s pr list failed — not "none"; check auth/wrapper)\n' "$ghw"
elif [ -z "$prs_json" ] || [ "$prs_json" = "[]" ]; then
	printf 'none\n'
elif [ "$lane_scoped" -eq 1 ]; then
	lane_json=$(printf '%s' "$prs_json" | jq '[.[] | select(.labels | map(.name) | index("pm"))]' 2>/dev/null || printf '[]')
	lane_count=$(printf '%s' "$lane_json" | jq 'length' 2>/dev/null || printf '0')
	count=$(printf '%s' "$prs_json" | jq 'length' 2>/dev/null || printf '0')
	if [ "$lane_count" -eq 0 ]; then
		printf 'none in the pm lane (label pm)\n'
	else
		printf '%s' "$lane_json" | jq -r '.[] | "#\(.number) \(.isDraft // false | if . then "[DRAFT] " else "" end)\(.title) [\(.headRefName)] (\(.updatedAt))"' 2>/dev/null | head -20
	fi
	printf 'other open PRs: %s (TL lanes, omitted)\n' "$((count - lane_count))"
else
	printf '%s' "$prs_json" | jq -r '.[] | "#\(.number) \(.isDraft // false | if . then "[DRAFT] " else "" end)\(.title) [\(.headRefName)] (\(.updatedAt))"' 2>/dev/null | head -20
	count=$(printf '%s' "$prs_json" | jq 'length' 2>/dev/null || printf '0')
	[ "$count" -gt 20 ] 2>/dev/null && printf '(showing 20 of %s)\n' "$count" || true
fi

# 6. Comment-cursor delta
section "Comment-cursor delta"
if [ -z "$comment_cursor_dir" ]; then
	printf 'skipped: comment_cursor_dir not declared (no orchestrate.local.md)\n'
else
	cursor_file="$comment_cursor_dir/$role.json"
	if [ ! -f "$cursor_file" ]; then
		printf 'missing: %s\n' "$cursor_file"
	elif [ -z "$gh_status_dir" ] || [ ! -d "$gh_status_dir/events" ]; then
		printf 'skipped: no gh-status events dir to diff against\n'
	else
		last_seen=$(jq -r '.last_seen // empty' "$cursor_file" 2>/dev/null || true)
		if [ -z "$last_seen" ]; then
			printf 'empty cursor: %s\n' "$cursor_file"
		else
			printf 'cursor:  %s (NOT advancing)\n' "$last_seen"
			last_epoch=$(isodate_to_epoch "$last_seen")
			deltas=0
			while IFS= read -r line; do
				[ -n "$line" ] || continue
				created=$(printf '%s' "$line" | jq -r '.at // empty' 2>/dev/null || true)
				[ -n "$created" ] || continue
				created_epoch=$(isodate_to_epoch "$created")
				[ "$created_epoch" -gt "$last_epoch" ] || continue
				type=$(printf '%s' "$line" | jq -r '.type // empty' 2>/dev/null || true)
				[ "$type" = "commented" ] || continue
				actor=$(printf '%s' "$line" | jq -r '.actor // empty' 2>/dev/null || true)
				if [ -n "$bot" ] && [ "$actor" = "$bot" ]; then
					continue
				fi
				if [ "$deltas" -eq 0 ]; then
					printf 'comments since cursor (stakeholder only; bot filtered):\n'
				fi
				[ "$deltas" -ge 20 ] && continue
				body=$(printf '%s' "$line" | jq -r '.body // empty' 2>/dev/null | tr '\n' ' ' | sed 's/  */ /g' | cut -c1-120)
				printf '  %s | %s | %s\n' "$created" "$actor" "$body"
				deltas=$((deltas + 1))
			done < <(find "$gh_status_dir/events" -maxdepth 1 -type f \( -name 'pr-*.log' -o -name 'issue-*.log' \) 2>/dev/null | while IFS= read -r log; do lane_log_ok "$log" && cat "$log"; done | sort -u)
			if [ "$deltas" -eq 0 ]; then
				if [ "$lane_scoped" -eq 1 ]; then
					printf 'no new stakeholder comments in the pm lane (issue logs + PRs labeled pm)\n'
				else
					printf 'no new stakeholder comments\n'
				fi
			fi
		fi
	fi
fi

# 7. Board Ready rows
section "Board Ready rows"
if [ -z "$board_snapshot_file" ]; then
	printf 'skipped: board_snapshot_file not declared (no orchestrate.local.md)\n'
elif [ ! -f "$board_snapshot_file" ]; then
	printf 'missing: %s\n' "$board_snapshot_file"
else
	now=$(date +%s)
	mtime=$(file_mtime "$board_snapshot_file")
	age=$((now - mtime))
	if [ "$age" -gt 3600 ]; then
		printf 'snapshot: %s old (stale)\n' "$(human_age "$age")"
	else
		printf 'snapshot: %s old\n' "$(human_age "$age")"
	fi
	# Role-specific lane filtering is not determinable from a generic snapshot;
	# show all rows whose Status column is Ready.
	board_filter="${BOOT_BOARD_FILTER:-.}"
	ready_rows=$(grep '| Ready |' "$board_snapshot_file" 2>/dev/null | grep -E -- "$board_filter" | head -20)
	if [ -z "$ready_rows" ]; then
		printf 'no Ready rows\n'
	else
		if [ -n "${BOOT_BOARD_FILTER:-}" ]; then
			printf '(filter: BOOT_BOARD_FILTER=%s)\n' "$BOOT_BOARD_FILTER"
		else
			printf '(no lane filter — set BOOT_BOARD_FILTER to an ERE, e.g. "Control Plane|Platform|Shared")\n'
		fi
		printf '%s\n' "$ready_rows"
		total=$(grep '| Ready |' "$board_snapshot_file" 2>/dev/null | grep -E -- "$board_filter" | wc -l | tr -d ' ')
		[ "$total" -gt 20 ] && printf '(showing 20 of %s)\n' "$total" || true
	fi
fi

# 8. Worktree hygiene — the pm role gets counts only: the trees belong to the
# TL lanes' workers, and the pm's own docs worktrees are short-lived.
section "Worktree hygiene"
wt_out="$tmpdir/worktree-out"
touch "$wt_out"
wt_emit() { if [ "$lane_scoped" -eq 1 ]; then printf '%s\n' "$*" >> "$wt_out"; else printf '%s\n' "$*"; fi; }
wt_tmp="$tmpdir/worktree"
wt_reason_tmp="$tmpdir/worktree-locked"
touch "$wt_tmp" "$wt_reason_tmp"
git worktree list --porcelain > "$wt_tmp"

# Parse porcelain line-by-line: track current worktree, gather the locked
# reason line, and flag dead pid locks. Fully portable bash/awk subset.
current_wt=''
locked_reason=''
while IFS= read -r line; do
	case "$line" in
		worktree*)
			# Emit previous worktree's lock if any.
			if [ -n "$current_wt" ] && [ -n "$locked_reason" ]; then
				printf '%s\t%s\n' "$current_wt" "$locked_reason" >> "$wt_reason_tmp"
			fi
			current_wt=${line#worktree }
			locked_reason=''
			;;
		locked*)
			locked_reason=${line#locked}
			locked_reason=${locked_reason# }
			;;
		prunable*)
			wt_emit "prunable: $current_wt (${line#prunable })"
			;;
	esac
done < "$wt_tmp"
if [ -n "$current_wt" ] && [ -n "$locked_reason" ]; then
	printf '%s\t%s\n' "$current_wt" "$locked_reason" >> "$wt_reason_tmp"
fi

while IFS=$'\t' read -r wt reason; do
	[ -n "$wt" ] || continue
	pid=$(printf '%s' "$reason" | grep -oE 'pid:[0-9]+' | head -1 | cut -d: -f2 || true)
	if [ -z "$pid" ]; then
		wt_emit "locked (no pid): $wt"
	elif ! kill -0 "$pid" 2>/dev/null; then
		wt_emit "locked with DEAD pid $pid: $wt"
	fi
done < "$wt_reason_tmp"

# local branches with no remote counterpart
while IFS= read -r branch; do
	[ -n "$branch" ] || continue
	if ! git rev-parse --verify "origin/$branch" >/dev/null 2>&1; then
		wt_emit "no remote counterpart: $branch"
	fi
done < <(git for-each-ref refs/heads --format='%(refname:short)')
if [ "$lane_scoped" -eq 1 ]; then
	printf 'prunable: %s · dead-pid locked: %s · locked (no pid): %s · no remote counterpart: %s — TL-lane trees; run boot-report tl-product for the list\n' \
		"$(grep -c '^prunable:' "$wt_out" || true)" \
		"$(grep -c '^locked with DEAD pid' "$wt_out" || true)" \
		"$(grep -c '^locked (no pid)' "$wt_out" || true)" \
		"$(grep -c '^no remote counterpart:' "$wt_out" || true)"
fi
