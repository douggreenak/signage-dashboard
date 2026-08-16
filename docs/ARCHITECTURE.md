# Architecture & data flow

*Audio Flow Console (dashboard **v1.1**) — the Spotify-to-BrightSign signage system for BethelAK.*

This document explains what the system does, every moving part, and how audio
gets from a Spotify playlist all the way to the digital sign. It is written for
the operator who runs this box.

---

## 1. What the system does

One Debian PC (`172.16.50.100`, Linux user `jellyfin`) does two jobs at once:

1. **It plays a Spotify playlist** locally with `librespot` (a headless Spotify
   Connect receiver that Spotify sees as a device named **"Signage"**), and
   re-broadcasts that audio as an **MP3 stream over the LAN** so a **BrightSign**
   digital sign (and optionally **Sonos**) can play it.
2. **It runs a web dashboard** that controls playback through the **Spotify Web
   API** — play/pause/next, playlist picker, a weekly schedule, loudness
   leveling, and a live status view.

Both halves run on this single machine and meet at the librespot **"Signage"**
device: the dashboard tells Spotify *what* to play on "Signage", and the audio
pipeline turns whatever "Signage" is playing into a stream on the wire.

```
                        ┌───────────────────────────────────────────────┐
                        │          Spotify (cloud) — accounts &          │
                        │            api.spotify.com/v1                   │
                        └───────────────────────────────────────────────┘
                             ▲  Web API (control)          ▲  Connect (audio)
                             │                             │
     ============ CONTROL HALF ==========    ====== AUDIO / PLAYBACK HALF ======
                             │                             │
   ┌──────────────────────────────────┐        ┌───────────────────────────────┐
   │  signage-dashboard.service        │        │  spotify-stream.service        │
   │  node server.js  :8088            │        │  stream.sh  (the pipeline)     │
   │                                   │        │                                │
   │  • Express + SSE  (/api/stream)   │        │   librespot 0.8.0              │
   │  • token cache + 429 backoff      │        │   device "Signage"            │
   │  • weekly scheduler (15s tick)    │        │   --backend pipe --format S16 │
   │  • loudness / audio.env writer    │        │        │ 44.1kHz S16 PCM      │
   │  • public/index.html (SPA)        │        │        ▼                      │
   └──────────────┬────────────────────┘        │   relay.py  (reclock to 1x)   │
                  │ browser (LAN)                │   176400 bytes/sec, pad       │
                  ▼                              │   silence on underrun         │
        Operator's web browser                  │        │ steady S16 PCM       │
        http://172.16.50.100:8088               │        ▼                      │
                                                │   ffmpeg  libmp3lame 128k     │
                                                │        │ MP3 (source client)  │
                                                │        ▼                      │
                                                │   Icecast2  :8000  (SYSTEM)   │
                                                │   mount /spotify.mp3          │
                                                └──────────────┬─────────────────┘
                                                               │ HTTP MP3 pull
                                                               ▼
                              ┌───────────────────────────────────────────────┐
                              │  BrightSign XT1143  (172.16.1.187)  Audio Stream │
                              │  http://172.16.50.100:8000/spotify.mp3          │
                              │  ── optional: Sonos (same URL as TuneIn radio)  │
                              └───────────────────────────────────────────────┘
```

---

## 2. The audio / playback half (the streaming pipeline)

The whole pipeline is one shell script, `stream.sh`, run as the systemd `--user`
unit **`spotify-stream.service`**. It is a single Unix pipe:

```
librespot ──▶ relay.py ──▶ ffmpeg ──▶ Icecast2 ──▶ BrightSign
```

Source: `/home/jellyfin/.config/spotify-signage/stream.sh`

`stream.sh` sources two env files before launching: `stream.env` (Icecast
host/port/mount + source/admin passwords + optional `STREAM_BITRATE`) and, if
present, `audio.env` (loudness settings). It then builds any normalization flags
and `exec`s the pipe.

### 2.1 librespot — the Spotify Connect receiver

