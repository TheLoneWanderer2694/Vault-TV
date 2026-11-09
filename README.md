# 📼 Archive TV

A tiny static "cable guide" for the Internet Archive. Turn any list of
[archive.org](https://archive.org) videos into TV-style channels with a
time-based program guide, and watch everything right in the page.

## Run it

Double-click **`serve.bat`** (Windows), or run:

```
python -m http.server 8000 http://localhost:8000
```

then open **http://localhost:8000**. It can also run from any static host
(GitHub Pages, Netlify, …).

## The guide

- **TV Guide** — a full-day grid: channels as rows, time as columns.
- **Day List** — pick a channel and see every program with exact times.
- **Now Playing** — what's live on every channel right now, plus what's next.

Switch between them any time — your last view is remembered.

## Creating channels

All channels live in **`channels.json`**. Open<!--
--> the site's **＋ New channel** button: paste archive.org URLs/identifiers,
choose a name, mode and start time, click **Build JSON**, copy the result and
paste it into the `"channels"` list. Save and refresh.

Manual format:

```json
{
  "name": "My Channel",
  "color": "#38bdf8",
  "mode": "loop",          // "loop": videos repeat in order all day
  "start": "07:00",        // loop starts here
  "items": [
    { "id": "popeye_patriotic_popeye" },
    { "id": "house_on_haunted_hill_ipod", "seconds": 5400 }
  ]
}
```

- `id` — the archive.org identifier: from `https://archive.org/details/his_girl_friday`
  it is `his_girl_friday`. URLs work too (they're cleaned up automatically).
- Mode `"fixed"` plus a `"time": "20:30"` on each item pins programs to exact
  broadcast times.
- `seconds` / `minutes` are optional — lengths are fetched automatically from
  archive.org's metadata API (and cached in your browser). Set them only when a
  video's length can't be detected (e.g. audio-only or odd formats).
- `title` is optional — real titles are pulled from archive.org as well.

### Commercial breaks

Add a `"breaks"` rule to a loop-mode channel — episodes cut to a pod of **random
ads partway through**, then **resume at the exact frame they were cut at**.
The random ads are pulled from a **commercial pool file**, `commercials.json`,
which lives next to the site:

```json
// commercials.json
{ "commercials": [
  { "id": "qr_20240128" },
  { "id": "folgers_1", "seconds": 30 },
  { "id": "yt:aBCdEfGhIjK", "seconds": 45 }
]}
```

```json
// channels.json — inside a channel
"breaks": { "file": "commercials.json", "count": [1, 3] }
```

- `"count"` is how many ads play per break — a number or a `[min, max]` range
  (the actual size is seeded-random per occurrence; no repeat ads within a pod).
- `after` (optional) targets specific programs by part of their ID or title;
  omit it or use `"*"` for every program. Different pool files per channel are
  fine — any filename works.
- Which ads play and where the cut lands is **seeded-random**: it varies per
  episode and per day, but stays deterministic — every viewer on the same day
  sees the identical break, so all schedules stay in sync.
- The cut lands roughly 45–80% through the program (programs under 5 minutes
  and items with unknown lengths are left uncut). Continuation slots are listed
  in the guide as *"Program — resumes"*; the program still ends at its original
  scheduled end time.
- Ad lengths resolve automatically — archive.org via its metadata API, and
  **YouTube ads via auto-detection** (a hidden player reads each ad's length at
  load). A pool ad that somehow still ends up without a usable length is
  skipped, and the status bar lists it.
  The ＋ New channel builder includes a **"Generate / refresh commercials.json"**
  tool — paste one ad per line (`archive.org URL` or `YouTube URL + seconds`)
  and it validates each one before writing the file.
- You can also list fixed break videos directly in the channel
  (`"breaks": [{ "id": "some_ad_id", "after": "*" }]`) — the old short form
  still works; both show as striped dashed blocks in the guide and chain
  seamlessly (part 1 → ads → continuation).

### YouTube videos

Add YouTube content to any channel with `id: "yt:" + video ID`:

```json
{ "id": "yt:dQw4w9WgXcQ", "seconds": 213 }
```

- Titles auto-fetch via noembed.com; full YouTube URLs pasted into the
  **＋ New channel** builder are converted to `yt:ID` automatically.
- `seconds` is **optional** now: at load time the site briefly spins up hidden
  YouTube players (2×2 px, muted, off-screen) for each YouTube video and reads
  the real length from the player itself (`getDuration()`), then caches it in
  `localStorage`. Supply `seconds` only if you want to skip that step, or if
  detection is blocked (very old browsers / hardened extensions).
- Playback uses the privacy mode (`youtube-nocookie.com`) embed; autoplay and
  broadcast start-offset sync work the same as archive.org videos.

## Owner controls

Channel creation is yours alone:

- **Passcode**: set `"ownerPassword": "your-secret"` in `channels.json`.
  The **＋ New channel** button then requires it (asked once, remembered on your machine).
- **Publishing**: the site is static — visitors can only *watch*. The one file
  that defines channels (`channels.json`) lives wherever only you can edit it
  (your repo / hosting account), so nobody else can create or change channels.

## Real broadcast times

Programs follow the clock, not a shuffling playlist:

- Clicking a program that's on the air right now **joins it at the actual
  broadcast position** (Internet Archive supports `?start=` seconds — the player
  seeks there) and keeps **auto-advancing** to the next program as they end.
- Set `"timezone": "utc"` in `channels.json` so **every visitor worldwide** is on
  the **same broadcast clock** (otherwise each viewer sees the schedule in their
  own local time — handy while you're testing alone).

## Sharing with everyone

The guide, channels and playback are identical for every visitor — they each
just need the site's public URL:

- **Netlify Drop (easiest)**: go to `app.netlify.com/drop`, drag this whole
  folder onto the page → instant public link. Updating a channel later means
  re-dropping a single file.
- **GitHub Pages**: create a repo, upload these files (not `serve.bat`),
  then Settings → Pages → Source: *main branch* → `https://you.github.io/your-repo`.
  To update channels, edit `channels.json` and push — only you hold repo access.

## Files

| File            | What it is                       |
| --------------- | -------------------------------- |
| `index.html`    | the site (guide + player + builder) |
| `style.css`     | dark TV-guide styling            |
| `app.js`        | schedule logic & rendering       |
| `channels.json` | your channels — edit this!       |
