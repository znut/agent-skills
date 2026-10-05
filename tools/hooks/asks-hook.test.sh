#!/usr/bin/env bash
# asks-hook.test.sh: the asks hook's lock (run from the real lock/unlock source) and its
# deterministic clear (run through the real script). Self-contained: temp dir only, no network
# (the token file is absent, so a reply that reaches Jev fails fast and logs jev-failed).
# Needs bash 4 or later: macOS /bin/bash 3.2 hangs on it.
set -u
[ "${BASH_VERSINFO[0]}" -ge 4 ] || { echo "asks-hook.test.sh needs bash >= 4; run it with a newer bash" >&2; exit 1; }

script=$(cd "$(dirname "$0")" && pwd)/asks-hook.sh
tmp=$(mktemp -d)
trap 'kill $(jobs -p) 2>/dev/null; rm -rf "$tmp"' EXIT

# Isolation: every case runs on a private PATH with only the tools the hook and this harness use.
# claude, gh and curl are tripwires: they record a violation and exit 97. A case's working curl is
# its own Jev stub, put ahead of $bin.
bin=$tmp/bin
mkdir -p "$bin"
for t in jq sed awk tr cut grep find mktemp rm mv cp cat git dirname head tail sleep mkdir chmod ln perl ls env; do
	ln -s "$(command -v "$t")" "$bin/$t"
done
ln -s "$BASH" "$bin/bash"
for t in claude gh curl; do
	printf '#!/bin/sh\necho "tripwire: real %s called: $*" >&2\necho "%s $*" >>"%s/violation"\nexit 97\n' "$t" "$t" "$tmp" >"$bin/$t"
	chmod +x "$bin/$t"
done
export PATH=$bin
state=$tmp asks=$tmp/asks/sid
eval "$(sed -n '/^lock() {/,/^unlock() /p' "$script")"

failures=0
check() { # check <name> <command...>
	local name=$1
	shift
	if "$@"; then echo "ok   $name"; else echo "FAIL $name"; failures=$((failures + 1)); fi
}

# A contender holds the lock across an injected pause and logs entry and exit.
contender() { # contender <id> <pause>
	lock || { echo "$1 lockfail" >>"$tmp/log"; return; }
	echo "$1 in" >>"$tmp/log"
	sleep "$2"
	echo "$1 out" >>"$tmp/log"
	unlock
}

# Mutual exclusion: the log is pairs of "<id> in" then "<id> out", never interleaved.
exclusive() {
	awk '$2 == "in" { if (open) bad = 1; open = $1; n++ }
	     $2 == "out" { if (open != $1) bad = 1; open = "" }
	     $2 == "lockfail" { bad = 1 }
	     END { exit (bad || open != "" || n != want) }' want="$1" "$tmp/log"
}

# Four contenders, each pausing inside the critical section.
: >"$tmp/log"
for id in a b c d; do contender $id 0.2 & done
wait
check "four contenders never overlap" exclusive 4

# A holder killed with SIGKILL leaves no stale lock: the next contender gets in at once.
: >"$tmp/log"
( lock && : >"$tmp/held" && exec sleep 60 ) &
holder=$!
until [ -e "$tmp/held" ]; do sleep 0.02; done
kill -9 $holder
wait $holder 2>/dev/null
SECONDS=0
contender e 0
check "a killed holder frees the lock at once" test "$SECONDS" -lt 2
check "the contender after the kill entered" exclusive 1


# ---------- deterministic clear: short replies and ticket numbers ----------
roles=$tmp/roles st=$tmp/state
mkdir -p "$roles" "$st/asks"
echo tl-widgets >"$roles/s1"

# seed <ticket>...: one open ask per ticket, each with a detail file naming it.
seed() {
	local n=0 t
	rm -rf "$st/asks/s1.d" "$st/asks/s1.meta" "$st/asks/jev-log.jsonl"
	: >"$st/asks/s1"
	mkdir -p "$st/asks/s1.d"
	for t in "$@"; do
		n=$((n + 1))
		echo "#$t ask?" >>"$st/asks/s1"
		echo "context $t" >"$st/asks/s1.d/$n.md"
	done
}
reply() { # reply <text>
	jq -nc --arg p "$1" '{session_id:"s1",hook_event_name:"UserPromptSubmit",prompt:$p,cwd:"/tmp"}' |
		ASKS_STATE_DIR=$st ASKS_ROLE_DIR=$roles ASKS_TOKEN_FILE=$tmp/none ASKS_SYNC=1 TMPDIR=$tmp bash "$script"
}
open_asks() { sed 's/ ask?//' "$st/asks/s1" | tr '\n' ' '; }
went_to_jev() { grep -q '"decision":"jev-failed"' "$st/asks/jev-log.jsonl" 2>/dev/null; }
no_jev() { ! went_to_jev; }
asks_are() { [ "$(open_asks)" = "$1" ]; }