`librespot 0.8.0` logs into Spotify and advertises itself as the Connect device
named **"Signage"**. It decodes the playlist and writes raw PCM to its stdout.

Flags used (`stream.sh` lines 17-25):

| Flag | Meaning |
| --- | --- |
| `--name "Signage"` | Device name the dashboard/CLI target |
| `--backend pipe` | Write decoded PCM to stdout (no sound card) |
| `--format S16` | 16-bit signed PCM, 44.1 kHz stereo |
| `--bitrate 320` | Decode at highest Spotify quality |
| `--initial-volume 80` | Startup volume |
| `--disable-discovery` | No zeroconf; controlled only via Web API |
| `--cache /home/jellyfin/.cache/librespot` | Local audio/key cache |

**Gapless is always on** — the script never passes `--disable-gapless`.
There is **no crossfade**: librespot has no crossfade option, and a single
continuous PCM stream physically cannot overlap two tracks. Smooth song-to-song
transitions come from **gapless playback + volume normalization**, not crossfade
(see §4).

When `NORMALIZE=1` in `audio.env`, `stream.sh` appends
`--enable-volume-normalisation --normalisation-gain-type <track|album|auto>
--normalisation-method <basic|dynamic> --normalisation-pregain <dB>`.

### 2.2 relay.py — the real-time reclocking relay (why it exists)

Source: `/home/jellyfin/.config/spotify-signage/relay.py`

**The problem it solves.** librespot's `pipe` backend writes PCM as fast as the
reader drains it — it does **not** pace itself to real time. With a freely
buffering downstream (ffmpeg + Icecast happily accepting data), librespot raced
through an entire playlist at **~40-60x**: it decoded each track in a couple of
seconds, hit the end, auto-advanced, and Spotify's reported position (and thus
the dashboard) jumped tracks every few seconds while the already-produced audio
sat buffered in Icecast, playing out to the sign minutes behind. The rapid
per-track key requests also tripped Spotify's audio-key throttle ("Service
unavailable { audio key error }"), causing skip storms.

**The fix.** `relay.py` sits in the middle and emits a **steady real-time PCM
stream** — exactly `RATE * FRAME = 44100 * 4 = 176400` bytes per wall-clock
second. Each ~10 ms tick it computes how many bytes *should* have been emitted by
now to hold exactly real time, then:

- pulls up to that many bytes from librespot **without blocking** (`select` with
  a 0 timeout), deliberately leaving any surplus in the OS pipe; and
- writes real audio when it has it, or **pads digital silence** on underrun
  (pause / idle / gap), keeping the real|silence seam frame-aligned so an L/R
  sample pair is never split.

Two effects fall out of consuming only ~real-time:

1. **Back-pressure paces librespot to 1x.** Because the relay never over-reads,
   librespot's pipe stays full and it **blocks on write**, so it decodes at
   real speed. Its reported position stays in sync with the audio, and so does
   the dashboard progress bar.
2. **The Icecast mount is fed continuously.** Even when nothing is playing, the
   relay emits silence, so the `/spotify.mp3` source never drops and listeners
   never get an HTTP 404 — the mount stays up.

On librespot EOF (it exited), the relay flushes and exits cleanly, which lets
systemd restart the whole pipeline.

Key constants (relay.py): `FRAME = 4` bytes (2 ch × 2 bytes S16LE),
`RATE = 44100`, `BPS = 176400`, `TICK = 0.010` s.

### 2.3 ffmpeg — PCM to MP3

ffmpeg reads the relay's steady S16 PCM (`-f s16le -ar 44100 -ac 2`) and encodes
it to MP3 with **libmp3lame at `STREAM_BITRATE` kbps (default 128)**, then pushes
it to Icecast as a **source client** over the `icecast://` protocol. Notable
flags: `-reservoir 0` and `-flush_packets 1` keep latency low and the byte-rate
constant; `-content_type audio/mpeg`, `-ice_name`, and `-ice_description` set the
mount's metadata.

`STREAM_BITRATE` is read from `stream.env`; it is currently unset there, so the
effective bitrate is the **128 kbps default**.

