#!/bin/zsh -f
# Keep this FDA-authorized shell alive; do not exec into Python.
set -u
repo=$1
launcher="$repo/scripts/run-market.zsh"
if ! /bin/cat "$launcher" >/dev/null 2>&1; then
  print -u2 'Pro Web: main launcher cannot be opened; check repo path and /bin/zsh Full Disk Access.'
  exit 78
fi
child=0
stopping=0
trap 'if (( ! stopping )); then stopping=1; (( child > 0 )) && kill -TERM "$child" 2>/dev/null; fi' TERM INT HUP
/bin/zsh -f "$launcher" &
child=$!
# A signal between spawn and registration is deferred until the PID is known.
if (( stopping )); then kill -TERM "$child" 2>/dev/null; fi
wait "$child"
rc=$?
if (( stopping )); then
  trap '' TERM INT HUP
  # The first wait may have been interrupted before Python finished cleanup.
  wait "$child"
  final=$?
  (( final != 127 )) && rc=$final
fi
exit "$rc"
