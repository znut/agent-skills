#!/usr/bin/env bash
# UserPromptSubmit hook: when the user invokes a role skill (/pm, /tl,
# /tl <lane>), persist the role for this session so a statusline can render
# a role chip and parallel role sessions stay unmistakable.
# Writes the role string to /tmp/cc-session-roles/<session_id>; a statusline
# script reads it back. Silent + fast: no output, always exit 0.

input=$(cat)
sid=$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)
prompt=$(printf '%s' "$input" | jq -r '.prompt // empty' 2>/dev/null)
[ -z "$sid" ] || [ -z "$prompt" ] && exit 0
case "$sid" in */*|*..*) exit 0 ;; esac

role=""
case "$prompt" in
	/pm|/pm\ *) role="pm" ;;
	/tl|/tl\ *)
		lane=$(printf '%s' "$prompt" | awk '{print $2}' | tr -cd 'a-z0-9-')
		role="tl${lane:+-$lane}"
		;;
esac
[ -z "$role" ] && exit 0

mkdir -p /tmp/cc-session-roles 2>/dev/null
printf '%s' "$role" > "/tmp/cc-session-roles/$sid" 2>/dev/null
exit 0
