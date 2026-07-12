# Weekly playback schedule

The **Weekly playback schedule** is a drag-to-paint calendar that decides which
Spotify playlist plays on the sign at any given moment of the week. You paint
colored blocks onto a 7-day × 24-hour grid, and a background reconciler on the
dashboard keeps the actual Spotify playback matched to whatever the grid says
should be on right now.

It lives in the dashboard's **Playback & Scheduling** card at
<http://172.16.50.100:8088> (the "Weekly playback schedule" section below the
Play/Pause controls).

The timeline itself is stored on the host at
`/home/jellyfin/.config/spotify-signage/schedules.json` and is served/edited
through three HTTP endpoints on the dashboard (see
[HTTP endpoints](#http-endpoints)).

---

## The core idea in one paragraph

The grid is the **single source of truth**. Whichever block covers *this
weekday and this minute of the day* is the playlist that should be playing.
Any minute **not** covered by a block means **silence** (playback is paused).
The one exception: if automation is switched **off**, or the grid is **empty**
(zero blocks), the schedule stays completely hands-off and never touches
playback — so a blank grid can never mute music you started by hand. Blocks
belong to a single day and cannot cross midnight.

---

## Exact semantics

| Rule | Behavior |
|---|---|
| **Timeline is authoritative** | The block covering the current weekday + minute-of-day is what *should* be playing. The reconciler steers real playback toward that. |
| **Gaps = silence** | Any moment not inside a block ⇒ playback is paused. The sign goes quiet until the next block starts. |
| **Empty timeline = hands-off** | Zero blocks ⇒ the reconciler does nothing at all. It will not pause manual playback. Gap-silence only kicks in once at least one block exists. |
| **Automation off = hands-off** | With the schedule switched off, the reconciler does nothing — it will not even pause. Manual control only. |
| **One block per day** | Every block has a single `day` (0–6). Blocks cannot span midnight. To cover an overnight stretch, use one block ending at 24:00 on one day and another starting at 00:00 the next. |
| **15-minute snap** | Painting, moving, and resizing all snap to 15-minute increments. |
| **No overlaps** | The editor prevents two blocks on the same day from overlapping — a new/moved/resized block is confined to the free vertical channel between its neighbors. |
| **Start inclusive, end exclusive** | A block `start ≤ now < end`. A 09:00–17:00 block is active from 9:00:00 through 16:59:59. Back-to-back blocks (…17:00 / 17:00…) hand off with no gap and no overlap. |
| **Minimum block** | 15 minutes. |

Times are measured in **minutes from midnight** (0–1440). `1440` means
midnight at the end of the day (i.e. the block runs through 23:59).

---

## Using the calendar

The workflow is three steps, shown as a hint right above the grid:
**1.** pick a playlist · **2.** drag down a day to add a block · **3.** drag a
block to move it, its edges to resize, or click it to edit.

### 1. Pick a playlist brush

The **"Paint with"** palette is a row of color chips, one per Spotify playlist
in your library. Click a chip to select it — that becomes the active brush
(highlighted, filled with its color). Every playlist gets a stable color
assigned by its order in your library (a fixed 10-hue palette, all legible
under the white block text). The first playlist is selected by default.

> If the palette says *"No playlists loaded — connect Spotify to build a
> schedule,"* the dashboard hasn't been able to list your playlists yet.
> Connect Spotify (amber banner) and the palette fills in.

### 2. Paint a block

With a brush selected, **press and drag down a day column** to sweep out a time
range, then release. A ghost outline follows your drag so you can see the span
before you commit; it snaps to 15-minute lines and stops at the edges of any
neighboring block (no overlaps).

- **A plain click/tap** (no drag) drops a default **~1-hour** block.
- The **very first block you ever create** auto-opens its editor popover once,
  to teach you where the per-block settings live.

If you try to paint without picking a brush first, the dashboard nudges you:
*"Pick a playlist first."*

### 3. Move, resize, edit, delete

| Gesture | Result |
|---|---|
| **Drag a block's body** | Moves it earlier/later in the day (clamped so it can't overlap neighbors). |
| **Drag the top or bottom edge** | Resizes that end (ns-resize cursor on the thin edge handles). |
| **Click a block** (no drag) | Opens the editor popover. |
| **Editor → Playlist** | Change which playlist the block plays; the block recolors to match. |
| **Editor → Shuffle** | Toggle shuffle for that block (a shuffle icon appears on the block). |
| **Editor → trash icon** | Deletes the block. |
| **Editor → Done** | Closes the popover. |

The popover header shows the block's day and its full time range (e.g.
*Sun · 7:15 AM – 1:00 PM*). Clicking elsewhere closes it.

A **red "now" line** is drawn across today's column at the current time, and
today's column/header is highlighted, so it's easy to see what's on air right
now versus what's coming up.

### The automation switch

Top-right of the section is the **Schedule on / Schedule off** toggle. It is
the *only* control that flips automation — editing blocks never changes it.

