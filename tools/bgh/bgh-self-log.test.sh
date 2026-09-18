#!/usr/bin/env bash
# bgh-self-log.test.sh — smoke tests for bgh: BGH_SELF_LOG auto-derivation
# and the ready check. Self-contained bash; uses a stub gh on PATH (never the
# real gh) and a temporary global git config.
set -euo pipefail

script_dir=$(cd "$(dirname "$0")" && pwd)
failures=0

# Clean up markers and temp dirs on exit.
tmp=$(mktemp -d)
trap 'rm -rf "$tmp" "/tmp/pi-session-roles/test-pi-session" "/tmp/pi-session-roles/a" "/tmp/cc-session-roles/test-cc-session" "/tmp/codex-session-roles/test-codex-session"' EXIT

# --- stub gh -----------------------------------------------------------------
mkdir -p "$tmp/bin"
cat > "$tmp/bin/gh" <<'EOF'
#!/bin/sh
printf '%s\n' 'https://github.com/x/y/pull/1#issuecomment-777001'
EOF
chmod +x "$tmp/bin/gh"
export PATH="$tmp/bin:$PATH"

# Ensure the stub wins; if a real gh exists elsewhere, it must not be first.
if [ "$(command -v gh)" != "$tmp/bin/gh" ]; then
	echo "FAIL: gh is not the stub" >&2
	exit 1
fi

# --- git config isolated to temp file -----------------------------------------
export GIT_CONFIG_GLOBAL="$tmp/.gitconfig"
sev_dir="$tmp/self-events"
git config --global agent.self-events-dir "$sev_dir"

# Use the bot-token path with a dummy token file; personal mode exits before
# auto-derivation, so the bot path is needed to exercise self-log derivation.
token_file="$tmp/token"
printf '%s\n' 'fake-token' > "$token_file"
export BGH_TOKEN_FILE="$token_file"

# --- helper -------------------------------------------------------------------
run_bgh() {
	"$script_dir/bgh" "$@"
}

reset_sev() {
	rm -rf "$sev_dir"
	mkdir -p "$sev_dir"
}

assert_id_logged() {
	local file=$1
	if [ -f "$file" ] && grep -qxF "777001" "$file"; then
		echo "PASS: id logged in $file"
	else
		echo "FAIL: expected 777001 in $file"; ((failures++)) || true
	fi
}

assert_id_not_logged() {
	local file=$1
	if [ -f "$file" ] && grep -qxF "777001" "$file"; then
		echo "FAIL: unexpected id in $file"; ((failures++)) || true
	else
		echo "PASS: id not logged in $file"
	fi
}

# (a) pi posting-shaped call with marker -------------------------------
echo "--- case (a): pi posting-shaped with marker ---"
reset_sev
mkdir -p /tmp/pi-session-roles
printf '%s\n' "tl-lane" > "/tmp/pi-session-roles/test-pi-session"
(
	unset CLAUDE_CODE_SESSION_ID || true
	export PI_SESSION_ID="test-pi-session"
	run_bgh pr comment 1 --body "hello"
)
assert_id_logged "$sev_dir/tl-lane.ids"

# (b) pi read-shaped call ------------------------------------------------------
echo "--- case (b): pi read-shaped ---"
reset_sev
(
	unset CLAUDE_CODE_SESSION_ID || true
	export PI_SESSION_ID="test-pi-session"
	run_bgh api "repos/x/y/issues"
)
assert_id_not_logged "$sev_dir/tl-lane.ids"

# (c) pi posting-shaped with NO marker ---------------------------------------
echo "--- case (c): pi posting-shaped without marker ---"
reset_sev
rm -f "/tmp/pi-session-roles/test-pi-session"
(
	unset CLAUDE_CODE_SESSION_ID || true
	export PI_SESSION_ID="test-pi-session"
	run_bgh pr comment 1 --body "hello"
)
assert_id_not_logged "$sev_dir/tl-lane.ids"

# (d) explicit BGH_SELF_LOG overrides derivation -----------------------------
echo "--- case (d): explicit BGH_SELF_LOG overrides ---"
reset_sev
explicit_log="$tmp/explicit.ids"
mkdir -p "$sev_dir"
printf '%s\n' "tl-lane" > "/tmp/pi-session-roles/test-pi-session"
(
	unset CLAUDE_CODE_SESSION_ID || true
	export PI_SESSION_ID="test-pi-session"
	export BGH_SELF_LOG="$explicit_log"
	run_bgh pr comment 1 --body "hello"
)
assert_id_logged "$explicit_log"
assert_id_not_logged "$sev_dir/tl-lane.ids"