seed 1111 2222 3333
reply "1111 go"
check "a number plus a short reply clears only that ask" asks_are "#2222 #3333 "
check "the survivors' details renumber" test "$(cat "$st/asks/s1.d/1.md")" = "context 2222"
check "the number path never calls Jev" bash -c '! grep -q jev-failed "$0" 2>/dev/null' "$st/asks/jev-log.jsonl"

seed 405 406 407
reply "405 407 go"
check "two numbers plus a short reply clear both" asks_are "#406 "
check "the lone survivor's detail is renumbered to 1" test "$(cat "$st/asks/s1.d/1.md")" = "context 406"

seed 1111 2222 3333
reply "1111 go, and what about 2222?"
check "numbers plus extra words keep every ask" asks_are "#1111 #2222 #3333 "
check "numbers plus extra words go to Jev" went_to_jev

seed 1111 2222 3333
reply "999 go"
check "a number that matches no open ask clears the newest ask" asks_are "#1111 #2222 "
check "the unmatched number never calls Jev" no_jev

seed 1111 2222 3333
reply "1111 999 go"
check "matched and unmatched numbers clear only the matched ask" asks_are "#2222 #3333 "

seed 1111 2222 3333
reply "go"
check "a short reply alone clears the newest ask" asks_are "#1111 #2222 "

# Combined list entries, the Thai-layout "go" and a bare option digit clear the newest ask.
for r in "yes go" "ok go" "yes, go" "Ok, go ahead!" "เน" "1" "2." "2 go" "[Image #3] 1" "1111 เน"; do
	seed 1111 2222 3333
	reply "$r"
	if [ "$r" = "1111 เน" ]; then want="#2222 #3333 "; else want="#1111 #2222 "; fi
	check "\"$r\" clears without Jev" asks_are "$want"
	check "\"$r\" never calls Jev" no_jev
done
for r in "1111" "#5" "12 34" "100" "yes maybe" "1 and 2"; do
	seed 1111 2222 3333
	reply "$r"
	check "\"$r\" keeps every ask and goes to Jev" asks_are "#1111 #2222 #3333 "
	check "\"$r\" goes to Jev" went_to_jev
done

# Text that is not the user's own words: no .seen touch, no Jev call, no clear.
for r in $'<task-notification>\n<task-id>abc</task-id> go' $'Another Claude session sent a message:\n<agent-message from="x">go</agent-message>' \
	$'Stop hook feedback:\n[bash x]: go' "[Image #3]" " [Image #1] [Image #2] " ""; do
	label=$(printf '%s' "${r:0:24}" | tr '\n' ' ')
	seed 1111 2222 3333
	rm -f "$st/asks/s1.seen"
	reply "$r"
	check "machine prompt [$label]: every ask stays" asks_are "#1111 #2222 #3333 "
	check "machine prompt [$label]: no .seen touch" test ! -e "$st/asks/s1.seen"
	check "machine prompt [$label]: no Jev call" test ! -e "$st/asks/jev-log.jsonl"
done
seed 1111 2222 3333
reply "[Image #1] go"
check "an image with a short reply is the user's: it clears the newest ask" asks_are "#1111 #2222 "
check "the user's prompt touches .seen" test -e "$st/asks/s1.seen"

