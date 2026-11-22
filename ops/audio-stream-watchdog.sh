#!/usr/bin/env bash
# Watchdog for the signage audio stream (librespot -> ffmpeg -> Icecast -> BrightSign).
# systemd only knows the processes are *running*; Icecast 2.5.0 can hang with its port open while serving nothing
# (a full accept queue, source thread stuck). This checks that Icecast really answers and that the mount has a source,
# and recovers it. Runs every minute from audio-stream-watchdog.timer.
#   Icecast not answering for 2 checks in a row  -> restart icecast2, then spotify-stream (to re-attach the source)
#   Icecast fine but no source for 3 checks      -> restart spotify-stream
# At most one recovery per 10 minutes, so a real outage (network, Spotify) can't turn into a restart loop.
set -uo pipefail
STATE="${XDG_RUNTIME_DIR:-/tmp}/audio-stream-watchdog"; mkdir -p "$STATE"
URL="${ICECAST_STATUS_URL:-http://localhost:8000/status-json.xsl}"; MOUNT="${ICECAST_MOUNT:-/spotify.mp3}"
COOLDOWN="${COOLDOWN:-600}"
log(){ echo "[$(date -Is)] $*"; }
count(){ cat "$STATE/$1" 2>/dev/null || echo 0; }

now=$(date +%s)
body="$(curl -fsS -m 6 "$URL" 2>/dev/null)"; rc=$?
if [ $rc -ne 0 ]; then kind=hung; elif grep -q "\"listenurl\"[^,]*${MOUNT}" <<<"$body"; then kind=ok; else kind=nosource; fi

if [ $kind = ok ]; then
  [ "$(count hung)$(count nosource)" != "00" ] && log "stream healthy again"
  echo 0 >"$STATE/hung"; echo 0 >"$STATE/nosource"; exit 0
fi
n=$(( $(count $kind) + 1 )); echo $n >"$STATE/$kind"
[ $kind = hung ] && echo 0 >"$STATE/nosource" || echo 0 >"$STATE/hung"
need=2; [ $kind = nosource ] && need=3
log "check failed: $kind ($n/$need)"
[ $n -lt $need ] && exit 0

last=$(cat "$STATE/last" 2>/dev/null || echo 0)
if [ $(( now - last )) -lt "$COOLDOWN" ]; then log "recovered less than ${COOLDOWN}s ago; waiting"; exit 0; fi
echo "$now" >"$STATE/last"; echo 0 >"$STATE/hung"; echo 0 >"$STATE/nosource"
if [ $kind = hung ]; then
  log "Icecast is not answering: restarting icecast2"; sudo -n systemctl restart icecast2 || log "icecast2 restart failed"
  sleep 3
fi
log "restarting spotify-stream so the source re-attaches"; systemctl --user restart spotify-stream.service || log "spotify-stream restart failed"
