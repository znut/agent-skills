#!/usr/bin/env bash
set -euo pipefail

# Renders the two launchd templates in tools/launchd/ into concrete plists
# and installs them into ~/Library/LaunchAgents (or $LAUNCH_AGENTS_DIR, for
# testing). Never runs `launchctl bootstrap` itself — it only prints the
# commands, so nothing gets registered with launchd without a separate,
# explicit step from you.
#
# Usage: tools/install.sh <configName>
#   <configName> must match the "name" field of a config you've placed at
#   $AGENT_TOOLS_HOME/config/<configName>.json — see tools/config/example.json
#   and tools/README.md for the config contract.

CONFIG_NAME="${1:-}"
if [ -z "$CONFIG_NAME" ]; then
	echo "usage: tools/install.sh <configName>" >&2
	exit 1
fi

TOOLS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_TOOLS_HOME="${AGENT_TOOLS_HOME:-$HOME/.config/agent-tools}"
VAR_DIR="$AGENT_TOOLS_HOME/var"
LAUNCH_AGENTS_DIR="${LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"

BUN_PATH="$(command -v bun || true)"
if [ -z "$BUN_PATH" ]; then
	echo "install.sh: bun not found on PATH — install bun first (https://bun.sh)" >&2
	exit 1
fi

GH_PATH="$(command -v gh || true)"
if [ -z "$GH_PATH" ]; then
	echo "install.sh: gh (GitHub CLI) not found on PATH — board-snapshot and on-merge command steps both shell out to it" >&2
	exit 1
fi

BUN_DIR="$(dirname "$BUN_PATH")"
GH_DIR="$(dirname "$GH_PATH")"
# Both directories must land in the rendered plist PATH: launchd invokes
# ProgramArguments[0] (bun) directly, and board-snapshot / on-merge command
# steps shell out to `gh` — computed fresh here every run, never hardcoded to
# one bun version or one package manager's install prefix. ~/.local/bin rides
# along for the repo-level wrappers on-merge steps invoke (e.g. the bgh
# identity wrapper) — without it, any step or test that shells out to one
# fails only under launchd and never in an interactive checkout.
RENDERED_PATH="$BUN_DIR:$GH_DIR:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

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
ON_MERGE_PLIST="$LAUNCH_AGENTS_DIR/com.agent-tools.on-merge.plist"

render "$TOOLS_DIR/launchd/com.agent-tools.gh-status.plist.template" "$GH_STATUS_PLIST"
render "$TOOLS_DIR/launchd/com.agent-tools.on-merge.plist.template" "$ON_MERGE_PLIST"

plutil -lint "$GH_STATUS_PLIST"
plutil -lint "$ON_MERGE_PLIST"

echo
echo "Rendered:"
echo "  $GH_STATUS_PLIST"
echo "  $ON_MERGE_PLIST"
echo
echo "Not installed yet — review the plists above, then run:"
echo "  launchctl bootstrap gui/\$UID $GH_STATUS_PLIST"
echo "  launchctl bootstrap gui/\$UID $ON_MERGE_PLIST"