# ---------- capture: one ask per ticket, newest wins ----------
# Jev is stubbed: curl keeps the last request in $STUB_REQ and answers with $STUB_ANSWERS, else a
# fixed "yes, a decision" answer with no context lines.
stub=$tmp/stub
mkdir -p "$stub"
cat >"$stub/curl" <<'STUB'
#!/bin/sh
cat >/dev/null
while [ $# -gt 0 ]; do
	case $1 in -o) out=$2 ;; --data-binary) req=${2#@} ;; esac
	shift
done
[ -z "${STUB_REQ:-}" ] || cp "$req" "$STUB_REQ"
# STUB_REPIN: while Jev "runs", the user answers the open ask and the same ask is pinned again.
if [ -n "${STUB_REPIN:-}" ] && [ -z "${STUB_NESTED:-}" ]; then
	printf '%s' '{"session_id":"s1","hook_event_name":"UserPromptSubmit","prompt":"go","cwd":"/nonexistent"}' |
		STUB_NESTED=1 STUB_ANSWERS= STUB_REQ= bash "$STUB_HOOK"
	printf '{"session_id":"s1","hook_event_name":"Stop","last_assistant_message":"%s","cwd":"/nonexistent"}' "$STUB_REPIN" |
		STUB_NESTED=1 STUB_ANSWERS= STUB_REQ= bash "$STUB_HOOK"
fi
if [ -f "${STUB_ANSWERS:-/nonexistent}" ]; then cat "$STUB_ANSWERS" >"$out"
else printf '%s' '{"answers":{"decision":{"noul":0.9},"problem":{"choice":"none","confidence":0},"options":{"choice":"none","confidence":0},"rec":{"choice":"none","confidence":0}}}' >"$out"; fi
STUB
chmod +x "$stub/curl"
echo fake >"$tmp/token"
# The session's repo: its GitHub origin names the link's repo.
git init -q "$tmp/repo" && git -C "$tmp/repo" remote add origin git@github.com:acme/widgets.git
capture() { # capture <final assistant message>; $capture_cwd overrides the session cwd
	jq -nc --arg m "$1" --arg cwd "${capture_cwd:-$tmp/repo}" '{session_id:"s1",hook_event_name:"Stop",last_assistant_message:$m,cwd:$cwd}' |
		env PATH="$stub:$bin" ASKS_STATE_DIR="$st" ASKS_ROLE_DIR="$roles" ASKS_TOKEN_FILE="$tmp/token" \
			STUB_REQ="$tmp/req.last" STUB_ANSWERS="$tmp/answers.json" STUB_HOOK="$script" STUB_REPIN="${repin:-}" ASKS_SYNC=1 TMPDIR="$tmp" bash "$script"
}
# same_scores <json of same_<n> scores>: Jev's answer for the next captures, a decision plus these.
same_scores() {
	jq -n --argjson s "$1" '{answers: ({decision:{noul:0.9}, problem:{choice:"none",confidence:0},
		options:{choice:"none",confidence:0}, rec:{choice:"none",confidence:0}} + $s)}' >"$tmp/answers.json"
}
# seed_lines <ask line>...: the given lines verbatim, each with a detail file "context <line number>".
seed_lines() {
	local n=0 l
	rm -rf "$st/asks/s1.d" "$st/asks/s1.meta" "$st/asks/jev-log.jsonl"
	: >"$st/asks/s1"
	mkdir -p "$st/asks/s1.d"
	for l in "$@"; do
		n=$((n + 1))
		echo "$l" >>"$st/asks/s1"
		echo "context $n" >"$st/asks/s1.d/$n.md"
	done
}
jqt() { jq -e "$@" >/dev/null; }
lines_are() { [ "$(tr '\n' '|' <"$st/asks/s1")" = "$1" ]; }
detail_is() { [ "$(cat "$st/asks/s1.d/$1.md" 2>/dev/null)" = "$2" ]; }
detail_links() { grep -q "issues/$2\$" "$st/asks/s1.d/$1.md" 2>/dev/null; }
log_last() { jqt -s "last | $1" "$st/asks/jev-log.jsonl"; }

seed_lines "#1111 first?" "#2222 second?"
capture "Ship #1111 as one PR?"
check "a capture with an open ticket's #N replaces that ask" lines_are "#2222 second?|Ship #1111 as one PR?|"
check "the survivor's detail follows its line" detail_is 1 "context 2"
check "the replaced ask's detail is replaced, not kept" detail_links 2 1111
check "no detail of the replaced ask is left" bash -c '! grep -rq "context 1" "$0"' "$st/asks/s1.d"
check "the #N replace is logged as replace with the removed ask" log_last '.decision == "replace" and .candidate == "Ship #1111 as one PR?" and .replaced == ["#1111 first?"]'
check "the link names the session's GitHub repo" grep -qx 'link: https://github.com/acme/widgets/issues/1111' "$st/asks/s1.d/2.md"

# The link: an https GitHub origin works too; a non-GitHub origin or no repo gets no link line.
git -C "$tmp/repo" remote set-url origin https://github.com/acme/widgets
seed_lines "#1111 first?"
capture "Ship #2222 now?"
check "an https GitHub origin gives the link" grep -qx 'link: https://github.com/acme/widgets/issues/2222' "$st/asks/s1.d/2.md"
git -C "$tmp/repo" remote set-url origin git@git.example.com:acme/widgets.git
seed_lines "#1111 first?"
capture "Ship #2222 now?"
check "a non-GitHub origin gives no link" bash -c '! grep -qs link: "$0"' "$st/asks/s1.d/2.md"
git -C "$tmp/repo" remote set-url origin git@github.com:acme/widgets.git
seed_lines "#1111 first?"
capture_cwd=/nonexistent capture "Ship #2222 now?"
check "a cwd outside any repo gives no link" bash -c '! grep -qs link: "$0"' "$st/asks/s1.d/2.md"

