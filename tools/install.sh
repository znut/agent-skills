#!/usr/bin/env bash
set -euo pipefail

# Renders the launchd templates in tools/launchd/ into concrete plists
# (gh-status and main-ci) and installs them into ~/Library/LaunchAgents (or
# $LAUNCH_AGENTS_DIR, for testing). Never runs `launchctl bootstrap` itself —
# it only prints the commands, so nothing gets registered with launchd
# without a separate, explicit step from you. It does boot out and remove the
# retired on-merge and on-merge-gate jobs when their plists are present:
# main-ci replaces both, and either would run beside it.
#
# Usage: tools/install.sh [--dry-run] <configName>
#   <configName> must match the "name" field of a config you've placed at
#   $AGENT_TOOLS_HOME/config/<configName>.json — see tools/config/example.json
#   and tools/README.md for the config contract.
#   --dry-run renders and lints into a temp dir, prints the launchd PATH and
#   what a real run would remove, and changes nothing under LaunchAgents.

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
# launchd gets no user PATH: bun, node (not bun's shim), then ~/.local/bin
# ahead of the real gh, so `gh` resolves to bgh (the clone's identity) and
# bgh finds the real binary later on PATH.
NODE_PATH_BIN="$(command -v node || true)"
NODE_DIR="${NODE_PATH_BIN:+$(dirname "$NODE_PATH_BIN")}"
RENDERED_PATH="$BUN_DIR:${NODE_DIR:+$NODE_DIR:}$HOME/.local/bin:$GH_DIR:/usr/bin:/bin:/usr/sbin:/sbin"

TARGET_DIR="$LAUNCH_AGENTS_DIR"
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

render "$TOOLS_DIR/launchd/com.agent-tools.gh-status.plist.template" "$GH_STATUS_PLIST"
render "$TOOLS_DIR/launchd/com.agent-tools.main-ci.plist.template" "$MAIN_CI_PLIST"

plutil -lint "$GH_STATUS_PLIST"
plutil -lint "$MAIN_CI_PLIST"

echo
# A failed bootout keeps the plist: deleting it would hide a job that still runs.
STILL_LOADED=""
for label in com.agent-tools.on-merge com.agent-tools.on-merge-gate; do
	retired="$TARGET_DIR/$label.plist"
	[ -f "$retired" ] || continue
	loaded=false
	launchctl print "gui/$UID/$label" >/dev/null 2>&1 && loaded=true
	if [ "$DRY_RUN" = true ]; then
		if [ "$loaded" = true ]; then
			echo "Would retire: launchctl bootout gui/$UID/$label; rm $retired"
		else
			echo "Would retire: rm $retired (not loaded)"
		fi
		continue
	fi
	if [ "$loaded" = true ] && ! err=$(launchctl bootout "gui/$UID/$label" 2>&1); then
		echo "install.sh: $label is still loaded; bootout failed: $err; kept $retired" >&2
		STILL_LOADED="$STILL_LOADED $label"
		continue
	fi
	rm "$retired"
	echo "Retired: $label ($([ "$loaded" = true ] && echo "booted out, ")$retired removed)"
done

if [ "$DRY_RUN" = true ]; then
	echo "Dry run: nothing changed under $TARGET_DIR."
	echo "launchd PATH: $RENDERED_PATH"
	echo "real gh:      $GH_PATH"
	echo "A real run renders these plists there and prints:"
else
	echo "Rendered:"
	echo "  $GH_STATUS_PLIST"
	echo "  $MAIN_CI_PLIST"
	echo
	echo "Not installed yet — review the rendered plists, then run:"
fi
echo "  launchctl bootstrap gui/\$UID $TARGET_DIR/com.agent-tools.gh-status.plist"
echo "  launchctl bootstrap gui/\$UID $TARGET_DIR/com.agent-tools.main-ci.plist   # only if this config has a mainCi block"
if [ -n "$STILL_LOADED" ]; then
	echo "install.sh: still loaded:$STILL_LOADED — boot it out before bootstrapping main-ci" >&2
	exit 1
fi
