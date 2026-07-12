# Audio Flow Console — Spotify → BrightSign signage

Plays a Spotify playlist from this Linux PC and streams it as MP3 over the LAN to a
BrightSign digital sign (and optionally Sonos). Everything — playback control and the
audio stream — runs on this one box. There's a web dashboard for control, a weekly
drag‑to‑paint schedule, loudness leveling, and live status.

```
Spotify ──▶ librespot ──▶ relay.py ──▶ ffmpeg ──▶ Icecast2 ──▶ BrightSign / Sonos
"Signage"    (pipe)     (real-time)   (MP3 128k)   /spotify.mp3     (LAN players)
   ▲
   └── controlled by the dashboard (Spotify Web API) + the weekly schedule
```

## Quick reference

| What | Where |
|------|-------|
| **Web dashboard** | http://172.16.50.100:8088 |
| **Audio stream (for players)** | http://172.16.50.100:8000/spotify.mp3 |
| **Spotify Connect device name** | `Signage` |
| Host / user | `172.16.50.100` / `jellyfin` |
| Dashboard code | `/home/jellyfin/signage-dashboard/` (`server.js`, `public/index.html`) |
| Pipeline + config | `/home/jellyfin/.config/spotify-signage/` |

**Services** (systemd `--user`, run without login via linger):

```bash
systemctl --user status  spotify-stream.service      # the audio pipeline
systemctl --user status  signage-dashboard.service   # the web dashboard (:8088)
sudo systemctl status    icecast2                     # the stream server (:8000, system unit)

# restart / logs
systemctl --user restart spotify-stream.service
journalctl --user -u spotify-stream -f
```

## Documentation

Start here, then dive into whichever area you need — all under [`docs/`](docs/):

| Doc | Read it when you want to… |
|-----|---------------------------|
| [Architecture](docs/ARCHITECTURE.md) | Understand the whole pipeline and how the pieces fit |
| [Operations runbook](docs/OPERATIONS.md) | Start/stop/restart services, check health, read logs |
| [Using the dashboard](docs/DASHBOARD.md) | Learn every control in the web UI |
| [Weekly schedule](docs/SCHEDULING.md) | Set up when playlists play (drag‑to‑paint calendar) |
| [Audio & loudness](docs/AUDIO.md) | Loudness leveling, gapless, and why there's no crossfade |
| [Spotify authentication](docs/AUTHENTICATION.md) | Re‑connect Spotify / fix login problems |
| [HTTP API reference](docs/API.md) | Script or integrate against the dashboard's `/api/*` |
| [Configuration reference](docs/CONFIGURATION.md) | Every config file and setting |
| [Troubleshooting](docs/TROUBLESHOOTING.md) | Fix "no audio", "device offline", re‑auth, etc. |
| [BrightSign & Sonos](docs/BRIGHTSIGN.md) | Point a player at the stream |

## How it works in one paragraph

`librespot` logs into Spotify as a Connect device called **Signage** and decodes the
audio to raw PCM. Because librespot's pipe output races ahead of real time, **`relay.py`**
reclocks it to exactly 1× and keeps the stream fed even during silence, then **`ffmpeg`**
encodes it to MP3 and pushes it to **Icecast2**, which serves it at
`http://172.16.50.100:8000/spotify.mp3` for the BrightSign to play. Separately, the
**dashboard** (`server.js`) uses the Spotify Web API to start playlists on the Signage
device, show now‑playing/queue, and run the **weekly schedule** — a level‑based reconciler
that starts the right playlist during each scheduled block and pauses in the gaps.

## Common tasks

- **Play something now:** open the dashboard → pick a playlist → **Play playlist** (or run
  `signage-play "<playlist url>"`). Playback loops (repeat = context).
- **Schedule playback:** dashboard → *Playback & Scheduling* → paint blocks on the week. See
  [SCHEDULING.md](docs/SCHEDULING.md).
- **Smooth out volume between songs:** dashboard → *Live Output Level* → **Loudness leveling**.
  See [AUDIO.md](docs/AUDIO.md).
- **Reconnect Spotify:** dashboard → **Connect Spotify** banner. See
  [AUTHENTICATION.md](docs/AUTHENTICATION.md).

## Good to know

- **No true crossfade** — the Spotify receiver (librespot) doesn't support it, and the
  single audio stream can't overlap two songs. Smooth transitions come from **gapless +
  loudness leveling** instead. ([AUDIO.md](docs/AUDIO.md))
- **Obsolete leftovers**, safe to ignore: the `spotify_player` binary, `signage-list`,
  `spotify-silence.service`, `add-fallback.sh`, `silence.sh`.
- Dashboard version **v1.1**.