seed_lines "#1111 old?" "#2222 mid?" "#1111 new?"
capture "Hold #3333 a week?"
check "a write collapses existing duplicates, keeping the newest" lines_are "#2222 mid?|#1111 new?|Hold #3333 a week?|"
check "the kept duplicate's detail is its own" detail_is 2 "context 3"

seed_lines "#1111 old?" "#2222 mid?" "#1111 new?"
reply "2222 go"
check "a clear also collapses existing duplicates" lines_are "#1111 new?|"
check "the survivor's detail is the newest one's" detail_is 1 "context 3"

seed_lines "Ship it now or wait?"
capture "Ship it now or wait?"
check "an ask with no #N is deduped by exact text" lines_are "Ship it now or wait?|"
check "the deduped ask keeps its detail" detail_is 1 "context 1"
capture "Another question here?"
check "a different ask with no #N is appended" lines_are "Ship it now or wait?|Another question here?|"

# A re-ask in other words: Jev scores each open ask as the same decision; every ask at 0.6 or above is replaced.
seed_lines "#1111 first?" "Shall we do the thing?" "#3333 third?"
same_scores '{"same_1":{"noul":0.1},"same_2":{"noul":0.9},"same_3":{"noul":0.2}}'
capture "Should we do that thing a new way?"
check "a re-ask scored 0.9 replaces that ask and goes last" lines_are "#1111 first?|#3333 third?|Should we do that thing a new way?|"
check "the survivors' details renumber after the replace" detail_is 2 "context 3"
check "no detail of the replaced ask is left" bash -c '! grep -rq "context 2" "$0"' "$st/asks/s1.d"
check "Jev got one same-decision question per open ask" test "$(jq '[.questions | keys[] | select(startswith("same_"))] | length' "$tmp/req.last")" = 3
check "Jev got the open ask line, no context" jqt '.questions.same_2.instructions | keys == ["open_ask","question"] and .open_ask == "Shall we do the thing?"' "$tmp/req.last"
check "the log keeps every ask's score" jqt -s 'last | .decision == "replace" and .scores.same == {"1":0.1,"2":0.9,"3":0.2}' "$st/asks/jev-log.jsonl"
check "the replace log names the removed ask" log_last '.replaced == ["Shall we do the thing?"]'

seed_lines "#1111 first?" "Shall we do the thing?"
same_scores '{"same_1":{"noul":0.2},"same_2":{"noul":0.59}}'
capture "Should we do that thing a new way?"
check "a re-ask scored 0.59 is appended" lines_are "#1111 first?|Shall we do the thing?|Should we do that thing a new way?|"
check "an appended re-ask is logged as a pin with no removal" log_last '.decision == "pin" and (has("replaced") | not)'

seed_lines "Shall we do the thing?" "#3333 third?"
same_scores '{"same_1":{"noul":0.6},"same_2":{"noul":0.2}}'
capture "Should we do that thing a new way?"
check "a re-ask scored exactly 0.6 replaces" lines_are "#3333 third?|Should we do that thing a new way?|"

seed_lines "Shall we do it?" "Do the thing now?" "Ship the other part?"
same_scores '{"same_1":{"noul":0.73},"same_2":{"noul":0.61},"same_3":{"noul":0.41}}'
capture "Should we do that thing a new way?"
check "a re-ask replaces every open ask at 0.6 or above, not only the best" lines_are "Ship the other part?|Should we do that thing a new way?|"
check "the replace log names every removed ask" log_last '.decision == "replace" and .replaced == ["Shall we do it?","Do the thing now?"]'
check "a replace logs no settled line" bash -c '! grep -q "\"decision\":\"settled\"" "$0"' "$st/asks/jev-log.jsonl"

seed_lines "#1111 first?" "other?"
same_scores '{"same_1":{"noul":0.9},"same_2":{"noul":0.9}}'
capture "Ship #1111 as one PR?"
check "a #N match replaces without a Jev same-decision question" lines_are "other?|Ship #1111 as one PR?|"
check "the #N match sent no same-decision question" bash -c '! grep -q same_ "$0"' "$tmp/req.last"
rm -f "$tmp/answers.json"