# (e) path-unsafe PI_SESSION_ID ----------------------------------------------
echo "--- case (e): path-unsafe PI_SESSION_ID ---"
reset_sev
# create a sibling that would match a naive prefix if not guarded
mkdir -p "/tmp/pi-session-roles/a"
printf '%s\n' "tl-lane" > "/tmp/pi-session-roles/a/b"
(
	unset CLAUDE_CODE_SESSION_ID || true
	export PI_SESSION_ID="a/b"
	run_bgh pr comment 1 --body "hello"
)
assert_id_not_logged "$sev_dir/tl-lane.ids"

# (f) Claude Code branch regression ------------------------------------------
echo "--- case (f): Claude Code branch regression ---"
reset_sev
mkdir -p /tmp/cc-session-roles
printf '%s\n' "tl-lane" > "/tmp/cc-session-roles/test-cc-session"
(
	unset PI_SESSION_ID || true
	export CLAUDE_CODE_SESSION_ID="test-cc-session"
	run_bgh pr comment 1 --body "hello"
)
assert_id_logged "$sev_dir/tl-lane.ids"

# (f2) Codex branch -----------------------------------------------------------
echo "--- case (f2): Codex branch ---"
reset_sev
mkdir -p /tmp/codex-session-roles
printf '%s' "tl-lane" > "/tmp/codex-session-roles/test-codex-session"
(
	unset CLAUDE_CODE_SESSION_ID PI_SESSION_ID || true
	export CODEX_THREAD_ID="test-codex-session"
	run_bgh pr comment 1 --body "hello"
)
assert_id_logged "$sev_dir/tl-lane.ids"

# (n) named registration match: log to ITS self-events dir, not the role dir --
echo "--- case (n): named registration match logs to its own dir ---"
reset_sev
named_dir="$tmp/named-self-events"
mkdir -p "$named_dir"
mkdir -p /tmp/pi-session-roles
printf '%s\n' "tl-lane" > "/tmp/pi-session-roles/test-pi-session"
cat > "$tmp/bin/agent-session-stub-match" <<EOF
#!/bin/sh
printf '%s\n' '{"ok":true,"session":{"role":"tl","lane":"lane","paths":{"self_events":"$named_dir"}}}'
EOF
chmod +x "$tmp/bin/agent-session-stub-match"
(
	unset CLAUDE_CODE_SESSION_ID || true
	export PI_SESSION_ID="test-pi-session"
	export AGENT_SESSION_TOOL="$tmp/bin/agent-session-stub-match"
	run_bgh pr comment 1 --body "hello"
)
assert_id_logged "$named_dir/tl-lane.ids"
assert_id_not_logged "$sev_dir/tl-lane.ids"

# (o) named lookup: no active registration (exit 3) falls back --------------
echo "--- case (o): stub exits 3, falls back to role-based path ---"
reset_sev
cat > "$tmp/bin/agent-session-stub-noreg" <<'EOF'
#!/bin/sh
echo '{"ok":false,"code":3,"error":"No active named registration"}' >&2
exit 3
EOF
chmod +x "$tmp/bin/agent-session-stub-noreg"
(
	unset CLAUDE_CODE_SESSION_ID || true
	export PI_SESSION_ID="test-pi-session"
	export AGENT_SESSION_TOOL="$tmp/bin/agent-session-stub-noreg"
	run_bgh pr comment 1 --body "hello"
)
assert_id_logged "$sev_dir/tl-lane.ids"

# (p) named lookup: stub hangs -- bounded, falls back, gh call still succeeds -
echo "--- case (p): stub hangs, falls back and gh call still succeeds ---"
reset_sev
cat > "$tmp/bin/agent-session-stub-hang" <<'EOF'
#!/bin/sh
sleep 60
EOF
chmod +x "$tmp/bin/agent-session-stub-hang"
hang_err="$tmp/hang.stderr"
start=$(date +%s)
(
	unset CLAUDE_CODE_SESSION_ID || true
	export PI_SESSION_ID="test-pi-session"
	export AGENT_SESSION_TOOL="$tmp/bin/agent-session-stub-hang"
	out=$(run_bgh pr comment 1 --body "hello" 2>"$hang_err")
	case $out in *issuecomment*) ;; *) echo "FAIL: gh call did not succeed while stub hung" >&2 ;; esac
)
elapsed=$(( $(date +%s) - start ))
assert_id_logged "$sev_dir/tl-lane.ids"
if [ "$elapsed" -le 10 ]; then
	echo "PASS: bounded wait (${elapsed}s)"
else
	echo "FAIL: hang was not bounded (${elapsed}s)"; ((failures++)) || true
fi
if [ -s "$hang_err" ]; then
	echo "FAIL: unexpected stderr on a bounded timeout: $(cat "$hang_err")"; ((failures++)) || true
else
	echo "PASS: no stderr leaked on a bounded timeout"
fi

