#!/usr/bin/env bash
# asks-hook.test.sh: the asks hook's lock (run from the real lock/unlock source) and its
# deterministic clear (run through the real script). Self-contained: temp dir only, no network
# (the token file is absent, so a reply that reaches Jev fails fast and logs jev-failed).
set -u

script=$(cd "$(dirname "$0")" && pwd)/asks-hook.sh
tmp=$(mktemp -d)
trap 'kill $(jobs -p) 2>/dev/null; rm -rf "$tmp"' EXIT
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
echo pm >"$roles/s1"

# seed <ticket>...: one open ask per ticket, each with a detail file naming it.
seed() {
	local n=0 t
	rm -rf "$st/asks/s1.d" "$st/asks/jev-log.jsonl"
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
asks_are() { [ "$(open_asks)" = "$1" ]; }

seed 1111 2222 3333
reply "1111 go"
check "a number plus a short reply clears only that ask" asks_are "#2222 #3333 "
check "the survivors' details renumber" test "$(cat "$st/asks/s1.d/1.md")" = "context 2222"
check "the number path never calls Jev" bash -c '! grep -q jev-failed "$0" 2>/dev/null' "$st/asks/jev-log.jsonl"

seed 4405 4406 4407
reply "4405 4407 go"
check "two numbers plus a short reply clear both" asks_are "#4406 "
check "the lone survivor's detail is renumbered to 1" test "$(cat "$st/asks/s1.d/1.md")" = "context 4406"

seed 1111 2222 3333
reply "1111 go, and what about 2222?"
check "numbers plus extra words keep every ask" asks_are "#1111 #2222 #3333 "
check "numbers plus extra words go to Jev" went_to_jev

seed 1111 2222 3333
reply "9999 go"
check "an unmatched number keeps every ask and goes to Jev" went_to_jev

seed 1111 2222 3333
reply "go"
check "a short reply alone clears the newest ask" asks_are "#1111 #2222 "

# ---------- capture: one ask per ticket, newest wins ----------
# Jev is stubbed: curl writes a fixed "yes, a decision" answer with no context lines.
stub=$tmp/stub
mkdir -p "$stub"
cat >"$stub/curl" <<'STUB'
#!/bin/sh
cat >/dev/null
while [ $# -gt 0 ]; do [ "$1" = -o ] && out=$2; shift; done
printf '%s' '{"answers":{"decision":{"noul":0.9},"problem":{"choice":"none","confidence":0},"options":{"choice":"none","confidence":0},"rec":{"choice":"none","confidence":0}}}' >"$out"
STUB
chmod +x "$stub/curl"
echo fake >"$tmp/token"
capture() { # capture <final assistant message>
	jq -nc --arg m "$1" '{session_id:"s1",hook_event_name:"Stop",last_assistant_message:$m,cwd:"/nonexistent"}' |
		env PATH="$stub:$PATH" ASKS_STATE_DIR="$st" ASKS_ROLE_DIR="$roles" ASKS_TOKEN_FILE="$tmp/token" \
			ASKS_SYNC=1 TMPDIR="$tmp" bash "$script"
}
# seed_lines <ask line>...: the given lines verbatim, each with a detail file "context <line number>".
seed_lines() {
	local n=0 l
	rm -rf "$st/asks/s1.d" "$st/asks/jev-log.jsonl"
	: >"$st/asks/s1"
	mkdir -p "$st/asks/s1.d"
	for l in "$@"; do
		n=$((n + 1))
		echo "$l" >>"$st/asks/s1"
		echo "context $n" >"$st/asks/s1.d/$n.md"
	done
}
lines_are() { [ "$(tr '\n' '|' <"$st/asks/s1")" = "$1" ]; }
detail_is() { [ "$(cat "$st/asks/s1.d/$1.md" 2>/dev/null)" = "$2" ]; }
detail_links() { grep -q "issues/$2\$" "$st/asks/s1.d/$1.md" 2>/dev/null; }

seed_lines "#1111 first?" "#2222 second?"
capture "Ship #1111 as one PR?"
check "a capture with an open ticket's #N replaces that ask" lines_are "#2222 second?|Ship #1111 as one PR?|"
check "the survivor's detail follows its line" detail_is 1 "context 2"
check "the replaced ask's detail is replaced, not kept" detail_links 2 1111
check "no detail of the replaced ask is left" bash -c '! grep -rq "context 1" "$0"' "$st/asks/s1.d"

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
capture $'Intro.\n: should we ship #4449 now?'
check "a leading colon is stripped from the candidate" lines_are "#1111 first?|should we ship #4449 now?|"
capture $'Intro.\n\xe2\x80\x94 should we hold #5555 a week?'
check "a leading em dash is stripped from the candidate" lines_are "#1111 first?|should we ship #4449 now?|should we hold #5555 a week?|"

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
bin=$tmp/bin-no-perl
mkdir -p "$bin"
for t in jq sed awk tr cut grep find mktemp rm mv cat git dirname head tail curl sleep mkdir; do ln -s "$(command -v $t)" "$bin/$t"; done
seed 1111 2222
check "no perl: exits 0" silent_ok "$(event_json s1 UserPromptSubmit go)" PATH="$bin"
check "no perl: the asks stay" asks_are "#1111 #2222 "

exit $((failures > 0))
