/* =========================================================
   Archive TV — a tiny static "cable guide" for archive.org
   Data lives in channels.json — edit that file to make channels.
   ========================================================= */

const ARCHIVE_EMBED = (id) => `https://archive.org/embed/${encodeURIComponent(id)}`;
const ARCHIVE_PAGE  = (id) => `https://archive.org/details/${encodeURIComponent(id)}`;
const CACHE_KEY = "ia-duration-cache-v1";
const DAY = 86400;

const state = {
  channels: [],
  durations: {},      // identifier -> {seconds, title}
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
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
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

function itemSeconds(it) {
  if (it.seconds) return +it.seconds;
  if (it.minutes) return +it.minutes * 60;
  const d = state.durations[it.id];
  return d ? d.seconds : 0;
}

function itemTitle(it) {
  return it.title || state.durations[it.id]?.title || prettyId(it.id);
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
    const res = await fetch("channels.json");
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
}

async function resolveDurations() {
  let cache = {};
  try { cache = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}"); } catch {}

  const ids = new Set();
  for (const ch of state.channels)
    for (const it of ch.items)
      if (!itemSeconds(it)) ids.add(it.id);

  await Promise.allSettled([...ids].map(async (id) => {
    if (cache[id]) { state.durations[id] = cache[id]; return; }
    try {
      const r = await fetch(`https://archive.org/metadata/${encodeURIComponent(id)}`);
      const m = await r.json();
      if (!m || !m.files) return;
      const vids = m.files.filter((f) =>
        /MPEG4|h\.264|Ogg Video|QuickTime|Matroska/.test(f.format || ""));
      const len = Math.max(0, ...vids.map((f) => parseLen(f.length)));
      if (len > 0) {
        const entry = { seconds: Math.round(len), title: m.metadata?.title };
        state.durations[id] = entry;
        cache[id] = entry;
        localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
      }
    } catch { /* offline/blocked — set "seconds" in channels.json manually */ }
  }));
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
      .map((it, idx) => ({ it, idx, t: parseHHMM(it.time || ch.start) }))
      .filter((e) => e.t != null)
      .sort((a, b) => a.t - b.t)
      .forEach((e, i, arr) => {
        const start = e.t;
        const nextStart = arr[i + 1] ? arr[i + 1].t : DAY;
        let dur = itemSeconds(e.it);
        if (!dur) dur = Math.min(nextStart - start, 5400); // default guess: 90 min
        const end = Math.min(start + dur, nextStart, DAY);
        out.push({ start, end, item: e.it, chIndex, idx: e.idx });
      });
    return out;
  }

  const startSec = parseHHMM(ch.start || "00:00") ?? 0;
  const n = ch.items.length;
  if (!n) return out;
  let cur = startSec, k = 0, guard = 0;
  while (cur < DAY && guard++ < 400) {
    const it = ch.items[k];
    const dur = itemSeconds(it) || 600; // unknown duration -> 10 min placeholder
    const end = Math.min(cur + dur, DAY);
    out.push({ start: cur, end, item: it, chIndex, idx: k });
    cur += dur;
    k = (k + 1) % n;
  }
  return out;
}

function liveEntry(entries, tz) {
  const n = nowSecs(tz);
  return entries.find((e) => n >= e.start && n < e.end) || null;
}

