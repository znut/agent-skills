#!/usr/bin/env bash
# Claude Code hook, one script for two events (picked from hook_event_name):
#   Stop             pins the final question of the turn as an ask
#   UserPromptSubmit clears the open asks the user's message answers
# Scope: sessions with a /tmp/cc-session-roles marker (boot-report writes it at
# every PM and TL boot). Silent and fail-open: any failure pins nothing, clears
# nothing, exits 0. A candidate is the last "?" line of the final assistant
# message; Jev (TypeSafe) judges it, with a hard 3 s cap per call.
# File format (orchestrate/SKILL.md §Pinned asks): <state>/asks/<sid> holds one
# line per ask; <state>/asks/<sid>.d/<n>.md its context, renumbered on delete.
# Env overrides (tests): ASKS_STATE_DIR, ASKS_ROLE_DIR, ASKS_TOKEN_FILE,
# ASKS_DRY_RUN=1 (judge and print the decision, write no ask).

set -u
[ -n "${ASKS_DEBUG:-}" ] || exec 2>/dev/null

PIN_MIN=0.6      # yes-probability that the final question is a decision
CLEAR_MIN=0.6    # yes-probability that a message answers an ask
PICK_MIN=0.6     # confidence to keep a context-line pick
OPTIONS_MIN=0.4  # lower for options: sibling lines split the confidence, the block is kept whole
JEV_TIMEOUT=3
ROLE_DIR=${ASKS_ROLE_DIR:-/tmp/cc-session-roles}
TOKEN_FILE=${ASKS_TOKEN_FILE:-$HOME/.config/typesafe.token}
DRY=${ASKS_DRY_RUN:-}

input=$(cat)
field() { printf '%s' "$input" | jq -r "$1 // empty"; }

