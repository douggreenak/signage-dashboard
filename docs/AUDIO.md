# Audio, loudness & the "no crossfade" reality

This document covers everything audio on the Audio Flow Console: the exact format chain,
gapless playback, the stream URL, loudness leveling (volume normalization), the dashboard
controls that manage it, the live output-level meter, and a clear explanation of **why there
is no true crossfade** and what we do instead.

Audience: the operator running this box. All paths are real and absolute; all commands are
copy-pasteable.

---

## 1. The audio pipeline at a glance

The audio is produced by the systemd `--user` unit **`spotify-stream.service`**, which runs
`/home/jellyfin/.config/spotify-signage/stream.sh`. That script is a single Unix pipe:

```
librespot 0.8.0  ->  relay.py  ->  ffmpeg  ->  Icecast2
  (Spotify           (real-time    (S16 PCM ->    (MP3 mount
   Connect,           reclocking    MP3 128k)      /spotify.mp3
   S16 PCM out)       relay)                       on :8000)
```

| Stage | Program | Role |
|-------|---------|------|
| Source | `librespot 0.8.0` | Spotify Connect receiver; appears to Spotify as the device **"Signage"**. Decodes the track and writes raw PCM. |
| Reclock | `relay.py` (python3) | Paces the byte stream to exactly real time; pads silence when idle. |
| Encode | `ffmpeg` (libmp3lame) | Encodes S16 PCM -> MP3 128 kbps and pushes it to Icecast as a source client. |
| Serve | `Icecast2` (system service) | Publishes the MP3 on the LAN at `http://172.16.50.100:8000/spotify.mp3`. |

The pipeline is launched from `stream.sh`, which first sources
`/home/jellyfin/.config/spotify-signage/stream.env` (Icecast host/port/mount, source password,
`STREAM_BITRATE`) and then `audio.env` (loudness settings, see below).

---

## 2. The format chain, exactly

### 2.1 librespot — Spotify 320 decode -> S16 PCM

`stream.sh` invokes librespot with these flags:

| Flag | Value | Meaning |
|------|-------|---------|
| `--name` | `Signage` | Device name shown in Spotify Connect. |
| `--backend` | `pipe` | Writes decoded PCM to stdout (no sound card involved). |
| `--format` | `S16` | Output is **signed 16-bit little-endian, 44.1 kHz, stereo** PCM. |
| `--bitrate` | `320` | Requests Spotify's highest-quality (320 kbps) source for decoding. This is the **decode** quality, not the output bitrate. |
| `--initial-volume` | `80` | Starting Spotify-side volume. |
| `--cache` | `/home/jellyfin/.cache/librespot` | Local audio/key cache. |
| `--disable-discovery` | (set) | No zeroconf; the dashboard/`signage-play` transfer playback explicitly. |

So the source material is Spotify's 320 kbps stream, decoded to uncompressed PCM at
**176,400 bytes/sec** (44100 samples/sec x 2 channels x 2 bytes = the number relay.py meters
itself against). Gapless is discussed in section 3.

### 2.2 relay.py — the real-time reclocking relay

librespot's `pipe` backend does **not** pace itself to real time — it writes PCM as fast as the
reader drains it. With a freely-buffering downstream (ffmpeg + Icecast) that meant librespot
raced through an entire playlist at ~40-60x: it decoded each track in a few seconds, auto-advanced,
and Spotify's reported position (and the dashboard) jumped tracks every few seconds while the
audio already produced sat buffered in Icecast, playing out to the sign minutes behind. The rapid
per-track key requests also tripped Spotify's audio-key throttle, causing skip storms.

`relay.py` fixes this by emitting a **steady real-time PCM stream** — exactly `RATE*FRAME =
176400` bytes per wall-clock second (`FRAME=4`, `RATE=44100`, output granularity `TICK=0.010`s).
Each tick it computes how many bytes *should* have been emitted by now and:

- pulls that many bytes from librespot **without blocking** when audio is available, leaving any
  surplus in the OS pipe on purpose — that back-pressure is what paces librespot to **1x**, so its
  position (and the UI) stays in sync with the audio;
- pads **digital silence** (`\x00`) on underrun (pause / idle / gap between commands), keeping the
  seam frame-aligned so an L/R sample pair is never split.

Two consequences matter operationally:

1. **The dashboard "now playing" position stays truthful** because librespot is throttled to 1x.
2. **The Icecast mount is fed continuously** — silence when idle means `/spotify.mp3` never drops,
   so listeners (the BrightSign, Sonos) don't get an HTTP 404 or a dead mount.

On librespot EOF the relay flushes and exits, which lets systemd restart the whole pipeline.

### 2.3 ffmpeg — S16 PCM -> MP3 128 kbps -> Icecast

ffmpeg reads the reclocked PCM and encodes it:

