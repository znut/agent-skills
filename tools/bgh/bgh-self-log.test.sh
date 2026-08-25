#!/usr/bin/env bash
# bgh-self-log.test.sh — smoke test for bgh BGH_SELF_LOG auto-derivation.
# Self-contained bash; uses a stub gh on PATH (never the real gh).
set -euo pipefail

script_dir=$(cd "$(dirname "$0")" && pwd)
failures=0

# Clean up markers and temp dirs on exit.
tmp=$(mktemp -d)
trap 'rm -rf "$tmp" "/tmp/pi-session-roles/test-pi-session" "/tmp/pi-session-roles/a" "/tmp/cc-session-roles/test-cc-session"' EXIT

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
git config agent.self-events-dir "$sev_dir"

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
printf '%s\n' "tl-platform" > "/tmp/pi-session-roles/test-pi-session"
(
	unset CLAUDE_CODE_SESSION_ID || true
	export PI_SESSION_ID="test-pi-session"
	run_bgh pr comment 1 --body "hello"
)
assert_id_logged "$sev_dir/tl-platform.ids"

# (b) pi read-shaped call ------------------------------------------------------
echo "--- case (b): pi read-shaped ---"
reset_sev
(
	unset CLAUDE_CODE_SESSION_ID || true
	export PI_SESSION_ID="test-pi-session"
	run_bgh api "repos/x/y/issues"
)
assert_id_not_logged "$sev_dir/tl-platform.ids"

# (c) pi posting-shaped with NO marker ---------------------------------------
echo "--- case (c): pi posting-shaped without marker ---"
reset_sev
rm -f "/tmp/pi-session-roles/test-pi-session"
(
	unset CLAUDE_CODE_SESSION_ID || true
	export PI_SESSION_ID="test-pi-session"
	run_bgh pr comment 1 --body "hello"
)
assert_id_not_logged "$sev_dir/tl-platform.ids"

# (d) explicit BGH_SELF_LOG overrides derivation -----------------------------
echo "--- case (d): explicit BGH_SELF_LOG overrides ---"
reset_sev
explicit_log="$tmp/explicit.ids"
mkdir -p "$sev_dir"
printf '%s\n' "tl-platform" > "/tmp/pi-session-roles/test-pi-session"
(
	unset CLAUDE_CODE_SESSION_ID || true
	export PI_SESSION_ID="test-pi-session"
	export BGH_SELF_LOG="$explicit_log"
	run_bgh pr comment 1 --body "hello"
)
assert_id_logged "$explicit_log"
assert_id_not_logged "$sev_dir/tl-platform.ids"

# (e) path-unsafe PI_SESSION_ID ----------------------------------------------
echo "--- case (e): path-unsafe PI_SESSION_ID ---"
reset_sev
# create a sibling that would match a naive prefix if not guarded
mkdir -p "/tmp/pi-session-roles/a"
printf '%s\n' "tl-platform" > "/tmp/pi-session-roles/a/b"
(
	unset CLAUDE_CODE_SESSION_ID || true
	export PI_SESSION_ID="a/b"
	run_bgh pr comment 1 --body "hello"
)
assert_id_not_logged "$sev_dir/tl-platform.ids"

# (f) Claude Code branch regression ------------------------------------------
echo "--- case (f): Claude Code branch regression ---"
reset_sev
mkdir -p /tmp/cc-session-roles
printf '%s\n' "tl-platform" > "/tmp/cc-session-roles/test-cc-session"
(
	unset PI_SESSION_ID || true
	export CLAUDE_CODE_SESSION_ID="test-cc-session"
	run_bgh pr comment 1 --body "hello"
)
assert_id_logged "$sev_dir/tl-platform.ids"

if [ "$failures" -eq 0 ]; then
	echo "ALL PASS"
	exit 0
else
	echo "FAILURES: $failures"
	exit 1
fi