/* ---------- renderers ---------- */
function render() {
  if (!state.loadError)
    $("#status").innerHTML =
      `times shown in ${esc(state.timezone === "utc" ? "UTC (same for every viewer)" : "your local time")}` +
      ` · click any program to watch · click a channel's name for its day list`;
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
    s.textContent = h === 24 ? "24:00" : fmtClock(h * 3600);
    track.appendChild(s);
  }
  // spacer over the label column
  const pad = document.createElement("div");
  pad.className = "rulerPad";
  ruler.insertBefore(pad, track);

  $("#gridRows").innerHTML = "";
  state.channels.forEach((ch, i) => {
    const entries = scheduleFor(i);
    // grid display: chunk a channel's lineup into ~2h blocks so the day stays readable
    // (the Day List view still shows every program with exact times)
    const CHUNK = 7200;
    const merged = [];
    for (const e of entries) {
      const prev = merged[merged.length - 1];
      const span = e.end - e.start;
      if (prev && !prev.solo && prev.end === e.start && (e.end - prev.start) <= CHUNK) {
        prev.end = e.end;
        prev.count++;
      } else {
        merged.push({ ...e, count: 1, solo: span > CHUNK });
      }
    }

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
    for (const e of merged) {
      const b = document.createElement("div");
      b.className = "block";
      const isLive = n >= e.start && n < e.end;
      if (isLive) b.classList.add("live");
      b.style.left = `${(e.start / DAY) * 100}%`;
      b.style.width = `calc(${((e.end - e.start) / DAY) * 100}% - 2px)`;
      const label = e.count > 1 ? `${itemTitle(e.item)} + ${e.count - 1} more` : itemTitle(e.item);
      b.innerHTML = `<div class="bTitle">${esc(label)}</div>
        <div class="bTime">${fmtClock(e.start)} – ${fmtClock(e.end)}${e.count > 1 ? ` · ${e.count} programs` : ""}</div>`;
      b.onclick = () => watch(e.chIndex, e.idx, isLive);
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
    ? `<div class="dayItem live" onclick="watch(${state.listChannel},${live.idx},true)">
         <span class="t">NOW</span>
         <span>${esc(itemTitle(live.item))}<span class="badge">LIVE</span></span>
         <span class="d">until ${fmtClock(live.end)}</span>
       </div>`
    : "";
  box.innerHTML = entries.length
    ? entries.map((e) => `
      <div class="dayItem" onclick="watch(${state.listChannel},${e.idx})">
        <span class="t">${fmtClock(e.start)} – ${fmtClock(e.end)}</span>
        <span>${esc(itemTitle(e.item))}</span>
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
    return `<div class="nowCard" onclick="watch(${i},${live ? live.idx : (entries[0]?.idx ?? 0)},${live ? "true" : "false"})">
      <div class="name">${esc(ch.name)}${tz === "utc" ? " · UTC" : ""}</div>
      <h3><span class="dot" style="background:${esc(ch.color || "#38bdf8")}"></span>
        ${live ? esc(itemTitle(live.item))
               : "Off air — starts at " + fmtClock(startT)}
        ${live ? '<span class="badge">LIVE</span>' : ""}</h3>
      <div>${live ? `${fmtClock(live.start)} – ${fmtClock(live.end)}` : ""}</div>
      ${upNext ? `<div class="next">Next: ${fmtClock(upNext.start)} · ${esc(itemTitle(upNext.item))}</div>`
               : '<div class="next">Nothing else scheduled today</div>'}
    </div>`;
  }).join("");
}

/* ---------- watch ---------- */
function embedSrc(id) {
  // autoplay + optional broadcast position (?start=seconds)
  return `${ARCHIVE_EMBED(id)}?autoplay=1${watchOffset ? `&start=${watchOffset}` : ""}`;
}
let watchOffset = 0;

window.watch = function (chIndex, idx, syncLive = false) {
  const ch = state.channels[chIndex];
  const it = ch?.items?.[idx];
  if (!it) return;
  const entries = scheduleFor(chIndex);
  const n = nowSecs(effTz(ch));
  // in loop mode the same item occupies several slots a day — pick the on-air one
  const e = (syncLive ? entries.find((x) => x.idx === idx && n >= x.start && n < x.end)
                      : entries.find((x) => x.idx === idx))
         || entries.find((x) => x.idx === idx) || null;
  const isLive = !!(e && n >= e.start && n < e.end);
  watchOffset = syncLive && isLive ? Math.floor(n - e.start) : 0;

  $("#watchFrame").src = embedSrc(it.id);
  state.watchChIndex = chIndex;
  $("#watchTitle").textContent = itemTitle(it);
  $("#watchChannel").textContent = ch.name + (watchOffset > 0 ? ` · joined ${fmtDur(watchOffset)} in (synced to broadcast)` : "");
  $("#watchLink").href = ARCHIVE_PAGE(it.id);
  $("#watch").style.display = "block";
  document.body.style.paddingBottom = "34vw";

  // while a synced channel is open, the player follows the schedule:
  // when this program ends, the next one starts automatically at its live position
  state.follow = syncLive && isLive ? { chIndex, start: e.start } : null;
};

window.closeWatch = function () {
  state.follow = null;
  $("#watch").style.display = "none";
  $("#watchFrame").src = "about:blank";
  document.body.style.paddingBottom = "";
};

function tickFollow() {
  if (!state.follow) return;
  const { chIndex, start } = state.follow;
  const ch = state.channels[chIndex];
  if (!ch) { state.follow = null; return; }
  const live = liveEntry(scheduleFor(chIndex), effTz(ch));
  if (live && live.start !== start)
    watch(chIndex, live.idx, true); // program ended — follow the broadcast
  if (!live) state.follow = null;   // channel sign-off (or day rolled over)
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
    if (live) { state.watchChIndex = c; watch(c, live.idx, true); return; }
  }
  const c = (state.watchChIndex + offset + n) % n;
  const e = scheduleFor(c)[0];
  state.watchChIndex = c;
  if (e) watch(c, e.idx, false);
};

window.zap = function (dir) { watchLive(dir); };

window.toggleTheater = function () {
  document.body.classList.toggle("theater");
  $("#theaterBtn").textContent = document.body.classList.contains("theater")
    ? "◱ Exit theater" : "⤢ Theater";
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
    <div class="searchHit" onclick="runSearchPick(${h.chIndex},${h.e.idx})">
      <span class="t">${fmtClock(h.e.start)} – ${fmtClock(h.e.end)}</span>
      <span class="sTitle">${esc(itemTitle(h.e.item))}</span>
      <span class="sCh">${esc(h.ch.name)}</span>
    </div>`).join("")
    : `<div class="searchHit empty">nothing scheduled under “${esc(q)}” today</div>`;
  box.style.display = "block";
};
window.runSearchPick = function (chIndex, idx) {
  $("#searchResults").style.display = "none";
  $("#searchInput").value = "";
  watch(chIndex, idx);
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
    .map((l) => l.replace(/.*archive\.org\/(?:details|embed)\//, "").replace(/\/.*$/, ""));

  if (!ids.length) { alert("Paste at least one archive.org identifier or URL."); return; }

  const items = ids.map((id, n) => {
    const item = { id };
    if (mode === "fixed") {
      const base = parseHHMM($("#cfgStart").value || "18:00");
      if (base != null) item.time = fmtClock(base + n * 5400); // 90 min apart
    }
    return item;
  });

  $("#cfgOut").value = JSON.stringify(
    { name, description: desc, color, mode, start, items }, null, 2);
  $("#cfgOutWrap").style.display = "block";
  validateIds(ids);
};

/* check each pasted identifier can actually play (exists + is a video item) */
async function validateIds(ids) {
  const box = $("#cfgIssues");
  box.style.display = "block";
  box.innerHTML = "checking identifiers on archive.org…";
  const issues = [];
  await Promise.allSettled(ids.map(async (id) => {
    try {
      const r = await fetch(`https://archive.org/metadata/${encodeURIComponent(id)}`);
      const m = await r.json();
      if (!m || !m.metadata) { issues.push([id, "not found — check the identifier"]); return; }
      const mt = m.metadata.mediatype;
      if (mt && mt !== "movies" && mt !== "dontstepin")
        issues.push([id, `this is a collection (mediatype "${mt}") — open it and use an individual episode's identifier instead`]);
      else if (!(m.files || []).some((f) => /MPEG4|h\.264|Ogg Video|QuickTime|Matroska/.test(f.format || "")))
        issues.push([id, "no video file detected — it may not play (add \"seconds\" manually if you know its length)"]);
    } catch { issues.push([id, "could not be checked (offline?)"]); }
  }));
  box.innerHTML = issues.length
    ? "⚠️ " + issues.map(([id, msg]) => `<b>${esc(id)}</b> — ${esc(msg)}`).join("<br>")
    : "✓ all identifiers are playable videos";
  box.style.background = issues.length ? "rgba(239,68,68,.12)" : "rgba(74,222,128,.1)";
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
  $("#cfgCopy").addEventListener("click", copyChannelJson);
  $("#watchLiveBtn").addEventListener("click", () => watchLive(0));
  $("#zapPrev").addEventListener("click", () => zap(-1));
  $("#zapNext").addEventListener("click", () => zap(1));
  $("#theaterBtn").addEventListener("click", toggleTheater);
  $("#searchInput").addEventListener("input", runSearch);
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

  $("#status").textContent = "fetching video lengths from archive.org…";
  await resolveDurations();
  setView(state.view);

  const tick = () => {
    const d = new Date();
    $("#clock").textContent = d.toLocaleTimeString([], {
      hour: "2-digit", minute: "2-digit", second: "2-digit",
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
