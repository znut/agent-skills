#!/usr/bin/env bash
# boot-report.sh — one-call session boot state collector for TL/PM roles.
#
# Usage: tools/boot-report.sh <pm|tl-product|tl-platform>
#
# Read-only. Prints bounded, labeled sections from the current project checkout.
# No cursors are advanced, no archives touched, no state written.
#
# Path resolution follows the repo's existing convention: parse
# .pi/orchestrate.local.md OR .claude/orchestrate.local.md (prefer the one
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
	local pi_md="$repo_root/.pi/orchestrate.local.md"
	local claude_md="$repo_root/.claude/orchestrate.local.md"
	if [ -f "$pi_md" ] && [ -f "$claude_md" ]; then
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
			find "$events_dir" -maxdepth 1 -type f \( -name 'pr-*.log' -o -name 'issue-*.log' \) -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -20 | cut -d' ' -f2- > "$event_tmp" || true
			if [ ! -s "$event_tmp" ]; then
				# BSD fallback: sort by mtime via stat.
				find "$events_dir" -maxdepth 1 -type f \( -name 'pr-*.log' -o -name 'issue-*.log' \) -exec stat -f '%m %N' {} + 2>/dev/null | sort -rn | head -20 | cut -d' ' -f2- > "$event_tmp" || true
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
if ! prs_json=$("$ghw" pr list --state open --json number,title,labels,headRefName,isDraft,updatedAt 2>/dev/null); then
	printf 'unavailable (%s pr list failed — not "none"; check auth/wrapper)\n' "$ghw"
	prs_json=''
elif [ -z "$prs_json" ] || [ "$prs_json" = "[]" ]; then
	printf 'none\n'
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
			done < <(find "$gh_status_dir/events" -maxdepth 1 -type f \( -name 'pr-*.log' -o -name 'issue-*.log' \) -exec cat {} + 2>/dev/null | sort -u)
			[ "$deltas" -eq 0 ] && printf 'no new stakeholder comments\n' || true
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

# 8. Worktree hygiene
section "Worktree hygiene"
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
			printf 'prunable: %s (%s)\n' "$current_wt" "${line#prunable }"
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
		printf 'locked (no pid): %s\n' "$wt"
	elif ! kill -0 "$pid" 2>/dev/null; then
		printf 'locked with DEAD pid %s: %s\n' "$pid" "$wt"
	fi
done < "$wt_reason_tmp"

# local branches with no remote counterpart
while IFS= read -r branch; do
	[ -n "$branch" ] || continue
	if ! git rev-parse --verify "origin/$branch" >/dev/null 2>&1; then
		printf 'no remote counterpart: %s\n' "$branch"
	fi
done < <(git for-each-ref refs/heads --format='%(refname:short)')
