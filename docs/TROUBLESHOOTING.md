# Troubleshooting

A symptom → likely cause → fix guide for the **Audio Flow Console** (the Spotify →
librespot → relay.py → ffmpeg → Icecast → BrightSign signage stream). It assumes you are
logged in as the `jellyfin` user on the host (LAN IP `172.16.50.100`).

Read this alongside the sibling docs in this `docs/` directory:

- **`OPERATIONS.md`** — day-to-day runbook (start/stop/restart, health checks, safe changes).
- **`ARCHITECTURE.md`** — how the two halves (audio pipeline + Web-API dashboard) fit together.
- **`AUDIO.md`** — the format chain, loudness leveling, and the "no crossfade" reality.
- **`DASHBOARD.md`** — every card and control in the web UI.

> **Secrets:** `stream.env`, `audio.env`, `schedules.json`, `token.json`, and `key.pem` are
> `chmod 600` and hold passwords or state. Reference the files — never paste their contents into
> logs, chat, or screenshots.

---

## First stop: the two health surfaces

Almost every problem is diagnosable from these two commands. Run them first.

```bash
# 1. Are all three services up?
systemctl --user is-active spotify-stream.service signage-dashboard.service
sudo systemctl is-active icecast2

# 2. What does the dashboard itself think is wrong? (one JSON snapshot of everything)
curl -s http://172.16.50.100:8088/api/status
```

`/api/status` is the single source of truth the web UI is built on. The fields that matter
most for triage (pipe through `jq` if you have it):

| Field | Meaning when wrong |
| --- | --- |
| `services.stream` | `false` → the audio pipeline (`spotify-stream.service`) is down. |
| `services.icecast` | `false` → Icecast is down; the mount will 404. |
| `source.active` | `false` → ffmpeg is **not** feeding the mount (no live source). |
| `librespot.authed` / `.user` | `false` → librespot never logged into Spotify Connect. |
| `auth.connected` | `false` → the dashboard's Spotify token is missing/broken (401). |
| `schedule.enabled` / `.count` / `.active` | tells you whether the timeline should be playing now. |
| `nowplaying.state` | `playing` / `paused` / `idle` / `unlinked` / `ratelimited`. |
| `streamUrl` | the exact mount URL the sign should be pulling. |

---

## Quick-triage table

