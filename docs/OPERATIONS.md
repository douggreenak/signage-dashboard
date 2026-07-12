# Operations runbook

Day-to-day operation of the **Audio Flow Console** — the system that plays a Spotify
playlist on this PC and streams it as MP3 over the LAN to the BrightSign sign (and
optionally Sonos).

This runbook is for the operator sitting at (or SSH'd into) the host. Everything below is
copy-pasteable. It never prints secrets — where a password or token matters, it points at
the file instead.

---

## At a glance

| Fact | Value |
| --- | --- |
| Host OS | Debian Linux (kernel 6.12) |
| Host LAN IP | `172.16.50.100` |
| Linux user | `jellyfin` (all `--user` services run as this user) |
| Node.js | v24 |
| Dashboard | v1.1 |
| Dashboard / web UI | http://172.16.50.100:8088 |
| Live stream URL | http://172.16.50.100:8000/spotify.mp3 |
| Config directory | `/home/jellyfin/.config/spotify-signage/` |
| Dashboard directory | `/home/jellyfin/signage-dashboard/` |

### Services

| Unit | Type | Role | State |
| --- | --- | --- | --- |
| `spotify-stream.service` | systemd `--user` | The audio pipeline (librespot → relay.py → ffmpeg → Icecast) | enabled |
| `signage-dashboard.service` | systemd `--user` | The web dashboard (`node server.js`) | enabled |
| `icecast2` | **system** service | The MP3 stream server (mount `/spotify.mp3`, port 8000) | enabled / active |
| `spotify-silence.service` | systemd `--user` | **OBSOLETE — disabled.** Replaced by `relay.py`. Do not start it. | disabled |

`spotify-stream.service` runs `/home/jellyfin/.config/spotify-signage/stream.sh`, which is the
chain **librespot 0.8.0 → relay.py → ffmpeg → Icecast2**. `relay.py` reclocks librespot to
real time and pads digital silence when idle so the Icecast mount never drops (no HTTP 404).

### Ports

| Port | Purpose |
| --- | --- |
| `8088` | Dashboard / web UI |
| `8000` | Icecast stream (`/spotify.mp3`) |
| `8989` | OAuth callback (HTTPS) — only live during a Spotify login |
| `8899` | OAuth short-URL redirector — only live during a login |

---

## What "linger" is (services run without a login)

The two `--user` units run under the `jellyfin` user's own systemd instance. Normally a
user's services stop when that user logs out. **User lingering is enabled**, which tells
systemd to start the `jellyfin` user manager at boot and keep it running with no interactive
login. That is why the stream and dashboard come up on reboot and stay up whether or not
anyone is logged in.

Check that lingering is on:

```bash
loginctl show-user jellyfin -p Linger
```

Expect `Linger=yes`. (If it ever reads `no`, re-enable with
`sudo loginctl enable-linger jellyfin`.)

Because these are `--user` units, always manage them with `systemctl --user ...` **as the
`jellyfin` user** — no `sudo`. Icecast is the exception: it is a **system** unit and uses
`sudo systemctl ...`.

---

## Check overall health

### 1. The dashboard (fastest)

Open http://172.16.50.100:8088. The status cards (services, live output level, connected
outputs, now-playing, schedule) show the whole system at a glance and update live over
Server-Sent Events (~every 2.5 s). If the page loads and shows a track playing, you are
healthy. For a raw snapshot:

```bash
curl -s http://172.16.50.100:8088/api/status | head -c 2000; echo
```

### 2. Service status

```bash
systemctl --user status spotify-stream.service --no-pager
systemctl --user status signage-dashboard.service --no-pager
sudo systemctl status icecast2 --no-pager
```

Each should read `active (running)`. A one-line summary of both user units:

```bash
systemctl --user is-active spotify-stream.service signage-dashboard.service
```

### 3. Confirm the stream is actually live

Fetch the mount headers (does not download audio). A live mount returns `200 OK` with
`Content-Type: audio/mpeg`; a dead mount returns `404`:

```bash
curl -sI http://172.16.50.100:8000/spotify.mp3
```

Or grab ~1 second of audio to prove bytes are flowing:

```bash
curl -s --max-time 2 http://172.16.50.100:8000/spotify.mp3 -o /dev/null -w 'bytes=%{size_download} http=%{http_code}\n'
```

`bytes` should be non-zero. Note: the relay pads **silence** when nothing is playing, so the
mount stays up (bytes flow) even when the sign is quiet — a `200` proves the pipeline is alive,
not that a song is currently playing. Use the dashboard or `/api/status` to see now-playing.

### 4. Logs

```bash
# follow the audio pipeline
journalctl --user -u spotify-stream -f

# follow the dashboard
journalctl --user -u signage-dashboard -f

# Icecast (system unit)
sudo journalctl -u icecast2 -f
```

Recent history instead of following: swap `-f` for `-n 100 --no-pager` (last 100 lines) or add
`--since "10 min ago"`.

---

## Start / stop / restart each service

### Audio stream (`spotify-stream.service`)

```bash
systemctl --user restart spotify-stream.service
systemctl --user stop    spotify-stream.service
systemctl --user start   spotify-stream.service
```

Restarting drops the Icecast source for a few seconds while the pipeline re-buffers. The
BrightSign listener reconnects on its own, and the schedule reconciler resumes the correct
playlist within ~15 s.

