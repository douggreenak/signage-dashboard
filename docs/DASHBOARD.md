# Using the web dashboard

The **Audio Flow Console** is the web page you use to run the signage audio system: it
shows what's playing, what's connected, and how healthy the pipeline is, and it lets
you start/stop playback, pick playlists, tune the sound, and paint a weekly schedule.

Open it in any browser on the LAN:

```
http://172.16.50.100:8088
```

It is a single page served by `signage-dashboard.service` (`node /home/jellyfin/signage-dashboard/server.js`).
The page updates itself live — you don't need to refresh. Data streams in over
Server-Sent Events (`GET /api/stream`) roughly every 2.5 seconds; if that connection
drops, the browser reconnects it automatically (the footer reads "Reconnecting…"
until it's back). On the rare browser without SSE support the page instead polls
`GET /api/status` every few seconds. The footer at the bottom shows the
live-connection state ("Live · auto-refreshing" or "Reconnecting…").

> This guide covers the dashboard UI. For the drag-to-paint weekly calendar in the
> **Playback & Scheduling** card, see **[SCHEDULING.md](SCHEDULING.md)** — this page
> only points you at it.

---

## The top bar

Running left to right across the top of the page:

| Element | What it is |
| --- | --- |
| **Logo + "Audio Flow Console"** | Title. The sub-label reads "Spotify · BrightSign · Sonos". |
| **Theme toggle** (sun/moon icon) | Switches between light and dark mode. See [Light / dark theme](#light--dark-theme). |
| **Clock** | The dashboard host's current time, ticking every second. |
| **Live status pill** | The overall broadcast state — see below. |
| **Account avatar** | Your Spotify link status — see [Connecting Spotify](#connecting-spotify). |

The **live status pill** is the fastest read on whether sound is actually going out:

| Pill | Meaning |
| --- | --- |
| **On air** (green, pulsing dot) | Audio is flowing through the pipeline to Icecast right now. |
| **Idle · Ready** | The Icecast broadcast is up and reachable, but nothing is playing into it. |
| **Offline** (red) | Icecast (the broadcast) is down — nothing can be received. |
| **Connecting…** | The page is still establishing its live connection. |

---

## KPI strip

Four summary tiles sit directly under the top bar (or under the Connect banner when
that's showing). They restate the most important numbers at a glance:

| Tile | Shows |
| --- | --- |
| **Broadcast status** | "On air" (green), "Idle", or "Offline" (red) — mirrors the top-bar pill. |
| **Connected outputs** | How many devices are currently pulling the stream (BrightSign, Sonos, browsers, etc.). |
| **Stream format** | The encode format and bitrate, e.g. `MP3 · 128k`. |
| **Server uptime** | How long the host/service has been up, e.g. `2d 3h`, `5h 12m`, or `45m`. |

---

## Connecting Spotify

Everything that touches playback (Now Playing, transport, playlists, the queue, and
the scheduler) needs the dashboard linked to the admin's Spotify account. When it
isn't, an amber-edged **Connect banner** appears near the top ("Spotify not
connected"), the account avatar shows a grey status dot, and the **Playback &
Scheduling** card is dimmed and non-interactive.

To link:

1. Click **Connect Spotify** on the banner (or click the avatar — when unlinked it
   does the same thing). This calls `POST /api/auth/start`, which starts a one-time
   secure login and returns a login URL.
2. The dashboard opens that URL in a new browser tab. Approve the app there (tap
   **Agree**).
3. Because the login callback uses the server's own self-signed certificate, your
   browser will warn **"connection not private"** on `172.16.50.100`. That's expected
   — it's this box's own certificate, not a real problem. Click **Advanced → Proceed**.
4. The banner updates to "Waiting…" and polls `GET /api/auth/status` every few
   seconds. Once the link succeeds it shows a "Spotify connected ✓" toast, the banner
   clears itself, the avatar's dot turns green (and shows your initial), and playlists,
   the schedule, and the queue load automatically.

If the login is left unfinished it stops waiting after about 10 minutes; just click
**Connect Spotify** again to retry. Once linked, clicking the avatar simply confirms
"Spotify account is linked ✓".

> Behind the scenes this is a PKCE login against the admin's own Spotify app; the
> token is stored server-side. You never enter a password into the dashboard itself.

---

## Now Playing

The large card on the left is the transport and metadata for the current track.

**What's shown**

- **Album art** (a placeholder album icon appears when there's no art).
- **Track title**, then **artist · album** underneath.
- **Status chips**: the play/pause state; the playlist context (`queue_music` +
  playlist name) when a playlist is playing; the playback device (usually **Signage**);
  a **shuffle** chip when shuffle is on; and a **repeat** chip when looping is active.
- When nothing is playing it reads "Nothing playing yet". If Spotify is briefly
  rate-limiting the server, it shows "Rate-limited / Spotify API cooling down".

**Transport controls**

- **Previous** / **Play–Pause** (the large blue button) / **Next**. The play-pause
  button flips optimistically the moment you click, so it feels instant; rapid
  double-clicks are ignored so you can't queue opposing commands.
- A **playlist picker** dropdown plus a **Play playlist** button — choose a playlist
  and start it on the Signage device. This picker automatically reflects the
  playlist that's currently playing, and remembers a manual pick you make.

The **play-pause** button calls `POST /api/pause` or `POST /api/resume`; **Previous**
and **Next** call `POST /api/previous` / `POST /api/next`; **Play playlist** calls
`POST /api/play`. Common messages you may see as toasts:

| Toast | Cause |
| --- | --- |
| "Signage device offline — start the stream service" | The Signage receiver isn't available (`409`). Start/restart `spotify-stream.service`. |
| "Connect Spotify first" | Spotify isn't linked (`401`). |
| "Spotify busy — try again shortly" | Spotify is rate-limiting (`429`); wait a moment. |

**Progress bar (scrubbing)**

The thin progress bar under the metadata is **seekable**. Click anywhere on it to jump,
or drag the handle to scrub. With the bar focused you can also nudge ±5 seconds with
the **left/right arrow keys**. Seeks are sent as `POST /api/seek`. The current time and
track length are shown on either end.

**Up Next**

When Spotify reports a queue, an **Up Next** panel appears below the transport with a
"N queued" count and the upcoming tracks (up to about 20, scrollable — art, title,
artist, and length per row). It's fed by `GET /api/queue` and refreshes on its own
(and shortly after you hit Next/Previous or start a playlist). If there's no queue,
the panel is hidden.

---

## Live Output Level

The card on the right is the broadcast meter, the stream address, and the sound
(loudness) controls.

**The meter** is a live bar-graph of the current output level; the percentage next to
the card title ("Live Output Level  NN%") is the same value as a number. When the
stream is silent the bars drop to the floor. The moving highlights in the **Signal
Path** pipes are driven by this same level.

**Stream URL + Copy** — the box shows the public stream address:

```
http://172.16.50.100:8000/spotify.mp3
```

Click **Copy** to put it on your clipboard (the button briefly shows "Copied"). This is
the exact URL to point a new receiver at — e.g. a BrightSign Audio Stream, or a Sonos
"custom radio station" / TuneIn custom URL.

**Loudness leveling + Level** — the controls at the bottom of the card tune the sound:

- **Loudness leveling** (toggle) — evens out volume from song to song so nothing jumps
  out. Turning it on/off writes the setting and applies it (`POST /api/audio` with
  `{normalize}`).
- **Level** (slider, −6 to +6 dB) — an overall pre-gain trim applied when leveling is
  on. The label shows the current value (e.g. `+2 dB`); the change is applied when you
  release the slider (`POST /api/audio` with `{pregain}`). When leveling is off, the
  Level slider is dimmed and inactive.
- **Gapless on** badge — informational: songs always play back-to-back with no gap.
  Gapless is always on and isn't a setting you toggle here.

Changing either sound setting restarts the audio pipeline, so **the stream re-buffers
for a few seconds** (you'll see a "Applying sound settings — stream re-buffers
briefly…" toast). Playback and any connected receivers reconnect on their own.

---

## Signal Path

A full-width diagram of the audio chain, left to right:

```
Spotify  →  Signage  →  Encoder  →  Broadcast  →  Destinations
(cloud)     (librespot)  (ffmpeg·mp3)  (icecast)     (BrightSign / …)
```

Each node lights up by state — **blue** = healthy/active, **amber** = up but not
currently passing audio, **red** = down. The connecting **pipes** animate a flowing
blue highlight when audio is actually moving, a slow grey shimmer when a stage is ready
but idle, and turn red when a stage is down. Notes on individual nodes:

- **Spotify** shows the account tier and carries a **PREMIUM** badge when the linked
  account is Premium; it's amber until Spotify is linked.
- **Signage** is the librespot receiver (the "Signage" Spotify Connect device).
- **Encoder** shows the live encode, e.g. `mp3 · 128k`, or `idle`.
- **Destinations** lists the actual receivers. **BrightSign** is always shown as the
  known target (with "N connected" or "not connected"); other kinds (Sonos, VLC,
  browser, generic listeners) appear only when one is observed.

This card is a diagnostic read-out — there are no buttons on it.

---

## Connected Outputs

A list of every device currently pulling the stream, with a "N live" count in the card
header. Each row shows the device type (BrightSign, Sonos, VLC, Browser, or a generic
Listener), its IP address and a short user-agent, and how long it's been connected.
When nothing is receiving, it reads "No outputs connected to the stream yet."

Your BrightSign XT1143 sign shows up here whenever it's pulling
`http://172.16.50.100:8000/spotify.mp3`.

---

## Pipeline Health

A compact four-item status grid — each item has a coloured dot (green = healthy, amber
= idle-but-fine, red = down) and a one-line detail:

| Item | Green when… | Detail line |
| --- | --- | --- |
| **Stream service** | `spotify-stream.service` is running | `librespot → ffmpeg` |
| **Icecast** | The Icecast broadcast is up | `broadcast :8000` |
| **Spotify account** | Spotify is linked | e.g. `premium · linked` / `not linked` |
| **Audio flowing** | Audio is actively encoding | `live encoding` / `idle` |

"Audio flowing" shows **amber (idle)** rather than red when the pipeline is healthy but
simply paused — that's normal when playback is stopped or between scheduled blocks.

---

## Playback & Scheduling

The full-width card at the bottom holds both quick manual controls and the weekly
schedule.

**Manual controls (top row)**

- **Playlist** dropdown — pick which playlist to start.
- **Shuffle** toggle — start it shuffled or in order.
- **Play now** — starts the chosen playlist on the Signage device (`POST /api/play`),
  and sets it to loop so it repeats for 24/7 signage.
- **Pause** — pauses playback (`POST /api/pause`).

These are the same actions as the Now Playing transport, just with an explicit playlist
+ shuffle picker. The same "Signage device offline / Connect Spotify first / Spotify
busy" messages apply.

> **A manual Play or Pause temporarily overrides the schedule** for a few hours so your
> ad-hoc control isn't immediately undone by the automation.

**Weekly playback schedule (below the divider)**

The rest of the card is a **drag-to-paint weekly calendar**: pick a playlist from the
colour "Paint with" chips, drag down a day column to add a block, drag blocks to move
or resize them, and click a block to edit it. A status pill shows whether the schedule
is currently **On-air**, **Off-air (silent)**, has **No blocks yet**, or is switched
**off**, and there's a **Schedule on/off** master switch. Any time on the grid that
isn't covered by a block plays nothing (silence). A small log under the calendar shows
the scheduler's recent actions.

**This guide does not cover the calendar in depth — see
[SCHEDULING.md](SCHEDULING.md)** for how blocks, the timeline, the on/off switch, and
the reconciler behave.

---

## Light / dark theme

The **sun/moon button** in the top bar toggles light and dark mode. Your choice is
remembered in the browser (so each device keeps its own preference); on first visit the
page follows your operating system's light/dark setting. Every card, chart, and control
is styled for both themes — nothing else changes, it's purely visual.

---

## Quick reference

| I want to… | Where |
| --- | --- |
| See if sound is going out | Top-bar pill / "Broadcast status" KPI |
| Start a playlist | Now Playing → Play playlist, **or** Playback & Scheduling → Play now |
| Pause / resume | Now Playing play-pause button, or Playback & Scheduling → Pause |
| Skip / scrub within a track | Now Playing → Next/Previous, or drag the progress bar |
| See what's coming up | Now Playing → Up Next |
| Get the stream address | Live Output Level → Copy |
| Even out song volumes | Live Output Level → Loudness leveling + Level |
| See who's receiving | Connected Outputs |
| Check the pipeline is healthy | Signal Path + Pipeline Health |
| Set weekly playing hours | Playback & Scheduling → weekly calendar (see [SCHEDULING.md](SCHEDULING.md)) |
| Link/relink Spotify | Connect banner, or the account avatar |
| Switch light/dark | Sun/moon button, top bar |

If the dashboard itself won't load or shows "Reconnecting…" for a long time, the web
service may be down — restart it from the host with
`systemctl --user restart signage-dashboard.service`.
