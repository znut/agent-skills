#!/usr/bin/env bash
# dismiss-ask.test.sh: scripts/dismiss-ask.pl run for real on a temp asks file. No network.
set -u
script=$(cd "$(dirname "$0")/.." && pwd)/scripts/dismiss-ask.pl
tmp=$(mktemp -d)
trap 'kill $(jobs -p) 2>/dev/null; rm -rf "$tmp"' EXIT
asks=$tmp/asks/sid
failures=0
check() { # check <name> <command...>
	local name=$1
	shift
	if "$@"; then echo "ok   $name"; else echo "FAIL $name"; failures=$((failures + 1)); fi
}
stage() { # stage <asks text> <meta text>: a fresh asks file, its sidecar, no detail files
	rm -rf "$tmp/asks"
	mkdir -p "$asks.d"
	printf '%s' "$1" >"$asks"
	printf '%s' "$2" >"$asks.meta"
}

# Line 2 of 3: lines 1 and 3 stay, 2.md goes, 3.md becomes 2.md, the sidecar follows.
stage $'#11 first?\n#12 second?\n#13 third?\n' $'100\n200 board-done\n300\n'
printf one >"$asks.d/1.md"
printf two >"$asks.d/2.md"
printf three >"$asks.d/3.md"
perl "$script" "$asks" '#12 second?'
check 'line 2 of 3: lines 1 and 3 left' [ "$(cat "$asks")" = $'#11 first?\n#13 third?' ]
check 'line 2 of 3: 1.md kept' [ "$(cat "$asks.d/1.md")" = one ]
check 'line 2 of 3: 3.md became 2.md' [ "$(cat "$asks.d/2.md")" = three ]
check 'line 2 of 3: no 3.md' [ ! -e "$asks.d/3.md" ]
check 'line 2 of 3: sidecar parallel' [ "$(cat "$asks.meta")" = $'100\n300' ]
check 'line 2 of 3: no temp left' [ -z "$(find "$tmp/asks" -name '*.dismiss.*')" ]

# The only ask: an empty file, its detail gone.
stage $'#12 merge the fold?\n' $'100\n'
printf ctx >"$asks.d/1.md"
perl "$script" "$asks" '#12 merge the fold?'
check 'only ask: file empty' [ -f "$asks" -a ! -s "$asks" ]
check 'only ask: 1.md gone' [ ! -e "$asks.d/1.md" ]

# A text no longer in the file (the hook dropped it first) changes nothing.
stage $'#11 first?\n' $'100\n'
perl "$script" "$asks" '#12 gone?'
check 'absent text: file unchanged' [ "$(cat "$asks")" = '#11 first?' ]

# The asks hook's lock held elsewhere: the holder appends an ask before it lets go. A dismiss that
# ran without the lock would lose to that write and leave #11 in place.
stage $'#11 first?\n#12 second?\n' $'100\n200\n'
perl -e 'use Fcntl ":flock"; my ($lock, $asks, $held, $release) = @ARGV;
	open(F, ">>", $lock) or die; flock(F, LOCK_EX); open(R, ">", $held); close R;
	select(undef, undef, undef, 0.01) until -e $release;
	open(A, ">", $asks); print A "#11 first?\n#12 second?\n#13 x?\n"; close A;
	open(M, ">", "$asks.meta"); print M "100\n200\n300\n"; close M' "$asks.lock" "$asks" "$tmp/held" "$tmp/release" &
for ((i = 0; i < 1000; i++)); do [ -e "$tmp/held" ] && break; perl -e 'select(undef, undef, undef, 0.01)'; done
perl "$script" "$asks" '#11 first?' &
dismiss=$!
: >"$tmp/release"
wait "$dismiss"
check 'held lock: waits, then drops from the holder'"'"'s write' [ "$(cat "$asks")" = $'#12 second?\n#13 x?' ]
check 'held lock: sidecar follows' [ "$(cat "$asks.meta")" = $'200\n300' ]

[ "$failures" -eq 0 ] && echo "all passed" || { echo "$failures failed"; exit 1; }
