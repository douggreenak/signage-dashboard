# Stream watchdog

`audio-stream-watchdog.*` keeps the Icecast audio stream alive. Icecast 2.5.0 can hang with its port still open
(systemd says "active" but nothing is served and the BrightSign player gets no audio). Every minute the watchdog checks
that Icecast answers and that `/spotify.mp3` has a source; if not it restarts `icecast2` and `spotify-stream`
(max once per 10 minutes). Check its log with `journalctl --user -u audio-stream-watchdog`.

Install:
```
install -m755 ops/audio-stream-watchdog.sh ~/.local/bin/
cp ops/audio-stream-watchdog.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now audio-stream-watchdog.timer
```
Needs passwordless `sudo systemctl restart icecast2` for the user.