### Dashboard (`signage-dashboard.service`)

```bash
systemctl --user restart signage-dashboard.service
systemctl --user stop    signage-dashboard.service
systemctl --user start   signage-dashboard.service
```

Restarting the dashboard does **not** interrupt audio — the stream pipeline is a separate
unit. It only blips the web UI and the schedule/automation reconciler for a moment.

### Icecast (`icecast2`, system unit)

```bash
sudo systemctl restart icecast2
sudo systemctl stop    icecast2
sudo systemctl start   icecast2
```

Restarting Icecast tears down the mount, so `spotify-stream` loses its source connection.
After Icecast comes back, restart the stream so ffmpeg reconnects:

```bash
sudo systemctl restart icecast2 && systemctl --user restart spotify-stream.service
```

---

## Common tasks (cheat sheet)

| Task | Command |
| --- | --- |
| Restart the stream | `systemctl --user restart spotify-stream.service` |
| Restart the dashboard | `systemctl --user restart signage-dashboard.service` |
| Tail stream logs | `journalctl --user -u spotify-stream -f` |
| Tail dashboard logs | `journalctl --user -u signage-dashboard -f` |
| Tail Icecast logs | `sudo journalctl -u icecast2 -f` |
| Is the stream live? | `curl -sI http://172.16.50.100:8000/spotify.mp3` |
| Open the stream in a player | point VLC/Sonos/browser at `http://172.16.50.100:8000/spotify.mp3` |
| Full status snapshot | `curl -s http://172.16.50.100:8088/api/status` |
| Check lingering | `loginctl show-user jellyfin -p Linger` |

### "The sign went quiet"

1. Confirm the mount is up: `curl -sI http://172.16.50.100:8000/spotify.mp3` (expect `200`).
2. Open the dashboard — is anything playing, and is the **schedule** the cause? Any time not
   covered by a schedule block is intentionally paused/silent. Check the status pill
   (On-air / Off-air (silent) / No blocks yet / Schedule off).
3. Check the Spotify link — an amber **Connect Spotify** banner means the token needs a
   re-auth (see the auth doc / click the banner).
4. If the mount is up but no audio and nothing in the schedule explains it, restart the
   stream: `systemctl --user restart spotify-stream.service`.

### "The web UI won't load"

Restart the dashboard, then check its log:

```bash
systemctl --user restart signage-dashboard.service
journalctl --user -u signage-dashboard -n 50 --no-pager
```

---

## Safely applying changes

Most day-to-day settings do **not** need a manual restart — the dashboard applies them for you:

- **Loudness leveling / level (pregain):** the "Live Output Level" card writes
  `audio.env` and restarts `spotify-stream.service` for you. Expect a few seconds of
  re-buffer; the schedule then resumes playback and the BrightSign reconnects on its own.
- **Schedule edits / automation on-off / play-pause:** applied by the reconciler on its
  next tick (~15 s). No restart.

When you edit a config file by hand, apply it explicitly:

| Changed file | Apply with |
| --- | --- |
| `stream.sh`, `relay.py`, `stream.env`, `audio.env` | `systemctl --user restart spotify-stream.service` |
| `server.js`, `public/index.html` | `systemctl --user restart signage-dashboard.service` |
| Icecast config (`/etc/icecast2/icecast.xml`) | `sudo systemctl restart icecast2` then `systemctl --user restart spotify-stream.service` |

Safe-change habits:

1. **Back up first** for anything hand-editing a config:
   `cp file file.bak-$(date +%F)`.
2. **Watch the log** right after applying:
   `journalctl --user -u spotify-stream -f` (or `-u signage-dashboard`) and confirm it comes
   back to a running state without errors.
3. **Verify the result** — `curl -sI` the mount, and glance at the dashboard.
4. Do stream restarts during a quiet moment when practical; each one is a few seconds of
   silence on the sign.
5. `stream.env`, `schedules.json`, `token.json`, and `key.pem` are `chmod 600`
   and hold secrets or state — preserve their permissions and **never** paste their contents
   into logs, chat, or screenshots. (`audio.env` holds only normalization settings, no
   secrets.)

---

## Obsolete units and leftovers — do not use

These are dead and must stay that way:

| Item | Why it is obsolete |
| --- | --- |
| `spotify-silence.service` | Disabled. Its job (keeping the mount fed) is now done by `relay.py` inside the stream pipeline. Do not start or enable it. |
| `add-fallback.sh`, `silence.sh` | Leftover helper scripts from the old silence approach. Unused. |
| `spotify_player` binary (`~/.local/bin`, ~205 MB) | Abandoned. Its auth was hardwired to a client id that Spotify now rejects. |
| `signage-list` helper | Obsolete — it calls `spotify_player`. The dashboard lists playlists instead. |

If someone accidentally enabled the silence unit, disable it:

```bash
systemctl --user disable --now spotify-silence.service
```

---

## Related docs

- Spotify authentication and re-linking — see the auth/setup doc in this `docs/` directory
  (the OAuth helper is `spotify_oauth.py`; the token lives in `token.json`).
- Streaming pipeline internals (librespot flags, `relay.py` reclocking, ffmpeg encode) —
  the source of truth is `/home/jellyfin/.config/spotify-signage/stream.sh`.