```
ffmpeg -hide_banner -loglevel warning -nostdin \
  -f s16le -ar 44100 -ac 2 -channel_layout stereo -i pipe:0 \
  -c:a libmp3lame -b:a ${STREAM_BITRATE:-128}k -reservoir 0 \
  -content_type audio/mpeg -flush_packets 1 \
  -ice_name "Spotify Signage" -ice_description "Spotify to BrightSign" \
  -f mp3 "icecast://source:<pw>@${ICECAST_HOST}:${ICECAST_PORT}${ICECAST_MOUNT}"
```

- **Codec / bitrate:** `libmp3lame` at `STREAM_BITRATE` kbps, **default 128** (`STREAM_BITRATE` is
  not set in `stream.env`, so the `128` default applies). `-reservoir 0` and `-flush_packets 1`
  keep latency low and packets flowing steadily for a live stream.
- **Input format** is fixed to match librespot/relay exactly: `s16le`, 44.1 kHz, 2-channel stereo.
- **Destination** comes from `stream.env`: `ICECAST_HOST=localhost`, `ICECAST_PORT=8000`,
  `ICECAST_MOUNT=/spotify.mp3`. The source password lives in `stream.env` (chmod 600) — **never
  printed here**.

### 2.4 Icecast2 — the mount and the stream URL

Icecast2 is a **system** service (`icecast2`, not a `--user` unit). It publishes the single mount
`/spotify.mp3` on port 8000, bound to `0.0.0.0`.

| | |
|---|---|
| **Public stream URL** | `http://172.16.50.100:8000/spotify.mp3` |
| Mount | `/spotify.mp3` |
| Port | `8000` |
| Format | MP3 (audio/mpeg), 128 kbps |

The dashboard reports this exact URL in `/api/status` (`streamUrl`). It is the URL you put into
the BrightSign as an **Audio Stream**, and the same URL Sonos uses as a custom radio station /
TuneIn custom URL.

Manage Icecast (system unit, needs sudo):

```
sudo systemctl restart icecast2
sudo journalctl -u icecast2 -f
```

---

## 3. Gapless

**Gapless playback is always on.** `stream.sh` never passes `--disable-gapless` to librespot, so
tracks decode back-to-back with no inserted silence between them. Combined with the continuous
reclocked PCM stream from `relay.py`, one track flows into the next without a gap. This is half of
the "smooth transition" story; loudness leveling (below) is the other half.

---

## 4. Loudness leveling (volume normalization)

"Loudness leveling" in the dashboard is librespot's **volume normalization**. It evens out the
loudness differences between tracks so one song isn't jarringly louder than the next — the part of
a track change that actually sounds abrupt.

### 4.1 Configuration: `audio.env`

Settings live in `/home/jellyfin/.config/spotify-signage/audio.env` (chmod 600), sourced by
`stream.sh`. The file is **managed by the dashboard** (`/api/audio`) but is plain and safe to read.

| Key | Values / range | Default | Effect |
|-----|----------------|---------|--------|
| `NORMALIZE` | `1` / `0` | on | Master on/off for loudness leveling. |
| `NORMALIZE_GAIN_TYPE` | `track` \| `album` \| `auto` | `track` | Which ReplayGain reference to use. `track` levels song-to-song (best for shuffled signage); `album` preserves intra-album dynamics; `auto` picks per context. |
| `NORMALIZE_METHOD` | `basic` \| `dynamic` | `dynamic` | `basic` applies a fixed gain; `dynamic` adds a limiter to tame peaks. |
| `NORMALIZE_PREGAIN` | `-10 .. 10` (dB) | `0` | Extra gain applied before normalization — the dashboard's **Level** slider. |

Current on-box values: `NORMALIZE=1`, `NORMALIZE_GAIN_TYPE=track`, `NORMALIZE_METHOD=dynamic`,
`NORMALIZE_PREGAIN=0`.

### 4.2 How the flags reach librespot

When `NORMALIZE=1`, `stream.sh` appends these librespot flags (otherwise none are added):

```
--enable-volume-normalisation \
--normalisation-gain-type  <track|album|auto> \
--normalisation-method     <basic|dynamic> \
--normalisation-pregain    <dB>
```

If `NORMALIZE=0`, librespot runs with no normalization flags at all. **Gapless stays on either
way.**

### 4.3 Dashboard controls — the "Live Output Level" card

The dashboard exposes two controls in the **Live Output Level** card:

- **Loudness leveling** toggle -> `NORMALIZE` (1/0).
- **Level** slider -> `NORMALIZE_PREGAIN`, range **-10 to +10 dB** (the server clamps to that
  range and rounds to 0.1 dB).

`gainType` and `method` are also part of the settings and accepted by the API; the card's two
visible controls are the toggle and the Level slider.

### 4.4 Applying a change restarts the stream (brief re-buffer)

Endpoints:

| Endpoint | Purpose |
|----------|---------|
| `GET /api/audio` | Returns `{normalize, gainType, method, pregain, gapless:true}`. |
| `POST /api/audio` | Body `{normalize?, pregain?, gainType?, method?}`. Validates (gainType in track/album/auto, method in basic/dynamic, pregain clamped `-10..10` and rounded to 0.1), writes `audio.env`, then applies. |

