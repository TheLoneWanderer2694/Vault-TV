/* =========================================================
   Archive TV — a tiny static "cable guide" for archive.org
   Data lives in channels.json — edit that file to make channels.
   ========================================================= */

const utcIs = void 0;
const ARCHIVE_EMBED = (id) => `https://archive.org/embed/${encodeURIComponent(id)}`;
const ARCHIVE_PAGE  = (id) => `https://archive.org/details/${encodeURIComponent(id)}`;
let watchOffset = 0;
const CACHE_KEY = "ia-duration-cache-v1";
const DAY = 86400;
// how long an on-air player waits after a program's scheduled end before
// switching to the next program — covers archive.org video buffering lag
const FOLLOW_GRACE = 45;

const state = {
  channels: [],
  durations: {},      // identifier -> {seconds, title}
  commercialPools: {},// filename -> [ad, ...] loaded from commercials.json
  view: localStorage.getItem("at-view") || "grid",
  listChannel: 0,
  timezone: "local",  // top-level "timezone" in channels.json: "local" or "utc"
  ownerPassword: null,
  follow: null,       // {chIndex, idx} — player auto-follows the broadcast schedule
};

/* ---------- helpers ---------- */
const $ = (sel) => document.querySelector(sel);

function fmtClock(secs) {
  const s = ((secs % 86400) + 86400) % 86400;
  const h24 = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  const ampm = h24 >= 12 ? "PM" : "AM";
  let h = h24 % 12;
  if (h === 0) h = 12;
  return `${h}:${String(m).padStart(2, "0")} ${ampm}`;
}

// machine format (for channels.json "time" fields and math) — always 24h
function fmtClock24(secs) {
  const s = ((secs % 86400) + 86400) % 86400;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// "7:00 – 7:20 PM" — meridiem only on the end time if it differs
function fmtRange(a, b) {
  const sameHalf = Math.floor(a % 86400) < 43200 === Math.floor(b % 86400) < 43200;
  return sameHalf
    ? `${fmtClock(a).replace(/ (AM|PM)$/i, "")} – ${fmtClock(b)}`
    : `${fmtClock(a)} – ${fmtClock(b)}`;
}

function fmtDur(secs) {
  const h = Math.floor(secs / 3600), m = Math.round((secs % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

function nowSecs(tz) {
  const d = new Date();
  if ((tz || state.timezone) === "utc")
    return d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds();
  return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
}

// effective time zone of a channel (per-channel "timezone" overrides global)
function effTz(ch) { return ch?.timezone || state.timezone || "local"; }

function parseLen(v) { // archive.org "length" can be seconds or "mm:ss"
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.includes(":")) {
    const p = v.split(":").map(Number);
    return p.reduce((acc, x) => acc * 60 + x, 0);
  }
  return parseFloat(v) || 0;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const isBreak = (it) => !!it.break;
const isYT = (id) => typeof id === "string" && id.startsWith("yt:");

/* deterministic randomness for commercial breaks: every viewer on the same day
   sees the same ad rotation & cut points, but they vary per program cycle */
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h || 1);
}
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const breakDay = () => Math.floor(Date.now() / 86400000);

function itemSeconds(it) {
  if (it.seconds) return +it.seconds;
  if (it.minutes) return +it.minutes * 60;
  const d = state.durations[it.id];
  return d ? d.seconds : 0;
}

/* ---------- YouTube items (id: "yt:VIDEO_ID") ---------- */
const ytVid = (id) => id.slice(3);
const linkFor = (id) => isYT(id)
  ? `https://www.youtube.com/watch?v=${ytVid(id)}`
  : ARCHIVE_PAGE(id);
const embedFor = (id) => isYT(id)
  ? `https://www.youtube-nocookie.com/embed/${ytVid(id)}?autoplay=1&rel=0` + (watchOffset ? `&start=${watchOffset}` : "")
  : `${ARCHIVE_EMBED(id)}?autoplay=1` + (watchOffset ? `&start=${watchOffset}` : "");
const iso8601ToSec = (s) => {
  const m = String(s || "").match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)(?:\.\d+)?S)?$/);
  if (!m) return 0;
  return ((+m[1] || 0) * 86400) + ((+m[2] || 0) * 3600) + ((+m[3] || 0) * 60) + (+m[4] || 0);
};