- **Off** dims the grid and palette and stops all enforcement (hands-off; won't
  even pause). Use it when you want manual control without the schedule fighting
  you. While off, the grid is **read-only** — you can't paint, move, resize, or
  open a block's editor until you switch the schedule back on.
- **On** re-enables enforcement and applies **immediately** (the server runs a
  reconcile pass right away rather than waiting for the next tick).

### The status pill

Next to the switch, a live pill shows the current schedule state (driven by the
dashboard's ~2.5s status stream):

| Pill | Meaning |
|---|---|
| **On-air · *\<playlist\>*** (green) | A block covers right now; that playlist should be playing. |
| **Off-air (silent)** | Automation is on and blocks exist, but you're in a gap — the sign is intentionally paused. |
| **No blocks yet** | Automation is on but the grid is empty — hands-off. |
| **Schedule off** | Automation is switched off — hands-off. |

### Empty state

When the grid has no blocks, an overlay reads *"Your week is open — nothing
scheduled / Pick a playlist above, then drag down any day to add when it
plays."* The grid is still fully drag-able underneath the hint.

### Saving

Edits save automatically. They're applied optimistically to the on-screen grid
and pushed to the server on a short debounce (a fraction of a second after you
stop). You never press a save button. A background poll refreshes the grid
every 30s but is skipped while you're dragging, have the editor open, or have
unsaved local edits — so it can't clobber work in progress.

---

## How enforcement works: the level-based reconciler

The dashboard server runs a **reconciler** that makes real Spotify playback
match the timeline. Understanding it explains why the schedule feels calm and
never restarts good audio.

### When it runs

- **Every 15 seconds**, on a timer.
- **Once at startup**, so a reboot (or a dashboard/service restart) restores the
  correct state without waiting for the first tick.
- **Immediately** when you turn automation **on**, and it is re-armed right
  after an audio-processing restart (see the loudness-leveling settings) so the
  schedule reasserts itself once librespot is back.

### It is *level-based*, not event-based

On each tick it computes what **should** be playing (the block covering "now",
or silence in a gap) and compares it against what **is** playing (a ~3-second
cached now-playing snapshot). It only issues a command when there's **real
drift**:

- **In a block, correct playlist already playing** → do nothing except ensure
  Spotify's repeat mode is `context`. It **never** re-sends a fresh
  play/context-transfer when the right playlist is already on. This is why
  editing the schedule, or crossing from one block into an adjacent block that
  uses the *same* playlist, does **not** restart the audio from track 1.
- **In a block, correct playlist but paused** → resume in place (keeps the
  current position; doesn't jump back to the first track).
- **In a block, but idle / wrong playlist / different context** → start the
  block's playlist and set repeat=`context`.
- **In a gap, and something is playing** → pause. (If already silent, do
  nothing.)

### Self-heal

Because it re-checks every 15s, if playback dies mid-block — the stream
hiccups, Spotify drops the device, someone pauses at the sign — the next tick
sees the drift and restarts/resumes the correct playlist on its own.

### The 4-hour manual-override window

Any **successful** Play, Pause, Resume, Next, or Previous from the dashboard
arms a **4-hour manual-override window**. While that window is open, the
reconciler leaves playback completely alone, so an ad-hoc change isn't
overwritten within 15 seconds.

The window is cleared early by the **next genuine slot change** — that is, when
the timeline actually crosses from a gap into a block, from a block into a gap,
or from one block into a different block. At that point the schedule reclaims
control. A mere re-evaluation (e.g. you edited the grid, or the server just
restarted) does **not** count as a slot change and will not cancel an in-effect
manual pause.

Notes:
- A **failed** command (e.g. the Signage device is offline) does *not* arm the
  window, so a failed Play can't silence the schedule for four hours.
- The reconciler needs Spotify to be linked. While unlinked it does nothing.

### repeat=context looping

A block never "runs out." When a block starts, playback is set to Spotify
**repeat=`context`**, so when the playlist reaches its last track it loops back
to the first and keeps going — essential for 24/7 signage. The reconciler
re-ensures repeat=`context` on every tick a block is active. A block therefore
plays its playlist on a loop until the block's **end** time, at which point the
timeline hands off to the next block or falls into a gap (pause).

### Apply latency

Grid edits take up to **~15 seconds** to affect real playback — they land on
the next reconciler tick. (Turning automation **on** is the exception; it
applies at once.) So after painting or moving a block, expect the sign to catch
up within about 15 seconds, not instantly.

---

## `schedules.json` format

The timeline is persisted at
`/home/jellyfin/.config/spotify-signage/schedules.json` (mode `600`). You
normally never edit it by hand — the dashboard owns it — but here's the shape:

```json
{
  "version": 2,
  "enabled": true,
  "blocks": [
    {
      "id": "bmr81f3ra4enc",
      "day": 0,
      "start": 435,
      "end": 780,
      "playlist": "3Z5zejprig1SlzGBXaSmma",
      "name": "BethelAK 🙌🏼Children's Ministry🙌🏼",
      "shuffle": false
    }
  ]
}
```

### Top-level fields

| Field | Type | Meaning |
|---|---|---|
| `version` | number | Store schema version (currently `2`). |
| `enabled` | bool | Master automation switch. `false` ⇒ reconciler is hands-off. |
| `blocks` | array | The painted time blocks (see below). An empty array ⇒ hands-off. |

### Block fields

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Stable unique id for the block (generated by the editor). |
| `day` | int 0–6 | Weekday. **0 = Sunday … 6 = Saturday.** |
| `start` | int 0–1440 | Start, in **minutes from midnight**. |
| `end` | int 0–1440 | End, in minutes from midnight. Must be `> start`. |
| `playlist` | string | Spotify **playlist id** (bare id, e.g. `3Z5zejprig1SlzGBXaSmma`). |
| `name` | string | Display label shown on the block (usually the playlist name). |
| `shuffle` | bool | Whether to shuffle this block's playlist. |

On save the server sanitizes every block: `day` is clamped to 0–6, `start`/`end`
are clamped to 0–1440 and rounded to the 5-minute grid, the playlist id is
normalized, and any block with `end ≤ start` or no valid playlist is dropped.
Overlap prevention is handled in the editor UI; if two blocks ever did overlap,
the one with the earlier `start` wins for the covered minute.

### Worked example

The block above reads: **Sunday** (`day: 0`), **7:15 AM → 1:00 PM**
(`start: 435` = 7×60+15, `end: 780` = 13×60), playing the *BethelAK Children's
Ministry* playlist, shuffle off. Because it's the only block, every other minute
of the week is a **gap** — the sign is silent outside Sunday 7:15 AM–1:00 PM
(while automation is on).

To add, say, a Sunday-evening service block right after it, you'd append a
second block on `day: 0` starting at `1080` (6:00 PM) — leaving a deliberate
silent gap from 1:00 PM to 6:00 PM:

```json
{
  "id": "b8k2xf90qz11",
  "day": 0,
  "start": 1080,
  "end": 1260,
  "playlist": "3Z5zejprig1SlzGBXaSmma",
  "name": "Sunday Evening",
  "shuffle": true
}
```

---

## HTTP endpoints

All under <http://172.16.50.100:8088>.

| Method & path | Body | Purpose |
|---|---|---|
| `GET /api/schedules` | — | Read the timeline. Returns `{ enabled, blocks, activeId, now:{dow,min}, log }`. `activeId` is the block covering right now (or `null`); `log` is the recent scheduler action log. |
| `PUT /api/schedules` | `{ enabled?, blocks }` | **Replaces the whole timeline.** `blocks` is sanitized and stored wholesale. Triggers a re-evaluation applied on the next tick (≤15s). |
| `POST /api/schedules/enabled` | `{ enabled }` | Flip the master switch only. Turning it **on** reconciles immediately. |

The block editor deliberately sends only `blocks` on a `PUT` (never `enabled`),
so a block edit can't accidentally toggle automation. `POST
/api/schedules/enabled` is the sole authority for the on/off state.

The dashboard's Server-Sent Events stream (`GET /api/stream`, ~2.5s) also
carries a compact `schedule` summary (`enabled`, block `count`, and the `active`
block) that drives the live status pill.

---

## Quick troubleshooting

| Symptom | Likely cause |
|---|---|
| Painted a block but the sign didn't change | Give it up to ~15s (next reconciler tick). Also check the status pill says **On-air**. |
| Sign is silent when a block should be playing | Automation off? Spotify unlinked? Signage device offline? The scheduler needs Spotify linked and the `Signage` device reachable. |
| Manual Play/Pause keeps getting "undone" quickly | It shouldn't — a successful manual command arms a 4-hour override. If it's reverting, the command likely **failed** (e.g. device offline), which doesn't arm the window. |
| Schedule won't pause during a gap | The grid may be **empty** or automation **off** — both are intentionally hands-off. Add at least one block and turn automation on. |
| Block plays but restarts from track 1 unexpectedly | Normal only when entering a block from idle/a different playlist. Crossing between same-playlist blocks or editing the grid should *not* restart it. |

---

## Related configuration

- Timeline store: `/home/jellyfin/.config/spotify-signage/schedules.json`
- Dashboard server (reconciler + endpoints): `/home/jellyfin/signage-dashboard/server.js`
- Dashboard UI (calendar): `/home/jellyfin/signage-dashboard/public/index.html`
- Spotify link/auth and the `Signage` playback device are prerequisites for the
  scheduler to control anything — see the Spotify auth/setup notes and
  `/home/jellyfin/.config/spotify-signage/token.json`.
- Loudness leveling (which restarts the stream and re-arms the reconciler) is
  configured in `/home/jellyfin/.config/spotify-signage/audio.env`.
</content>
</invoke>
