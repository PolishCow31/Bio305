#!/bin/zsh
# Bio 305 deep-grade relay. Drains pending grade jobs from the Worker, grades each with
# `claude -p` (via grade.py), posts the verdict back. Run on an interval by launchd (see the .plist).
# Needs env: BIO305_API (Worker base URL), BIO305_RELAY_SECRET. Single-pass + lockfile so
# overlapping launchd runs don't double-grade.

API="${BIO305_API:?set BIO305_API}"
SECRET="${BIO305_RELAY_SECRET:?set BIO305_RELAY_SECRET}"
CLAUDE="/Users/christian/.npm-global/bin/claude"
DIR="${0:A:h}"
LOCK="/tmp/bio305-relay.lock"

[ -e "$LOCK" ] && exit 0
trap 'rm -f "$LOCK"' EXIT
touch "$LOCK"

# Normally /jobs is a cheap single-key read (the pending index). Once an hour, add ?full=1 so the
# Worker does an authoritative KV.list to catch anything the index missed and prune dead ids.
# Keeps list ops ~24/day instead of the 2,880/day (30s poll) that blew the 1,000/day KV list cap.
SWEEP="/tmp/bio305-relay.sweep"
full=""
if [ ! -e "$SWEEP" ] || [ $(( $(date +%s) - $(stat -f %m "$SWEEP" 2>/dev/null || echo 0) )) -ge 3600 ]; then
  full="?full=1"; touch "$SWEEP"
fi
jobs=$(curl -s -H "x-relay-secret: $SECRET" "$API/jobs$full")
[ -z "$jobs" ] && exit 0

# Program from the file, jobs JSON from the pipe (stdin). Keeping these separate is the fix —
# `python3 - <<HEREDOC` would override the pipe with the heredoc and the data would never arrive.
print -r -- "$jobs" | python3 "$DIR/grade.py" "$API" "$SECRET" "$CLAUDE"