# A message that is not a short reply gets one Jev yes/no per open ask; 0.45 or above clears.
reply_jev() { # reply_jev <text>: through the stubbed Jev, answering with $tmp/answers.json
	jq -nc --arg p "$1" '{session_id:"s1",hook_event_name:"UserPromptSubmit",prompt:$p,cwd:"/nonexistent"}' |
		env PATH="$stub:$bin" ASKS_STATE_DIR="$st" ASKS_ROLE_DIR="$roles" ASKS_TOKEN_FILE="$tmp/token" \
			STUB_REQ="$tmp/req.last" STUB_ANSWERS="$tmp/answers.json" ASKS_SYNC=1 TMPDIR="$tmp" bash "$script"
}
seed_lines "Lock the first mock?" "Ship the second part?" "Hold the third?"
echo '{"answers":{"1":{"noul":0.45},"2":{"noul":0.44},"3":{"noul":0.1}}}' >"$tmp/answers.json"
reply_jev "lock the mock as drawn, fine by me"
check "a Jev clear score of exactly 0.45 clears that ask, 0.44 keeps it" lines_are "Ship the second part?|Hold the third?|"
check "the clear is logged with every ask's score" log_last '.decision == "clear" and .scores == {"1":0.45,"2":0.44,"3":0.1}'
rm -f "$tmp/answers.json"

# A done ticket drops its ask on a later write, only when it closed after the ask was pinned: its PR
# is MERGED or CLOSED with a close time after the pin, or its board row is Done and was not at the pin.
pr_state() { # pr_state <number> <state> [mergedAt] [closedAt]; updatedAt is 2026-01-02, after every seeded pin
	mkdir -p "$st/gh-status/status"
	jq -n --argjson n "$1" --arg s "$2" --arg m "${3:-}" --arg c "${4:-}" '{number:$n, state:$s, title:"say \"state\": \"MERGED\"",
		updatedAt:"2026-01-02T00:00:00.123Z"} + (if $m != "" then {mergedAt:$m} else {} end)
		+ (if $c != "" then {closedAt:$c} else {} end)' >"$st/gh-status/status/pr-$1.json"
}
board_row() { # board_row <number> <status>: Status is found by its header, escaped pipes never split a cell
	printf '%s\n' '| # | Title | Owner | Status | Due |' '|---|---|---|---|---|' \
		"| #$1 | a \\| Done \\| title | sam | $2 | Friday |" >"$st/board-snapshot.md"
}
pinned_at() { printf '%s\n' "$@" >"$st/asks/s1.meta"; } # pinned_at <meta line>...: one per seeded ask
write_with_dismiss() { # the ask under test, a plain ask and a newest ask that a bare "go" clears
	seed_lines "#460 run the benchmark once it merges?" "plain ask?" "#462 newest?"
	[ -z "${meta:-}" ] || pinned_at "$meta" 0 0
	reply "go"
}
JAN1=1767225600000000 # 2026-01-01T00:00:00Z in microseconds
rm -rf "$st/gh-status" "$st/board-snapshot.md"
pr_state 460 MERGED 2026-01-02T00:00:00Z
write_with_dismiss
check "an ask whose PR is MERGED is dropped on the next write" lines_are "plain ask?|"
check "the dropped ask's detail goes and the survivor's renumbers" detail_is 1 "context 2"
check "the dismissal is logged" bash -c 'grep -q "\"decision\":\"done-ticket\"" "$0"' "$st/asks/jev-log.jsonl"
pr_state 460 CLOSED "" 2026-01-02T00:00:00.123Z
write_with_dismiss
check "an ask whose PR is CLOSED with a closedAt after the pin is dropped (fractional seconds parse)" lines_are "plain ask?|"
pr_state 460 CLOSED
write_with_dismiss
check "a CLOSED PR with only updatedAt is kept: updatedAt is no close time" lines_are "#460 run the benchmark once it merges?|plain ask?|"
pr_state 460 OPEN
write_with_dismiss
check "an ask whose PR is OPEN is kept" lines_are "#460 run the benchmark once it merges?|plain ask?|"
echo '{"number":460,"state":"MERGED"}' >"$st/gh-status/status/pr-460.json"
write_with_dismiss
check "a MERGED PR with no close time is kept" lines_are "#460 run the benchmark once it merges?|plain ask?|"
meta=$JAN1
pr_state 460 MERGED 2025-12-31T23:59:59Z
write_with_dismiss
check "an ask pinned after its PR merged is kept" lines_are "#460 run the benchmark once it merges?|plain ask?|"
check "the kept ask's pin stamp stays" test "$(head -1 "$st/asks/s1.meta")" = "$JAN1"
pr_state 460 MERGED 2026-01-01T00:00:01Z
write_with_dismiss
check "an ask pinned before its PR merged is dropped" lines_are "plain ask?|"
meta=
rm -rf "$st/gh-status"
write_with_dismiss
check "an ask with no status file is kept" lines_are "#460 run the benchmark once it merges?|plain ask?|"
board_row 460 Done
write_with_dismiss
check "an ask whose board row is Done is dropped" lines_are "plain ask?|"
meta="$JAN1 board-done"
write_with_dismiss
check "an ask whose board row was already Done at its pin is kept" lines_are "#460 run the benchmark once it merges?|plain ask?|"
check "the board-done flag stays with the ask" test "$(head -1 "$st/asks/s1.meta")" = "$JAN1 board-done"
meta=
board_row 460 Backlog
write_with_dismiss
check "an ask whose board row is not Done is kept" lines_are "#460 run the benchmark once it merges?|plain ask?|"
board_row 461 Done
write_with_dismiss
check "an ask with no board row is kept" lines_are "#460 run the benchmark once it merges?|plain ask?|"
printf '%s\n' '| # | Title | Owner | Due |' '|---|---|---|---|' '| #460 | a | sam | Done |' >"$st/board-snapshot.md"
write_with_dismiss
check "a board with no Status column dismisses nothing" lines_are "#460 run the benchmark once it merges?|plain ask?|"
printf '%s\n' '| # | Title | Status | Due |' '|---|---|---|---|' '| #461 | b | Backlog | Friday |' '' \
	'| # | Title | Done-by | Owner |' '|---|---|---|---|' '| #460 | a | Done | sam |' >"$st/board-snapshot.md"
