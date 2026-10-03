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

exit $((failures > 0))
