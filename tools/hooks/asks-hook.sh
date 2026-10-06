#!/usr/bin/env bash
# Claude Code hook, one script for two events (picked from hook_event_name):
#   Stop             pins the final question of the turn as an ask, and clears the open
#                    asks the message settles
#   UserPromptSubmit clears the open asks the user's message answers
# Scope: sessions whose /tmp/cc-session-roles marker names a manager role, `pm` or any
# `tl-<lane>` (boot-report writes it at every PM and TL boot). Silent and fail-open: any
# failure pins nothing, clears nothing, exits 0. A candidate is the last "?" line of the
# final assistant message; Jev (TypeSafe) judges it, with a hard 3 s cap per call, detached so the
# hook itself never waits on it.
# File format (orchestrate/SKILL.md §Pinned asks): <state>/asks/<sid> holds one
# line per ask; <state>/asks/<sid>.d/<n>.md its context, renumbered on delete.
# Env overrides (tests): ASKS_STATE_DIR, ASKS_ROLE_DIR, ASKS_TOKEN_FILE,
# ASKS_DRY_RUN=1 (judge and print the decision, write no ask), ASKS_SYNC=1
# (run the Jev part in the foreground).

set -u
[ -n "${ASKS_DEBUG:-}" ] || exec 2>/dev/null
# Fail open on every path, including an abort under set -u: the exit status is always 0.
trap 'exit 0' EXIT

PIN_MIN=0.6      # yes-probability that the final question is a decision
CLEAR_MIN=0.45   # yes-probability that a message answers an ask
PICK_MIN=0.4     # confidence to keep a context-line pick
SAME_MIN=0.6     # yes-probability that a new question is the same decision as an open ask
SETTLED_MIN=0.6  # yes-probability that the assistant's message settles an open ask
OPTIONS_MIN=0.5 # lower for options: sibling lines split the confidence, the block is kept whole
JEV_TIMEOUT=3
ROLE_DIR=${ASKS_ROLE_DIR:-/tmp/cc-session-roles}
TOKEN_FILE=${ASKS_TOKEN_FILE:-${HOME:-}/.config/typesafe.token}
DRY=${ASKS_DRY_RUN:-}

# Inline work: builtins and one jq (a fork costs ~5 ms of every turn and prompt).
input=$(</dev/stdin)

