#!/bin/sh
# Hands soma an instruction for this Claude Code session at a later time:
#
#   sh register.sh --at <when>    with the instruction on standard input
#
# <when> is an ISO 8601 date-time with an offset or an ISO 8601 duration such as PT2M. The request goes into soma's drop
# directory as a file renamed into place, so nothing of soma's is needed here and a request written while soma is down
# is taken when it starts. The instruction is read from standard input so that no character of it passes through shell
# quoting. Prints one line; exits 0 accepted, 1 refused or nothing registered, 2 usage, 3 not confirmed.
#
# SOMA_HANDOFF_DIR is the drop directory (default prod's), SOMA_HANDOFF_WAIT the seconds to wait for soma's reply.

usage() {
	echo 'usage: sh register.sh --at <when>, with the instruction on standard input; <when> is an ISO 8601 date-time with an offset, such as 2026-11-04T18:00:00+08:00, or a duration, such as PT2M'
	exit 2
}

at=
while [ $# -gt 0 ]; do
	case $1 in
	--at)
		[ $# -ge 2 ] || usage
		at=$2
		shift 2
		;;
	--at=*)
		at=${1#--at=}
		shift
		;;
	*) usage ;;
	esac
done
# A line break in it would end the header line early.
case $at in
'' | *'
'*) usage ;;
esac

session=${CLAUDE_CODE_SESSION_ID:-}
if [ -z "$session" ]; then
	echo 'nothing was registered: CLAUDE_CODE_SESSION_ID is not set, so this is not the Bash of a Claude Code session'
	exit 1
fi
# The request file is named after it, and soma reads only names of these characters.
case $session in
-* | *[!A-Za-z0-9-]*)
	echo "nothing was registered: CLAUDE_CODE_SESSION_ID \"$session\" is not a session id"
	exit 1
	;;
esac

dir=${SOMA_HANDOFF_DIR:-$HOME/.local/share/soma/soma.sqlite.handoff}
# Never made here: soma makes it when it serves it, so a missing one means no soma does.
if [ ! -d "$dir" ]; then
	echo "nothing was registered: there is no drop directory at $dir, so no soma serves it"
	exit 1
fi

wait=${SOMA_HANDOFF_WAIT:-10}
case $wait in
'' | *[!0-9]*) wait=10 ;;
esac

umask 077
name=$session-$(date +%s)-$$
temporary=$dir/$name.tmp
request=$dir/$name.req
reply=$dir/$name.reply
if ! {
	printf 'session: %s\ncwd: %s\nat: %s\n\n' "$session" "$(pwd -P)" "$at" && cat
} >"$temporary" 2>/dev/null; then
	rm -f "$temporary"
	echo "nothing was registered: the request could not be written in $dir"
	exit 1
fi
if ! mv -f "$temporary" "$request" 2>/dev/null; then
	rm -f "$temporary"
	echo "nothing was registered: the request could not be put in place in $dir"
	exit 1
fi

waited=0
while [ ! -f "$reply" ]; do
	if [ "$waited" -ge "$wait" ]; then
		echo "not confirmed: soma did not answer within $wait s. The request is kept at $request, and soma takes it when it runs, unless its time has passed by then. Do not register it again; delete that file to withdraw it."
		exit 3
	fi
	sleep 1
	waited=$((waited + 1))
done
line=$(cat "$reply")
rm -f "$reply"
case $line in
'accepted '*)
	rest=${line#accepted }
	echo "accepted as ${rest%% *}; at ${rest#* } soma gives this session the instruction as a new prompt, resuming the session if it is closed. This session may be closed now."
	exit 0
	;;
'refused '*)
	echo "refused: ${line#refused }"
	exit 1
	;;
esac
echo "soma's reply could not be read: $line"
exit 1
