#!/usr/bin/env bash
set -euo pipefail

# Renders the launchd templates in tools/launchd/ into concrete plists
# (gh-status, main-ci, on-merge, and on-merge-gate — the last one runs a
# config's optional `onMergeGate` list as its own job) and installs them into
# ~/Library/LaunchAgents (or $LAUNCH_AGENTS_DIR, for testing). Never runs
# `launchctl bootstrap` itself — it only prints the
# commands, so nothing gets registered with launchd without a separate,
# explicit step from you.
#
# Usage: tools/install.sh [--dry-run] <configName>
#   <configName> must match the "name" field of a config you've placed at
#   $AGENT_TOOLS_HOME/config/<configName>.json — see tools/config/example.json
#   and tools/README.md for the config contract.
#   --dry-run renders and lints into a temp dir, prints the launchd PATH,
#   and writes nothing under LaunchAgents.

usage() {
	echo "usage: tools/install.sh [--dry-run] <configName>" >&2
	exit 1
}
DRY_RUN=false
CONFIG_NAME=""
for arg in "$@"; do
	case "$arg" in
		--dry-run) DRY_RUN=true ;;
		-*) usage ;;
		*) [ -z "$CONFIG_NAME" ] || usage; CONFIG_NAME="$arg" ;;
	esac
done
[ -n "$CONFIG_NAME" ] || usage

TOOLS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_TOOLS_HOME="${AGENT_TOOLS_HOME:-$HOME/.config/agent-tools}"
VAR_DIR="$AGENT_TOOLS_HOME/var"
LAUNCH_AGENTS_DIR="${LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"

BUN_PATH="$(command -v bun || true)"
if [ -z "$BUN_PATH" ]; then
	echo "install.sh: bun not found on PATH — install bun first (https://bun.sh)" >&2
	exit 1
fi

# The real gh, not the bgh wrapper installed as gh: bgh looks for the real
# binary on PATH, so the rendered PATH must carry the real one's directory.
GH_PATH=""
IFS=: read -ra path_dirs <<< "$PATH"
for d in "${path_dirs[@]}"; do
	[ -x "$d/gh" ] || continue
	[ "$(basename "$(realpath "$d/gh")")" = bgh ] && continue
	GH_PATH="$d/gh"
	break
done
if [ -z "$GH_PATH" ]; then
	echo "install.sh: no real gh (GitHub CLI) on PATH, only the bgh wrapper or nothing — board-snapshot and repo steps shell out to it" >&2
	exit 1
fi

BUN_DIR="$(dirname "$BUN_PATH")"
GH_DIR="$(dirname "$GH_PATH")"
# launchd gets no user PATH: bun, node (a test runner that spawns node must
# not land on bun's shim), ~/.local/bin (bgh and other wrappers), real gh.
NODE_PATH_BIN="$(command -v node || true)"
NODE_DIR="${NODE_PATH_BIN:+$(dirname "$NODE_PATH_BIN")}"
RENDERED_PATH="$BUN_DIR:${NODE_DIR:+$NODE_DIR:}$HOME/.local/bin:$GH_DIR:/usr/bin:/bin:/usr/sbin:/sbin"

if [ "$DRY_RUN" = true ]; then
	LAUNCH_AGENTS_DIR="$(mktemp -d)"
	trap 'rm -rf "$LAUNCH_AGENTS_DIR"' EXIT
fi
mkdir -p "$LAUNCH_AGENTS_DIR"

render() {
	local template="$1" out="$2"
	sed \
		-e "s#__BUN__#$BUN_PATH#g" \
		-e "s#__TOOLS_DIR__#$TOOLS_DIR#g" \
		-e "s#__VAR_DIR__#$VAR_DIR#g" \
		-e "s#__CONFIG_NAME__#$CONFIG_NAME#g" \
		-e "s#__PATH__#$RENDERED_PATH#g" \
		-e "s#__AGENT_TOOLS_HOME__#$AGENT_TOOLS_HOME#g" \
		"$template" > "$out"
}

GH_STATUS_PLIST="$LAUNCH_AGENTS_DIR/com.agent-tools.gh-status.plist"
MAIN_CI_PLIST="$LAUNCH_AGENTS_DIR/com.agent-tools.main-ci.plist"
ON_MERGE_PLIST="$LAUNCH_AGENTS_DIR/com.agent-tools.on-merge.plist"
ON_MERGE_GATE_PLIST="$LAUNCH_AGENTS_DIR/com.agent-tools.on-merge-gate.plist"

render "$TOOLS_DIR/launchd/com.agent-tools.gh-status.plist.template" "$GH_STATUS_PLIST"
render "$TOOLS_DIR/launchd/com.agent-tools.main-ci.plist.template" "$MAIN_CI_PLIST"
render "$TOOLS_DIR/launchd/com.agent-tools.on-merge.plist.template" "$ON_MERGE_PLIST"
render "$TOOLS_DIR/launchd/com.agent-tools.on-merge-gate.plist.template" "$ON_MERGE_GATE_PLIST"

plutil -lint "$GH_STATUS_PLIST"
plutil -lint "$MAIN_CI_PLIST"
plutil -lint "$ON_MERGE_PLIST"
plutil -lint "$ON_MERGE_GATE_PLIST"

if [ "$DRY_RUN" = true ]; then
	echo
	echo "Dry run: nothing written under LaunchAgents."
	echo "launchd PATH: $RENDERED_PATH"
	echo "real gh:      $GH_PATH"
	exit 0
fi

echo
echo "Rendered:"
echo "  $GH_STATUS_PLIST"
echo "  $MAIN_CI_PLIST"
echo "  $ON_MERGE_PLIST"
echo "  $ON_MERGE_GATE_PLIST"
echo
echo "Not installed yet — review the rendered plists, then run:"
echo "  launchctl bootstrap gui/\$UID $GH_STATUS_PLIST"
echo "  launchctl bootstrap gui/\$UID $MAIN_CI_PLIST   # only if this config has a mainCi block; drop main-health from onMerge first"
echo "  launchctl bootstrap gui/\$UID $ON_MERGE_PLIST"
echo "  launchctl bootstrap gui/\$UID $ON_MERGE_GATE_PLIST   # only if this config uses onMergeGate"
