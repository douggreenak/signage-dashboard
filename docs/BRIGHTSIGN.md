# BrightSign & Sonos playback

This document explains how the digital sign (and, optionally, a Sonos speaker) actually
plays audio from the Audio Flow Console. The console produces one thing for the outside
world: an MP3 audio stream on the LAN. Anything that can play a plain MP3 HTTP stream can
be an "output." The known output today is a **BrightSign** player; **Sonos** is the common
optional second output.

Audience: the operator running this box. All paths are absolute; all commands are
copy-pasteable. For how the stream itself is produced, see [`AUDIO.md`](AUDIO.md); for the
dashboard UI, see [`DASHBOARD.md`](DASHBOARD.md).

---

## 1. The one thing every output connects to: the stream URL

Everything the sign and Sonos do comes down to opening a single URL:

| | |
|---|---|
| **Stream URL** | `http://172.16.50.100:8000/spotify.mp3` |
| Host / port | `172.16.50.100` (this PC, LAN) : `8000` |
| Mount | `/spotify.mp3` |
| Format | **MP3, 128 kbps**, 44.1 kHz stereo (`audio/mpeg`) |
| Server | Icecast2 (Icecast / SHOUTcast-style HTTP audio stream) |
| Transport | Plain **HTTP** (not HTTPS), continuous / never-ending stream |

A few properties worth knowing before you point a device at it:

- **It is a live, continuous stream**, not a file. There is no beginning or end; a client
  connects and starts hearing whatever is playing "now." There is no seeking.
- **It never goes 404, even when nothing is playing.** The pipeline's `relay.py` pads
  digital silence when idle, so the Icecast mount `/spotify.mp3` stays up continuously. A
  client can stay connected 24/7 and simply hears silence during scheduled gaps. (Details in
  [`AUDIO.md`](AUDIO.md).)
- **It is HTTP on the LAN only.** Use the literal IP `172.16.50.100`. Don't put `https://`
  in front of it — Icecast serves plain HTTP on port 8000.

You can sanity-check the URL from any machine on the network by opening it in VLC, a browser,
or:

```
ffplay http://172.16.50.100:8000/spotify.mp3
# or
vlc     http://172.16.50.100:8000/spotify.mp3
```

If you hear audio (or silence that turns into audio when the schedule/Play starts), the
stream is healthy and the problem, if any, is on the output device.

---

## 2. The current sign: BrightSign XT1143

| Attribute | Value |
|-----------|-------|
| Model | **BrightSign XT1143** |
| Firmware | **BrightSign OS 9.1.99** |
| Player IP | **172.16.1.187** (on the LAN; may change if not DHCP-reserved) |
| Pulls | `http://172.16.50.100:8000/spotify.mp3` as an **Audio Stream** |
| Appears in dashboard | **Connected Outputs** card, classified as *BrightSign* |

BrightSign players run presentations authored in **BrightAuthor:connected** (BrightSign's
current authoring app) and published to the player. The exact BrightAuthor:connected version
used to author this player is not recorded here, so the steps below stick to the general,
reliable path that works across recent versions. Menu labels may differ slightly by version;
the concepts (a presentation containing an **Audio Stream** state pointed at a media-stream
URL, set to auto-start and loop) are stable.

> Note on models: any BrightSign that can play a network audio stream will work the same way —
> the XT1143 is simply the unit installed. Nothing here is XT1143-specific except the model and
> IP above.

---

## 3. Pointing a BrightSign at the audio stream (general, reliable path)

The goal is a presentation whose only job is to keep an **Audio Stream** playing from
`http://172.16.50.100:8000/spotify.mp3`, forever, unattended.

### 3.1 In BrightAuthor:connected

1. **Create (or open) a presentation** for the player. Choose the model/resolution that
   matches the XT1143 when prompted. A audio-only presentation is fine — there doesn't need
   to be any video.
2. **Add an *Audio Stream* state** to the presentation (in some versions this is under
   "Media" / "Stream" state types; it may be called *Audio Stream* or *Media Stream*). This
   is the state that opens a network audio URL rather than a file on the player.