### 2.4 Icecast2 — the streaming server

Icecast2 is a **SYSTEM** service (`icecast2`), **not** a `--user` unit. It hosts
the mount **`/spotify.mp3`** on **port 8000**, bound to `0.0.0.0`. The public LAN
stream URL is:

```
http://172.16.50.100:8000/spotify.mp3
```

The dashboard reads Icecast's `/status-json.xsl` (to know the source is up and
its bitrate/listeners) and the admin `/admin/listclients` endpoint (to list
connected players by IP and User-Agent). `/status-json.xsl` is fetched with no
auth; only `/admin/listclients` sends HTTP Basic `admin:<ICECAST_ADMIN_PW>`
from `stream.env`.

### 2.5 BrightSign (and Sonos)

The connected player is a **BrightSign XT1143** running **BrightSign OS 9.1.99**,
currently at **172.16.1.187**, configured to pull
`http://172.16.50.100:8000/spotify.mp3` as an **Audio Stream**. It appears in the
dashboard's "Connected Outputs" card (classified by its `brightsign` User-Agent).
Because the mount stays continuously fed (silence when idle), the sign never
sees the stream drop, and it reconnects on its own after a pipeline restart.

**Sonos** can play the exact same Icecast URL as a custom radio station / TuneIn
custom URL.

---

## 3. The control half (the Web-API dashboard)

Source: `/home/jellyfin/signage-dashboard/server.js`

The dashboard is a Node.js (**v24**) Express server run as the systemd `--user`
unit **`signage-dashboard.service`**: `node /home/jellyfin/signage-dashboard/server.js`.
It listens on **`0.0.0.0:8088`** and serves a single-page app from
`public/index.html` (vanilla JS, Material-style, light/dark). Live updates reach
the browser over **Server-Sent Events** at `GET /api/stream` (a full status push
every ~2.5 s, plus a loudness `level` event every 100 ms).

It never touches the audio pipeline's bytes — it controls playback entirely
through the **Spotify Web API** (`https://api.spotify.com/v1`), which relays
commands to the "Signage" Connect device.

### 3.1 Staying off Spotify's rate limiter

Two mechanisms in `server.js` keep the dashboard from getting `429`-throttled:

- **In-memory access-token cache** — the access token is refreshed only when it
  is within 60 s of expiry (≈ once/hour), not per request (`getAccessToken`).
- **Global 429 backoff** — any `429` sets a `backoffUntil` that honors the
  `Retry-After` header; further API calls short-circuit until it passes (`api`).

On top of that, several reads are cached so the UI can poll cheaply: playlists
**5 min**, up-next queue **~9 s**, now-playing **3 s** (extrapolated forward
between reads so the progress bar stays smooth), `/me` profile **1 h**, and
playlist-name lookups **10 min**.

### 3.2 Playback control

- `playPlaylist()` finds the "Signage" device, optionally sets shuffle, starts
  the playlist context, and **sets `repeat=context`** so the playlist loops
  forever (essential for 24/7 signage).
- Pause / resume / next / previous / seek all target the "Signage" device
  explicitly by `device_id`.
- If "Signage" is not among Spotify's Connect devices, the call fails with a
  `device-offline` error surfaced to the client as **HTTP 409**.

### 3.3 Weekly schedule (the reconciler)

Store: `/home/jellyfin/.config/spotify-signage/schedules.json`
(`{version:2, enabled, blocks:[{id, day 0-6 Sun-Sat, start, end (minutes 0-1440),
playlist, name, shuffle}]}`).

The timeline is **authoritative**: whichever block covers "now" (this weekday +
minute-of-day) is the playlist that should play; **any time not covered by a
block = paused/silent**. Two exceptions make a blank grid safe: if automation is
**off**, or the timeline has **zero blocks**, the reconciler is fully hands-off
and never pauses (so an empty schedule never mutes manual playback).