| Symptom | Most likely cause | Jump to |
| --- | --- | --- |
| Stream URL returns **404** | ffmpeg source disconnected (stream pipeline or Icecast down) | [404 / no audio](#stream-url-gives-404-or-no-audio) |
| Stream URL returns **200 but silence** | Nothing is playing (schedule gap, paused, unlinked) — relay pads silence | [404 / no audio](#stream-url-gives-404-or-no-audio) |
| **"Signage device offline"** / **409** on Play | librespot isn't showing as the `Signage` Connect device | [Device offline / 409](#signage-device-offline--409-on-play) |
| **"Connect Spotify"** banner / **401** | The dashboard's Spotify token needs a re-auth | [Not linked / 401](#spotify-not-linked--needs-re-auth-401) |
| **429 / rate-limited** warning | Too many Spotify Web-API calls; global backoff engaged | [Rate-limited / 429](#rate-limited--429) |
| Tracks **jump every few seconds** | The real-time relay lost its pacing | [Tracks jump](#tracks-jump-every-few-seconds-relay-lost-real-time-pacing) |
| **Dashboard won't load** | `signage-dashboard.service` down or port blocked | [Dashboard won't load](#dashboard-not-loading) |
| **Schedule isn't playing** | Automation off, empty/gap timeline, offline, token, or override | [Schedule not playing](#the-schedule-is-not-playing) |
| **Loudness change did nothing** | The stream must restart to reload librespot flags | [Loudness no-op](#a-loudness-change-did-nothing-stream-restart-needed) |
| BrightSign shows **disconnected** after an audio change | Transient — the source dropped during the restart | [BrightSign reconnect](#brightsign-shows-disconnected-after-an-audio-change-transient) |
| Playback **does not loop** at end of playlist | `repeat` is not set to `context` | [No loop](#playback-does-not-loop-repeat-state) |

---

## Stream URL gives 404 or no audio

The public stream URL is **`http://172.16.50.100:8000/spotify.mp3`** (port `8000`, mount
`/spotify.mp3`, served by the **system** `icecast2` service).

Key fact: `relay.py` pads **digital silence** into the pipeline whenever nothing is playing
(pause / idle / schedule gap). So the mount stays **up** (200, bytes flowing) even when the
sign is intentionally quiet. That gives you two very different failure modes:

### A. 404 — the mount is dead

A 404 means Icecast has **no source client** on `/spotify.mp3` — i.e. ffmpeg is not connected.
That happens when the audio pipeline is down, or Icecast itself is down/restarting.

**Diagnose**

```bash
# Expect: HTTP/1.0 200 OK, Content-Type: audio/mpeg. A dead mount => 404.
curl -sI http://172.16.50.100:8000/spotify.mp3

# Is the pipeline running? Is Icecast running?
systemctl --user status spotify-stream.service --no-pager
sudo systemctl status icecast2 --no-pager

# What did the pipeline log on its way down?
journalctl --user -u spotify-stream -n 80 --no-pager
```

**Fix**

```bash
# If Icecast is down, bring it back first, THEN restart the source pipeline so ffmpeg reconnects:
sudo systemctl restart icecast2 && systemctl --user restart spotify-stream.service

# If only the pipeline is down:
systemctl --user restart spotify-stream.service
```

Re-check with `curl -sI` — it should flip to `200 OK` within a few seconds. If it keeps
dying, read the stream log (`journalctl --user -u spotify-stream -f`) for a librespot,
`relay.py`, or ffmpeg error, and confirm `stream.env` still holds the correct Icecast
host/port/mount and source password.

### B. 200 but no sound on the sign

The mount is alive but you hear silence. The pipeline is healthy; **nothing is playing**, or
the BrightSign isn't pulling.

**Diagnose**

```bash
# Prove bytes are flowing (they will, even during silence):
curl -s --max-time 2 http://172.16.50.100:8000/spotify.mp3 -o /dev/null -w 'bytes=%{size_download} http=%{http_code}\n'

# What does the system think is playing, and why?
curl -s http://172.16.50.100:8088/api/status
```

Check, in order:

1. **Now playing** — `nowplaying.state`. If `paused` or `idle`, nothing is being sent. If
   `unlinked`, see [Not linked / 401](#spotify-not-linked--needs-re-auth-401).
2. **Schedule** — any moment **not** covered by a schedule block is intentionally
   paused/silent. Check the dashboard status pill (On-air / Off-air (silent) / No blocks yet /
   Schedule off) and see [The schedule is not playing](#the-schedule-is-not-playing).
3. **The BrightSign itself** — confirm it is on the network at `172.16.1.187` and still has
   `http://172.16.50.100:8000/spotify.mp3` configured as its Audio Stream. It should appear in
   the dashboard's **Connected Outputs** card; if it is missing there, it isn't pulling. Test
   the URL from a laptop (VLC or a browser) to prove audio is really on the mount.

---

## "Signage device offline" / 409 on Play

The dashboard controls playback by finding a Spotify Connect device **named `Signage`** (that
device is our librespot instance) and transferring playback to it. `POST /api/play` and
`POST /api/seek` return **409** with error `device-offline` when no `Signage` device is
present in Spotify's device list.

**Diagnose**

```bash
# Did librespot authenticate and register as a Connect device?
curl -s http://172.16.50.100:8088/api/status     # look at librespot.authed / librespot.user

# Confirm librespot logged in (it prints this once at startup):
journalctl --user -u spotify-stream --no-pager | grep -i 'Authenticated as' | tail -1

# Is the pipeline actually running?
systemctl --user status spotify-stream.service --no-pager
```

**Likely causes and fixes**

| Cause | Fix |
| --- | --- |
| librespot's dealer websocket died without reconnecting (**the common case**, see below). | Automatic — the reconciler restarts `spotify-stream.service` itself. See **Auto self-heal** below. |
| The stream pipeline is down (so librespot isn't running). | `systemctl --user restart spotify-stream.service`, wait ~10 s, retry Play. |
| librespot is running but hasn't finished registering with Spotify Connect. | Wait ~10–20 s after a restart and retry; watch the log for `Authenticated as`. |
| librespot can't authenticate (bad/expired cache, network). | Restart the stream; check the log for auth errors. Cache lives at `/home/jellyfin/.cache/librespot`. |
| The dashboard's Web-API token is unlinked, so it can't even list devices. | See [Not linked / 401](#spotify-not-linked--needs-re-auth-401) — that would show as 401, not 409, but re-linking fixes both. |

Note: librespot always launches with `--disable-discovery` and the fixed name `Signage`, so the
device name never changes — if `Signage` is absent, librespot is simply not up or not logged in.

**Root cause of the common case (confirmed Aug 2026):** librespot's websocket connection to
Spotify's dealer service can die (log shows `WARN librespot_core::dealer] Websocket peer does not
respond.`) and, unlike a normal disconnect, never reconnect. The **process stays alive** (so
`systemctl` shows it `active (running)` and `librespot.authed:true` on the dashboard) but it
silently falls off Spotify's Connect device list — `GET /me/player/devices` returns `[]` — so
every scheduled block fails with `device-offline` until something restarts the process. Because
the process never exits, `Restart=always` in the systemd unit does **not** catch this; only an
external check that actually asks Spotify "is the device there?" can.

**Auto self-heal:** `reconcile()` in `server.js` does exactly that — when a scheduled block's
`playPlaylist()` fails with `device-offline`, it calls `healStream()`, which runs
`systemctl --user restart spotify-stream.service` (cooldown-gated to once per 5 minutes so a real
outage can't trigger a restart loop) and logs `⟳ Signage device offline — restarting
spotify-stream.service to recover` / `✓ ... restarted` to the scheduler log (`GET /api/schedules`
→ `log`, also shown in the dashboard's activity feed). librespot typically re-registers as
`Signage` within ~10 s of the restart, well inside the next 15 s reconcile tick, so playback
resumes on its own — no manual restart needed anymore. If the log shows repeated heal attempts
within a 5-minute window without recovering, that points to a deeper problem (Spotify outage,
network, or bad auth) — check the causes further up this table.

---

## Spotify "not linked" / needs re-auth (401)

The dashboard talks to the Spotify Web API using the admin's own PKCE app (client id
`99aa015e38634f389d6b8d1e16b3a578`). Credentials live in
`/home/jellyfin/.config/spotify-signage/token.json` (contains `access_token`,
`refresh_token`, `scope`, `expires_at`; `chmod 600`). The server refreshes the access token
automatically (only when it is <60 s from expiry, roughly once an hour).

**401 / "unlinked"** means either `token.json` has no `refresh_token`, or the refresh call to
Spotify returned **400** (the refresh token was revoked/invalidated). The UI shows the amber
**Connect Spotify** banner and API endpoints return **401**.

**Diagnose**

```bash
# The dashboard's own view of the link:
curl -s http://172.16.50.100:8088/api/auth/status
# {connected:false} => needs re-auth. When connected it also reports scopes/expires_at.
# (product/user aren't here — they appear under the `auth` object in /api/status.)
```

**Fix — re-link from the dashboard (normal path)**

1. Click the amber **Connect Spotify** banner (or the avatar). This calls
   `POST /api/auth/start`, which spawns `spotify_oauth.py auth` and returns a `login_url`.
2. Open that URL in a browser and log in / approve. The redirect goes to
   **`https://172.16.50.100:8989/login`** (HTTPS, self-signed cert — accept the browser
   warning). The helper captures the code, exchanges it, and writes a fresh `token.json`.
3. The dashboard polls `/api/auth/status` and clears the banner once connected.

**Fix — re-link from the terminal (if the UI can't)**

```bash
cd /home/jellyfin/.config/spotify-signage
SIGNAGE_REDIRECT=https://172.16.50.100:8989/login SIGNAGE_BIND=0.0.0.0 \
  python3 spotify_oauth.py auth
# Prints a login URL; open it, approve, and it saves token.json.
```

**Important redirect facts** (Spotify's 2025 "secure redirect" policy):

- The redirect URI **must** be exactly `https://172.16.50.100:8989/login` — the LAN IP over
  HTTPS. Spotify rejects `http://` loopback for non-`127.0.0.1` hosts, rejects `localhost`,
  and requires an exact match against what's registered on the app.
- During a login, port **8989** (HTTPS callback) and port **8899** (short-URL redirector) are
  live only for the duration of the flow.

> Do **not** try to fix auth with the old `spotify_player` binary or the `signage-list`
> helper — both are obsolete and wired to a client id Spotify now rejects. The dashboard's
> `spotify_oauth.py` flow is the only supported path.

---

## Rate-limited / 429

The server keeps itself off Spotify's rate limiter with an in-memory access-token cache
(refresh only near expiry) and a **global 429 backoff** that honors the `Retry-After` header.
When Spotify returns 429, the server sets a backoff window and, until it expires, fails fast
with `rate-limited` rather than making things worse. Endpoints surface this as **429**; the UI
keeps showing the last-good now-playing/queue with a "ratelimited" warning instead of blanking.

**Diagnose**

```bash
journalctl --user -u signage-dashboard -n 80 --no-pager   # look for rate-limit / 429 mentions
curl -s http://172.16.50.100:8088/api/status              # nowplaying.state may read 'ratelimited'
```

**Fix**

- **Wait.** The backoff clears itself automatically once `Retry-After` elapses (typically
  seconds to a couple of minutes). Normal operation resumes with no action.
- **Do not** hammer the Play/Next buttons, hard-refresh the page repeatedly, or run a loop
  hitting `/api/status` — extra calls extend the throttle.
- If 429s are **persistent** (not a brief burst), suspect a second client using the same token,
  or a script polling the API in a tight loop. Stop the extra caller. Under normal use the
  dashboard refreshes on a ~2.5 s SSE cadence with cached playlists (5 min) and queue (~9 s),
  which stays well within limits.

---

## Tracks jump every few seconds (relay lost real-time pacing)

**Symptom:** the dashboard's now-playing (and Spotify's reported position) skips forward a
track every few seconds, often with a "skip storm," while the actual audio on the sign lags
minutes behind.

**Cause:** `relay.py` is the real-time reclocking stage that fixes exactly this. librespot's
pipe backend does **not** pace itself to real time — with a freely-buffering downstream it
races through the whole playlist at ~40–60×, decoding each track in seconds and auto-advancing.
`relay.py` emits a steady **176400 bytes/sec** (RATE × FRAME = 44100 × 4) of PCM, pulling
librespot audio when available and padding silence on underrun; consuming only real-time
back-pressures librespot down to 1×. If that stage is missing, crashed, or bypassed, the
racing behavior returns — and the rapid per-track key requests also trip Spotify's audio-key
throttle ("Service unavailable { audio key error }").

**Diagnose**

```bash
# Is relay.py actually in the running pipeline?
pgrep -af relay.py

# The chain, as configured (librespot | relay.py | ffmpeg):
grep -n 'relay.py\|librespot\|ffmpeg' /home/jellyfin/.config/spotify-signage/stream.sh

# Look for relay/librespot errors or 'audio key' storms:
journalctl --user -u spotify-stream -n 120 --no-pager
```

**Fix**

```bash
systemctl --user restart spotify-stream.service
```

Confirm `pgrep -af relay.py` shows the process afterward and the pipeline is
`librespot | python3 -u .../relay.py | ffmpeg …`. If `relay.py` keeps exiting, read the stream
log for a Python traceback and verify `/home/jellyfin/.config/spotify-signage/relay.py` and
`stream.sh` are intact (restore from backup if either was edited). See `AUDIO.md` §2.2 and
`ARCHITECTURE.md` §2.2 for the full explanation.

---

## Dashboard not loading

The web UI is served by `signage-dashboard.service` (`node server.js`) on `0.0.0.0:8088`
(`http://172.16.50.100:8088`). Audio is a **separate** unit, so a dead dashboard does **not**
stop the sign's audio — and restarting the dashboard does not interrupt audio.

**Diagnose**

```bash
systemctl --user status signage-dashboard.service --no-pager
journalctl --user -u signage-dashboard -n 60 --no-pager

# Is anything listening on 8088, and does it answer locally?
curl -s -o /dev/null -w 'http=%{http_code}\n' http://172.16.50.100:8088/api/status
```

**Fix**

```bash
systemctl --user restart signage-dashboard.service
journalctl --user -u signage-dashboard -n 50 --no-pager   # confirm it came back clean
```

**Likely causes**

| Cause | Tell / fix |
| --- | --- |
| Service crashed or stopped. | `status` isn't `active (running)` → restart it (above). |
| A code edit broke startup. | The log shows a Node stack trace on boot. Fix/revert `server.js` (or `public/index.html`), then restart. |
| Loads locally but not from another machine. | Network/firewall between you and `172.16.50.100:8088`; the server binds `0.0.0.0`, so it's reachable on the LAN by design. |
| Blank page but `/api/status` returns JSON. | The server is fine; it's a browser/static-asset issue — hard-refresh, or check `public/index.html` is present. |

---

## The schedule is not playing

The weekly timeline in `schedules.json` is **authoritative**: whichever block covers *now*
(this weekday + minute-of-day) is the playlist that should play; any time **not** covered by a
block is intentionally paused/silent. A level-based reconciler runs every 15 s (and once at
startup) and only issues a command on real drift — it never restarts audio that's already
correct. Work through these in order.

**Diagnose**

```bash
# The timeline, whether automation is on, and which block is active right now:
curl -s http://172.16.50.100:8088/api/schedules
# -> {enabled, blocks:[...], activeId, now:{dow,min}}   (also includes a recent action log)

# The scheduler also decides silence — confirm the link and device are healthy:
curl -s http://172.16.50.100:8088/api/status
journalctl --user -u signage-dashboard -n 60 --no-pager | grep -i sched
```

**Cause → fix**

| Cause | How to confirm | Fix |
| --- | --- | --- |
| **Automation is off.** | `enabled:false`; status pill reads "Schedule off." | Toggle automation on (UI switch) or `POST /api/schedules/enabled {"enabled":true}` — applied immediately. |
| **Empty timeline (zero blocks).** | `blocks` is `[]`; pill reads "No blocks yet." | This is deliberately hands-off (a blank grid never mutes manual playback). Paint at least one block for the schedule to drive playback. |
| **You're in a gap** (no block covers now). | `activeId:null` while `enabled:true` and blocks exist; pill "Off-air (silent)." | Expected silence. Add/extend a block to cover this weekday + time (blocks can't cross midnight; one per day). |
| **Signage device offline.** | Scheduler log shows a block "failed"; `/api/status` `librespot.authed:false` or no `Signage` device. | Restart the stream so librespot re-registers — see [Device offline / 409](#signage-device-offline--409-on-play). The reconciler self-heals on its next tick. |
| **Spotify unlinked.** | `auth.connected:false`. | The reconciler skips all control while unlinked. Re-link — see [Not linked / 401](#spotify-not-linked--needs-re-auth-401). |
| **Manual override active.** | You (or someone) recently hit Play/Pause in the dashboard. | A dashboard Play/Pause arms a **4-hour** manual-override window so ad-hoc control isn't instantly reverted. It clears at the next genuine slot change, or wait it out. |

Edits apply within ~15 s (the next reconciler tick); `PUT /api/schedules` replaces the whole
timeline and re-evaluates without thrashing audio mid-edit. See `DASHBOARD.md` → "Playback &
Scheduling" for the painting UI.

---

## A loudness change did nothing (stream restart needed)

Loudness leveling is applied by **librespot flags**, which are only read when librespot
launches. So a normalization change takes effect **only after the stream pipeline restarts.**

- **From the dashboard** ("Live Output Level" card), `POST /api/audio` writes `audio.env` **and
  restarts `spotify-stream.service` for you.** Expect a few seconds of re-buffer; the scheduler
  then resumes playback and the BrightSign reconnects on its own. If you changed it in the UI
  and heard nothing change, give it those few seconds — the audio drops and returns.
- **If you hand-edited `audio.env`**, you must restart the stream yourself:

  ```bash
  systemctl --user restart spotify-stream.service
  ```

**Also check that normalization is actually enabled and that the flags reach librespot:**

```bash
# What the dashboard has stored:
curl -s http://172.16.50.100:8088/api/audio
# {normalize, gainType, method, pregain, gapless:true}

# The file stream.sh sources:
cat /home/jellyfin/.config/spotify-signage/audio.env

# Confirm librespot was launched WITH the normalisation flags:
pgrep -af librespot | grep -o 'normalisation[^ ]*'
```

`stream.sh` only appends `--enable-volume-normalisation --normalisation-gain-type …
--normalisation-method … --normalisation-pregain …` when `NORMALIZE=1`. If `NORMALIZE=0`
(normalize off), there is nothing to hear a change from — turn leveling on first. `pregain` is
clamped to −10…+10 dB. Gapless is always on and unaffected. Full details in `AUDIO.md` §4.

---

## BrightSign shows disconnected after an audio change (transient)

**Symptom:** right after you change loudness settings, restart the stream, or restart Icecast,
the BrightSign (and the dashboard's **Connected Outputs** card) briefly shows the listener as
gone.

**Cause:** any of those actions tears down the Icecast **source** for a few seconds while the
pipeline re-buffers, which drops all listeners. This is expected and self-healing — the
BrightSign's Audio Stream reconnects to `http://172.16.50.100:8000/spotify.mp3` on its own once
the mount is live again.

**What to do:** wait ~10–20 s and re-check.

```bash
# Mount back up?
curl -sI http://172.16.50.100:8000/spotify.mp3            # expect 200 OK

# Listener reappeared?
curl -s http://172.16.50.100:8088/api/status              # look under 'audience' / Connected Outputs
```

If the BrightSign has **not** come back after a minute or two:

1. Confirm the mount is genuinely up (200, per above). If it's 404, fix the pipeline first —
   see [404 / no audio](#stream-url-gives-404-or-no-audio).
2. Verify the player is still on the network (`172.16.1.187`) and still has the stream URL set
   as its Audio Stream. Reboot the BrightSign or re-load its presentation only if it refuses to
   reconnect to a confirmed-live mount.

---

## Playback does not loop (repeat state)

For 24/7 signage the playlist must loop back to track 1 when it ends. The system does this by
setting Spotify **`repeat=context`**. The Play action sets it, and the schedule reconciler
re-ensures it every tick (if the correct playlist is playing but `repeat` isn't `context`, it
issues a repeat call without restarting the track). Note there is **no crossfade** — smooth
transitions come from gapless + normalization, not overlap (see `AUDIO.md` §5).

If a playlist stops at the end instead of looping, `repeat` has been knocked off `context` —
usually by controlling that Spotify account from another app/device.

**Diagnose**

```bash
curl -s http://172.16.50.100:8088/api/status     # nowplaying.repeat should read 'context'
```

**Fix**

- **Re-play from the dashboard** (Play, or "Play playlist") — this re-asserts `repeat=context`.
- **Or let the scheduler fix it:** if a schedule block is active, the reconciler will restore
  `repeat=context` on its next tick (≤15 s) without restarting the current track. Confirm
  automation is on and a block covers now (see
  [The schedule is not playing](#the-schedule-is-not-playing)).
- Avoid driving the same Spotify account from the phone/desktop app while signage is running —
  changing repeat/shuffle there overrides the sign until the next Play or reconciler tick.

---

## Related docs

- **`OPERATIONS.md`** — start/stop/restart every service, health checks, the "sign went quiet"
  and "web UI won't load" cheat sheets, and how to safely apply hand edits.
- **`AUDIO.md`** — the exact format chain, `relay.py` reclocking, loudness leveling, and why
  there is no crossfade.
- **`ARCHITECTURE.md`** — components, ports, services, file locations, and the full API table.
- **`DASHBOARD.md`** — the web UI, the Connect Spotify flow, and the scheduling calendar.
- Pipeline source of truth: `/home/jellyfin/.config/spotify-signage/stream.sh`,
  `relay.py`, and the dashboard's `server.js`.