3. **Set the stream URL** for that state to exactly:
   ```
   http://172.16.50.100:8000/spotify.mp3
   ```
   Enter it as the media-stream / URL field. It is a plain HTTP MP3 (Icecast) stream — no
   credentials, no HTTPS.
4. **Make it auto-start and stay playing:**
   - Set the presentation so this Audio Stream state is the **initial state** (it starts as
     soon as the presentation loads / the player boots).
   - Configure it to **loop / auto-reconnect** — i.e. if the stream state ever ends, transition
     back into the same Audio Stream state so it re-opens the URL. Because the mount is
     continuous, the player normally just stays connected, but a loop/auto-restart makes it
     self-heal if the network blips or the pipeline restarts (e.g. after an audio-settings
     change, which briefly re-buffers the stream — see [`AUDIO.md`](AUDIO.md) §4.4).
   - There is no "end" to design for; the stream is 24/7.
5. **Set the volume** on the player/state as desired. Loudness leveling is already handled
   upstream by the console (see [`AUDIO.md`](AUDIO.md) §4), so the sign's own volume is just a
   final level control.
6. **Publish the presentation to the player** (via local network publish, a BrightSign
   network/BSN.cloud group, or a published SD card — whichever method this player is managed
   with). Once published, the player boots straight into the stream.

### 3.2 What "correct" looks like on the player

After publishing, the XT1143 should, on boot and unattended:

- open `http://172.16.50.100:8000/spotify.mp3`,
- play whatever the console is currently sending (music during scheduled on-air blocks,
  silence during gaps — the schedule is authoritative; see [`DASHBOARD.md`](DASHBOARD.md)),
- and stay connected indefinitely, reconnecting on its own if the stream restarts.

You do **not** control which playlist plays from the BrightSign. The BrightSign is a dumb
output — it just plays the mount. *What* is on the mount is decided entirely on this PC by the
dashboard and the weekly schedule.

### 3.3 If you can reach the player directly

The XT1143 has a local diagnostic web server / DWS (typically reachable at the player's IP,
`http://172.16.1.187`, when enabled). It's useful for confirming the player is on the network,
checking the loaded presentation, and rebooting. The exact DWS availability depends on how
this unit was provisioned; if it's enabled, it's the quickest way to confirm the player is
alive independent of the dashboard.

---

## 4. Confirming the sign is connected (dashboard "Connected Outputs")

The console dashboard (`http://172.16.50.100:8088`) shows every device currently pulling the
stream in its **Connected Outputs** card, and a **Connected outputs** count in the KPI row at
the top.

### 4.1 How the dashboard knows

The server asks Icecast who is currently listening to the `/spotify.mp3` mount (Icecast's
`admin/listclients`) and reports each connected client. For every listener it captures:

- the client **IP address**,
- the **User-Agent** string, and
- how long it has been **connected**.

It then classifies each listener by User-Agent into a **kind**: `brightsign`, `sonos`, `vlc`,
`browser`, `ffmpeg`, or `other`. Listeners classified as `ffmpeg` are filtered out of the
output list — this is the dashboard's own loudness meter, an internal ffmpeg process that
pulls the mount to measure the live level (see [`AUDIO.md`](AUDIO.md)), so it never shows up
as an "output." (The encoder feeding Icecast is a *source* client, not a listener, so it
never appears here in the first place.) This all comes back in the status snapshot
as the `audience` / `audienceCount` fields (`GET /api/status`, and live over `GET /api/stream`).

### 4.2 What you should see

When the BrightSign is playing the stream correctly:

- The **Connected Outputs** card lists a **BrightSign** entry showing its IP (e.g.
  `172.16.1.187`) and a growing connected time.
- The top **Connected outputs** KPI is at least `1`.
- The card is keyed to always show **BrightSign** as a known destination — it reads
  **connected** when the player is pulling the stream and **not connected** when it isn't — so
  a missing/absent BrightSign is easy to spot at a glance. Other kinds (Sonos, VLC, a browser
  you used to test) appear only while they're actually connected.

If the BrightSign shows **not connected**:

1. Confirm the stream itself is healthy from another device (§1's `ffplay`/VLC test). If that
   fails, it's the console/pipeline, not the sign — see [`OPERATIONS.md`](OPERATIONS.md) and
   [`AUDIO.md`](AUDIO.md).
2. Confirm the player is powered and on the network (ping `172.16.1.187`, or open its DWS).
3. Confirm the presentation is published and its Audio Stream URL is exactly
   `http://172.16.50.100:8000/spotify.mp3` (a wrong IP/port/mount is the most common mistake).
4. Reboot the player; it should reconnect on boot.

> Note: **listener detection needs the Icecast admin password** (`ICECAST_ADMIN_PW` in
> `stream.env`, chmod 600 — never printed here). If that isn't configured, the dashboard can
> still show the stream is up but won't be able to enumerate individual connected outputs.

---

## 5. Adding the same stream to Sonos

Sonos can play the identical Icecast MP3 as a **custom radio station** (a TuneIn "custom URL").
Sonos treats it as an internet radio stream, which is exactly what it is.

### 5.1 Add it as a custom radio station

Using the **Sonos app** (S2):

1. Go to your music sources / **Add Music Service** → **TuneIn** area, and choose to **add a
   radio station by URL** (in some app versions this lives under a "**...**"/More menu as
   *Add Radio Station* → *Streaming URL*). Historically this was the desktop Sonos controller's
   **Manage → Add Radio Station** dialog; current apps expose the same "custom stream URL"
   entry point.
2. Enter the **Stream URL** exactly:
   ```
   http://172.16.50.100:8000/spotify.mp3
   ```
3. Give the station a name (e.g. **Signage Stream**).
4. Save, then select the station on the Sonos speaker/room and press play.

### 5.2 Sonos specifics to expect

| Point | Detail |
|-------|--------|
| Format | MP3 128 kbps is natively supported by Sonos as an internet-radio stream. |
| URL | Use the plain `http://` LAN URL — **do not** add `https://`. |
| Behavior | It plays as "radio": live, no scrubbing/seeking, and it plays whatever is on the mount right now (music or scheduled silence). |
| Reconnect | On a stream restart Sonos may need a manual re-press of play; unlike the BrightSign presentation it won't always auto-reconnect. |
| Dashboard | Once playing, Sonos appears in **Connected Outputs** classified as *Sonos* (it's detected from its User-Agent). |

Sonos is optional and additive — you can run the BrightSign, Sonos, both, or neither. They are
independent listeners on the same mount and don't interfere with each other.

---

## 6. Quick reference

| Item | Value |
|------|-------|
| Stream URL (all outputs) | `http://172.16.50.100:8000/spotify.mp3` |
| Format | MP3 128 kbps, 44.1 kHz stereo, Icecast HTTP stream |
| BrightSign model / OS | XT1143 / BrightSign OS 9.1.99 |
| BrightSign IP | `172.16.1.187` |
| Test the stream | `ffplay http://172.16.50.100:8000/spotify.mp3` |
| See connected outputs | Dashboard **Connected Outputs** card at `http://172.16.50.100:8088` |
| Who decides what plays | The console's weekly schedule / dashboard — **not** the sign |

### Common issues

| Symptom | Likely cause / fix |
|---------|--------------------|
| Sign shows "not connected" but stream tests fine elsewhere | Player offline or wrong URL in the presentation. Check power/network and that the Audio Stream URL is exactly the one above. |
| Sign was playing, then went silent for a while | Normal if outside a scheduled on-air block (silence is expected in gaps). Confirm in the dashboard schedule status pill. |
| Sign briefly dropped then came back | Expected after an audio-settings change or a `spotify-stream.service` restart — the mount re-buffers for a few seconds and clients reconnect. |
| Nothing plays anywhere, stream URL fails | Pipeline/Icecast problem, not the sign. See [`OPERATIONS.md`](OPERATIONS.md) and [`AUDIO.md`](AUDIO.md). |
| Sonos stopped after a restart | Re-press play on the station; Sonos doesn't always auto-reconnect. |

### Related docs

- [`AUDIO.md`](AUDIO.md) — how the MP3 stream is produced (librespot → relay → ffmpeg → Icecast), why the mount never 404s, loudness leveling.
- [`DASHBOARD.md`](DASHBOARD.md) — the web UI, Connected Outputs card, and status API.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — the whole system end to end.
- [`OPERATIONS.md`](OPERATIONS.md) — services, logs, and recovery.