# (p2) named lookup: stub prints garbage, falls back ------------------------
echo "--- case (p2): stub prints garbage, falls back to role-based path ---"
reset_sev
cat > "$tmp/bin/agent-session-stub-garbage" <<'EOF'
#!/bin/sh
printf 'not json at all\n'
EOF
chmod +x "$tmp/bin/agent-session-stub-garbage"
(
	unset CLAUDE_CODE_SESSION_ID || true
	export PI_SESSION_ID="test-pi-session"
	export AGENT_SESSION_TOOL="$tmp/bin/agent-session-stub-garbage"
	run_bgh pr comment 1 --body "hello"
)
assert_id_logged "$sev_dir/tl-lane.ids"

# (q) a read-shaped call never invokes the named-session lookup -------------
echo "--- case (q): read-shaped call never invokes agent-session ---"
reset_sev
called_flag="$tmp/stub-called"
rm -f "$called_flag"
cat > "$tmp/bin/agent-session-stub-recorder" <<EOF
#!/bin/sh
touch "$called_flag"
printf '%s\n' '{"ok":true,"session":{"role":"tl","lane":"lane","paths":{"self_events":"$named_dir"}}}'
EOF
chmod +x "$tmp/bin/agent-session-stub-recorder"
(
	unset CLAUDE_CODE_SESSION_ID || true
	export PI_SESSION_ID="test-pi-session"
	export AGENT_SESSION_TOOL="$tmp/bin/agent-session-stub-recorder"
	run_bgh api "repos/x/y/issues"
)
if [ -f "$called_flag" ]; then
	echo "FAIL: agent-session invoked on a read-shaped call"; ((failures++)) || true
else
	echo "PASS: agent-session not invoked on a read-shaped call"
fi

# (g) ready check declared and failing: refuse, gh not called ----------------
echo "--- case (g): ready check fails ---"
cat > "$tmp/check-fail" <<'EOF'
#!/bin/sh
echo "gate red for pr $1"; exit 1
EOF
cat > "$tmp/check-pass" <<'EOF'
#!/bin/sh
[ "$1" = "5" ] && exit 0; exit 1
EOF
chmod +x "$tmp/check-fail" "$tmp/check-pass"
# The stub gh prints an issuecomment URL; the check scripts never do, so that
# token tells a real gh call apart from the check's own output.
gh_called() { case $1 in *issuecomment*) return 0 ;; *) return 1 ;; esac; }
git config --global agent.ready-check "$tmp/check-fail"
if out=$(run_bgh pr ready 5 2>/dev/null); then
	echo "FAIL: ready allowed despite a failing check"; ((failures++)) || true
elif gh_called "$out"; then
	echo "FAIL: gh was called after a failed check"; ((failures++)) || true
else
	echo "PASS: ready refused, gh not called"
fi

# (h) ready check passes: gh called ------------------------------------------
echo "--- case (h): ready check passes ---"
git config --global agent.ready-check "$tmp/check-pass"
if out=$(run_bgh pr ready 5 2>/dev/null) && gh_called "$out"; then
	echo "PASS: ready allowed after a passing check"
else
	echo "FAIL: ready blocked despite a passing check"; ((failures++)) || true
fi

# (i) --undo is never gated ---------------------------------------------------
echo "--- case (i): --undo bypasses the check ---"
git config --global agent.ready-check "$tmp/check-fail"
if out=$(run_bgh pr ready 5 --undo 2>/dev/null) && gh_called "$out"; then
	echo "PASS: undo not gated"
else
	echo "FAIL: undo was gated"; ((failures++)) || true
fi

# (k) installed as gh ahead of the real binary: no recursion, the real gh is
# the first PATH entry that is not the shim itself.
echo "--- case (k): invoked as gh through a symlink ---"
mkdir -p "$tmp/shim"
ln -s "$script_dir/bgh" "$tmp/shim/gh"
if out=$(PATH="$tmp/shim:$PATH" gh pr comment 1 --body "hello" 2>&1) && gh_called "$out"; then
	echo "PASS: gh shim reached the real gh"
else
	echo "FAIL: gh shim: $out"; ((failures++)) || true
fi

# (l) a preset GH_TOKEN passes through with no identity lookup ------------
echo "--- case (l): preset GH_TOKEN passes through ---"
if out=$(env -u BGH_TOKEN_FILE GH_TOKEN=preset "$script_dir/bgh" pr view 1 2>&1) && gh_called "$out"; then
	echo "PASS: preset GH_TOKEN passed through"
else
	echo "FAIL: preset GH_TOKEN: $out"; ((failures++)) || true
fi

# (m) outside a git repo the real gh runs unchanged --------------------------
echo "--- case (m): outside a git repo ---"
mkdir -p "$tmp/nogit"
if out=$(cd "$tmp/nogit" && env -u BGH_TOKEN_FILE "$script_dir/bgh" pr view 1 2>&1) && gh_called "$out"; then
	echo "PASS: real gh ran outside a repo"
else
	echo "FAIL: outside a repo: $out"; ((failures++)) || true
fi

if [ "$failures" -eq 0 ]; then
	echo "ALL PASS"
	exit 0
else
	echo "FAILURES: $failures"
	exit 1
fi