**Applying is a stream restart, by design.** librespot's normalization flags are set at launch, so
`POST /api/audio` runs:

```
systemctl --user restart spotify-stream.service
```

Sequence of events after you move the toggle/slider:

1. `audio.env` is rewritten with the new values.
2. `spotify-stream.service` restarts -> **a few seconds of stream re-buffer** while librespot,
   relay.py and ffmpeg come back and re-attach to the Icecast mount.
3. The server re-asserts the schedule (`resetSlot()`), then runs the reconciler again at ~6s and
   ~12s, so **the weekly schedule resumes playback automatically** — you don't have to press play.
4. The BrightSign (and any Sonos) **reconnect on their own** once the mount is back up.

So: expect a brief gap of a few seconds, then normal playback of whatever the schedule says should
be on air. This is the only time a loudness change interrupts audio.

---

## 5. Why there is no true crossfade

This system **cannot** do a true crossfade, and the reason is structural, not a missing setting:

1. **librespot has no crossfade feature.** There is no flag for it; it simply decodes one track
   after another.
2. **The pipeline carries a single, continuous PCM stream.** Everything downstream of librespot —
   `relay.py`, `ffmpeg`, the Icecast mount — is **one serial byte stream** of whatever track is
   current. A real crossfade requires **two tracks decoding simultaneously and being mixed
   together** for the overlap. There is only ever one decoder (librespot) producing one timeline,
   and `relay.py` re-clocks that single timeline; there is no second stream to overlap it with.
   Overlapping two tracks here is architecturally impossible.

### The chosen alternative: gapless + normalization

Instead of crossfading, we make transitions smooth two ways at once:

- **Gapless playback** (always on) removes the silent gap between tracks — one song runs straight
  into the next with no dead air.
- **Volume normalization / loudness leveling** removes the loudness jump between tracks — which is
  the part of a track change that actually sounds jarring.

Together, gapless + normalization deliver seamless, even-sounding transitions for 24/7 signage.
That combination — not crossfade — is the intended and correct behavior. Do not expect, or try to
add, a fade-in/fade-out overlap; the architecture doesn't support one.

---

## 6. The live output-level meter

The dashboard's **Live Output Level** card shows a real-time meter of what's actually coming off
the Icecast mount. It is not a guess from Spotify metadata — the server runs its own **ffmpeg
ebur128** analyzer against the local mount:

```
ffmpeg -nostdin -hide_banner -loglevel info -i http://localhost:8000/spotify.mp3 \
       -filter_complex ebur128=peak=true -f null -
```

- The server parses ffmpeg's momentary loudness (`M:` values, in LUFS) from stderr, maps roughly
  **-40 LUFS -> 0** and **-5 LUFS -> 1.0** onto a 0..1 bar, and snaps near-silence to a true 0.
  `-inf` (digital silence) reads as the floor.
- The meter runs **only while the `/spotify.mp3` source is live** (checked every ~4s); it reads the
  mount over `localhost`, so it doesn't add LAN load.
- The level is pushed to the browser over Server-Sent Events (`GET /api/stream`) as an `event:
  level` message about **every 100 ms** for a smooth bar, and is also included in the full status
  snapshot (`level`) roughly every 2.5s.

Because this meters the real Icecast output, when the pipeline is idle (relay.py padding silence)
the meter correctly sits at 0.

---

## 7. Quick operations reference

| Task | Command |
|------|---------|
| Restart the audio pipeline | `systemctl --user restart spotify-stream.service` |
| Pipeline status | `systemctl --user status spotify-stream.service` |
| Follow pipeline logs | `journalctl --user -u spotify-stream -f` |
| Restart Icecast (system) | `sudo systemctl restart icecast2` |
| Follow Icecast logs | `sudo journalctl -u icecast2 -f` |
| Read current loudness settings | `cat /home/jellyfin/.config/spotify-signage/audio.env` |
| Play the stream directly (test) | open `http://172.16.50.100:8000/spotify.mp3` |

Relevant files:

| File | Purpose |
|------|---------|
| `/home/jellyfin/.config/spotify-signage/stream.sh` | Pipeline launcher (librespot -> relay -> ffmpeg -> Icecast). |
| `/home/jellyfin/.config/spotify-signage/relay.py` | Real-time reclocking relay. |
| `/home/jellyfin/.config/spotify-signage/audio.env` | Loudness leveling settings (dashboard-managed, chmod 600). |
| `/home/jellyfin/.config/spotify-signage/stream.env` | Icecast host/port/mount, source password, `STREAM_BITRATE` (chmod 600; secrets — do not print). |
| `/home/jellyfin/signage-dashboard/server.js` | Dashboard server: `/api/audio`, the ebur128 meter, `streamUrl`. |

> Note: `spotify-silence.service`, `add-fallback.sh`, and `silence.sh` are **obsolete** —
> continuous-silence behavior is now handled inside `relay.py`. Don't re-enable them.