function itemTitle(it) {
  if (it.break) return it.title || "Commercial break";
  return it.title || state.durations[it.id]?.title || prettyId(it.id);
}
// display title for a schedule entry — continuation slots show they resume
function entryLabel(e) {
  const t = itemTitle(e.item);
  return e.cont ? `${t} — resumes` : t;
}
function prettyId(id) {
  return id.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function parseHHMM(str) {
  if (typeof str !== "string") return null;
  const m = str.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return (+m[1]) * 3600 + (+m[2]) * 60;
}

/* ---------- data loading ---------- */
async function loadChannels() {
  try {
    const res = await fetch("channels.json", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    state.channels = data.channels || [];
    state.timezone = data.timezone === "utc" ? "utc" : "local";
    state.ownerPassword = data.ownerPassword || null;
    state.loadError = null;
  } catch (e) {
    state.channels = [];
    state.loadError =
      `⚠️ Could not load <code>channels.json</code> (${e}). Run the site from a local ` +
      `server — double-click <code>serve.bat</code> or run <code>python -m http.server 8000</code> — ` +
      `then open <code>http://localhost:8000</code>.`;
  }
  // load the commercial pools any channel pulls its random ads from
  await loadCommercials();
}

async function loadCommercials() {
  const files = new Set();
  for (const ch of state.channels) {
    // breaks may be an array of rules or a single rule object
    const rules = Array.isArray(ch.breaks) ? ch.breaks : (ch.breaks ? [ch.breaks] : []);
    for (const b of rules)
      if (b && typeof b === "object") {
        const f = b.file || b.pool;
        if (typeof f === "string") files.add(f);
      }
  }
  await Promise.allSettled([...files].map(async (f) => {
    try {
      const r = await fetch(f, { cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const data = await r.json();
      const ads = Array.isArray(data) ? data
        : (Array.isArray(data.commercials) ? data.commercials
        : (Array.isArray(data.ads) ? data.ads : []));
      if (ads.length) state.commercialPools[f] = ads;
    } catch { /* pool file missing/broken — those breaks simply don't run */ }
  }));
}

async function resolveDurations() {
  let cache = {};
  try { cache = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}"); } catch {}

  const ids = new Set();
  const yts = new Set();
  for (const ch of state.channels) {
    for (const it of [...ch.items, ...(Array.isArray(ch.breaks) ? ch.breaks : (ch.breaks ? [ch.breaks] : []))]) {
      if (it && it.id) {
        if (isYT(it.id)) yts.add(it.id);            // titles via noembed.com
        else if (!itemSeconds(it)) ids.add(it.id);  // lengths via archive.org
      }
    }
  }
  // ads pulled from commercials.json pools get resolved too (length + playable file)
  for (const file of Object.keys(state.commercialPools))
    for (const ad of state.commercialPools[file])
      if (ad && ad.id) {
        if (isYT(ad.id)) yts.add(ad.id);
        else if (!itemSeconds(ad)) ids.add(ad.id);
      }

  await Promise.allSettled([...ids].map(async (id) => {
    // use cache only when it also knows the direct video file (older cache entries lack it)
    if (cache[id] && cache[id].file) { state.durations[id] = cache[id]; return; }
    try {
      const r = await fetch(`https://archive.org/metadata/${encodeURIComponent(id)}`);
      const m = await r.json();
      if (!m || !m.files) return;
      const vids = m.files.filter((f) =>
        f.name && /MPEG4|h\.264|Ogg Video|QuickTime|Matroska/.test(f.format || ""));
      if (!vids.length) return;
      // pick the best playable file: h.264 beats older derivatives
      const score = { "h.264": 3, "MPEG4": 2, "512Kb MPEG4": 2, "Ogg Video": 1 };
      vids.sort((a, b) => ((score[b.format] || 0) - (score[a.format] || 0))
                     || (parseLen(b.length) - parseLen(a.length)));
      const lens = new Set(vids.map((f) => Math.round(parseLen(f.length))));
      // multi-part item (parts with different lengths) -> let the archive embed play
      // all parts (it sequences them); single video -> we control playback ourselves
      const multiPart = lens.size > 1;
      const best = multiPart ? null : vids.find((f) => f.format === "h.264") || vids[0];
      const len = parseLen(vids[0].length);
      if (len > 0) {
        const entry = { seconds: Math.round(len), title: m.metadata?.title, file: best?.name || null };
        state.durations[id] = entry;
        cache[id] = entry;
        localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
      }
    } catch { /* offline/blocked — set "seconds" in channels.json manually */ }
  }));
  await Promise.allSettled([...yts].map(async (id) => {
    // cached title is reusable; a cached seconds:0 means "length unknown" — that
    // is exactly what the IFrame API pass below tries to fill in
    if (cache[id] && cache[id].title) {
      state.durations[id] = cache[id];
      return;
    }
    try {
      const r = await fetch(`https://noembed.com/embed?url=https://www.youtube.com/watch?v=${encodeURIComponent(ytVid(id))}`);
      const j = await r.json();
      if (j && j.title) {
        const entry = { seconds: cache[id]?.seconds || 0, title: j.title };
        state.durations[id] = entry;
        cache[id] = entry;
        localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
      }
    } catch { /* offline — set "seconds" manually or rely on the YT player probe */ }
  }));
  // YouTube has no CORS-friendly length API, but its own player can report the
  // length: spin up tiny hidden players, let each one read getDuration().
  await detectYoutubeLengths(yts);
}

/* ---------- YouTube length auto-detect (IFrame Player API) ---------- */
function loadYoutubeApi() {
  if (window.YT && window.YT.Player) return Promise.resolve(window.YT);
  return new Promise((done, fail) => {
    const old = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { if (typeof old === "function") old(); done(window.YT); };
    if (!document.getElementById("yt-iframe-api")) {
      const s = document.createElement("script");
      s.id = "yt-iframe-api";
      s.src = "https://www.youtube.com/iframe_api";
      s.onerror = fail;
      document.head.appendChild(s);
    }
  });
}

async function detectYoutubeLengths(ids) {
  const todo = [...ids].filter((id) => !(state.durations[id] && state.durations[id].seconds > 1));
  if (!todo.length) return 0;
  let yt;
  try { yt = await loadYoutubeApi(); } catch { return 0; } // offline / blocked
  const holder = document.createElement("div");
  holder.id = "yt-length-probe";
  holder.style.cssText = "position:fixed;width:2px;height:2px;left:-9999px;opacity:0.01;pointer-events:none";
  document.body.appendChild(holder);

  let cache = {};
  try { cache = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}"); } catch {}
  let found = 0;

  // one at a time — gentle on YouTube and simple to reason about
  for (const id of todo) {
    try {
      const secs = await new Promise((resolve) => {
        let settled = false;
        const finish = (v) => { if (!settled) { settled = true; try { p.destroy(); } catch {} resolve(v); } };
        const p = new yt.Player(holder.appendChild(document.createElement("div")), {
          videoId: ytVid(id),
          width: 320, height: 180,
          playerVars: { autoplay: 1, mute: 1, controls: 0, playsinline: 1 },
          events: {
            onReady: () => {
              // duration usually arrives once the video has started buffering
              let tries = 0;
              const tick = setInterval(() => {
                let d = 0;
                try { d = p.getDuration(); } catch {}
                if (d > 1 || ++tries >= 20) { clearInterval(tick); finish(d > 1 ? Math.round(d) : 0); }
              }, 250);
              // hard stop in case the state event never fires
              setTimeout(() => finish(0), 8000);
            },
          },
        });
      });
      if (secs > 1) {
        const title = state.durations[id]?.title;
        const entry = { seconds: secs, title };
        state.durations[id] = entry;
        cache[id] = entry;
        try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch {}
        found++;
      }
    } catch { /* skip this one */ }
  }
  holder.remove();
  return found;
}

/* ---------- schedule building ----------
   schedule = [{start, end, item, chIndex, idx}]
   mode "loop":  videos repeat in order from channel.start until midnight.
   mode "fixed": each item appears at its own "time".                      */
function buildSchedule(ch, chIndex) {
  const out = [];
  if (!ch) return out;

  if (ch.mode === "fixed") {
    ch.items
      .map((it, idx) => ({ it, idx, key: "i" + idx, t: parseHHMM(it.time || ch.start) }))
      .filter((e) => e.t != null)
      .sort((a, b) => a.t - b.t)
      .forEach((e, i, arr) => {
        const start = e.t;
        const nextStart = arr[i + 1] ? arr[i + 1].t : DAY;
        let dur = itemSeconds(e.it);
        if (!dur) dur = Math.min(nextStart - start, 5400); // default guess: 90 min
        const end = Math.min(start + dur, nextStart, DAY);
        out.push({ start, end, item: e.it, chIndex, key: e.key });
      });
    return out;
  }

  const startSec = parseHHMM(ch.start || "00:00") ?? 0;
  const n = ch.items.length;
  if (!n) return out;
  let cur = startSec, k = 0, iter = 0, guard = 0;
  while (cur < DAY && guard++ < 600) {
    const cycle = Math.floor(iter / n);
    const it = ch.items[k];
    const dur = itemSeconds(it) || 600; // unknown duration -> 10 min placeholder

    // mid-program commercial break: split the program partway through, play a
    // seeded-random pod of ads — either a fixed break video or a random draw
    // from a commercials.json pool — then resume the video at the exact frame
    // it was cut at. Seeded so the same day plays the same ads for everyone.
    const chBreakRules = Array.isArray(ch.breaks) ? ch.breaks : (ch.breaks ? [ch.breaks] : []);
    const rules = chBreakRules
      .map((b, bi) => ({ b, bi }))
      .filter((x) => breakApplies(x.b, it));
    const canCut = rules.length > 0
      && itemSeconds(it) > 0          // needs a known program length to pick a cut
      && dur >= 300                   // don't slice short programs
      && cur + dur < DAY;             // and it must finish inside today

    let pod = null;
    if (canCut) {
      const rnd = mulberry32(hashStr(ch.name + "|" + it.id) + cycle * 7919 + breakDay());
      const rule = rules[Math.floor(rnd() * rules.length)];
      pod = rulePod(rule.b, rnd).filter((a) => itemSeconds(a) > 2);
      if (pod.length) {
        const bd = pod.reduce((s, a) => s + itemSeconds(a), 0);
        const cut = Math.min(
          Math.floor(dur * (0.45 + rnd() * 0.35)), // cut 45%–80% through
          Math.max(60, dur - bd - 30),             // leave room to resume before end
        );
        const endP1 = cur + cut;
        out.push({ start: cur, end: endP1, item: it, chIndex, key: "i" + k, src: 0 });
        let t = endP1;
        pod.forEach((ad, j) => {
          const d = itemSeconds(ad);
          out.push({
            start: t, end: Math.min(t + d, DAY), chIndex, key: `b${rule.bi}p${j}`,
            item: { ...ad, break: true }, src: 0,
          });
          t += d;
        });
        out.push({
          start: t, end: cur + dur, item: it, chIndex, key: "i" + k + "c",
          src: cut, cont: true,
        });
        cur += dur;
      }
    }
    if (!pod || !pod.length) { // no break this time — plain program slot
      out.push({ start: cur, end: Math.min(cur + dur, DAY), item: it, chIndex, key: "i" + k, src: 0 });
      cur += dur;
    }
    k = (k + 1) % n;
    iter++;
  }
  return out;
}

/* turn a break rule into the pod of ads it should play now:
   - { id, ... }  -> fixed video (legacy after-list form)
   - { file: "commercials.json", count: [1,3] } -> seeded random picks from the pool */
function rulePod(rule, rnd) {
  const file = (rule && (rule.file || rule.pool)) || null;
  if (!file) return [rule];
  const pool = state.commercialPools[file] || [];
  const usable = pool.filter((a) => a && a.id && itemSeconds(a) > 2);
  if (!usable.length) return [];
  let want = rule.count;
  if (Array.isArray(want)) {
    const lo = Math.max(1, +want[0] || 1), hi = Math.max(lo, +want[1] || lo);
    want = lo + Math.floor(rnd() * (hi - lo + 1));
  }
  want = Math.max(1, Math.floor(+want || 1));
  const picks = [];
  const idxs = usable.map((_, i) => i);
  for (let i = 0; i < want && idxs.length; i++) {
    const j = Math.floor(rnd() * idxs.length);
    picks.push(usable[idxs[j]]);
    idxs.splice(j, 1); // no repeats within one pod
  }
  return picks;
}

function breakApplies(b, it) {
  if (!b || typeof b !== "object") return false;
  if (b.after === "*" || !("after" in b)) return true; // omitted = every program
  if (typeof b.after !== "string") return false;
  const hay = (it.id + " " + itemTitle(it)).toLowerCase();
  return hay.includes(b.after.toLowerCase());
}

function liveEntry(entries, tz) {
  const n = nowSecs(tz);
  return entries.find((e) => n >= e.start && n < e.end) || null;
}

/* ---------- renderers ---------- */
function render() {
  if (!state.loadError) {
    // YouTube ads whose "seconds" is missing can never be timed — tell the owner
    const badYt = [];
    for (const file of Object.keys(state.commercialPools))
      for (const ad of state.commercialPools[file])
        if (ad && isYT(ad.id) && !itemSeconds(ad)) badYt.push(file.replace(/\.json$/, "") + " · " + ad.id);
    $("#status").innerHTML =
      `times shown in ${esc(state.timezone === "utc" ? "UTC (same for every viewer)" : "your local time")}` +
      ` · click any program to watch · click a channel's name for its day list` +
      (badYt.length
        ? `<br><span style="color:var(--accent)">⚠️ these YouTube ads in the commercial pool need a "seconds" value (YouTube won't tell a static site the length): ${esc(badYt.join(", "))}</span>`
        : "");
  }
  document.querySelectorAll("#views button[data-view]").forEach((b) =>
    b.classList.toggle("active", b.dataset.view === state.view));
  document.querySelectorAll(".view").forEach((v) => (v.style.display = "none"));
  $("#help").style.display  = state.view === "guidehelp" ? "block" : "none";
  $("#gridWrap").style.display = state.view === "grid" ? "block" : "none";
  $("#listView").style.display = state.view === "list" ? "block" : "none";
  $("#nowView").style.display  = state.view === "now"  ? "grid"  : "none";
  $("#toolbar").style.display  = state.view === "list" ? "flex" : "none";

  if (state.view === "grid") renderGrid();
  if (state.view === "list") renderList();
  if (state.view === "now") renderNow();
}

function scheduleFor(i) { return buildSchedule(state.channels[i], i); }

function renderGrid() {
  const ruler = $("#gridRuler");
  ruler.innerHTML = "";
  for (let h = 0; h <= 24; h += 3) {
    const s = document.createElement("span");
    s.style.left = `calc(230px + ${(h / 24) * 100}% * (100% - 230px) / 100%)`;
    ruler.appendChild(s);
  }
  // simpler: position hours inside the track area only
  ruler.innerHTML = "";
  const track = document.createElement("div");
  track.className = "rulerTrack";
  ruler.appendChild(track);
  for (let h = 0; h <= 24; h += 3) {
    const s = document.createElement("span");
    s.style.left = `${(h / 24) * 100}%`;
    // no text on the final midnight tick — the day's last hour isn't "0 AM"
    s.textContent = h < 24 ? fmtClock(h * 3600) : "";
    track.appendChild(s);
  }
  // spacer over the label column
  const pad = document.createElement("div");
  pad.className = "rulerPad";
  ruler.insertBefore(pad, track);

  $("#gridRows").innerHTML = "";
  // canvas wide enough that each program block is readable (x-scrollable)
  const maxEntries = Math.max(1, ...state.channels.map((_, i) => scheduleFor(i).length));
  $("#gridInner").style.minWidth = Math.min(14000, Math.max(1150, maxEntries * 38 + 260)) + "px";

  state.channels.forEach((ch, i) => {
    const entries = scheduleFor(i);
    const row = document.createElement("div");
    row.className = "channelRow";
    row.innerHTML = `
      <div class="rowLabelCell" onclick="showChannelList(${i})">
        <span class="dot" style="background:${esc(ch.color || "#38bdf8")}"></span>
        <span><div class="rowName">${esc(ch.name)}</div>
        <div class="rowSub">${esc(ch.description || "")}</div></span>
      </div>
      <div class="track"></div>`;
    const trackEl = row.querySelector(".track");
    const tz = effTz(ch);
    const n = nowSecs(tz);
    for (const e of entries) {
      const b = document.createElement("div");
      b.className = isBreak(e.item) ? "block isBreak" : "block";
      const isLive = n >= e.start && n < e.end;
      if (isLive) b.classList.add("live");
      b.style.left = `${(e.start / DAY) * 100}%`;
      b.style.width = `calc(${((e.end - e.start) / DAY) * 100}% - 2px)`;
      b.innerHTML = `<div class="bTitle">${esc(entryLabel(e))}</div>
        <div class="bTime">${fmtRange(e.start, e.end)}</div>`;
      b.onclick = () => watch(e.chIndex, e.key, isLive);
      // short breaks (60s etc.) get no room for text — they read as dashed stripes
      if ((e.end - e.start) < 900) {
        b.innerHTML = `<div class="bTitle">·</div>`;
      }
      trackEl.appendChild(b);
    }
    $("#gridRows").appendChild(row);
  });

  moveNowLine();
}

function moveNowLine() {
  const line = $("#nowLine");
  const n = nowSecs();
  if (n >= DAY) { line.style.display = "none"; return; }
  line.style.display = "block";
  const body = $("#gridBody");
  const track = body.querySelector(".channelRow .track");
  if (!track) return;
  line.style.left = `${track.offsetLeft + (n / DAY) * track.offsetWidth}px`;
}

window.showChannelList = function (i) {
  state.listChannel = i;
  setView("list");
};

function renderList() {
  const sel = $("#channelSelect");
  sel.innerHTML = state.channels
    .map((c, i) => `<option value="${i}" ${i === state.listChannel ? "selected" : ""}>${esc(c.name)}</option>`)
    .join("");

  const ch = state.channels[state.listChannel];
  const box = $("#dayList");
  const banner = $("#listLiveBanner");
  if (!ch) { box.innerHTML = ""; banner.innerHTML = ""; return; }
  const tz = effTz(ch);
  const entries = scheduleFor(state.listChannel);
  const live = liveEntry(entries, tz);
  banner.innerHTML = live
    ? `<div class="dayItem live" onclick="watch(${state.listChannel},'${live.key}',true)">
         <span class="t">NOW</span>
         <span>${esc(entryLabel(live))}<span class="badge">LIVE</span></span>
         <span class="d">until ${fmtClock(live.end)}</span>
       </div>`
    : "";
  box.innerHTML = entries.length
    ? entries.map((e) => `
      <div class="dayItem" onclick="watch(${state.listChannel},'${e.key}')">
        <span class="t">${fmtRange(e.start, e.end)}</span>
        <span>${esc(entryLabel(e))}</span>
        <span class="d">${fmtDur(e.end - e.start)}</span>
      </div>`).join("")
    : `<p style="color:var(--muted)">No programs scheduled. Edit channels.json.</p>`;
}

function renderNow() {
  $("#nowView").innerHTML = state.channels.map((ch, i) => {
    const entries = scheduleFor(i);
    const tz = effTz(ch);
    const live = liveEntry(entries, tz);
    const n = nowSecs(tz);
    const upNext = live ? entries[entries.indexOf(live) + 1]
                        : entries.find((e) => e.start > n) || null;
    const startT = parseHHMM(ch.start || "00:00") ?? 0;
    return `<div class="nowCard" onclick="watch(${i},'${live ? live.key : (entries[0]?.key || "")}',${live ? "true" : "false"})">
      <div class="name">${esc(ch.name)}${tz === "utc" ? " · UTC" : ""}</div>
      <h3><span class="dot" style="background:${esc(ch.color || "#38bdf8")}"></span>
        ${live ? esc(entryLabel(live))
               : "Off air — starts at " + fmtClock(startT)}
        ${live ? '<span class="badge">LIVE</span>' : ""}</h3>
      <div>${live ? `${fmtClock(live.start)} – ${fmtClock(live.end)}` : ""}</div>
      ${upNext ? `<div class="next">Next: ${fmtClock(upNext.start)} · ${esc(entryLabel(upNext))}</div>`
               : '<div class="next">Nothing else scheduled today</div>'}
    </div>`;
  }).join("");
}

function sizeWatchPadding() {
  const w = $("#watch");
  if (w.style.display === "none") return;
  requestAnimationFrame(() => {
    document.body.style.paddingBottom = document.body.classList.contains("theater")
      ? "0px"
      : (w.offsetHeight + 24) + "px";
  });
}

/* ---------- watch ---------- */
function embedSrc(id) {
  return embedFor(id);
}

window.watch = function (chIndex, key, syncLive = false) {
  const ch = state.channels[chIndex];
  if (!ch) return;
  const entries = scheduleFor(chIndex);
  // resolve the schedule entry by key ("i3", "b0", "i3c" continuation, or legacy "3").
  // loop mode repeats keys across the day — pick the occurrence that's on air now,
  // otherwise the first one (same item, same content).
  const norm = /^\d+$/.test(String(key)) ? "i" + key : String(key);
  const candidates = entries.filter((x) => x.key === norm);
  const n = nowSecs(effTz(ch));
  const e = candidates.find((x) => n >= x.start && n < x.end) || candidates[0] || null;
  if (!e) return;
  const it = e.item;
  // clicking a program that's on air joins the broadcast at the point you missed
  // from; clicking a finished or future one plays it from its natural position
  const isLive = n >= e.start && n < e.end;
  watchOffset = Math.floor((e.src || 0) + (isLive ? n - e.start : 0));

  const yt = isYT(it.id);
  const dEntry = state.durations[it.id];
  const useDirect = !yt && !!(dEntry && dEntry.file) && document.createElement("video").canPlayType !== undefined;
  const vid = $("#watchVideo");
  const frame = $("#watchFrame");

  if (useDirect) {
    vid.src = `https://archive.org/download/${encodeURIComponent(it.id)}/${encodeURIComponent(dEntry.file)}`;
    const seek = () => {
      try {
        // clamp: joining past the real length would otherwise wrap back to 0
        const max = vid.duration ? Math.max(0, vid.duration - 1) : watchOffset;
        vid.currentTime = Math.min(watchOffset, max);
      } catch {}
    };
    vid.addEventListener("loadedmetadata", seek, { once: true });
    vid.style.display = "block";
    frame.style.display = "none";
    frame.src = "about:blank";
    vid.play().catch(() => { /* user may need to press play once */ });
  } else {
    vid.pause();
    vid.removeAttribute("src");
    vid.load();
    vid.style.display = "none";
    frame.style.display = "block";
    frame.src = embedSrc(it.id);
  }
  state.watchChIndex = chIndex;
  $("#watchTitle").textContent = itemTitle(it);
  $("#watchChannel").textContent = ch.name + (watchOffset > 0 ? ` · joined ${fmtDur(watchOffset)} in (synced to broadcast)` : "");
  $("#watchLink").href = linkFor(it.id);
  $("#watch").style.display = "block";
  sizeWatchPadding();

  // while the player is open on an on-air entry, it follows the schedule:
  // when this program ends (+ grace period for buffering), the next one starts
  state.follow = isLive ? { chIndex, start: e.start, end: e.end } : null;
  $("#followChk").checked = !!state.follow;
};

/* the direct video player tells us when it actually finished — advance then,
   exactly when the video is done (not when a clock says so) */
function watchVideoEnded() {
  const follow = state.follow;
  if (!follow) return; // not following — just let it stop
  const ch = state.channels[follow.chIndex];
  if (!ch) { state.follow = null; return; }
  const entries = scheduleFor(follow.chIndex);
  const tz = effTz(ch);
  const n = nowSecs(tz);
  const i = entries.findIndex((x) => x.start === follow.start);
  const next = i >= 0 ? entries[i + 1] : null;
  const live = liveEntry(entries, tz);
  // the next slot may already be ruling (video finished late) — then it's live now
  const target = next && live && live.start > follow.start ? live : next;
  if (target && n >= target.start - 60) watch(follow.chIndex, target.key, true);
  else {
    // show ended early relative to the schedule — tell the viewer what's coming
    const whenTarget = target ? fmtClock(target.start) : "later";
    const base = $("#watchChannel").textContent.split(" · ")[0];
    $("#watchChannel").textContent = base + ` · show ended — next program at ${whenTarget}`;
  }
}

window.closeWatch = function () {
  state.follow = null;
  $("#watch").style.display = "none";
  $("#watchFrame").src = "about:blank";
  const vid = $("#watchVideo");
  vid.pause();
  vid.removeAttribute("src");
  vid.load();
  document.body.style.paddingBottom = "";
};

window.setFollow = function (on) {
  if (!on) { state.follow = null; return; }
  const chIndex = state.watchChIndex ?? 0;
  const ch = state.channels[chIndex];
  if (!ch) return;
  const live = liveEntry(scheduleFor(chIndex), effTz(ch));
  if (live) {
    state.follow = { chIndex, start: live.start, end: live.end };
    watch(chIndex, live.key, true);
  } else state.follow = null;
};

function tickFollow() {
  if (!state.follow) return;
  const { chIndex, end } = state.follow;
  const ch = state.channels[chIndex];
  if (!ch) { state.follow = null; return; }
  const tz = effTz(ch);
  const live = liveEntry(scheduleFor(chIndex), tz);
  const n = nowSecs(tz);
  const base = $("#watchChannel").textContent.split(" · ")[0];
  if (n >= end && n < end + FOLLOW_GRACE)
    $("#watchChannel").textContent = base + " · show ended — next program starting shortly…";
  else if (n >= end + FOLLOW_GRACE) {
    const next = live || scheduleFor(chIndex)[0];
    if (next) watch(chIndex, next.key, true); // follows the broadcast at its live position
    else state.follow = null;                 // channel sign-off (or day rolled over)
    return;
  }
}

/* ---------- watch live / zapping / theater ---------- */
window.watchLive = function (offset = 0) {
  // open the channel that's broadcasting right now (offset = channel steps to zap)
  const n = state.channels.length;
  if (!n) return;
  if (typeof state.watchChIndex !== "number") state.watchChIndex = 0;
  for (let i = 0; i < n; i++) {
    const c = (state.watchChIndex + offset + i + n) % n;
    const live = liveEntry(scheduleFor(c), effTz(state.channels[c]));
    if (live) { state.watchChIndex = c; watch(c, live.key, true); return; }
  }
  const c = (state.watchChIndex + offset + n) % n;
  const e = scheduleFor(c)[0];
  state.watchChIndex = c;
  if (e) watch(c, e.key, false);
};

window.zap = function (dir) { watchLive(dir); };

window.toggleTheater = function () {
  document.body.classList.toggle("theater");
  $("#theaterBtn").textContent = document.body.classList.contains("theater")
    ? "◱ Exit theater" : "⤢ Theater";
  sizeWatchPadding();
};

/* ---------- program search ---------- */
window.runSearch = function () {
  const q = $("#searchInput").value.trim().toLowerCase();
  const box = $("#searchResults");
  if (q.length < 2) { box.style.display = "none"; box.innerHTML = ""; return; }
  const hits = [];
  for (let i = 0; i < state.channels.length && hits.length < 24; i++) {
    for (const e of scheduleFor(i)) {
      const t = itemTitle(e.item).toLowerCase();
      const id = e.item.id.toLowerCase();
      if (t.includes(q) || id.includes(q)) {
        hits.push({ chIndex: i, ch: state.channels[i], e });
        if (hits.length >= 24) break;
      }
    }
  }
  box.innerHTML = hits.length ? hits.map((h) => `
    <div class="searchHit" onclick="runSearchPick(${h.chIndex},'${h.e.key}')">
      <span class="t">${fmtRange(h.e.start, h.e.end)}</span>
      <span class="sTitle">${esc(entryLabel(h.e))}</span>
      <span class="sCh">${esc(h.ch.name)}</span>
    </div>`).join("")
    : `<div class="searchHit empty">nothing scheduled under “${esc(q)}” today</div>`;
  box.style.display = "block";
};
window.runSearchPick = function (chIndex, key) {
  $("#searchResults").style.display = "none";
  $("#searchInput").value = "";
  watch(chIndex, key);
};

/* ---------- view switching ---------- */
function setView(v) {
  state.view = v;
  localStorage.setItem("at-view", v);
  render();
}

/* ---------- channel builder (owner only) ---------- */
window.openBuilder = function () {
  if (state.ownerPassword && localStorage.getItem("at-owner-unlocked") !== state.ownerPassword) {
    const a = prompt("Owner passcode:");
    if (a !== state.ownerPassword) { alert("Wrong passcode — only the channel owner can create channels."); return; }
    localStorage.setItem("at-owner-unlocked", state.ownerPassword);
  }
  $("#builder").style.display = "flex";
};
window.closeBuilder = () => { $("#builder").style.display = "none"; };

window.buildChannelJson = function () {
  const name = $("#cfgName").value.trim() || "My Channel";
  const desc = $("#cfgDesc").value.trim();
  const mode = $("#cfgMode").value;
  const start = $("#cfgStart").value || "07:00";
  const color = $("#cfgColor").value;
  const ids = $("#cfgIds").value.trim().split(/\r?\n/).map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map(normalizeId);

  if (!ids.length) { alert("Paste at least one archive.org identifier or URL."); return; }

  const items = ids.map((id, n) => {
    const item = { id };
    if (mode === "fixed") {
      const base = parseHHMM($("#cfgStart").value || "18:00");
      if (base != null) item.time = fmtClock24(base + n * 5400); // 90 min apart
    }
    return item;
  });

  const breaks = buildBreaks();
  const out = { name, description: desc, color, mode, start, items };
  if (breaks.length) out.breaks = breaks;
  $("#cfgOut").value = JSON.stringify(out, null, 2);
  $("#cfgOutWrap").style.display = "block";
  validateIds([...items, ...breaks.filter((b) => b.id)]);
};

/* pool file generator: lines of "URL-or-ID [seconds]" -> commercials.json */
window.buildPoolFile = async function () {
  const inBox = $("#cfgPoolIn");
  const issues = $("#cfgPoolIssues");
  const out = $("#cfgPoolOut");
  const outLbl = $("#cfgPoolOutLbl");
  const copyBtn = $("#cfgPoolCopy");
  const msgs = [];
  const ads = [];
  for (const raw of inBox.value.split(/\n+/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    const id = normalizeId(parts[0] || "");
    if (!id) continue;
    const ad = { id };
    const sec = parseFloat(parts[1]);
    if (sec > 0) ad.seconds = Math.round(sec);
    ads.push(ad);
  }
  // validate: YouTube ads get titles via noembed (and demand seconds), archive ads get lengths verified
  await Promise.allSettled(ads.map(async (ad) => {
    if (isYT(ad.id)) {
      try {
        const r = await fetch(`https://noembed.com/embed?url=https://www.youtube.com/watch?v=${encodeURIComponent(ytVid(ad.id))}`);
        const j = await r.json();
        if (j.error) msgs.push(`${ad.id} — not found on YouTube, check the link`);
        else if (!ad.seconds) msgs.push(`${ad.id} ("${j.title}") — length auto-detected at site load (paste its seconds to skip that)`);
      } catch { msgs.push(`${ad.id} — could not be checked (offline?)`); }
    } else if (!ad.seconds) {
      try {
        const r = await fetch(`https://archive.org/metadata/${encodeURIComponent(ad.id)}`);
        const m = await r.json();
        if (!m || !m.metadata) msgs.push(`${ad.id} — not found on archive.org`);
        else if (!(m.files || []).some((f) => /MPEG4|h\.264|Ogg Video|QuickTime|Matroska/.test(f.format || "")))
          msgs.push(`${ad.id} — no video file detected there; add its seconds after the URL`);
      } catch { msgs.push(`${ad.id} — could not be checked (offline?)`); }
    }
  }));
  const json = JSON.stringify({ commercials: ads }, null, 2);
  out.value = json;
  out.style.display = "block";
  outLbl.style.display = "block";
  copyBtn.style.display = "inline-block";
  issues.style.display = "block";
  issues.textContent = msgs.length
    ? "⚠️ " + msgs.join(" · ")
    : (ads.length
        ? `✓ checked ${ads.length} ad${ads.length === 1 ? "" : "s"} — archive.org lengths resolve automatically, YouTube ads use the seconds you gave`
        : "paste at least one ad URL above");
  return json;
};

function setupPoolGenerator() {
  $("#cfgPoolBuild").addEventListener("click", () => buildPoolFile());
  $("#cfgPoolCopy").addEventListener("click", () => {
    const t = $("#cfgPoolOut");
    t.select();
    document.execCommand("copy");
    $("#cfgPoolMsg").textContent = "copied!";
    setTimeout(() => ($("#cfgPoolMsg").textContent = ""), 4000);
  });
}

/* normalize a pasted URL/identifier -> item id (yt: for YouTube) */
function normalizeId(line) {
  const s = line.trim();
  const yt = s.match(/(?:youtube\.com\/(?:watch\?.*v=|embed\/|live\/|shorts\/)|youtu\.be\/)([\w-]{11})/);
  if (yt) return "yt:" + yt[1];
  return s.replace(/.*archive\.org\/(?:details|embed)\//, "").replace(/\/.*$/, "");
}

function buildBreaks() {
  const after = $("#cfgBrkAfter").value.trim() || "*";
  if ($("#cfgBrkFileOn").checked) {
    const file = $("#cfgBrkFile").value.trim() || "commercials.json";
    const min = Math.max(1, +$("#cfgBrkCountMin").value || 1);
    const max = Math.max(min, +$("#cfgBrkCountMax").value || min);
    return [{ after, file, count: min === max ? min : [min, max] }];
  }
  const line = $("#cfgBrkId").value.trim();
  if (!line) return [];
  const b = { id: normalizeId(line) };
  const sec = +$("#cfgBrkSec").value || 0;
  if (sec) b.seconds = sec;
  if (after !== "*") b.after = after;
  return [b];
}

/* check each item can actually play (exists + is a video, or is a known YouTube id) */
async function validateIds(items) {
  const box = $("#cfgIssues");
  box.style.display = "block";
  box.innerHTML = "checking videos on archive.org / youtube…";
  const issues = [];
  await Promise.allSettled(items.map(async (it) => {
    const id = it.id;
    if (isYT(id)) {
      try {
        const r = await fetch(`https://noembed.com/embed?url=https://www.youtube.com/watch?v=${encodeURIComponent(ytVid(id))}`);
        const j = await r.json();
        if (j.error) issues.push([id, "not found — check the YouTube video ID"]);
        else if (!itemSeconds(it))
          issues.push([id, `plays "${j.title}" — length will be auto-detected when the site loads (or add "seconds": N now to skip the wait)`]);
        else issues.push([id, `✓ ${j.title}`]);
      } catch { issues.push([id, "could not be checked (offline?)"]); }
      return;
    }
    try {
      const r = await fetch(`https://archive.org/metadata/${encodeURIComponent(id)}`);
      const m = await r.json();
      if (!m || !m.metadata) { issues.push([id, "not found — check the identifier"]); return; }
      const mt = m.metadata.mediatype;
      if (mt === "collection")
        issues.push([id, "this is a collection — open it and use an individual episode's identifier instead"]);
      else if (!(m.files || []).some((f) => /MPEG4|h\.264|Ogg Video|QuickTime|Matroska/.test(f.format || "")))
        issues.push([id, "no video file detected — add \"seconds\" manually if you know its length"]);
    } catch { issues.push([id, "could not be checked (offline?)"]); }
  }));
  const bad = issues.filter(([i]) => !i.startsWith("✓"));
  box.innerHTML = (issues.length
    ? issues.map(([id, msg]) => `<b>${esc(id)}</b> — ${esc(msg)}`).join("<br>")
    : "checking…");
  box.style.background = bad.length ? "rgba(239,68,68,.12)" : "rgba(74,222,128,.1)";
}

window.copyChannelJson = function () {
  const t = $("#cfgOut");
  t.select();
  document.execCommand("copy");
  $("#copyMsg").textContent = "copied! paste it into the \"channels\" list in channels.json";
  setTimeout(() => ($("#copyMsg").textContent = ""), 4000);
};

/* ---------- init ---------- */
(async function init() {
  $("#views").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-view]");
    if (b) setView(b.dataset.view);
  });
  $("#channelSelect").addEventListener("change", (e) => {
    state.listChannel = +e.target.value;
    renderList();
  });
  $("#newChannelBtn").addEventListener("click", openBuilder);
  $("#builderClose").addEventListener("click", closeBuilder);
  $("#cfgBuild").addEventListener("click", buildChannelJson);
  setupPoolGenerator();
  $("#cfgBrkFileOn").addEventListener("change", (e) => {
    $("#cfgBrkFileRow").style.display = e.target.checked ? "block" : "none";
    $("#cfgBrkFixLbl").textContent = e.target.checked
      ? "Fixed break video (optional — used when the checkbox above is off)"
      : "Break video (URL / identifier)";
  });
  $("#cfgCopy").addEventListener("click", copyChannelJson);
  $("#watchLiveBtn").addEventListener("click", () => watchLive(0));
  $("#zapPrev").addEventListener("click", () => zap(-1));
  $("#zapNext").addEventListener("click", () => zap(1));
  $("#theaterBtn").addEventListener("click", toggleTheater);
  $("#followChk").addEventListener("change", (e) => setFollow(e.target.checked));

  /* OBS overlay link generator */
  $("#obsGenBtn").addEventListener("click", () => {
    const chSel = $("#obsCh");
    let chVal = chSel.value;
    if (/^\d+:/.test(chVal)) chVal = state.channels[+chVal.slice(0, -1)]?.name || "auto";
    const p = new URLSearchParams();
    if (chVal && chVal !== "auto") p.set("ch", chVal);
    const style = $("#obsStyle").value;
    if (style !== "bar") p.set("style", style);
    const scale = $("#obsScale").value;
    if (scale) p.set("scale", scale);
    const base = new URL("overlay.html", location.href);
    const url = base.origin + base.pathname + (p.toString() ? "?" + p : "");
    $("#obsUrl").value = url;
    $("#obsOut").style.display = "block";
  });
  $("#obsCopy").addEventListener("click", () => {
    const t = $("#obsUrl");
    t.select();
    document.execCommand("copy");
    $("#obsMsg").textContent = "copied! paste it into an OBS Browser Source";
    setTimeout(() => ($("#obsMsg").textContent = ""), 4000);
  });
  $("#searchInput").addEventListener("input", runSearch);
  $("#watchVideo").addEventListener("ended", watchVideoEnded);
  $("#searchInput").addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.target.value = ""; runSearch(); e.target.blur(); }
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#searchWrap")) $("#searchResults").style.display = "none";
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && document.body.classList.contains("theater")) toggleTheater();
  });

  await loadChannels();
  if (!state.channels.length) { render(); return; }

  $("#status").textContent = "fetching video lengths from archive.org & YouTube…";
  await resolveDurations();
  // populate the OBS overlay channel picker now that channels are known
  $("#obsCh").innerHTML =
    `<option value="auto">Auto — whatever's live right now</option>` +
    state.channels.map((c) => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join("");
  setView(state.view);

  const tick = () => {
    const d = new Date();
    $("#clock").textContent = d.toLocaleTimeString([], {
      hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true,
    });
    if (state.view === "grid") moveNowLine();
    tickFollow();
    if (d.getSeconds() % 30 === 0) {
      if (state.view === "list") renderList();
      else if (state.view === "now") renderNow();
    }
  };
  tick();
  setInterval(tick, 1000);
})();
