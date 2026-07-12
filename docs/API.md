# Dashboard HTTP API reference

The **Audio Flow Console** dashboard (`signage-dashboard.service` → `node
/home/jellyfin/signage-dashboard/server.js`) is an Express server bound to
`0.0.0.0:8088`. This document is the precise reference for every `/api/*` endpoint it
serves: method, path, request body, a representative JSON response, and the error status
codes the client understands.

For day-to-day operation (starting/stopping services, logs, the pipeline) see
[OPERATIONS.md](OPERATIONS.md). For the system overview see [README.md](../README.md).

- **Base URL:** `http://172.16.50.100:8088`
- **Version:** `v1.1` (returned as `version` in `/api/status`)
- **Content type:** all bodies are JSON (`express.json()`); all responses are JSON except
  `GET /api/stream`, which is `text/event-stream`.
- **Auth:** there is **no dashboard-level authentication.** Anyone on the LAN who can reach
  port 8088 can call these endpoints. The only "auth" concept here is whether the box is
  linked to Spotify (see `/api/auth/status`).

The static single-page UI (`public/index.html`) is served from `/`; everything below lives
under `/api`.

---

## How the server talks to Spotify

Every playback/now-playing/playlist call proxies the [Spotify Web
API](https://api.spotify.com/v1). Two safeguards shape the error behavior you see:

- **Token cache.** The server holds an in-memory access token and only refreshes it when
  it is within 60 s of expiry (≈ once an hour), using the `refresh_token` in
  `/home/jellyfin/.config/spotify-signage/token.json`. If that file has no `refresh_token`,
  requests fail as **unlinked** → HTTP **401**.
- **Global 429 backoff.** When Spotify returns `429`, the server records a backoff until
  `Retry-After + 1` seconds and short-circuits every subsequent Web API call as
  **rate-limited** → HTTP **429** until the window clears.

Playback commands are always aimed at the Spotify Connect device named **`Signage`** (the
librespot receiver). If that device is not currently registered with Spotify, playback
commands fail as **device-offline** → HTTP **409**.

### Common error status codes

| Status | Meaning | `error` value(s) you may see | Which endpoints |
| --- | --- | --- | --- |
| **401** | Spotify not linked (no valid refresh token) | `not-authenticated`, `refresh-failed:400` | playlists, queue, play, resume, seek |
| **409** | The `Signage` device is offline / not found | `device-offline` | play, resume, seek |
| **429** | Rate-limited (global backoff active) | `rate-limited` | playlists, queue, play, seek |
| **400** | Bad request (bad/missing field, command rejected) | `bad-playlist`, `position_ms required`, `play-failed:…`, `seek-failed:…` | play, pause, resume, next, previous, seek |
| **500** | Server-side failure (unhandled error, file write) | `write-failed`, `no-login-url`, stringified error | status, auth/start, playlists, queue, audio |

Error responses always take the form:

```json
{ "error": "device-offline" }
```

---

## Status & live updates

### GET /api/status

Full status snapshot. This is the single source of truth the UI polls (and the same object
pushed over SSE). Never takes a body.

**Representative response (200):**

```json
{
  "ts": 1751731200000,
  "services": { "stream": true, "icecast": true },
  "librespot": { "authed": true, "user": "bethelak" },
  "auth": {
    "connected": true,
    "scopes": "user-read-playback-state user-modify-playback-state user-read-currently-playing playlist-read-private playlist-read-collaborative user-read-private",
    "expires_at": "2026-07-05T18:30:00.000Z",
    "product": "premium",
    "user": "Bethel AK"
  },
  "schedule": {
    "enabled": true,
    "count": 5,
    "active": { "id": "b1a2c3", "name": "Sunday Worship", "playlist": "37i9dQZF1DXcBWIGoYBM5M" }
  },
  "audio": {
    "normalize": true,
    "gainType": "track",
    "method": "dynamic",
    "pregain": 0,
    "gapless": true
  },
  "icecast": { "up": true, "serverStart": "2026-07-05T09:00:00-08:00" },
  "source": { "active": true, "bitrate": 128, "mount": "/spotify.mp3" },
  "streamBitrate": 128,
  "hostStart": "2026-07-01T08:00:00.000Z",
  "version": "v1.1",
  "audience": [
    { "ip": "172.16.1.187", "ua": "BrightSign/9.1.99", "connected": 43120, "kind": "brightsign" }
  ],
  "audienceCount": 1,
  "nowplaying": {
    "state": "playing",
    "track": "Great Are You Lord",
    "artists": "All Sons & Daughters",
    "album": "Live",
    "art": "https://i.scdn.co/image/ab67…",
    "progress": 63120,
    "duration": 241000,
    "device": "Signage",
    "shuffle": false,
    "repeat": "context",
    "contextType": "playlist",
    "contextId": "37i9dQZF1DXcBWIGoYBM5M",
    "contextName": "Sunday Worship"
  },
  "level": 0.734,
  "host": "172.16.50.100",
  "streamUrl": "http://172.16.50.100:8000/spotify.mp3"
}
```

**Field notes:**

| Field | Type | Notes |
| --- | --- | --- |
| `ts` | number | Epoch ms when the snapshot was built. |
| `services.stream` | bool | `spotify-stream.service` is `active`. |
| `services.icecast` | bool | System `icecast2` unit is `active`. |
| `librespot` | object | `{authed:true, user}` once librespot has logged `Authenticated as '…'`; otherwise `{authed:false}`. Cached ~30 s, sticky once seen. |
| `auth` | object | `authStatus()` merged with `product` + `user` (Spotify account tier + display name, cached ~1 h). See `/api/auth/status`. |
| `schedule` | object | `enabled`, `count` (number of blocks), and `active` = the block covering "now" or `null`. |
| `audio` | object | Current loudness settings; identical shape to `GET /api/audio`. |
| `icecast` | object | `{up, serverStart}` from Icecast's `status-json.xsl`. |
| `source` | object | `{active:true, bitrate, mount}` when the `/spotify.mp3` source is feeding Icecast, else `{active:false}`. |
| `streamBitrate` | number | Configured encoder bitrate (`STREAM_BITRATE` from `stream.env`, default `128`). |
| `hostStart` | ISO string | Host boot time, for "server uptime". |
| `audience` | array | Connected Icecast listeners with `ffmpeg`/`lavf` clients filtered out. Each: `{ip, ua, connected (seconds), kind}` where `kind` ∈ `brightsign` \| `sonos` \| `vlc` \| `browser` \| `other`. Empty `[]` if the Icecast admin password is not configured. |
| `nowplaying` | object | See the **Now-playing shape** below. |
| `level` | number | Live loudness `0..1` (from an `ffmpeg ebur128` meter on the mount; `0` at silence). |
| `streamUrl` | string | The public MP3 URL players should pull. |

**Now-playing shape** (`nowplaying`) — the `state` field drives everything:

| `state` | Meaning | Other fields present |
| --- | --- | --- |
| `playing` / `paused` | A track is loaded | `track, artists, album, art, progress (ms), duration (ms), device, shuffle, repeat, contextType, contextId, contextName` |
| `idle` | Nothing playing / Spotify returned `204` | — |
| `unlinked` | Not authenticated | — |
| `ratelimited` | 429 with no cached track to show | — |
| `unknown` | Initial value before first read | — |

A transient rate-limit or timeout does **not** blank the card: the last good track is
returned with an added `"warn": "ratelimited"` or `"warn": "stale"`, and its `progress` is
extrapolated forward by wall-clock time so the progress bar keeps advancing.

**Errors:** `500 { "error": "…" }` on an unhandled exception.

```bash
curl -s http://172.16.50.100:8088/api/status | jq
```

---

### GET /api/stream

Server-Sent Events. The dashboard opens this once and receives live pushes instead of
polling. Never takes a body; keep the connection open.

**Response headers:** `Content-Type: text/event-stream`, `Cache-Control: no-cache`,
`Connection: keep-alive`, `X-Accel-Buffering: no`.

**Two event types are emitted:**

| Event | Cadence | `data` payload |
| --- | --- | --- |
| `status` | once immediately on connect, then every **2500 ms** | The full `/api/status` JSON object |
| `level` | every **100 ms** | The loudness meter as a fixed-3-decimal string, e.g. `0.734` |

**Wire example:**

```
event: status
data: {"ts":1751731200000,"services":{"stream":true,...},"level":0.734,...}

event: level
data: 0.734

event: level
data: 0.681
```

The server clears both timers when the client disconnects. There is no error status here —
if `fullStatus()` throws while building a `status` event, that tick is simply skipped.

```bash
curl -N http://172.16.50.100:8088/api/stream
```

---

## Authentication (Spotify link)

### GET /api/auth/status

Reports whether the box is linked to Spotify. Reads
`/home/jellyfin/.config/spotify-signage/token.json`. No body.

**Response (200) — linked:**

```json
{
  "connected": true,
  "scopes": "user-read-playback-state user-modify-playback-state user-read-currently-playing playlist-read-private playlist-read-collaborative user-read-private",
  "expires_at": "2026-07-05T18:30:00.000Z"
}
```

**Response (200) — not linked:**

```json
{ "connected": false }
```

> Note: `product` and `user` are **not** returned by this endpoint — they appear only in
> the `auth` object of `GET /api/status` (fetched via `/me` and cached ~1 h).

```bash
curl -s http://172.16.50.100:8088/api/auth/status | jq
```

---

### POST /api/auth/start

Begins the PKCE OAuth flow. Spawns
`/home/jellyfin/.config/spotify-signage/spotify_oauth.py auth` with
`SIGNAGE_REDIRECT=https://172.16.50.100:8989/login` and `SIGNAGE_BIND=0.0.0.0`, waits for
the helper to print `LOGIN_URL …`, and returns that URL. Open it in a browser to log in,
then poll `GET /api/auth/status` until `connected` is `true`. No request body.

**Response (200) — first start:**

```json
{
  "login_url": "https://accounts.spotify.com/authorize?client_id=99aa015e…&response_type=code&redirect_uri=https%3A%2F%2F172.16.50.100%3A8989%2Flogin&…",
  "redirect": "https://172.16.50.100:8989/login"
}
```

**Response (200) — a login is already in progress:**

```json
{ "login_url": "https://accounts.spotify.com/authorize?…", "reused": true }
```

**Errors:** `500 { "error": "no-login-url" }` if the helper does not print a URL within
8 seconds (or any spawn error).

> The callback listener on port **8989** (HTTPS, self-signed cert in the config dir) is
> only live during a login. See the auth section of [OPERATIONS.md](OPERATIONS.md) for
> re-linking troubleshooting.

```bash
curl -s -X POST http://172.16.50.100:8088/api/auth/start | jq
```

---

## Playlists & queue

### GET /api/playlists

The current user's playlists, mapped for the dropdown. Cached **5 minutes** so opening the
picker never rate-limits. No body.

**Response (200):**

```json
{
  "playlists": [
    {
      "id": "37i9dQZF1DXcBWIGoYBM5M",
      "name": "Sunday Worship",
      "tracks": 84,
      "image": "https://i.scdn.co/image/ab67…",
      "owner": "Bethel AK"
    }
  ]
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Spotify playlist ID. |
| `name` | string | Playlist name. |
| `tracks` | number | Total track count (`0` if unknown). |
| `image` | string \| null | First cover image URL, or `null`. |
| `owner` | string | Owner display name (may be `""`). |

**Errors:** `429` rate-limited · `401` unlinked · `500` other.

```bash
curl -s http://172.16.50.100:8088/api/playlists | jq
```

---

### GET /api/queue

The up-next queue (what plays after the current track), up to **20** items. Cached ~9 s. No
body. This endpoint reports its state in the `state` field rather than via HTTP errors — it
degrades gracefully.

**Response (200) — playing:**

```json
{
  "state": "ok",
  "current": {
    "id": "3n3Ppam7vgaVa1iaRUc9Lp",
    "name": "Great Are You Lord",
    "artists": "All Sons & Daughters",
    "art": "https://i.scdn.co/image/ab67…",
    "duration": 241000
  },
  "items": [
    { "id": "1301WleyT98MSxVHPZCA6M", "name": "10,000 Reasons", "artists": "Matt Redman", "art": "https://i.scdn.co/image/…", "duration": 366000 }
  ]
}
```

| `state` | Meaning | Fields |
| --- | --- | --- |
| `ok` | Queue read successfully | `current` (may be `null`), `items[]` |
| `idle` | Nothing playing / `204` | `items: []` |
| `unlinked` | Not authenticated | `items: []` |
| `ratelimited` | 429 and no cached queue | `items: []` |

If a rate-limit or transient error hits but a previous good queue exists, the last good
queue is returned with an added `"warn": "ratelimited"` or `"warn": "stale"`.

Each item (`current` and `items[]`): `{ id, name, artists, art, duration (ms) }`.

**Errors (rare — most conditions surface via `state`):** `429` · `401` · `500`.

```bash
curl -s http://172.16.50.100:8088/api/queue | jq
```

---

## Playback control

All playback commands target the `Signage` device and are POSTs. A **successful**
`/api/play`, `/api/pause`, `/api/resume`, `/api/next`, or `/api/previous` from the
dashboard arms a 4-hour manual-override window that suspends the schedule reconciler
(cleared at the next genuine slot change) — a failed command does not. `/api/seek` is the
exception: it only nudges the position within the current track and never arms the
override.

### POST /api/play

Start a playlist on `Signage`, set shuffle, and force `repeat=context` so the playlist
loops forever (essential for 24/7 signage).

**Request body:**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `playlist` | string | yes | Playlist URL, URI, or bare ID. Normalized server-side (`spotify:playlist:…`, `…/playlist/ID?…`, or `ID` all work). |
| `shuffle` | bool | no | Defaults to falsey (no shuffle). |

**Response (200):**

```json
{ "ok": true, "device": "Signage", "playlist": "37i9dQZF1DXcBWIGoYBM5M", "shuffle": false }
```

**Errors:** `429` rate-limited · `409` `device-offline` · `401` unlinked ·
`400` `bad-playlist` / `play-failed:<status>:…`.

```bash
curl -s -X POST http://172.16.50.100:8088/api/play \
  -H 'Content-Type: application/json' \
  -d '{"playlist":"spotify:playlist:37i9dQZF1DXcBWIGoYBM5M","shuffle":false}' | jq
```

---

### POST /api/pause

Pause playback on `Signage`. No body.

**Response (200):** `{ "ok": true }` (or `{ "ok": false }` if Spotify rejected it).
**Errors:** `400 { "error": "…" }`.

```bash
curl -s -X POST http://172.16.50.100:8088/api/pause | jq
```

---

### POST /api/resume

Resume playback on `Signage`. No body.

**Response (200):** `{ "ok": true }`.
**Errors:** `409` `device-offline` · `401` unlinked · `400` other.

```bash
curl -s -X POST http://172.16.50.100:8088/api/resume | jq
```

---

### POST /api/next  ·  POST /api/previous

Skip to the next / previous track on `Signage`. No body.

**Response (200):** `{ "ok": true }`.
**Errors:** `400 { "error": "…" }`.

```bash
curl -s -X POST http://172.16.50.100:8088/api/next | jq
curl -s -X POST http://172.16.50.100:8088/api/previous | jq
```

---

### POST /api/seek

Seek within the current track.

**Request body:**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `position_ms` | number | yes | Target position in milliseconds; clamped to `≥ 0` and floored. |

**Response (200):**

```json
{ "ok": true, "position_ms": 63120 }
```

**Errors:** `400 { "error": "position_ms required" }` if missing/non-numeric ·
`429` rate-limited · `409` `device-offline` (Spotify `404`) · `401` unlinked ·
`400` `seek-failed:<status>:…`.

```bash
curl -s -X POST http://172.16.50.100:8088/api/seek \
  -H 'Content-Type: application/json' \
  -d '{"position_ms":63120}' | jq
```

---

## Weekly schedule (timeline)

The schedule is stored at `/home/jellyfin/.config/spotify-signage/schedules.json`
(`{ version:2, enabled, blocks:[…] }`). The timeline is authoritative: whichever block
covers "now" (this weekday + minute-of-day) is what plays; any uncovered time is paused —
**unless** automation is off or the timeline is empty (then playback is hands-off). A
level-based reconciler applies the timeline every ~15 s. See the schedule section of
[OPERATIONS.md](OPERATIONS.md) for the operating model.

**Block shape:**

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Stable block ID (auto-generated if omitted). |
| `day` | number | `0`–`6`, **0 = Sunday … 6 = Saturday**. |
| `start` | number | Minutes from midnight, `0`–`1440`, snapped to 5 (server); the UI paints on a 15-min grid. |
| `end` | number | Minutes from midnight; must be `> start`. Blocks cannot cross midnight. |
| `playlist` | string | Playlist ID (normalized). |
| `name` | string | Label, ≤ 80 chars. |
| `shuffle` | bool | Shuffle for this block. |

### GET /api/schedules

Read the whole timeline plus a small activity log. No body.

**Response (200):**

```json
{
  "enabled": true,
  "blocks": [
    { "id": "b1a2c3", "day": 0, "start": 540, "end": 720, "playlist": "37i9dQZF1DXcBWIGoYBM5M", "name": "Sunday Worship", "shuffle": false }
  ],
  "activeId": "b1a2c3",
  "now": { "dow": 0, "min": 615 },
  "log": [
    { "ts": 1751731200000, "msg": "▶ \"Sunday Worship\" started (scheduled)" }
  ]
}
```

- `activeId` — the block covering now, or `null`.
- `now` — server's current `{ dow (0–6), min (minute of day) }`, so the UI can align its
  playhead.
- `log` — last 25 reconciler events (most recent first), each `{ ts, msg }`.

```bash
curl -s http://172.16.50.100:8088/api/schedules | jq
```

---

### PUT /api/schedules

Replace the whole timeline (and optionally toggle automation). Blocks are sanitized:
invalid ones (bad day, `end ≤ start`, missing playlist) are dropped; overlaps should be
prevented client-side. Changes apply on the next reconciler tick (≤ 15 s) — no mid-edit
audio restart.

**Request body:**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `blocks` | array | no (but usually sent) | Full replacement array of block objects (see shape above). If present it replaces all blocks. |
| `enabled` | bool | no | If a boolean, sets automation on/off. |

**Response (200):**

```json
{
  "ok": true,
  "enabled": true,
  "blocks": [ { "id": "b1a2c3", "day": 0, "start": 540, "end": 720, "playlist": "37i9dQZF1DXcBWIGoYBM5M", "name": "Sunday Worship", "shuffle": false } ],
  "activeId": "b1a2c3",
  "now": { "dow": 0, "min": 615 }
}
```

```bash
curl -s -X PUT http://172.16.50.100:8088/api/schedules \
  -H 'Content-Type: application/json' \
  -d '{"enabled":true,"blocks":[{"day":0,"start":540,"end":720,"playlist":"37i9dQZF1DXcBWIGoYBM5M","name":"Sunday Worship","shuffle":false}]}' | jq
```

---

### POST /api/schedules/enabled

Toggle automation without touching the blocks. Turning it **on** re-asserts the timeline
immediately.

**Request body:**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `enabled` | bool | yes | Coerced to a boolean. |

**Response (200):**

```json
{ "ok": true, "enabled": false }
```

```bash
curl -s -X POST http://172.16.50.100:8088/api/schedules/enabled \
  -H 'Content-Type: application/json' \
  -d '{"enabled":false}' | jq
```

---

## Audio processing (loudness leveling)

Controls librespot's volume normalization, stored in
`/home/jellyfin/.config/spotify-signage/audio.env` (sourced by `stream.sh`). Gapless
playback is always on and is not configurable here. See the audio section of
[OPERATIONS.md](OPERATIONS.md) for background.

### GET /api/audio

Current settings. No body.

**Response (200):**

```json
{
  "normalize": true,
  "gainType": "track",
  "method": "dynamic",
  "pregain": 0,
  "gapless": true
}
```

| Field | Type | Values / default |
| --- | --- | --- |
| `normalize` | bool | Loudness leveling on/off. Default **on** (absent `NORMALIZE` reads as on). |
| `gainType` | string | `track` \| `album` \| `auto`. Default `track`. |
| `method` | string | `basic` \| `dynamic`. Default `dynamic`. |
| `pregain` | number | Pregain in dB, clamped `-10..10`. Default `0`. |
| `gapless` | bool | Always `true` (informational). |

```bash
curl -s http://172.16.50.100:8088/api/audio | jq
```

---

### POST /api/audio

Update settings, write `audio.env`, and **restart `spotify-stream.service`** so librespot
picks up the new flags. This causes a few seconds of stream re-buffer; the scheduler then
resumes playback automatically and the BrightSign listener reconnects on its own. Every
field is optional — omitted or invalid fields keep their current value.

**Request body:**

| Field | Type | Accepted values | Notes |
| --- | --- | --- | --- |
| `normalize` | bool | `true` / `false` | Ignored unless a real boolean. |
| `gainType` | string | `track` \| `album` \| `auto` | Ignored if not one of these. |
| `method` | string | `basic` \| `dynamic` | Ignored if not one of these. |
| `pregain` | number | `-10..10` (dB) | Clamped and rounded to one decimal. |

**Response (200):**

```json
{
  "ok": true,
  "applied": true,
  "normalize": true,
  "gainType": "track",
  "method": "dynamic",
  "pregain": 2.5,
  "gapless": true
}
```

The response returns **before** the service restart completes; the restart and follow-up
reconcile happen asynchronously.

**Errors:** `500 { "error": "write-failed" }` if `audio.env` cannot be written.

```bash
curl -s -X POST http://172.16.50.100:8088/api/audio \
  -H 'Content-Type: application/json' \
  -d '{"normalize":true,"pregain":2.5,"gainType":"track","method":"dynamic"}' | jq
```

---

## Endpoint index

| Method | Path | Purpose | Body |
| --- | --- | --- | --- |
| GET | `/api/status` | Full status snapshot | — |
| GET | `/api/stream` | SSE: `status` (~2.5 s) + `level` (100 ms) | — |
| GET | `/api/auth/status` | Spotify link state | — |
| POST | `/api/auth/start` | Begin OAuth, return `login_url` | — |
| GET | `/api/playlists` | User playlists (cached 5 min) | — |
| GET | `/api/queue` | Up-next queue (≤ 20, cached ~9 s) | — |
| POST | `/api/play` | Start playlist, loop, set shuffle | `{ playlist, shuffle? }` |
| POST | `/api/pause` | Pause | — |
| POST | `/api/resume` | Resume | — |
| POST | `/api/next` | Skip forward | — |
| POST | `/api/previous` | Skip back | — |
| POST | `/api/seek` | Seek within track | `{ position_ms }` |
| GET | `/api/schedules` | Read timeline + log | — |
| PUT | `/api/schedules` | Replace timeline | `{ enabled?, blocks }` |
| POST | `/api/schedules/enabled` | Toggle automation | `{ enabled }` |
| GET | `/api/audio` | Read loudness settings | — |
| POST | `/api/audio` | Update settings + restart stream | `{ normalize?, pregain?, gainType?, method? }` |