# Unset when stdin is empty or not JSON, or jq is missing.
sid= event= cwd= msg= prompt= tp= role=
eval "$(printf '%s' "$input" | jq -r '@sh "sid=\(.session_id // "") event=\(.hook_event_name // "") cwd=\(.cwd // "") msg=\(.last_assistant_message // "") prompt=\(.prompt // "") tp=\(.transcript_path // "")"')"
case "$sid" in ""|*/*|*..*) exit 0 ;; esac
read -r role <"$ROLE_DIR/$sid" 2>/dev/null
[[ $role =~ ^(pm|tl-[a-z0-9-]+)$ ]] || exit 0
[ -n "$cwd" ] || cwd=$PWD

# State dir, constant for a session: `state_dir` in the main checkout's .agent/local.env
# (orchestrate/session-bus.md §State directory), cached after the first git lookup; the gh-status
# dir and the board snapshot are fixed names under it.
resolve_state() {
	local cache="${TMPDIR:-/tmp}/asks-hook.$sid" common line
	state=${ASKS_STATE_DIR:-}
	if [ -z "$state" ]; then
		read -r state <"$cache" 2>/dev/null
		if [ -z "$state" ]; then
			common=$(git -C "$cwd" rev-parse --path-format=absolute --git-common-dir)
			while IFS= read -r line || [ -n "$line" ]; do
				[[ $line == state_dir=* ]] || continue
				state=${line#state_dir=}
				break
			done <"${common%/.git}/.agent/local.env"
			[[ $state == "~/"* ]] && state=${HOME:-}/${state#\~/}
			state=${state%/}
			[ -n "$state" ] || return 1
			printf '%s\n' "$state" >"$cache"
		fi
	fi
	gh_dir=$state/gh-status board_file=$state/board-snapshot.md
	asks="$state/asks/$sid"
	detail="$asks.d"
	logfile="$state/asks/jev-log.jsonl"
}

# Everything past the inline deterministic work (Jev calls, file writes behind a
# judgment) runs detached: the hook exits 0 at once, so a prompt never waits on Jev.
# Dry run and ASKS_SYNC=1 keep the job in the foreground, for tests and samples.
job() {
	if [ -n "$DRY" ] || [ -n "${ASKS_SYNC:-}" ]; then "$1"
	else ( "$1" ) </dev/null >/dev/null 2>&1 & disown
	fi
}

job_init() {
	tmp=$(mktemp -d) || return 1
	trap '[ -n "${ASKS_KEEP:-}" ] || rm -rf "$tmp" "${stamp:-}"; exit 0' EXIT
}

# Writers of the asks file and its details hold a kernel flock on fd 9 (perl, as macOS has no
# flock(1)): the kernel drops it when the holder dies, so no stale lock exists to break.
# Rewrites are temp + mv.
lock() {
	[ -d "$state/asks" ] || mkdir -p "$state/asks" || return 1
	{ exec 9>>"$asks.lock"; } 2>/dev/null || return 1
	perl -e 'open(F, "<&=9") or exit 1; alarm 5; flock(F, 2) or exit 1' || { exec 9>&-; return 1; }
}
unlock() { exec 9>&-; }

jstr() { # jstr <text>: $REPLY = the text as a JSON string body
	REPLY=${1//\\/\\\\}
	REPLY=${REPLY//\"/\\\"}; REPLY=${REPLY//$'\t'/ }; REPLY=${REPLY//$'\r'/ }; REPLY=${REPLY//$'\n'/ }
}

log() { # log <hook> <candidate> <decision> [scores-json] [replaced ask text...]
	local ts t extra=
	if [ "$#" -gt 4 ]; then
		for t in "${@:5}"; do jstr "$t"; extra="$extra,\"$REPLY\""; done
		extra=",\"replaced\":[${extra#,}]"
	fi
	jstr "$2"
	TZ=UTC printf -v ts '%(%FT%TZ)T' -1
	printf '{"ts":"%s","sid":"%s","hook":"%s","candidate":"%s","decision":"%s","scores":%s%s}\n' \
		"$ts" "$sid" "$1" "$REPLY" "$3" "${4:-null}" "$extra" >>"$logfile"
}

# jev <questions-json-file> <state-json-file>: prints the answers object; curl's exit
# status decides (a body is parsed only after curl succeeded), else it fails.
jev() {
	[ -r "$TOKEN_FILE" ] || return 1
	jq -n --slurpfile q "$1" --slurpfile s "$2" \
		'{model:"jev-latest",state:$s[0],questions:$q[0]}' >"$tmp/req.json" || return 1
	# The token goes in through curl's config on stdin, never on argv; xtrace stays off
	# around it so `bash -x` can never print it.
	{ local x=$- rc; set +x; } 2>/dev/null
	printf 'header = "Authorization: Bearer %s"\n' "$(tr -d '[:space:]' <"$TOKEN_FILE")" |
		curl -sS -f --max-time "$JEV_TIMEOUT" -K - -H 'Content-Type: application/json' \
			--data-binary "@$tmp/req.json" -o "$tmp/resp.json" https://api.typesafe.ai/v1/systemone
	rc=$?
	[[ $x == *x* ]] && set -x
	[ "$rc" -eq 0 ] || return 1
	jq -e '.answers' "$tmp/resp.json"
}

# judge <hook> <label>: Jev's answers into $ans, or log jev-failed and fail.
judge() {
	ans=$(jev "$tmp/q.json" "$tmp/state.json") && [ -n "$ans" ] || { log "$1" "$2" jev-failed; return 1; }
}

# ---------- Stop: pin the final question, clear the asks the message settles ----------
# build_ctx: sets $ctx from Jev's picks in $ans (up to three context lines) and the ticket link.
build_ctx() {
	local seen=" " key label conf pick text min slug
	ctx=""
	for key in problem options rec; do
		pick=$(printf '%s' "$ans" | jq -r ".$key.choice")
		conf=$(printf '%s' "$ans" | jq -r ".$key.confidence")
		case "$pick" in none|"") continue ;; esac
		case "$seen" in *" $pick "*) continue ;; esac
		min=$PICK_MIN
		[ "$key" != options ] || min=$OPTIONS_MIN
		awk -v c="$conf" -v m="$min" 'BEGIN { exit !(c + 0 >= m + 0) }' || continue
		# An options pick widens to its contiguous list block, joined as `a | b` (the plugin's option buttons).
		text=$(awk -F'\t' -v k="$pick" -v block="$([ "$key" = options ] && echo 1)" '
			function list(t) { return t ~ /^[ \t]*([-*]|[0-9]+[.)]|\([A-Za-z0-9]\)|[A-Za-z][.)])[ \t]+/ }
			function clean(t) { sub(/^[ \t]*([-*>]|[0-9]+[.)]|#+)[ \t]+/, "", t); gsub(/\*\*/, "", t); return t }
			{ id[NR] = $1; tx[NR] = $2; if ($1 == k) p = NR }
			END {
				if (!p) exit
				a = z = p
				if (block && list(tx[p])) {
					while (a > 1 && id[a - 1] == id[a] - 1 && list(tx[a - 1])) a--
					while (z < NR && id[z + 1] == id[z] + 1 && list(tx[z + 1])) z++
				}
				out = clean(tx[a])
				for (i = a + 1; i <= z; i++) out = out " | " clean(tx[i])
				print (z > a ? "|" : "") out
			}' "$tmp/prev.tsv")
		[ -n "$text" ] || continue
		seen="$seen$pick "
		case "$key" in
		problem) label="Problem:" ;;
		rec) label="Rec:" ;;
		options) case "$text" in "|"*) label="options:"; text=${text#|} ;; *) label="Options -" ;; esac ;;
		esac
		ctx="$ctx$label ${text:0:200}"$'\n'
	done
	# The link's repo is the session's GitHub origin remote; any other remote, or none, gets no link.
	if [ -n "$num" ]; then
		slug=$(git -C "$cwd" remote get-url origin)
		slug=${slug%.git}
		[[ $slug =~ ^(git@github\.com:|ssh://git@github\.com/|https://github\.com/)([^/]+/[^/]+)$ ]] &&
			ctx="${ctx}link: https://github.com/${BASH_REMATCH[2]}/issues/${num#\#}"$'\n'
	fi
}

# One Jev request per Stop. The final question, if the message has one, is gated as a decision and
# compared with each open ask; every open ask is also asked whether the message settles it.
capture() {
	resolve_state && job_init || return 0
	tick
	snap=$now
	if [ -z "$msg" ]; then
		[ -r "$tp" ] || return 0
		msg=$(tail -n 200 "$tp" | jq -R 'fromjson? // empty' | jq -rs '
			[ .[] | select(.type == "assistant" and (.isSidechain | not))
			  | [ .message.content[]? | select(.type == "text") | .text ] | join("\n")
			  | select(length > 0) ] | last // empty')
	fi
	[ -n "$msg" ] || return 0

	# Last line ending in "?" (markdown closers allowed); none when the message asks nothing.
	printf '%s\n' "$msg" | awk '
		{ l = $0; sub(/[ \t]+$/, "", l); t = l; sub(/[*_`)"\047\342\200\235]+$/, "", t) }
		t ~ /\?$/ { idx = NR; line = l }
		END { if (idx) { print idx "\t" line } }' >"$tmp/cand.tsv"
	local idx cand= prev= num= line have_asks=
	if [ -s "$tmp/cand.tsv" ]; then
		idx=$(cut -f1 "$tmp/cand.tsv")
		cand=$(cut -f2- "$tmp/cand.tsv" | sed -E 's/^[[:space:]]*([-*>]|[0-9]+[.)]|#+)[[:space:]]+//; s/\*\*//g; s/^[[:space:]]+//')
		# The ask is the question sentence alone: the last full sentence of the line (the boundary is
		# . ! ? or : plus a space, or the line start); one still over the cap keeps its start, cut at a word.
		cand=$(printf '%s' "$cand" | sed -E 's/^.*[.!?:] ([^.!?:])/\1/')
		if [ "${#cand}" -gt 110 ]; then
			cand=${cand:0:108}
			case "$cand" in *" "*) cand=${cand% *} ;; esac
			while [ "${cand%[[:space:],;:-]}" != "$cand" ]; do cand=${cand%[[:space:],;:-]}; done
			cand="${cand}…?"
		fi
		while [ "$cand" != "$prev" ]; do # a cut at a sentence can leave a leading ": "
			prev=$cand
			cand=${cand#[[:space:]:;,-]}; cand=${cand#–}; cand=${cand#—}
		done
	fi
	[ -s "$asks" ] && have_asks=1
	[ -n "$cand" ] || [ -n "$have_asks" ] || return 0
	if [ -n "$cand" ] && [ -z "$DRY" ] && grep -qxF -- "$cand" "$asks" 2>/dev/null; then return 0; fi
	[[ $cand =~ \#[0-9]+ ]] && num=${BASH_REMATCH[0]}

	# The open asks, as they were when the request was built. Same-decision questions are skipped
	# when the candidate's first #N matches one: that ask is replaced by the #N rule, with no Jev call.
	local gate=false same=false
	: >"$tmp/asks.txt"
	[ -z "$have_asks" ] || cat "$asks" >"$tmp/asks.txt"
	[ -z "$cand" ] || gate=true
	if [ -n "$cand" ] && [ -n "$have_asks" ]; then
		same=true
		if [ -n "$num" ]; then
			while IFS= read -r line; do
				[[ $line =~ \#[0-9]+ && ${BASH_REMATCH[0]} == "$num" ]] && { same=false; break; }
			done <"$tmp/asks.txt"
		fi
	fi

	# Jev sees the candidate and the 12 non-empty lines before it (the choices), the message's last
	# 12 non-empty lines and the open ask lines (each cut to 200 chars), nothing else.
	: >"$tmp/prev.tsv"
	[ -z "$cand" ] || printf '%s\n' "$msg" | awk -v idx="$idx" '
		NR < idx && $0 ~ /[^ \t]/ { n++; i[n] = NR; t[n] = $0 }
		END { for (k = n > 12 ? n - 11 : 1; k <= n; k++) { gsub(/\t/, " ", t[k]); print i[k] "\t" substr(t[k], 1, 200) } }' >"$tmp/prev.tsv"
	local tailtxt=
	[ -z "$have_asks" ] || tailtxt=$(printf '%s\n' "$msg" | awk '
		$0 ~ /[^ \t]/ { n++; t[n] = substr($0, 1, 200) }
		END { for (k = n > 12 ? n - 11 : 1; k <= n; k++) print t[k] }')

	jq -n --arg cand "$cand" --arg tail "$tailtxt" '
		(if $cand != "" then {final_question:$cand} else {} end) + (if $tail != "" then {assistant_message:$tail} else {} end)' >"$tmp/state.json"
	jq -n --rawfile prev "$tmp/prev.tsv" --rawfile asks "$tmp/asks.txt" --argjson gate "$gate" --argjson same "$same" '
		($prev | split("\n") | map(select(length > 0) | split("\t") | {key: .[0], value: (.[1:] | join(" "))}) | from_entries
		 + {none: "No line fits."}) as $lines
		| def pick($q): {type:"choice", instructions:$q, criteria:$lines};
		($asks | split("\n") | to_entries | map(select(.value != ""))) as $open
		| (if $gate then {
		    decision: {type:"noul",
		      instructions: "Is `final_question` a decision or question the user must answer before work can continue (not rhetorical, not a status line, not an offer that needs no reply)?"},
		    problem: pick("Which listed line states the problem or situation that `final_question` is about? Choose none if no line does."),
		    options: pick("Which listed line states one of the options or alternatives offered by `final_question`? Choose none if no line does."),
		    rec: pick("Which listed line states the recommendation behind `final_question`? Choose none if no line does.")
		  } else {} end)
		+ (if $same then ($open | map({key: "same_\(.key + 1)", value: {type:"noul", instructions:{open_ask: .value,
		    question: "Is `final_question` the same decision as `open_ask`? Answer yes only if one answer settles both, even when worded differently; a different decision on the same ticket or topic is not the same."}}})
		   | from_entries) else {} end)
		+ ($open | map({key: "settled_\(.key + 1)", value: {type:"noul", instructions:{open_ask: .value,
		    question: "Does `assistant_message` say that `open_ask` is settled, answered or no longer waiting on the user? A statement that nothing is waiting on the user settles every open ask. A message that only mentions the topic, or still waits on the user for it, does not."}}})
		   | from_entries)' >"$tmp/q.json"

	local score scores
	judge capture "${cand:--}" || return 0
	scores=$(printf '%s' "$ans" | jq -c '
		(if .decision then {decision:.decision.noul,
		   problem:[.problem.choice,.problem.confidence], options:[.options.choice,.options.confidence], rec:[.rec.choice,.rec.confidence]} else {} end)
		+ {same:([to_entries[] | select(.key | startswith("same_")) | {key: (.key | ltrimstr("same_")), value: .value.noul}] | from_entries),
		   settled:([to_entries[] | select(.key | startswith("settled_")) | {key: (.key | ltrimstr("settled_")), value: .value.noul}] | from_entries)}')

	# The asks the message settles, at SETTLED_MIN or above.
	local drops=() n t
	while IFS= read -r n; do
		[[ $n =~ ^[0-9]+$ ]] || continue
		t=$(sed -n "${n}p" "$tmp/asks.txt")
		[ -z "$t" ] || drops+=("$t")
	done < <(printf '%s' "$ans" | jq -r --argjson m "$SETTLED_MIN" '[to_entries[] | select(.key | startswith("settled_"))
		| select(.value.noul >= $m) | .key | ltrimstr("settled_")] | .[]')

	local skipped=
	if [ -n "$cand" ]; then
		score=$(printf '%s' "$ans" | jq -r '.decision.noul')
		if ! awk -v s="$score" -v m="$PIN_MIN" 'BEGIN { exit !(s + 0 >= m + 0) }'; then
			log capture "$cand" skip "$scores"
			[ -z "$DRY" ] || printf 'SKIP %s\n     scores %s\n' "$cand" "$scores"
			skipped=1
			cand=
		fi
	fi

	# The new ask replaces every open ask with a same-decision score at SAME_MIN or above, and (the
	# #N rule) an open ask with its first #N.
	local ctx="" replaces=() decision=pin
	if [ -n "$cand" ]; then
		build_ctx
		if [ "$same" = true ]; then
			while IFS= read -r n; do
				[[ $n =~ ^[0-9]+$ ]] || continue
				t=$(sed -n "${n}p" "$tmp/asks.txt")
				[ -z "$t" ] || replaces+=("$t")
			done < <(printf '%s' "$ans" | jq -r --argjson m "$SAME_MIN" '[to_entries[] | select(.key | startswith("same_"))
				| select(.value.noul >= $m) | .key | ltrimstr("same_")] | .[]')
		elif [ -n "$num" ]; then
			while IFS= read -r line; do
				[[ $line =~ \#[0-9]+ && ${BASH_REMATCH[0]} == "$num" ]] && replaces+=("$line")
			done <"$tmp/asks.txt"
		fi
		[ "${#replaces[@]}" -eq 0 ] || decision=replace
	fi

	if [ -n "$DRY" ]; then
		if [ -n "$cand" ]; then
			log capture "$cand" "$decision-dry" "$scores"
			printf '%s %s\n%s' "$([ "$decision" = pin ] && echo PIN || echo REPLACE)" "$cand" "$(printf '%s' "$ctx" | sed 's/^/     | /')"
			for t in ${replaces[@]+"${replaces[@]}"}; do printf '\n     replaces %s' "$t"; done
			printf '\n'
		fi
		for t in ${drops[@]+"${drops[@]}"}; do printf 'SETTLED %s\n' "$t"; done
		if [ -z "$cand" ] && [ -z "$skipped" ]; then
			[ "${#drops[@]}" -gt 0 ] || printf 'KEEP all open asks\n'
			printf '     scores %s\n' "$scores"
		elif [ -n "$cand" ]; then printf '     scores %s\n' "$scores"
		fi
		return 0
	fi
	if [ -z "$cand" ] && [ "${#drops[@]}" -eq 0 ]; then
		[ -n "$skipped" ] || log capture "-" keep "$scores"
		return 0
	fi
	lock || { log capture "${cand:--}" lock-failed; return 0; }
	if [ -n "$cand" ]; then
		if [ "$asks.seen" -nt "${stamp:-/nonexistent}" ]; then # a prompt landed while Jev ran: it may have answered this
			log capture "$cand" answered-first "$scores"
			cand= ctx= replaces=()
		elif grep -qxF -- "$cand" "$asks" 2>/dev/null; then cand= ctx= replaces=()
		fi
	fi
	removed=() superseded=()
	if [ -n "$cand" ] || [ "${#drops[@]}" -gt 0 ]; then
		rewrite_asks "$cand" "$ctx" ${replaces[@]+"${replaces[@]}"} ${drops[@]+"${drops[@]}"}
	fi
	unlock
	# Each removal is logged once: under the new ask's replace line, or as settled.
	local replaced=(${superseded[@]+"${superseded[@]}"}) settled=() r is
	for t in ${removed[@]+"${removed[@]}"}; do
		is=
		for r in ${replaces[@]+"${replaces[@]}"}; do [ "$t" != "$r" ] || is=1; done
		if [ -n "$is" ]; then replaced+=("$t"); else settled+=("$t"); fi
	done
	if [ -n "$cand" ]; then
		if [ "${#replaced[@]}" -gt 0 ]; then log capture "$cand" replace "$scores" "${replaced[@]}"
		else log capture "$cand" pin "$scores"
		fi
	fi
	for t in ${settled[@]+"${settled[@]}"}; do log capture "$t" settled "$scores"; done
	log_dismissed
}

# ticket_done <N> <pinned-at µs> <board-done-at-pin flag>: the ticket closed after the ask was pinned.
# A PR file (gh-status) with a top-level state of MERGED or CLOSED decides by its close time
# (mergedAt, else closedAt) against the pin time, and keeps the ask when it has neither: updatedAt
# moves on later comments, so it is never a close time. Without one, a board row with
# Status Done ($board_done, set by rewrite_asks) counts unless that row was already Done when the ask
# was pinned (the meta flag). Local files only; a missing file or time means not done.
ticket_done() {
	local f=$gh_dir/status/pr-$1.json closed
	if [ -n "$gh_dir" ] && [ -r "$f" ]; then
		closed=$(jq -r 'select(.state == "MERGED" or .state == "CLOSED")
			| (.mergedAt // .closedAt // "") | if . == "" then "none" else sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601 end' "$f" 2>/dev/null)
		[ "$closed" != none ] || return 1
		if [[ $closed =~ ^[0-9]+$ ]]; then
			[ "${closed}000000" -gt "$2" ]
			return
		fi
	fi
	[ -z "$3" ] && [[ $board_done == *" $1 "* ]]
}

log_dismissed() {
	local t
	for t in ${dismissed[@]+"${dismissed[@]}"}; do log clear "$t" done-ticket; done
}

# tick: $now = microseconds since the epoch (whole seconds before bash 5), a fork-free clock.
tick() { now=${EPOCHREALTIME//[.,]/}; [ -n "$now" ] || printf -v now '%(%s)T000000' -1; }

# ---------- the one writer of the asks file (call it under the lock) ----------
# rewrite_asks <new ask or ""> <its context> <dropped ask text>...: append the new ask, keep only
# the newest ask per ticket (its first #N; without one, its whole text), drop the lines with exactly
# the dropped texts, and renumber the detail files to follow their lines. Texts, not line numbers:
# the file may have changed since a judgment. Dropped lines land in $removed; older lines with the
# new ask's #N in $superseded. An ask whose first #N is a ticket closed after the ask was pinned is
# dropped too (into $dismissed), never in the write that pins it (see ticket_done).
# Every line has a pinned-at stamp (microseconds) in the sidecar $asks.meta, parallel to the file,
# plus ` board-done` when its ticket's board row was Done at the pin; a line with no stamp is old. A
# dropped text only removes a line stamped at or before $snap, the time its judgment read the file:
# an identical ask pinned while Jev ran is not touched.
rewrite_asks() {
	local new=$1 ctx=$2 n=0 i m=0 id t line seen=$'\n' drop nums='' k=0 st fl
	local -a text keep ids stamp flag
	shift 2
	removed=() superseded=() dismissed=() board_done=''
	while IFS= read -r line; do
		n=$((n + 1))
		text[n]=$line
	done <"$asks"
	while read -r st fl; do
		k=$((k + 1))
		stamp[k]=$st flag[k]=$fl
	done <"$asks.meta"
	[ -z "$new" ] || { n=$((n + 1)); text[n]=$new; tick; stamp[n]=$now; flag[n]=; }
	for ((i = n; i >= 1; i--)); do
		line=${text[i]}
		[ -n "$line" ] || continue
		if [[ $line =~ \#[0-9]+ ]]; then id=${BASH_REMATCH[0]}; nums="$nums ${id#\#}"; else id=$line; fi
		ids[i]=$id
		case "$seen" in *$'\n'"$id"$'\n'*) continue ;; esac
		seen="$seen$id"$'\n'
		keep[i]=1
	done
	# Board rows are `| #N | ... |`; the Status column is found by its header cell, and escaped
	# pipes (`\|`) inside a cell never split it.
	if [ -n "$nums" ] && [ -r "$board_file" ]; then
		board_done=$(awk -v want="$nums" 'BEGIN { n = split(want, a, " "); for (k = 1; k <= n; k++) w[a[k]] = 1 }
			/^\|/ { r = $0; gsub(/\\\|/, "", r); m = split(r, c, "|"); for (k = 1; k <= m; k++) gsub(/^[ \t]+|[ \t]+$/, "", c[k]) }
			!/^\|/ { col = 0; next }
			/^\|[ \t:|-]+$/ { next }
			!/^\|[ \t]*#[0-9]+[ \t]*\|/ { col = 0; for (k = 1; k <= m; k++) if (c[k] == "Status") col = k; next }
			col { id = c[2]; sub(/^#/, "", id); if ((id in w) && c[col] == "Done") printf " %s", id }
			END { print " " }' "$board_file")
	fi
	if [ -n "$new" ] && [[ ${ids[n]} =~ ^\#[0-9]+$ && $board_done == *" ${ids[n]#\#} "* ]]; then flag[n]=board-done; fi
	for ((i = 1; i <= n; i++)); do
		[ -n "${keep[i]:-}" ] || continue
		[ -z "$new" ] || [ "$i" -ne "$n" ] || continue
		st=${stamp[i]:-0}
		[[ $st =~ ^[0-9]+$ ]] || st=0
		[[ ${ids[i]} =~ ^\#[0-9]+$ ]] && ticket_done "${ids[i]#\#}" "$st" "${flag[i]:-}" || continue
		unset 'keep[i]'
		dismissed+=("${text[i]}")
	done
	[ -z "$ctx" ] || mkdir -p "$detail"
	: >"$asks.new"
	: >"$asks.meta.new"
	for ((i = 1; i <= n; i++)); do
		line=${text[i]}
		drop=
		for t in "$@"; do [ "$line" = "$t" ] && drop=1; done
		if [ -n "$drop" ] && [ -n "${snap:-}" ]; then
			st=${stamp[i]:-0}
			[[ $st =~ ^[0-9]+$ ]] || st=0
			[ "$st" -le "$snap" ] || drop=
		fi
		if [ -z "${keep[i]:-}" ] || [ -n "$drop" ]; then
			if [ -n "$drop" ]; then removed+=("$line")
			elif [ -n "$new" ] && [ "$i" -lt "$n" ] && [ "${ids[i]:-}" = "${ids[n]}" ]; then superseded+=("$line")
			fi
			[ ! -f "$detail/$i.md" ] || rm -f "$detail/$i.md"
			continue
		fi
		m=$((m + 1))
		printf '%s\n' "$line" >>"$asks.new"
		printf '%s\n' "${stamp[i]:-0}${flag[i]:+ ${flag[i]}}" >>"$asks.meta.new"
		if [ -n "$new" ] && [ "$i" -eq "$n" ]; then
			if [ -n "$ctx" ]; then printf '%s' "$ctx" >"$detail/$m.md"; elif [ -f "$detail/$m.md" ]; then rm -f "$detail/$m.md"; fi
		elif [ "$m" -ne "$i" ] && [ -f "$detail/$i.md" ]; then
			mv "$detail/$i.md" "$detail/$m.md"
		fi
	done
	mv "$asks.meta.new" "$asks.meta"
	mv "$asks.new" "$asks"
}

# ---------- UserPromptSubmit: clear answered asks ----------
# apply_clear <scores-json> <ask text>...: drop the lines with exactly these texts.
apply_clear() {
	local scores=$1 t
	shift
	if [ -n "$DRY" ]; then
		printf 'CLEAR %s\n     scores %s\n' "$(printf '%s | ' "$@")" "$scores"
		return 0
	fi
	lock || return 0
	rewrite_asks "" "" "$@"
	unlock
	for t in ${removed[@]+"${removed[@]}"}; do log clear "$t" clear "$scores"; done
	log_dismissed
}

# The Jev part: one yes/no per open ask, judged over a snapshot of the file.
clear_jev() {
	resolve_state && job_init || return 0
	tick
	snap=$now
	local n=0 line k v scores texts=()
	printf '{}' >"$tmp/q.json"
	jq -n --arg prompt "$prompt" '{user_message:$prompt}' >"$tmp/state.json"
	while IFS= read -r line; do
		n=$((n + 1))
		[ -n "$line" ] || continue
		texts[$n]=$line
		jq --arg k "$n" --arg ask "$line" --arg ctx "$(cat "$detail/$n.md" 2>/dev/null)" \
			'. + {($k): {type:"noul", instructions:{open_ask:$ask, ask_context:$ctx,
			question:"Does `user_message` answer `open_ask`? A reply that says yes or no to it, approves or declines it, or picks one of its options answers it; a message about something else does not."}}}' "$tmp/q.json" >"$tmp/q2.json" &&
			mv "$tmp/q2.json" "$tmp/q.json"
	done <"$asks"
	judge clear - || return 0
	scores=$(printf '%s' "$ans" | jq -c 'map_values(.noul)')
	local drop=()
	while IFS=$'\t' read -r k v; do
		awk -v s="$v" -v m="$CLEAR_MIN" 'BEGIN { exit !(s + 0 >= m + 0) }' && drop+=("${texts[$k]}")
	done < <(printf '%s' "$ans" | jq -r 'to_entries[] | [.key, .value.noul] | @tsv')
	if [ "${#drop[@]}" -eq 0 ]; then
		log clear "-" keep "$scores"
		[ -z "$DRY" ] || printf 'KEEP all open asks\n     scores %s\n' "$scores"
		return 0
	fi
	apply_clear "$scores" "${drop[@]}"
}

# The fixed short replies that clear an ask without a Jev call, one per line. A reply matches when it
# is one or more entries in a row (`yes go`, `ok, go`), compared in lower case with punctuation as a
# word break; anything else goes to Jev.
SHORT_REPLIES='go
go ahead
do it
yes
y
yep
sure
ok
okay
approve
approved
agree
agreed
ship
merge
no
n
nope
เน'
SHORT_ALTS=${SHORT_REPLIES//$'\n'/|}
SHORT_RE="^[[:space:][:punct:]]*($SHORT_ALTS)([[:space:][:punct:]]+($SHORT_ALTS))*[[:space:][:punct:]]*$"
NUM_RE='(^|[^[:alnum:]])#?([0-9]+)([^[:alnum:]]|$)'

# short_clear: a reply that is only short replies plus optional ticket numbers (`1111`, `#1111`), or
# a bare option digit under 100 with no `#` (`1`), clears without Jev. Numbers name the asks with
# those #N; no number, a bare digit, or numbers that match no open ask clear the newest ask. Returns 1
# to hand the reply to Jev.
short_clear() {
	local rest=$prompt line n targets=() nums=() newest= hash=
	tick
	snap=$now
	[ "${#prompt}" -le 120 ] || return 1
	while [[ $rest =~ \[Image\ \#[0-9]+\] ]]; do rest=${rest/"${BASH_REMATCH[0]}"/ }; done
	[[ $rest =~ \#[0-9] ]] && hash=1
	while [[ $rest =~ $NUM_RE ]]; do
		nums+=("${BASH_REMATCH[2]}")
		rest=${rest/"${BASH_REMATCH[0]}"/ }
	done
	if [[ ${rest,,} =~ $SHORT_RE ]]; then
		for n in ${nums[@]+"${nums[@]}"}; do
			while IFS= read -r line; do
				[[ $line =~ \#([0-9]+) && ${BASH_REMATCH[1]} == "$n" ]] && targets+=("$line")
			done <"$asks"
		done
	elif [[ ${#nums[@]} -ne 1 || $rest == *[![:space:][:punct:]]* || ${#nums[0]} -gt 2 || -n $hash ]]; then
		return 1
	fi
	if [ "${#targets[@]}" -eq 0 ]; then
		while IFS= read -r line; do [ -z "$line" ] || newest=$line; done <"$asks"
		[ -n "$newest" ] || return 0
		targets=("$newest")
	fi
	apply_clear '"deterministic"' "${targets[@]}"
}

# machine_prompt: the prompt is not the user's own words: a task notification, a message from
# another session, Stop-hook feedback, or images with no text.
machine_prompt() {
	local p=${prompt#"${prompt%%[![:space:]]*}"}
	case "$p" in "<task-notification>"* | "Another Claude session sent a message"* | "Stop hook feedback"*) return 0 ;; esac
	while [[ $p =~ \[Image\ \#[0-9]+\] ]]; do p=${p/"${BASH_REMATCH[0]}"/}; done
	[[ $p != *[![:space:]]* ]]
}

case "$event" in
Stop)
	# No "?" and no open ask: no work at all (an empty msg falls back to the transcript in the job).
	if [ -n "$msg" ] && [[ $msg != *\?* ]]; then
		resolve_state && [ -s "$asks" ] || exit 0
	fi
	stamp="${TMPDIR:-/tmp}/asks-stamp.$sid.$$"
	: >"$stamp"
	job capture
	;;
UserPromptSubmit)
	machine_prompt && exit 0
	resolve_state || exit 0
	[ -d "$state/asks" ] || mkdir -p "$state/asks"
	: >"$asks.seen"
	[ -s "$asks" ] || exit 0
	case "$prompt" in /*) exit 0 ;; esac
	short_clear || job clear_jev
	;;
esac
exit 0