write_with_dismiss
check "a second table with no Status header never reuses the first table's Status column" lines_are "#460 run the benchmark once it merges?|plain ask?|"
printf '%s\n' '| # | Title | Status | Due |' '|---|---|---|---|' '| #461 | b | Backlog | Friday |' \
	'| # | Title | Done-by | Owner |' '|---|---|---|---|' '| #460 | a | Done | sam |' >"$st/board-snapshot.md"
write_with_dismiss
check "a second header row with no Status column resets it, even with no blank line between" lines_are "#460 run the benchmark once it merges?|plain ask?|"
rm -f "$st/board-snapshot.md"
pr_state 460 MERGED 2026-01-02T00:00:00Z
seed_lines "no ticket, but merged? #460" "plain ask?" "#462 newest?"
reply "go"
check "only the first #N keys an ask" lines_are "plain ask?|"
rm -rf "$st/gh-status" "$st/board-snapshot.md"

# A pin is never dismissed in the write that pins it, and a ticket already done at the pin never
# dismisses it later.
rm -f "$tmp/answers.json"
board_row 777 Done
seed_lines "#1111 first?"
capture "Should I reopen #777?"
check "an ask about a board-Done ticket is pinned" lines_are "#1111 first?|Should I reopen #777?|"
check "its meta line carries the board-done flag" bash -c '[[ $(sed -n 2p "$0") =~ ^[0-9]+\ board-done$ ]]' "$st/asks/s1.meta"
reply "1111 go"
check "a later write keeps it while the row stays Done" lines_are "Should I reopen #777?|"
rm -f "$st/board-snapshot.md"
pr_state 778 MERGED 2026-01-02T00:00:00Z
seed_lines "#1111 first?"
capture "Should I follow up on #778?"
check "an ask about an already-merged PR is pinned" lines_are "#1111 first?|Should I follow up on #778?|"
reply "1111 go"
check "a later write keeps it: the PR merged before the pin" lines_are "Should I follow up on #778?|"
pr_state 778 MERGED 2099-01-01T00:00:00Z
seed_lines "#1111 first?" "#2222 second?"
capture "Should I follow up on #778?"
reply "2222 go"
check "a PR that merges after the pin dismisses the ask on a later write" lines_are "#1111 first?|"
rm -rf "$st/gh-status"

# The assistant's own message settles asks: a no-? Stop still asks Jev, once, about every open ask.
rm -f "$tmp/req.last"
seed_lines "Starting with 1: should I make the skills edit?" "Shall I dispatch the PRD change?" "#464 go ahead?"
same_scores '{"settled_1":{"noul":0.9},"settled_2":{"noul":0.4},"settled_3":{"noul":0.59}}'
capture $'You merged it, so the PRD now says it.\nNothing else is waiting on you from this lane.'
check "a no-? message scored 0.9 for ask 1 clears ask 1" lines_are "Shall I dispatch the PRD change?|#464 go ahead?|"
check "the others keep their details, renumbered" detail_is 1 "context 2"
check "the request had one settled question per open ask and no gate" jqt '[.questions | keys[]] == ["settled_1","settled_2","settled_3"]' "$tmp/req.last"
check "the request carried the message tail and no final question" jqt '.state | keys == ["assistant_message"]' "$tmp/req.last"
check "the log keeps each ask's settled score" jqt -s 'last | .decision == "settled" and .scores.settled == {"1":0.9,"2":0.4,"3":0.59}' "$st/asks/jev-log.jsonl"
same_scores '{"settled_1":{"noul":0.59},"settled_2":{"noul":0.5}}'
seed_lines "first?" "second?"
capture "Nothing to report."
check "settled scores under 0.6 keep every ask" lines_are "first?|second?|"
same_scores '{"settled_1":{"noul":0.5},"settled_2":{"noul":0.6}}'
capture "Nothing to report."
check "a settled score of exactly 0.6 clears that ask" lines_are "first?|"
rm -f "$tmp/req.last"
seed_lines "first?" "second?"
same_scores '{"settled_1":{"noul":0.9}}'
capture $'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9\nLine 10\nLine 11\nLine 12\nLine 13\nLine 14'
check "Jev gets the last 12 lines of the message" jqt '.state.assistant_message | split("\n") | length == 12 and .[0] == "Line 3"' "$tmp/req.last"
: >"$st/asks/s1"
rm -f "$tmp/req.last"
capture "Done, nothing to ask."
check "a no-? message with no open ask makes no Jev call" test ! -e "$tmp/req.last"
seed_lines "first?" "second?"
same_scores '{"settled_1":{"noul":0.9}}'
capture $'It is merged.\nShip #888 next?'
check "a message with a question pins it and clears the settled ask" lines_are "second?|Ship #888 next?|"
rm -f "$tmp/answers.json"