A **level-based reconciler** runs every **15 s** (and once on startup, so a
reboot restores the correct state). It compares what *should* be playing against
what *is*, and issues a command **only on real drift** — it never re-issues a
fresh play when the correct playlist is already playing, so editing the schedule
or crossing between adjacent same-playlist blocks does **not** restart audio.
Entering a block ⇒ play its playlist and ensure `repeat=context`; in a gap ⇒
pause; if playback dies mid-block it self-heals. A dashboard Play/Pause arms a
**4-hour manual-override window** (cleared at the next genuine slot change) so
ad-hoc control isn't instantly overridden.

**Watchdog for the "device vanished" failure mode:** librespot's dealer websocket can die without
reconnecting — the process stays alive (so systemd's `Restart=always` never triggers) but the
`Signage` Connect device silently disappears from Spotify's device list, and every scheduled
`playPlaylist()` fails with `device-offline`. When the reconciler sees that error it calls
`healStream()`, which runs `systemctl --user restart spotify-stream.service` (cooldown-gated to
once per 5 minutes) and logs the attempt to the scheduler log. librespot re-registers within
~10 s, so the next 15 s tick finds the device again and playback resumes with no manual
intervention. See `docs/TROUBLESHOOTING.md` §"Signage device offline".

Endpoints: `GET /api/schedules`, `PUT /api/schedules {enabled?, blocks}`
(replaces the whole timeline), `POST /api/schedules/enabled {enabled}`. Edits
apply within ~15 s (the next tick), with no mid-edit audio thrash.

### 3.4 Loudness leveling (audio processing)

Config: `/home/jellyfin/.config/spotify-signage/audio.env` — `NORMALIZE` (1/0),
`NORMALIZE_GAIN_TYPE` (track|album|auto, default track), `NORMALIZE_METHOD`
(basic|dynamic, default dynamic), `NORMALIZE_PREGAIN` (-10..10 dB). `stream.sh`
sources this file.

`GET /api/audio` returns the settings; `POST /api/audio {normalize?, pregain?,
gainType?, method?}` writes `audio.env` and **restarts `spotify-stream.service`**
so librespot picks up the new flags (a few seconds of re-buffer; the scheduler
then resumes playback, and the BrightSign reconnects on its own). Gapless stays
on regardless.

A separate `ffmpeg ... ebur128` meter runs continuously against the live Icecast
stream (a 4 s supervisor loop spawns it when the `/spotify.mp3` source is up and
tears it down when it goes away). Its momentary loudness drives the "Live Output
Level" reading pushed over SSE as a `level` event ~every 100 ms.

---

## 4. Where the two halves meet

The dashboard and the pipeline share exactly one thing: the librespot **"Signage"**
device.

- The **dashboard** (and the `signage-play` CLI) call the Spotify Web API to
  transfer playback to "Signage" and choose what plays.
- **librespot** *is* "Signage": it receives that playback and decodes it into the
  pipeline.

Neither half streams audio to the other directly — Spotify's cloud is the relay
point for control, and the LAN Icecast stream is the relay point for audio.

---

## 5. Spotify authentication (PKCE, the operator's own app)

The system uses the admin's **own** Spotify app with **PKCE** — no client secret
is stored anywhere.

- **App / client_id:** `99aa015e38634f389d6b8d1e16b3a578` (app "Signage Player").
- **Working redirect URI:** `https://172.16.50.100:8989/login` — LAN IP + HTTPS +
  a self-signed cert (`cert.pem` / `key.pem` in the config dir). Spotify's 2025
  "secure redirect" policy rejects `http` loopback for non-`127.0.0.1`, rejects
  `localhost`, and requires an exact match — hence the HTTPS LAN-IP redirect.
- **Helper:** `/home/jellyfin/.config/spotify-signage/spotify_oauth.py`
  - `auth` — one-time: starts a local HTTPS server (port from the redirect URI,
    8989), prints `LOGIN_URL <url>`, captures the returned `code`, exchanges it,
    and saves the token.
  - `token` — refreshes with the stored `refresh_token` and prints a fresh
    access token (used by the `signage-play` CLI).
- **Token file:** `/home/jellyfin/.config/spotify-signage/token.json` (chmod
  600) — holds `access_token`, `refresh_token`, `scope`, `expires_at`;
  self-refreshing. **Never print its contents.**
- **Scopes:** `user-read-playback-state`, `user-modify-playback-state`,
  `user-read-currently-playing`, `playlist-read-private`,
  `playlist-read-collaborative`, `user-read-private`.
- **Re-auth from the dashboard:** the amber "Connect Spotify" banner (or the
  avatar) triggers `POST /api/auth/start`, which spawns `spotify_oauth.py auth`
  with `SIGNAGE_REDIRECT=https://172.16.50.100:8989/login` and
  `SIGNAGE_BIND=0.0.0.0`, and returns a `login_url` to open in a browser; the
  dashboard polls `/api/auth/status` until connected.
- **Optional short-URL helper:** `redirector.py` can 302 any hit on port
  **8899** to the long authorize URL, so the operator can type a short URL during
  login instead of hand-copying the long one. It only runs during a login.

---

## 6. Reference tables

### 6.1 Components

| Component | Role | Runs as |
| --- | --- | --- |
| librespot 0.8.0 | Spotify Connect receiver, device "Signage"; decodes to PCM | inside `stream.sh` |
| relay.py | Real-time reclocking relay (paces to 1x, pads silence) | inside `stream.sh` |
| ffmpeg | Encodes S16 PCM → MP3 (libmp3lame), pushes to Icecast | inside `stream.sh` |
| Icecast2 | Streaming server, mount `/spotify.mp3` | **system** service `icecast2` |
| server.js (Express) | Web dashboard + Spotify Web API control + scheduler | `signage-dashboard.service` |
| public/index.html | Single-page dashboard UI (SSE live updates) | served by server.js |
| spotify_oauth.py | PKCE OAuth: `auth` (link) / `token` (refresh) | spawned on demand |
| redirector.py | Optional short-URL → authorize-URL 302 (login only) | spawned on demand |
| signage-play (CLI) | Transfer playback to "Signage" and start a playlist | manual CLI |
| BrightSign XT1143 | Digital sign; pulls the MP3 as an Audio Stream | external device |

### 6.2 Ports

| Port | Bind | Purpose |
| --- | --- | --- |
| 8088 | 0.0.0.0 | Dashboard / web UI (`http://172.16.50.100:8088`) |
| 8000 | 0.0.0.0 | Icecast MP3 stream (`http://172.16.50.100:8000/spotify.mp3`) |
| 8989 | 0.0.0.0 | OAuth callback, HTTPS — live only during a login |
| 8899 | 0.0.0.0 | OAuth short-URL redirector — live only during a login |

### 6.3 Services

| Unit | Type | State | Notes |
| --- | --- | --- | --- |
| `spotify-stream.service` | systemd `--user` | enabled | Runs `stream.sh` (the audio pipeline) |
| `signage-dashboard.service` | systemd `--user` | enabled | Runs `node server.js` on :8088 |
| `icecast2` | **system** | enabled/active | Streaming server on :8000 |
| `spotify-silence.service` | systemd `--user` | **obsolete, disabled** | Replaced by `relay.py`'s built-in silence |

User **lingering** is enabled, so the `--user` units run without an interactive
login. Manage them:

```bash
# audio pipeline
systemctl --user restart spotify-stream.service
systemctl --user status  spotify-stream.service
journalctl --user -u spotify-stream -f

# dashboard
systemctl --user restart signage-dashboard.service
journalctl --user -u signage-dashboard -f

# Icecast is a SYSTEM unit (needs sudo)
sudo systemctl restart icecast2
sudo journalctl -u icecast2
```

### 6.4 Key file locations

| Path | What |
| --- | --- |
| `/home/jellyfin/.config/spotify-signage/stream.sh` | Pipeline launcher (librespot → relay → ffmpeg → Icecast) |
| `/home/jellyfin/.config/spotify-signage/relay.py` | Real-time reclocking relay |
| `/home/jellyfin/.config/spotify-signage/stream.env` | Icecast host/port/mount + source/admin passwords + `STREAM_BITRATE` (chmod 600) |
| `/home/jellyfin/.config/spotify-signage/audio.env` | Loudness / normalization settings (dashboard-managed) |
| `/home/jellyfin/.config/spotify-signage/schedules.json` | Weekly timeline (chmod 600) |
| `/home/jellyfin/.config/spotify-signage/token.json` | Spotify token (chmod 600) — do not print |
| `/home/jellyfin/.config/spotify-signage/spotify_oauth.py` | PKCE OAuth helper (`auth` / `token`) |
| `/home/jellyfin/.config/spotify-signage/cert.pem`, `key.pem` | Self-signed cert for the HTTPS OAuth callback (key is 600) |
| `/home/jellyfin/.config/spotify-signage/redirector.py` | Short-URL redirector used during OAuth |
| `/home/jellyfin/signage-dashboard/server.js` | Dashboard server |
| `/home/jellyfin/signage-dashboard/public/index.html` | Dashboard SPA |
| `/home/jellyfin/signage-dashboard/package.json` | Node package (Express) |
| `/home/jellyfin/.local/bin/signage-play` | CLI to start a playlist on "Signage" |

### 6.5 Dashboard HTTP API (all under `http://172.16.50.100:8088`)

| Method & path | Purpose |
| --- | --- |
| `GET /api/status` | Full status snapshot (services, librespot, auth, schedule, audio, icecast, source, nowplaying, level, audience, host, streamUrl) |
| `GET /api/stream` | Server-Sent Events: full status ~every 2.5 s + `level` every 100 ms |
| `GET /api/auth/status` | `{connected, scopes, expires_at}` (product/user come from `/api/status`'s `auth` object) |
| `POST /api/auth/start` | Begin OAuth; returns `{login_url}` |
| `GET /api/playlists` | `{playlists:[{id,name,tracks,image,owner}]}` (cached 5 min) |
| `GET /api/queue` | `{state, current, items[]}` up-next, up to 20 tracks (cached ~9 s) |
| `POST /api/play` | Body `{playlist, shuffle}`; starts a playlist on "Signage", sets `repeat=context` |
| `POST /api/pause` \| `/api/resume` \| `/api/next` \| `/api/previous` | Transport controls |
| `POST /api/seek` | Body `{position_ms}` |
| `GET /api/schedules` \| `PUT /api/schedules {enabled?, blocks}` \| `POST /api/schedules/enabled {enabled}` | Weekly timeline |
| `GET /api/audio` \| `POST /api/audio {normalize?, pregain?, gainType?, method?}` | Loudness leveling (POST restarts the pipeline) |

Error statuses the client handles: **401** = Spotify not linked, **409** =
"Signage" device offline, **429** = rate-limited.

---

## 7. Host facts at a glance

| Item | Value |
| --- | --- |
| OS | Debian Linux, kernel 6.12 |
| Host LAN IP | 172.16.50.100 |
| Linux user | jellyfin (user lingering enabled) |
| Node.js | v24 |
| Dashboard version | v1.1 |
| Stream URL | `http://172.16.50.100:8000/spotify.mp3` |
| Dashboard URL | `http://172.16.50.100:8088` |
| BrightSign | XT1143, BrightSign OS 9.1.99, 172.16.1.187 |

---

## 8. Obsolete / do-not-use

These are leftovers; do **not** rely on or recommend them:

- **`spotify_player` binary** (~205 MB in `~/.local/bin`) — abandoned; its auth
  was hardwired to a different client id Spotify now rejects.
- **`signage-list`** helper — obsolete; it calls `spotify_player`. The dashboard
  lists playlists instead (`GET /api/playlists`).
- **`spotify-silence.service`** + **`add-fallback.sh`** + **`silence.sh`** —
  obsolete; `relay.py` now provides the continuous silence that keeps the Icecast
  mount alive.
- **`relay.py.bak-*`** — a backup copy of an earlier relay; not used.