sid=$(field .session_id)
event=$(field .hook_event_name)
cwd=$(field .cwd)
case "$sid" in ""|*/*|*..*) exit 0 ;; esac
role=$(cat "$ROLE_DIR/$sid" 2>/dev/null)
case "$role" in pm|tl-product|tl-platform) ;; *) exit 0 ;; esac
[ -n "$cwd" ] || cwd=$PWD

state=${ASKS_STATE_DIR:-}
if [ -z "$state" ]; then
	common=$(git -C "$cwd" rev-parse --path-format=absolute --git-common-dir)
	local_md="${common%/.git}/.agent/orchestrate.local.md"
	bus=$(sed -n 's/^- `session_bus_dir`: `\([^`]*\)`.*/\1/p' "$local_md" 2>/dev/null | head -n 1)
	bus=${bus/#\~/$HOME}
	[ -n "$bus" ] && state=$(dirname "${bus%/}")
fi
[ -n "$state" ] || exit 0
asks="$state/asks/$sid"
detail="$asks.d"
logfile="$state/asks/jev-log.jsonl"

tmp=$(mktemp -d) || exit 0
trap '[ -n "${ASKS_KEEP:-}" ] || rm -rf "$tmp"' EXIT

log() { # log <hook> <candidate> <decision> <scores-json>
	jq -nc --arg ts "$(date -u +%FT%TZ)" --arg sid "$sid" --arg hook "$1" --arg line "$2" \
		--arg decision "$3" --argjson scores "${4:-null}" \
		'{ts:$ts,sid:$sid,hook:$hook,candidate:$line,decision:$decision,scores:$scores}' \
		>>"$logfile"
}

# jev <questions-json-file> <state-json-file>: prints the answers object, or fails.
jev() {
	[ -r "$TOKEN_FILE" ] || return 1
	jq -n --slurpfile q "$1" --slurpfile s "$2" \
		'{model:"jev-latest",state:$s[0],questions:$q[0]}' >"$tmp/req.json" || return 1
	# The token goes in through curl's config on stdin, never on argv.
	printf 'header = "Authorization: Bearer %s"\n' "$(tr -d '[:space:]' <"$TOKEN_FILE")" |
		curl -sS -f --max-time "$JEV_TIMEOUT" -K - -H 'Content-Type: application/json' \
			--data-binary "@$tmp/req.json" https://api.typesafe.ai/v1/systemone |
		jq -e '.answers'
}

open_lines() { [ -s "$asks" ] && grep -n . "$asks"; }

# ---------- Stop: pin the final question ----------
capture() {
	local msg tp
	msg=$(field .last_assistant_message)
	if [ -z "$msg" ]; then
		tp=$(field .transcript_path)
		[ -r "$tp" ] || return 0
		msg=$(tail -n 200 "$tp" | jq -R 'fromjson? // empty' | jq -rs '
			[ .[] | select(.type == "assistant" and (.isSidechain | not))
			  | [ .message.content[]? | select(.type == "text") | .text ] | join("\n")
			  | select(length > 0) ] | last // empty')
	fi
	[ -n "$msg" ] || return 0

	# Last line ending in "?" (markdown closers allowed), cleaned of bullets and bold.
	printf '%s\n' "$msg" | awk '
		{ l = $0; sub(/[ \t]+$/, "", l); t = l; sub(/[*_`)"\047\342\200\235]+$/, "", t) }
		t ~ /\?$/ { idx = NR; line = l }
		END { if (idx) { print idx "\t" line } }' >"$tmp/cand.tsv"
	[ -s "$tmp/cand.tsv" ] || return 0
	local idx cand clause tail_msg
	idx=$(cut -f1 "$tmp/cand.tsv")
	cand=$(cut -f2- "$tmp/cand.tsv" | sed -E 's/^[[:space:]]*([-*>]|[0-9]+[.)]|#+)[[:space:]]+//; s/\*\*//g; s/^[[:space:]]+//')
	if [ "${#cand}" -gt 110 ]; then # keep the last clause, else the last 100 chars from a word start
		clause=$(printf '%s' "$cand" | sed -E 's/^.*[.:;] ([^.:;]{20,})$/\1/')
		if [ "${#clause}" -le 110 ] && [ "$clause" != "$cand" ]; then cand=$clause
		else cand="…$(printf '%s' "${cand: -100}" | sed -E 's/^[^ ]* //')"; fi
	fi
	[ -n "$cand" ] || return 0
	if [ -z "$DRY" ] && grep -qxF -- "$cand" "$asks" 2>/dev/null; then return 0; fi

	# Preceding non-empty lines (at most 30) become the choices for the context picks.
	printf '%s\n' "$msg" | awk -v idx="$idx" '
		NR < idx && $0 ~ /[^ \t]/ { n++; i[n] = NR; t[n] = $0 }
		END { s = n > 30 ? n - 29 : 1
		      for (k = s; k <= n; k++) { gsub(/\t/, " ", t[k]); print i[k] "\t" substr(t[k], 1, 200) } }' >"$tmp/prev.tsv"

	tail_msg=$msg
	[ "${#msg}" -le 3000 ] || tail_msg=${msg:$((${#msg} - 3000))}
	jq -n --arg msg "$tail_msg" --arg cand "$cand" '{final_message:$msg,final_question:$cand}' >"$tmp/state.json"
	jq -n --rawfile prev "$tmp/prev.tsv" '
		($prev | split("\n") | map(select(length > 0) | split("\t") | {key: .[0], value: (.[1:] | join(" "))}) | from_entries
		 + {none: "No line fits."}) as $lines
		| def pick($q): {type:"choice", instructions:$q, criteria:$lines};
		{
		  decision: {type:"noul",
		    instructions: "Is `final_question` a decision or question the user must answer before work can continue (not rhetorical, not a status line, not an offer that needs no reply)?"},
		  problem: pick("Which numbered line of `final_message` best states the problem or situation behind `final_question`?"),
		  options: pick("Which numbered line of `final_message` best lists the options or alternatives offered for `final_question`?"),
		  rec: pick("Which numbered line of `final_message` best states the recommendation for `final_question`?")
		}' >"$tmp/q.json"

	local ans score
	if ! ans=$(jev "$tmp/q.json" "$tmp/state.json") || [ -z "$ans" ]; then
		log capture "$cand" jev-failed
		return 0
	fi
	score=$(printf '%s' "$ans" | jq -r '.decision.noul')
	local scores
	scores=$(printf '%s' "$ans" | jq -c '{decision:.decision.noul,
		problem:[.problem.choice,.problem.confidence], options:[.options.choice,.options.confidence], rec:[.rec.choice,.rec.confidence]}')
	if ! awk -v s="$score" -v m="$PIN_MIN" 'BEGIN { exit !(s + 0 >= m + 0) }'; then
		log capture "$cand" skip "$scores"
		[ -z "$DRY" ] || printf 'SKIP %s\n     scores %s\n' "$cand" "$scores"
		return 0
	fi

	# Context: Problem, Options, Rec in that order; none, low-confidence or repeated picks dropped.
	local ctx="" seen=" " key label conf pick text min
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
	local num link slug
	num=$(printf '%s' "$cand" | grep -oE '#[0-9]+' | head -n 1)
	if [ -n "$num" ]; then
		slug=$(git -C "$cwd" remote get-url origin | sed -E 's#^(git@github.com:|https://github.com/)##; s#\.git$##')
		link="link: https://github.com/${slug:-EZ-OPD/ez-opd-services}/issues/${num#\#}"
		ctx="$ctx$link"$'\n'
	fi

	if [ -n "$DRY" ]; then
		log capture "$cand" pin-dry "$scores"
		printf 'PIN  %s\n%s' "$cand" "$(printf '%s' "$ctx" | sed 's/^/     | /')"
		printf '\n     scores %s\n' "$scores"
		return 0
	fi
	mkdir -p "$detail" || return 0
	local n
	n=$(($(grep -c . "$asks" 2>/dev/null) + 1))
	[ -z "$ctx" ] || printf '%s' "$ctx" >"$detail/$n.md"
	printf '%s\n' "$cand" >>"$asks"
	log capture "$cand" pin "$scores"
}

# ---------- UserPromptSubmit: clear answered asks ----------
clear_answered() {
	local prompt
	prompt=$(field .prompt)
	[ -n "$prompt" ] || return 0
	case "$prompt" in /*) return 0 ;; esac
	[ -s "$asks" ] || return 0
	local count
	count=$(grep -c . "$asks")
	[ "$count" -gt 0 ] || return 0

	local drop=" " scores="null"
	local norm
	norm=$(printf '%s' "$prompt" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z]+/ /g; s/^ +| +$//g')
	if [ "$count" -eq 1 ] && printf '%s' "$norm" | grep -qxE 'go|yes|no|y|n|ok|okay|yep|nope|approved?|do it|go ahead|sure|agreed?'; then
		drop=" 1 "
		scores='"deterministic"'
	else
		local n=0 line
		printf '{}' >"$tmp/q.json"
		jq -n --arg prompt "$prompt" '{user_message:$prompt}' >"$tmp/state.json"
		while IFS= read -r line; do
			n=$((n + 1))
			[ -n "$line" ] || continue
			jq --arg k "$n" --arg ask "$line" --arg ctx "$(cat "$detail/$n.md" 2>/dev/null)" \
				'. + {($k): {type:"noul", instructions:{open_ask:$ask, ask_context:$ctx,
				question:"Does `user_message` answer `open_ask`? A reply that says yes or no to it, approves or declines it, or picks one of its options answers it; a message about something else does not."}}}' "$tmp/q.json" >"$tmp/q2.json" &&
				mv "$tmp/q2.json" "$tmp/q.json"
		done <"$asks"
		local ans
		if ! ans=$(jev "$tmp/q.json" "$tmp/state.json") || [ -z "$ans" ]; then
			log clear "-" jev-failed
			return 0
		fi
		scores=$(printf '%s' "$ans" | jq -c 'map_values(.noul)')
		local k v
		while IFS=$'\t' read -r k v; do
			awk -v s="$v" -v m="$CLEAR_MIN" 'BEGIN { exit !(s + 0 >= m + 0) }' && drop="$drop$k "
		done < <(printf '%s' "$ans" | jq -r 'to_entries[] | [.key, .value.noul] | @tsv')
	fi

	if [ "$drop" = " " ]; then
		log clear "-" keep "$scores"
		[ -z "$DRY" ] || printf 'KEEP all open asks\n     scores %s\n' "$scores"
		return 0
	fi
	if [ -n "$DRY" ]; then
		printf 'CLEAR %s of:\n%s\n     scores %s\n' "$drop" "$(sed 's/^/     | /' "$asks")" "$scores"
		return 0
	fi

	# Drop the lines and their details, then renumber the survivors in ascending order.
	local n=0 new=0 line
	: >"$tmp/kept"
	while IFS= read -r line; do
		n=$((n + 1))
		[ -n "$line" ] || continue
		case "$drop" in
		*" $n "*) rm -f "$detail/$n.md"; log clear "$line" clear "$scores" ;;
		*)
			new=$((new + 1))
			printf '%s\n' "$line" >>"$tmp/kept"
			[ "$new" -eq "$n" ] || { [ ! -f "$detail/$n.md" ] || mv "$detail/$n.md" "$detail/$new.md"; }
			;;
		esac
	done <"$asks"
	cp "$tmp/kept" "$asks.new" && mv "$asks.new" "$asks"
}

case "$event" in
Stop) capture ;;
UserPromptSubmit) clear_answered ;;
esac
exit 0