# A done PR is read by its top-level state only: nested objects with a state never decide.
rm -rf "$st/gh-status" "$st/board-snapshot.md"
mkdir -p "$st/gh-status/status"
echo '{"checks":{"state":"CLOSED"},"reviews":[{"state":"CLOSED"}],"number":460,"state":"OPEN"}' >"$st/gh-status/status/pr-460.json"
write_with_dismiss
check "an OPEN PR with a nested CLOSED state is kept" lines_are "#460 run the benchmark once it merges?|plain ask?|"
echo '{"reviews":[{"state":"OPEN"}],"number":460,"state":"MERGED","mergedAt":"2026-01-02T00:00:00Z"}' >"$st/gh-status/status/pr-460.json"
write_with_dismiss
check "a MERGED PR with a nested OPEN state is dropped" lines_are "plain ask?|"
rm -rf "$st/gh-status"

# A judgment only clears asks that were already pinned when it read the file: an identical ask
# pinned while Jev ran stays (the stub answers the open ask and pins it again during the call).
seed_lines "Shall we do the thing?"
same_scores '{"settled_1":{"noul":0.9}}'
repin="Shall we do the thing?"
capture "Nothing is waiting on you."
repin=
check "a settled score for the old ask leaves the identical ask pinned meanwhile" lines_are "Shall we do the thing?|"
check "the log shows no settled clear" bash -c '! grep -q "\"decision\":\"settled\"" "$0"' "$st/asks/jev-log.jsonl"
seed_lines "Shall we do the thing?"
capture "Nothing is waiting on you."
check "the same score clears an ask that was already pinned" lines_are ""
rm -f "$tmp/answers.json"

# The ask is the question sentence alone, so a done ticket named in a lead-in sentence cannot dismiss it.
rm -rf "$st/gh-status" "$st/board-snapshot.md"
pr_state 465 MERGED 2026-01-02T00:00:00Z
seed_lines "#1111 first?"
capture "Merged #465. Should I start #466?"
check "a lead-in naming a merged ticket does not key the ask: it pins as #466 and survives" lines_are "#1111 first?|Should I start #466?|"
check "the pinned ask links the ticket of its question sentence" detail_links 2 466
seed_lines "#1111 first?"
capture "Should I start #465?"
check "a question whose own first #N is merged is pinned, never dismissed in the same write" lines_are "#1111 first?|Should I start #465?|"
rm -rf "$st/gh-status"
seed_lines "#1111 first?"
capture "Should we ship the schema change now?"
check "a short single-sentence question is unchanged" lines_are "#1111 first?|Should we ship the schema change now?|"
seed_lines "#1111 first?"
capture "Still open: shall I dispatch the PRD change?"
check "a lead-in clause before a colon is not part of the ask" lines_are "#1111 first?|shall I dispatch the PRD change?|"

# An over-length question keeps its last full sentence; one still too long is cut at a word with …?
seed_lines "#1111 first?"
capture 'Should the API team own both, with the web team closing #466 into the rewrite, or does the spec part go to the web team?'
check "an over-length question is cut at a word with …? and never gets a leading ellipsis" lines_are "#1111 first?|Should the API team own both, with the web team closing #466 into the rewrite, or does the spec part go to…?|"
seed_lines "#1111 first?"
capture 'We settled the schema in the earlier round and the migration lands with the next release train. Shall I dispatch the PRD change now?'
check "an over-length line keeps its last full sentence" lines_are "#1111 first?|Shall I dispatch the PRD change now?|"

# No-#N asks are compared as literal text: glob characters and letter case never merge two asks.
seed_lines "a*b?" "axxb?" "#2222 x?"
capture "Hold #3333 a week?"
check "no-#N asks differing by a glob character both survive a pin" lines_are "a*b?|axxb?|#2222 x?|Hold #3333 a week?|"
seed_lines "a*b?" "axxb?" "#2222 x?"
reply "2222 go"
check "no-#N asks differing by a glob character both survive a clear" lines_are "a*b?|axxb?|"
seed_lines "Ship it?" "ship it?" "#2222 x?"
reply "2222 go"
check "no-#N asks differing only by letter case both survive a clear" lines_are "Ship it?|ship it?|"
seed_lines "#1111 first?" "#2222 second?"
reply "Go Ahead!"
check "a short reply matches in any letter case" lines_are "#1111 first?|"

seed_lines "#1111 first?"
capture $'Intro.\n: should we ship #449 now?'
check "a leading colon is stripped from the candidate" lines_are "#1111 first?|should we ship #449 now?|"
capture $'Intro.\n\xe2\x80\x94 should we hold #555 a week?'
check "a leading em dash is stripped from the candidate" lines_are "#1111 first?|should we ship #449 now?|should we hold #555 a week?|"

# ---------- fail open: every early path exits 0 with no output ----------
event_json() { # event_json <sid> <event> <prompt-or-message>
	jq -nc --arg s "$1" --arg e "$2" --arg t "$3" \
		'{session_id:$s,hook_event_name:$e,prompt:$t,last_assistant_message:$t,cwd:"/nonexistent"}'
}
# silent_ok <stdin-text> [-u VAR] [VAR=value...]: the hook exits 0 and prints nothing.
silent_ok() {
	local in=$1 out rc unset_opt=()
	shift
	if [ "${1:-}" = -u ]; then unset_opt=(-u "$2"); shift 2; fi
	out=$(printf '%s' "$in" | env ${unset_opt[@]+"${unset_opt[@]}"} ASKS_STATE_DIR="$st" ASKS_ROLE_DIR="$roles" ASKS_TOKEN_FILE="$tmp/none" \
		TMPDIR="$tmp" ASKS_SYNC=1 "$@" "$BASH" "$script" 2>&1)
	rc=$?
	[ "$rc" -eq 0 ] && [ -z "$out" ]
}
closed_stdin_ok() { [ -z "$("$BASH" "$script" <&- 2>&1)" ] && "$BASH" "$script" <&-; }

check "no role marker, UserPromptSubmit" silent_ok "$(event_json nomarker UserPromptSubmit go)"
check "no role marker, Stop" silent_ok "$(event_json nomarker Stop 'Ship it?')"
check "empty stdin" silent_ok ""
check "closed stdin" closed_stdin_ok
check "empty JSON object" silent_ok "{}"
check "stdin that is not JSON" silent_ok "garbage"
check "an unknown event" silent_ok "$(event_json s1 SessionStart go)"
check "a non-manager role" silent_ok "$(echo worker >"$roles/w1"; event_json w1 Stop 'Ship it?')"

seed 1111 2222
check "Stop with no message text and no transcript" silent_ok "$(jq -nc '{session_id:"s1",hook_event_name:"Stop"}')"
check "Stop with an unreadable transcript path" silent_ok "$(jq -nc '{session_id:"s1",hook_event_name:"Stop",transcript_path:"/nonexistent/t.jsonl"}')"
check "no resolvable state dir" silent_ok "$(event_json s1 UserPromptSubmit go)" ASKS_STATE_DIR=
: >"$tmp/afile"
check "an unwritable state dir, UserPromptSubmit" silent_ok "$(event_json s1 UserPromptSubmit go)" ASKS_STATE_DIR="$tmp/afile/x"
check "an unwritable state dir, Stop" silent_ok "$(event_json s1 Stop 'Ship it?')" ASKS_STATE_DIR="$tmp/afile/x"
check "no jq, curl or perl on PATH" silent_ok "$(event_json s1 UserPromptSubmit go)" PATH=/var/empty
check "no HOME" silent_ok "$(event_json s1 Stop 'Ship it?')" -u HOME ASKS_TOKEN_FILE=

# Every tool but perl: the lock fails, so the clear is skipped and the asks stay.
noperl=$tmp/bin-no-perl
mkdir -p "$noperl"
for t in jq sed awk tr cut grep find mktemp rm mv cat git dirname head tail sleep mkdir; do ln -s "$bin/$t" "$noperl/$t"; done
seed 1111 2222
check "no perl: exits 0" silent_ok "$(event_json s1 UserPromptSubmit go)" PATH="$noperl"
check "no perl: the asks stay" asks_are "#1111 #2222 "

check "no real external binary was invoked" test ! -e "$tmp/violation"

exit $((failures > 0))
