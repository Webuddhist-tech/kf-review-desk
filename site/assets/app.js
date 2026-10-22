/* KF Fact-Check Review Desk — vanilla JS, no build step.
   Data: data/meta.json + data/{diamond,bca,ratna}.json (see dashboard/build/build_data.py).
   State lives in the URL hash (#/<lang>/<item key>); reviewers' marks live in localStorage and, when config.js sets
   submitUrl, are also sent to the team's Google Sheet (see dashboard/google-sheet/Code.gs). */
(() => {
"use strict";
const TEXTS = ["diamond", "bca", "ratna"];
const LS_KEY = "kf-review-v1";
const STATUS_ORDER = ["fixed", "fixed-residual", "unchanged", "reverted"];
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/* ---------------- store (reviewer marks) ---------------- */
let store = { reviewer: "", lang: "en", theme: "", reviews: {}, device: "", dirty: {} };
try { Object.assign(store, JSON.parse(localStorage.getItem(LS_KEY) || "{}")); } catch (e) { /* private mode: keep in memory */ }
if (!store.reviews) store.reviews = {};
if (!store.dirty) store.dirty = {};  // segment key → ts of the change not yet confirmed by the sheet
if (!store.device) store.device = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const persist = () => { try { localStorage.setItem(LS_KEY, JSON.stringify(store)); } catch (e) { /* ignore */ } };

/* ---------------- state ---------------- */
const S = {
  lang: ["en", "zh", "hi"].includes(store.lang) ? store.lang : "en",
  meta: null, data: {}, items: [], byKey: {}, list: [],
  sel: null, draft: 0, diff: false, sa: "deva", ctab: null, cview: null, showFilters: window.innerWidth > 860,
  f: { text: "", ver: new Set(), sev: new Set(), status: "", type: "", rev: "", q: "", sort: "priority" },
  jump: {}
};
const I = () => window.I18N[S.lang];
const tt = k => I()[k] ?? window.I18N.en[k] ?? k;

/* ---------------- helpers ---------------- */
const natKey = id => id.split("-").map(n => (/^\d+$/.test(n) ? n.padStart(6, "0") : n)).join("-");
const fontCls = l => ({ en: "t-en", zh: "t-zh", hi: "t-hi" }[l]);
const langAttr = l => ({ en: "en", zh: "zh-Hant", hi: "hi" }[l]);
const textName = k => I().texts[k] || S.meta.texts[k].title;
function toast(msg) {
  const el = document.createElement("div"); el.className = "toast"; el.textContent = msg; document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}
const rec = k => store.reviews[k];
function setRec(k, patch) {
  store.reviews[k] = Object.assign({}, store.reviews[k] || {}, patch, { ts: Date.now(), by: store.reviewer || "" });
  markDirty([k]);
}

/* ---------------- sync to the team's Google Sheet ---------------- */
const SYNC_URL = ((window.KF_CONFIG || {}).submitUrl || "").trim();
let syncing = false, syncTimer = null, syncState = "";
/* Who sent it: Apps Script cannot see the sender's IP, so ask ipify once per visit (blank if blocked). */
let clientIp = "";
const ipReady = !SYNC_URL ? Promise.resolve("") : Promise.race([
  fetch("https://api.ipify.org?format=json").then(r => r.json()).then(j => (clientIp = String(j.ip || ""))),
  new Promise(res => setTimeout(() => res(""), 4000))
]).catch(() => "");
function browserLabel() {
  const ua = navigator.userAgent;
  const b = (ua.match(/(Edg|OPR|SamsungBrowser|Firefox|FxiOS|CriOS|Chrome|Version)\/(\d+)/) || []);
  const name = { Edg: "Edge", OPR: "Opera", SamsungBrowser: "Samsung", FxiOS: "Firefox", CriOS: "Chrome", Version: "Safari" }[b[1]] || b[1] || "Browser";
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return `${name}${b[2] ? " " + b[2] : ""}${os ? " · " + os : ""}`;
}
/* With sync on, a reviewer must give a name before marking anything. */
const needName = () => SYNC_URL && !store.reviewer.trim();
function askName() {
  $("#overlay").innerHTML = `<div class="modal"><form class="sheet" role="dialog" aria-modal="true" id="name-form"><h2>${esc(tt("name_title"))}</h2><p>${esc(tt("name_why"))}</p>
    <input class="name-in" id="name-in" type="text" maxlength="60" autocomplete="name" placeholder="${esc(tt("reviewer_ph"))}" required>
    <p class="small">${esc(tt("help_note_sync"))}</p><div style="display:flex;gap:8px;justify-content:flex-end"><button type="button" class="btn" data-close>${esc(tt("close"))}</button><button class="btn primary" type="submit">${esc(tt("name_ok"))}</button></div></form></div>`;
  $("#name-in").focus();
}
function markDirty(keys) {
  const now = Date.now();
  keys.forEach(k => { store.dirty[k] = now; });
  persist();
  if (SYNC_URL) { if (syncState !== "wait") setSync("busy"); scheduleSync(2000); }
}
function scheduleSync(ms) { clearTimeout(syncTimer); syncTimer = setTimeout(syncNow, ms); }
function setSync(st) {
  syncState = st; const el = $("#sync"); if (!el) return;
  if (!SYNC_URL) { el.hidden = true; return; }
  el.hidden = false; el.dataset.st = st;
  el.textContent = st === "busy" ? tt("sync_busy") : st === "wait" ? "● " + tt("sync_wait") : "✓ " + tt("sync_ok");
  el.title = tt("sync_title");
}
function syncPayload(keys) {
  const who = store.reviewer.trim();
  return JSON.stringify({ app: "kf-review", v: 1, device: store.device, reviewer: who, ip: clientIp, browser: browserLabel(), rows: exportRows(keys).map(r => Object.assign(r, { reviewer: who || r.reviewer })) });
}
async function syncNow() {
  if (!SYNC_URL || !S.meta) return;
  const sent = Object.assign({}, store.dirty), keys = Object.keys(sent);
  if (!keys.length) { setSync("ok"); return; }
  if (syncing) { scheduleSync(1500); return; }
  syncing = true; setSync("busy");
  await ipReady;
  let ok = false;
  try {
    const r = await fetch(SYNC_URL, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: syncPayload(keys) });
    ok = r.ok && (await r.json()).ok === true;
  } catch (e) { ok = false; }
  syncing = false;
  if (ok) {
    keys.forEach(k => { if (store.dirty[k] === sent[k]) delete store.dirty[k]; });  // keep keys changed while sending
    persist();
    if (Object.keys(store.dirty).length) scheduleSync(500); else setSync("ok");
  } else { setSync("wait"); scheduleSync(30000); }
}
window.addEventListener("online", () => scheduleSync(300));
window.addEventListener("pagehide", () => {
  const keys = Object.keys(store.dirty);
  if (SYNC_URL && S.meta && keys.length && navigator.sendBeacon) navigator.sendBeacon(SYNC_URL, new Blob([syncPayload(keys)], { type: "text/plain;charset=utf-8" }));
});
const isDone = it => !!(rec(it.k) && rec(it.k).dec);

/* ---------------- data ---------------- */
async function load() {
  const names = ["meta", ...TEXTS]; let got = 0, slow = false;
  const show = () => { const el = $("#loading"); if (el) el.innerHTML = `${esc(tt("loading"))} ${got}/${names.length}${slow ? `<br><small>${esc(tt("loading_slow"))}</small>` : ""}`; };
  const slowTimer = setTimeout(() => { slow = true; show(); }, 5000);
  show();
  try {
    const [meta, ...parts] = await Promise.all(names.map(n => fetch(`data/${n}.json`).then(r => { if (!r.ok) throw new Error(n); return r.json(); }).then(j => { got++; show(); return j; })));
    clearTimeout(slowTimer);
    S.meta = meta;
    TEXTS.forEach((t, i) => { S.data[t] = parts[i]; });
  } catch (e) {
    $("#stage").innerHTML = `<div class="loading">${esc(tt("load_fail"))}</div>`;
    throw e;
  }
  S.items = [];
  TEXTS.forEach((text, ti) => {
    const d = S.data[text];
    d.items.forEach(it => {
      const [lang, ver] = it.track.split("-");
      let ci = it.atts.map(a => a.cur).lastIndexOf(true);
      if (ci < 0) ci = it.atts.length - 1;
      const o = Object.assign({}, it, { text, ti, lang, ver, d, s: d.src[it.id], ci, curText: it.atts[ci].t, nat: natKey(it.id) });
      o.types = [...new Set(it.atts.flatMap(a => a.i.map(x => x.ty)))];
      o.still = it.atts[ci].i.length > 0;
      S.items.push(o);
    });
  });
  S.byKey = Object.fromEntries(S.items.map(i => [i.k, i]));
}

/* ---------------- routing ---------------- */
function parseHash() {
  const m = location.hash.match(/^#\/(en|zh|hi)(?:\/(.+))?$/);
  return m ? { lang: m[1], key: m[2] ? decodeURIComponent(m[2]) : null } : null;
}
function go(lang, key, replace) {
  const h = `#/${lang}${key ? "/" + encodeURIComponent(key) : ""}`;
  if (replace) { history.replaceState(null, "", h); route(); } else if (location.hash !== h) location.hash = h; else route();
}
function route() {
  const r = parseHash() || { lang: S.lang, key: null };
  if (r.lang !== S.lang) { S.lang = r.lang; store.lang = r.lang; persist(); S.f = Object.assign(S.f, { text: "", ver: new Set(), sev: new Set(), status: "", type: "", rev: "", q: "" }); }
  document.documentElement.lang = langAttr(S.lang);
  const it = r.key && S.byKey[r.key] && S.byKey[r.key].lang === S.lang ? S.byKey[r.key] : null;
  const changed = it !== S.sel, sameLang = S._renderedLang === S.lang;
  if (changed) { S.sel = it; S.draft = it ? it.ci : 0; S.diff = false; S.ctab = null; S.jump = {}; }
  if (changed && sameLang && it) {   // fast path: only the selection moved, so skip rebuilding filters, summary and list
    document.querySelectorAll('.item[aria-current="true"]').forEach(x => x.setAttribute("aria-current", "false"));
    const row = [...document.querySelectorAll(".item")].find(x => x.dataset.k === it.k);
    if (row) { row.setAttribute("aria-current", "true"); row.scrollIntoView({ block: "nearest" }); } else renderList();
    renderDetail(); $("#layout").dataset.view = "detail"; return;
  }
  renderTop(); applyFilters();
  if (!S.sel && S.list.length && window.innerWidth > 860) { go(S.lang, S.list[0].k, true); return; }
  S._renderedLang = S.lang;
  renderFilters(); renderSummary(); renderList(); renderDetail();
  $("#layout").dataset.view = S.sel ? "detail" : "list";
}

/* ---------------- header / chrome ---------------- */
function renderTop() {
  $("#t-app").textContent = tt("app"); $("#t-sub").textContent = tt("sub");
  document.querySelectorAll("#langs button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.lang === S.lang)));
  $("#who").placeholder = tt("reviewer_ph"); $("#who").value = store.reviewer || ""; $("#who").setAttribute("aria-label", tt("reviewer"));
  $("#b-export").innerHTML = `⬇<span class="hide-s"> ${esc(tt("export"))}</span> ▾`; $("#b-help").innerHTML = `?<span class="hide-s"> ${esc(tt("help"))}</span>`;
  $("#b-export").title = tt("export"); $("#b-help").title = tt("help");
  $("#b-theme").setAttribute("aria-label", tt("theme"));
  document.title = tt("app");
  setSync(syncState);
}
function applyTheme() {
  const r = document.documentElement;
  if (store.theme) r.setAttribute("data-theme", store.theme); else r.removeAttribute("data-theme");
}

/* ---------------- filtering ---------------- */
function applyFilters() {
  const f = S.f, q = f.q.trim().toLowerCase();
  let L = S.items.filter(it => it.lang === S.lang);
  if (f.text) L = L.filter(i => i.text === f.text);
  if (f.ver.size) L = L.filter(i => f.ver.has(i.ver));
  if (f.sev.size) L = L.filter(i => f.sev.has(i.worst));
  if (f.status) L = L.filter(i => i.status === f.status);
  if (f.type) L = L.filter(i => i.types.includes(f.type));
  if (f.rev === "todo") L = L.filter(i => !isDone(i));
  if (f.rev === "done") L = L.filter(isDone);
  if (q) L = L.filter(i => (i.id + " " + i.curText + " " + i.atts.map(a => a.i.map(x => x.ev).join(" ")).join(" ")).toLowerCase().includes(q));
  const byOrder = (a, b) => a.ti - b.ti || cmp(a.nat, b.nat) || cmp(a.track, b.track);
  if (f.sort === "order") L.sort(byOrder);
  else if (f.sort === "todo") L.sort((a, b) => isDone(a) - isDone(b) || (a.worst === "major" ? 0 : 1) - (b.worst === "major" ? 0 : 1) || byOrder(a, b));
  else L.sort((a, b) => (a.worst === "major" ? 0 : 1) - (b.worst === "major" ? 0 : 1) || (a.still ? 0 : 1) - (b.still ? 0 : 1) || byOrder(a, b));
  S.list = L;
}
function renderFilters() {
  const f = S.f, I_ = I();
  const chip = (grp, val, label, cls = "") => `<button class="chip ${cls}" data-f="${grp}" data-v="${val}" aria-pressed="${grp === "ver" || grp === "sev" ? f[grp].has(val) : f[grp] === val}">${esc(label)}</button>`;
  const langItems = S.items.filter(i => i.lang === S.lang);
  const types = [...new Set(langItems.flatMap(i => i.types))].sort();
  const opt = (v, l, cur) => `<option value="${v}" ${cur === v ? "selected" : ""}>${esc(l)}</option>`;
  const sel = (name, label, inner) => `<label class="fl"><span class="k">${esc(label)}</span><select data-sel="${name}">${inner}</select></label>`;
  $("#filters").innerHTML = `
    <div class="fgrid">
      ${sel("text", tt("text"), opt("", tt("all_texts"), f.text) + TEXTS.map(t => opt(t, textName(t), f.text)).join(""))}
      ${sel("status", tt("status"), opt("", tt("all"), f.status) + STATUS_ORDER.map(s => opt(s, tt("s_" + s.replace("-", "_")), f.status)).join(""))}
      ${sel("type", tt("type"), opt("", tt("all"), f.type) + types.map(t => opt(t, I_.ty[t] || t, f.type)).join(""))}
      ${sel("sort", tt("sort"), opt("priority", tt("sort_priority"), f.sort) + opt("todo", tt("sort_todo"), f.sort) + opt("order", tt("sort_order"), f.sort))}
    </div>
    <div class="frow">${chip("ver", "academic", tt("academic"))}${chip("ver", "children", tt("children"))}<span class="vr"></span>${chip("sev", "major", tt("major"), "major")}${chip("sev", "minor", tt("minor"), "minor")}<span class="vr"></span>${chip("rev", "todo", tt("todo"))}${chip("rev", "done", tt("done"))}</div>
    <div class="frow"><input type="search" data-in="q" placeholder="${esc(tt("search"))}" value="${esc(f.q)}"></div>`;
  $("#filters").style.display = S.showFilters ? "" : "none";
}
function renderSummary() {
  const all = S.items.filter(i => i.lang === S.lang);
  const major = all.filter(i => i.worst === "major").length, done = all.filter(isDone).length;
  $("#summary").innerHTML = `
    <div class="sum-row"><span class="sum-big">${all.length}</span><span class="sum-lab">${esc(tt("segments"))} ${esc(tt("flagged"))}</span>
      <span class="sum-lab"><b style="color:var(--major)">${major}</b> ${esc(tt("n_major"))}</span>
      <span class="sum-lab"><b style="color:var(--ok)">${done}</b> ${esc(tt("reviewed"))}</span></div>
    <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="${all.length}" aria-valuenow="${done}"><i style="width:${all.length ? (100 * done / all.length).toFixed(1) : 0}%"></i></div>`;
}
const pillStatus = s => ({ fixed: "ok", "fixed-residual": "info", unchanged: "plain", reverted: "plain" }[s] || "plain");
function renderList() {
  $("#count").innerHTML = `<span>${S.list.length} / ${S.items.filter(i => i.lang === S.lang).length}</span><button class="chip" data-act="filters" style="padding:1px 10px">${S.showFilters ? "▴" : "▾"} ${esc(tt("filters"))}</button>`;
  if (!S.list.length) { $("#list").innerHTML = `<div class="empty">${esc(tt("empty"))}</div>`; return; }
  const I_ = I();
  $("#list").innerHTML = S.list.map(it => {
    const r = rec(it.k), dec = r && r.dec;
    const tick = dec ? `<span class="tick ${dec}">${esc({ ok: "✓", fix: "✎", unsure: "?" }[dec])}</span>` : "";
    const types = it.types.slice(0, 2).map(t => `<span class="pill plain">${esc(I_.ty[t] || t)}</span>`).join("");
    return `<button class="item ${it.worst === "major" ? "major" : "minor-only"}" role="listitem" data-k="${esc(it.k)}" aria-current="${S.sel && S.sel.k === it.k}">
      <div class="i1"><b>${esc(textName(it.text))} · ${esc(it.id)}</b><span class="pill plain">${esc(tt(it.ver))}</span>${it.worst === "major" ? `<span class="pill major">${esc(tt("major"))}</span>` : ""}${types}${tick}</div>
      <div class="i2 ${fontCls(it.lang)}" lang="${langAttr(it.lang)}">${esc(it.curText)}</div></button>`;
  }).join("");
  const cur = $('.item[aria-current="true"]'); if (cur) cur.scrollIntoView({ block: "nearest" });
}

/* ---------------- highlighting ---------------- */
function tibQueries(evs) {
  const set = new Set();
  for (const ev of evs) for (const m of ev.matchAll(/[ༀ-࿿]+/g)) {
    for (let part of m[0].replace(/༌/g, "་").split(/[།-༔]+/)) {
      part = part.replace(/^་+|་+$/g, "");
      if (part.split("་").filter(Boolean).length >= 2 && part.length >= 5) set.add(part);
    }
  }
  return [...set].sort((a, b) => b.length - a.length);
}
function marks(text, queries) {
  const norm = text.replace(/༌/g, "་"), rs = [];
  queries.forEach((q, qi) => { let p = 0, i; while ((i = norm.indexOf(q, p)) !== -1) { rs.push([i, i + q.length, qi]); p = i + q.length; } });
  rs.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  let out = "", pos = 0, n = 0;
  for (const [s, e, qi] of rs) {
    if (s < pos) continue;
    out += esc(text.slice(pos, s)) + `<mark class="q" data-q="${qi}">${esc(text.slice(s, e))}</mark>`; pos = e; n++;
  }
  return { html: out + esc(text.slice(pos)), n };
}
const fold = s => [...s].map(c => c.normalize("NFD")[0].toLowerCase()).join("");
function saQueries(evs) {
  const set = new Set();
  for (const ev of evs) for (const m of ev.matchAll(/[A-Za-zĀāĪīŪūṚṛṝḶḷṃṁḥṅñṭḍṇśṣ]{5,}/g)) set.add(fold(m[0]));
  return [...set];
}
function saMarks(iast, queries) {
  const f = fold(iast), rs = [];
  queries.forEach(q => { let p = 0, i; while ((i = f.indexOf(q, p)) !== -1) { rs.push([i, i + q.length]); p = i + q.length; } });
  rs.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  let out = "", pos = 0;
  for (const [s, e] of rs) { if (s < pos) continue; out += esc(iast.slice(pos, s)) + `<mark class="q">${esc(iast.slice(s, e))}</mark>`; pos = e; }
  return out + esc(iast.slice(pos));
}
function findSpan(text, sp) {
  let i = text.indexOf(sp); if (i >= 0) return [i, i + sp.length];
  const t = sp.trim().replace(/^[“"'‘]|[”"'’]$/g, "");
  i = text.indexOf(t); if (i >= 0 && t) return [i, i + t.length];
  const core = t.replace(/[…\.]+$/, ""); i = core.length > 3 ? text.indexOf(core) : -1;
  return i >= 0 ? [i, i + core.length] : null;
}
function markTranslation(text, issues) {
  const rs = [];
  issues.forEach((x, fi) => { const r = findSpan(text, x.sp); if (r) rs.push([r[0], r[1], fi, x.sv]); });
  rs.sort((a, b) => a[0] - b[0]);
  let out = "", pos = 0;
  for (const [s, e, fi, sv] of rs) {
    if (s < pos) continue;
    out += esc(text.slice(pos, s)) + `<mark class="f ${sv === "major" || sv === "critical" ? "major" : ""}" data-fi="${fi}">${esc(text.slice(s, e))}</mark>`; pos = e;
  }
  return out + esc(text.slice(pos));
}
function diffHtml(a, b, lang) {
  const tok = s => (lang === "zh" ? Array.from(s) : s.split(/(\s+)/).filter(x => x !== ""));
  const A = tok(a), B = tok(b), n = A.length, m = B.length;
  if (n * m > 4e6) return esc(b);
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  let i = 0, j = 0, out = "", buf = { d: "", n: "" };
  const flush = () => { if (buf.d) out += `<del class="d">${esc(buf.d)}</del>`; if (buf.n) out += `<ins class="d">${esc(buf.n)}</ins>`; buf = { d: "", n: "" }; };
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) { flush(); out += esc(A[i]); i++; j++; }
    else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) { buf.n += B[j++]; }
    else { buf.d += A[i++]; }
  }
  flush(); return out;
}
/* evidence text: Tibetan runs become yellow chips, commentary ids become jump buttons */
function richEvidence(ev, comm) {
  const re = /(bo-[a-z]+(?:-[a-z]+)*)(?: (\d+(?:-\d+)*))?|([ༀ-࿿]+(?:[  ]?[ༀ-࿿]+)*)/g;
  const queries = S._queries || [];
  let out = "", pos = 0, m;
  while ((m = re.exec(ev))) {
    out += esc(ev.slice(pos, m.index)); pos = m.index + m[0].length;
    if (m[1]) {
      const meta = S.meta.comm[m[1]];
      out += meta ? `<button class="cite" data-cite="${m[1]}">${esc(meta.label)}${m[2] ? " " + esc(m[2]) : ""}</button>` : esc(m[0]);
    } else {
      const norm = m[3].replace(/༌/g, "་"); let qi = -1;
      queries.some((q, i) => { if (norm.includes(q)) { qi = i; return true; } return false; });
      out += `<span class="bo" lang="bo" ${qi >= 0 ? `data-q="${qi}" title="↘"` : ""}>${esc(m[3])}</span>`;
    }
  }
  return out + esc(ev.slice(pos));
}

/* ---------------- detail ---------------- */
function renderDetail() {
  const it = S.sel, stage = $("#stage");
  if (!it) { stage.innerHTML = `<div class="empty">${S.list.length ? "" : esc(tt("empty"))}</div>`; return; }
  const att = it.atts[S.draft] || it.atts[it.ci], I_ = I();
  S._evs = att.i.map(x => x.ev);
  S._queries = tibQueries(S._evs);
  S._saq = saQueries(S._evs);
  const idx = S.list.findIndex(x => x.k === it.k);
  const bannerKey = "d_" + it.status.replace("-", "_");
  stage.innerHTML = `<div class="detail">
    <div class="dhead">
      <button class="btn back" data-act="back">← ${esc(tt("back"))}</button>
      <h2>${esc(textName(it.text))} · ${esc(tt("segment"))} ${esc(it.id)}</h2>
      <span class="sub">${esc(I_.lang_name)} · ${esc(tt(it.ver))}</span>
      <div class="dnav">
        <button class="btn" data-act="prev" ${idx <= 0 ? "disabled" : ""} title="k">← ${esc(tt("prev"))}</button>
        <button class="btn" data-act="next" ${idx < 0 || idx >= S.list.length - 1 ? "disabled" : ""} title="j">${esc(tt("next"))} →</button>
        <button class="btn primary" data-act="nexttodo">${esc(tt("next_todo"))} ⇥</button>
      </div>
    </div>
    <div class="banner ${it.worst === "major" ? "major" : ""}"><span class="b-ico">${it.worst === "major" ? "⚠" : "ℹ"}</span><div>${it.worst === "major" ? `<strong>${esc(tt("major_banner"))}</strong>` : ""}${esc(tt(bannerKey))}</div></div>
    <div class="cols">
      <div class="col-l">
        <section class="card" id="d-src">${srcHtml(it)}</section>
        <section class="card" id="d-trans">${transHtml(it)}</section>
        <section class="card" id="d-find">${findHtml(it)}</section>
        <section class="card review" id="d-rev">${reviewHtml(it)}</section>
        ${processHtml(it)}
      </div>
      <div class="col-r">
        <section class="card" id="d-comm">${commHtml(it)}</section>
        ${termsHtml(it)}
      </div>
    </div></div>`;
  afterComm();
  stage.scrollTop = 0;
}
function srcHtml(it) {
  const s = it.s, tib = marks(s.bo, S._queries);
  const sa = s.sa ? (S.sa === "iast" ? `<div class="sa iast" lang="sa-Latn">${saMarks(s.iast, S._saq)}</div>` : `<div class="sa" lang="sa">${esc(s.sa)}</div>`) : "";
  return `<h3>${esc(tt("source"))}</h3>
    <div class="src-body"><div class="lbl" style="margin-top:0">${esc(tt("tibetan"))}</div><span class="bo" lang="bo">${tib.html}</span>
    ${s.sa ? `<div class="lbl" style="display:flex;align-items:center;gap:10px">${esc(tt("sanskrit"))}
      <span class="seg" style="margin-left:auto"><button data-sa="deva" aria-pressed="${S.sa === "deva"}">${esc(tt("deva"))}</button><button data-sa="iast" aria-pressed="${S.sa === "iast"}">${esc(tt("iast"))}</button></span></div>${sa}` : ""}</div>`;
}
function transHtml(it) {
  const I_ = I(), att = it.atts[S.draft];
  const tabs = it.atts.map((a, i) => {
    const n = a.i.length;
    return `<button class="tab" role="tab" data-draft="${i}" aria-selected="${i === S.draft}">${esc(tt("draft"))} ${i + 1}${i === it.ci ? ` · ${esc(tt("current"))}` : ""} <small>${n ? n + " " + esc(tt(n === 1 ? "note_1" : "notes")) : "✓"}</small></button>`;
  }).join("");
  const body = S.diff && S.draft > 0 ? diffHtml(it.atts[S.draft - 1].t, att.t, it.lang) : markTranslation(att.t, att.i);
  const diffBtn = S.draft > 0 ? `<button class="btn sm" data-act="diff">${esc(S.diff ? tt("changes_off") : tt("changes"))} <span class="small">(${esc(tt("from_prev"))})</span></button>` : "";
  return `<h3>${esc(I_.lang_name)} · ${esc(tt(it.ver))}</h3>
    <div class="drafts" role="tablist">${tabs}<span class="sp"></span>${diffBtn}</div>
    <div class="cb"><div class="ttext ${fontCls(it.lang)}" lang="${langAttr(it.lang)}" id="ttext">${body}</div>
    <div style="margin-top:10px"><span class="pill ${att.v === "pass" ? "ok" : "major"}">${esc(tt(att.v === "pass" ? "passed" : "failed"))}</span></div></div>`;
}
function findHtml(it) {
  const att = it.atts[S.draft], I_ = I(), r = rec(it.k) || {};
  if (!att.i.length) return `<h3>${esc(tt("findings"))}</h3><div class="cb small">${esc(tt("no_findings"))}</div>`;
  return `<h3>${esc(tt("findings"))} · ${att.i.length}</h3>` + att.i.map((x, fi) => {
    const major = x.sv === "major" || x.sv === "critical", cur = (r.fnd || {})[S.draft + "." + fi];
    const jb = (v, label) => `<button class="jb ${v}" data-j="${v}" data-fi="${fi}" aria-pressed="${cur === v}">${esc(label)}</button>`;
    return `<div class="finding" data-fi="${fi}">
      <div class="fh"><span class="n">${fi + 1}</span><span class="pill ${major ? "major" : "minor"}">${esc(tt(major ? "major" : "minor"))}</span><span class="pill plain">${esc(I_.ty[x.ty] || x.ty)}</span></div>
      <div class="lbl" style="margin-top:0">${esc(tt("flagged_text"))}</div>
      <div class="quote ${major ? "major" : ""} ${fontCls(it.lang)}" lang="${langAttr(it.lang)}" style="white-space:pre-wrap">${esc(x.sp)}</div>
      <div class="lbl">${esc(tt("evidence"))}</div><div class="evid">${richEvidence(x.ev)}</div>
      ${x.fx ? `<div class="lbl">${esc(tt("suggested"))}</div><div class="fixbox"><div class="${fontCls(it.lang)}" lang="${langAttr(it.lang)}" style="white-space:pre-wrap">${esc(x.fx)}</div><button class="btn sm" data-apply="${fi}">${esc(tt("use_fix"))}</button></div>` : ""}
      <div class="judge"><span class="q">${esc(tt("agree"))}</span>${jb("real", tt("j_real"))}${jb("not", tt("j_not"))}${jb("unsure", tt("j_unsure"))}</div></div>`;
  }).join("");
}
function reviewHtml(it) {
  const r = rec(it.k) || {}, dec = (v, cls, l) => `<button class="dec ${cls}" data-dec="${v}" aria-pressed="${r.dec === v}">${esc(l)}</button>`;
  return `<h3>${esc(tt("review"))} ${r.dec ? `<span class="saved" style="margin-left:auto">✓ ${esc(tt("saved"))}</span>` : ""}</h3>
    <div class="decs">${dec("ok", "ok", tt("dec_ok"))}${dec("fix", "fix", tt("dec_fix"))}${dec("unsure", "unsure", tt("dec_unsure"))}</div>
    <div class="fld" ${r.dec === "fix" || r.corr ? "" : "hidden"} id="corr-wrap"><div class="lbl" style="display:flex;justify-content:space-between;align-items:center">${esc(tt("corrected"))}<button class="btn sm" data-act="fromcur">${esc(tt("from_current"))}</button></div>
      <textarea class="corr ${fontCls(it.lang)}" lang="${langAttr(it.lang)}" id="corr">${esc(r.corr || "")}</textarea></div>
    <div class="fld"><div class="lbl">${esc(tt("note"))}</div><textarea id="note" lang="${langAttr(S.lang)}">${esc(r.note || "")}</textarea></div>
    <div class="foot"><span class="small">${esc(store.reviewer ? store.reviewer : "")}</span><button class="btn primary" data-act="nexttodo">${esc(tt("next_todo"))} ⇥</button></div>`;
}
function processHtml(it) {
  const j = it.judge, jt = j ? tt({ win: "judge_win", tie: "judge_tie", loss: "judge_loss" }[j.result] || "judge_tie") : "";
  const runs = it.atts.map((a, i) => `${tt("draft")} ${i + 1}: ${a.v === "pass" ? "✓" : "✗"} ${a.i.length ? a.i.map(x => x.sv).join(", ") : "—"}`).join(" · ");
  return `<details class="card"><summary>${esc(tt("process"))}</summary><div class="cb small">${esc(runs)}${j ? `<p style="margin:8px 0 0">${esc(jt)}${j.reason ? `<br><span lang="en">${esc(j.reason)}</span>` : ""}</p>` : ""}</div></details>`;
}
function termsHtml(it) {
  if (!it.terms.length) return "";
  return `<details class="card"><summary>${esc(tt("terms"))} · ${it.terms.length}</summary><div class="terms">${it.terms.map(([bo, use]) => `<span class="term"><span class="bo" lang="bo">${esc(bo)}</span> → ${esc(use)}</span>`).join("")}</div></details>`;
}

/* commentary column */
function commStats(it) {
  const cited = new Set((S._evs.join(" ").match(/bo-[a-z]+(?:-[a-z]+)*/g) || []));
  const out = {};
  Object.keys(it.s.com).forEach(cid => {
    let hits = 0;
    it.s.com[cid].forEach(pi => { hits += marks(it.d.passages[pi][0], S._queries).n; });
    out[cid] = { hits, cited: cited.has(cid) };
  });
  return out;
}
function commHtml(it) {
  const cids = Object.keys(it.s.com), hasEn = !!S.meta.texts[it.text].english_commentary;
  if (!cids.length) return `<h3>${esc(tt("commentaries"))}</h3><div class="cb small">${esc(tt("no_comm"))}</div>`;
  const st = commStats(it);
  if (!S.ctab || !st[S.ctab]) S.ctab = cids.slice().sort((a, b) => (st[b].cited - st[a].cited) || (st[b].hits - st[a].hits))[0];
  if (!S.cview) S.cview = hasEn ? "both" : "bo";
  const view = hasEn ? S.cview : "bo";
  const tabs = cids.map(cid => `<button class="ctab" role="tab" data-ctab="${cid}" aria-selected="${cid === S.ctab}" title="${esc(S.meta.comm[cid].name)}${st[cid].cited ? " · " + esc(tt("cited")) : ""}">${st[cid].cited ? '<span class="star">★</span>' : ""}${esc(S.meta.comm[cid].label)}${st[cid].hits ? `<span class="hit">${st[cid].hits}</span>` : ""}</button>`).join("");
  const ps = it.s.com[S.ctab].map((pi, n, arr) => {
    const [bo, en] = it.d.passages[pi], mk = marks(bo, S._queries);
    const bo_ = `<div class="pcol bo" lang="bo"><span class="tag">${esc(tt("tibetan"))}</span>${mk.html}</div>`;
    const en_ = en ? `<div class="pcol en" lang="en"><span class="tag">${esc(tt("v_en"))} · MT</span>${esc(en)}</div>` : "";
    const none = !en && hasEn && view !== "bo" ? `<div class="pcol en small" lang="en">${esc(tt("no_en"))}</div>` : "";
    const body = view === "bo" ? bo_ : view === "en" ? (en_ || none || bo_) : bo_ + (en_ || none);
    return `<div class="passage"><div class="pmeta"><span>${esc(S.meta.comm[S.ctab].name)}${arr.length > 1 ? ` · ${esc(tt("passage"))} ${n + 1}/${arr.length}` : ""}</span><span class="sp"></span><button class="btn sm" data-expand>${esc(tt("expand"))}</button></div><div class="pbody">${body}</div></div>`;
  }).join("");
  const seg = `<span class="seg"><button data-cview="bo" aria-pressed="${view === "bo"}">${esc(tt("v_bo"))}</button><button data-cview="en" aria-pressed="${view === "en"}" ${hasEn ? "" : "disabled"}>${esc(tt("v_en"))}</button><button data-cview="both" aria-pressed="${view === "both"}" ${hasEn ? "" : "disabled"}>${esc(tt("v_both"))}</button></span>`;
  return `<div class="ch">${esc(tt("commentaries"))} ${seg}</div><div class="ctabs" role="tablist">${tabs}</div>${ps}
    <div class="note-mt">${hasEn ? esc(tt("mt")) : esc(tt("no_en"))}</div>`;
}
function afterComm() {
  const root = $("#d-comm"); if (!root) return;
  root.querySelectorAll(".pcol").forEach(col => { const m = col.querySelector("mark.q"); if (m) col.scrollTop = Math.max(0, m.offsetTop - col.offsetTop - 30); });
}
function rerender(...ids) {
  const it = S.sel; if (!it) return;
  const att = it.atts[S.draft]; S._evs = att.i.map(x => x.ev); S._queries = tibQueries(S._evs); S._saq = saQueries(S._evs);
  const fn = { "d-src": srcHtml, "d-trans": transHtml, "d-find": findHtml, "d-rev": reviewHtml, "d-comm": commHtml };
  ids.forEach(id => { const el = $("#" + id); if (el) el.innerHTML = fn[id](it); });
  if (ids.includes("d-comm")) afterComm();
}

/* jump from evidence (Tibetan chip or commentary name) to the matching text on the right */
function jumpQuery(qi) {
  const it = S.sel, q = S._queries[qi]; if (q == null) return;
  const scope = [$("#d-src"), $("#d-comm")];
  let hit = [...scope[0].querySelectorAll(`mark.q[data-q="${qi}"]`), ...scope[1].querySelectorAll(`mark.q[data-q="${qi}"]`)];
  if (!hit.length) {
    const other = Object.keys(it.s.com).find(cid => cid !== S.ctab && it.s.com[cid].some(pi => it.d.passages[pi][0].replace(/༌/g, "་").includes(q)));
    if (other) { S.ctab = other; rerender("d-comm"); hit = [...$("#d-comm").querySelectorAll(`mark.q[data-q="${qi}"]`)]; }
  }
  if (!hit.length) { toast("—"); return; }
  const n = (S.jump[qi] = ((S.jump[qi] ?? -1) + 1) % hit.length), el = hit[n];
  document.querySelectorAll("mark.q.on").forEach(m => m.classList.remove("on")); el.classList.add("on");
  el.scrollIntoView({ block: "center", behavior: "smooth" });
}

/* ---------------- actions ---------------- */
function step(d) { const i = S.list.findIndex(x => x.k === S.sel.k); const n = S.list[i + d]; if (n) go(S.lang, n.k); }
function nextTodo() {
  const i = S.list.findIndex(x => x.k === S.sel.k);
  const n = S.list.slice(i + 1).concat(S.list.slice(0, Math.max(i, 0))).find(x => !isDone(x) && x.k !== S.sel.k);
  if (n) go(S.lang, n.k); else toast("✓");
}
/* The checker's "fix" is a corrected phrase that often runs a little past the flagged span, so widen the replaced region
   over any neighbouring words the fix repeats (e.g. fix "…की कोई कुशलता" vs text "छन्द-रचना| की कोई कुशलता"). */
function spliceFix(base, sp, fx) {
  const rg = findSpan(base, sp); if (!rg) return null;
  let [s0, e0] = rg;
  const min = /[\u3400-\u9fff]/.test(fx) ? 2 : 3;
  for (let k = Math.min(fx.length, base.length - e0); k >= min; k--) if (fx.endsWith(base.slice(e0, e0 + k))) { e0 += k; break; }
  for (let k = Math.min(fx.length, s0); k >= min; k--) if (fx.startsWith(base.slice(s0 - k, s0))) { s0 -= k; break; }
  return base.slice(0, s0) + fx + base.slice(e0);
}
function applyFix(fi) {
  const it = S.sel, x = it.atts[S.draft].i[fi], r = rec(it.k) || {};
  const out = x.fx && spliceFix(r.corr || it.curText, x.sp, x.fx);
  if (!out) { toast(tt("flagged_text") + " ✗"); return; }
  setRec(it.k, { corr: out, dec: "fix" });
  rerender("d-rev"); renderList(); renderSummary(); toast("✓ " + tt("corrected"));
}
function dl(name, mime, text) {
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type: mime })); a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
function exportRows(keys) {
  const rows = [], base = location.origin + location.pathname;
  for (const k of keys || Object.keys(store.reviews)) {
    const r = store.reviews[k] || {}, it = S.byKey[k]; if (!it) continue;
    const fnd = Object.entries(r.fnd || {}).map(([key, v]) => { const [a, i] = key.split(".").map(Number), x = (it.atts[a] || { i: [] }).i[i]; return x ? `draft${a + 1}#${i + 1} ${x.ty}/${x.sv} [${x.sp.replace(/\s+/g, " ").slice(0, 60)}]: ${v}` : ""; }).filter(Boolean).join("; ");
    rows.push({ reviewer: r.by || store.reviewer || "", time: r.ts ? new Date(r.ts).toISOString() : "", text: it.text, language: it.lang, version: it.ver, segment: it.id, key: k,
      worst_severity: it.worst, status: it.status, decision: r.dec || "", checker_findings_verdicts: fnd, corrected_translation: r.corr || "", note: r.note || "", current_translation: it.curText,
      link: `${base}#/${it.lang}/${encodeURIComponent(k)}` });
  }
  return rows;
}
function exportCsv() {
  const rows = exportRows(); if (!rows.length) { toast("—"); return; }
  const cols = Object.keys(rows[0]), q = v => `"${String(v).replace(/"/g, '""')}"`;
  dl(`kf-review-${S.lang}-${new Date().toISOString().slice(0, 10)}.csv`, "text/csv;charset=utf-8", "﻿" + [cols.join(","), ...rows.map(r => cols.map(c => q(r[c])).join(","))].join("\r\n"));
}
function exportJson() {
  dl(`kf-review-backup-${new Date().toISOString().slice(0, 10)}.json`, "application/json", JSON.stringify({ app: "kf-review", v: 1, reviewer: store.reviewer, reviews: store.reviews }, null, 1));
}
function importJson() {
  const inp = document.createElement("input"); inp.type = "file"; inp.accept = "application/json,.json";
  inp.onchange = async () => {
    try {
      const j = JSON.parse(await inp.files[0].text()); let n = 0;
      const got = [];
      for (const [k, r] of Object.entries(j.reviews || {})) if (!store.reviews[k] || (r.ts || 0) > (store.reviews[k].ts || 0)) { store.reviews[k] = r; got.push(k); n++; }
      markDirty(got); route(); toast(`✓ ${n}`);
    } catch (e) { toast("✗ JSON"); }
  };
  inp.click();
}
function openMenu() {
  closeMenu();
  const m = document.createElement("div"); m.className = "menu"; m.id = "menu";
  m.innerHTML = `<button data-m="csv">⬇ ${esc(tt("exp_csv"))}</button><button data-m="json">⬇ ${esc(tt("exp_json"))}</button><hr><button data-m="imp">⬆ ${esc(tt("imp"))}</button>`;
  $(".top").appendChild(m);
}
const closeMenu = () => { const m = $("#menu"); if (m) m.remove(); };
function openHelp() {
  const I_ = I();
  $("#overlay").innerHTML = `<div class="modal" data-close><div class="sheet" role="dialog" aria-modal="true"><h2>${esc(I_.help_title)}</h2><ol>${(SYNC_URL ? [...I_.help_steps.slice(0, -1), I_.help_last_sync] : I_.help_steps).map(s => `<li>${esc(s)}</li>`).join("")}</ol><p class="small">${esc(SYNC_URL ? I_.help_note_sync : I_.help_note)}</p><button class="btn primary" data-close>${esc(I_.close)}</button></div></div>`;
}

/* ---------------- events ---------------- */
document.addEventListener("click", e => {
  const t = e.target, c = sel => t.closest(sel);
  let el;
  if (!c(".menu") && !c("#b-export")) closeMenu();
  if ((el = c("#langs button"))) { go(el.dataset.lang, null); return; }
  if ((el = c(".item"))) { go(S.lang, el.dataset.k); return; }
  if ((el = c("[data-f]"))) {
    const g = el.dataset.f, v = el.dataset.v;
    if (g === "ver" || g === "sev") { S.f[g].has(v) ? S.f[g].delete(v) : S.f[g].add(v); } else S.f[g] = S.f[g] === v ? "" : v;
    applyFilters(); renderFilters(); renderList(); return;
  }
  if (needName() && c("[data-j], [data-dec], [data-apply], [data-act=fromcur]")) { askName(); return; }
  if ((el = c("[data-act]"))) {
    const a = el.dataset.act;
    if (a === "back") go(S.lang, null);
    else if (a === "prev") step(-1); else if (a === "next") step(1); else if (a === "nexttodo") nextTodo();
    else if (a === "filters") { S.showFilters = !S.showFilters; renderFilters(); renderList(); }
    else if (a === "diff") { S.diff = !S.diff; rerender("d-trans"); }
    else if (a === "fromcur") { const ta = $("#corr"); if (ta && !ta.value) { ta.value = S.sel.curText; setRec(S.sel.k, { corr: ta.value }); } ta && ta.focus(); }
    return;
  }
  if ((el = c("[data-draft]"))) { S.draft = +el.dataset.draft; S.diff = false; rerender("d-src", "d-trans", "d-find", "d-comm"); return; }
  if ((el = c("[data-sa]"))) { S.sa = el.dataset.sa; rerender("d-src"); return; }
  if ((el = c("[data-ctab]"))) { S.ctab = el.dataset.ctab; rerender("d-comm"); return; }
  if ((el = c("[data-cview]"))) { S.cview = el.dataset.cview; rerender("d-comm"); return; }
  if ((el = c("[data-expand]"))) { const open = el.closest(".passage").querySelectorAll(".pcol"); const on = !open[0].classList.contains("open"); open.forEach(x => x.classList.toggle("open", on)); el.textContent = on ? tt("collapse") : tt("expand"); return; }
  if ((el = c("[data-cite]"))) { S.ctab = el.dataset.cite; rerender("d-comm"); const cm = $("#d-comm"), col = $(".col-r"); if (col) col.scrollTop = 0; if (cm) cm.scrollIntoView({ block: "nearest", behavior: "smooth" }); return; }
  if ((el = c(".evid .bo[data-q]"))) { jumpQuery(+el.dataset.q); return; }
  if ((el = c("[data-j]"))) {
    const key = S.draft + "." + el.dataset.fi, r = rec(S.sel.k) || {}, fnd = Object.assign({}, r.fnd || {});
    if (fnd[key] === el.dataset.j) delete fnd[key]; else fnd[key] = el.dataset.j;
    setRec(S.sel.k, { fnd }); rerender("d-find"); return;
  }
  if ((el = c("[data-apply]"))) { applyFix(+el.dataset.apply); return; }
  if ((el = c("[data-dec]"))) {
    const r = rec(S.sel.k) || {}; const v = r.dec === el.dataset.dec ? "" : el.dataset.dec;
    setRec(S.sel.k, { dec: v }); if (!v) delete store.reviews[S.sel.k].dec; persist();
    rerender("d-rev"); renderList(); renderSummary(); return;
  }
  if ((el = c("[data-m]"))) { const m = el.dataset.m; closeMenu(); if (m === "csv") exportCsv(); else if (m === "json") exportJson(); else if (m === "imp") importJson(); return; }
  if (c("#b-export")) { $("#menu") ? closeMenu() : openMenu(); return; }
  if (c("#b-help")) { openHelp(); return; }
  if (c("#b-theme")) { store.theme = store.theme === "" ? "dark" : store.theme === "dark" ? "light" : ""; persist(); applyTheme(); return; }
  if (t.matches("[data-close]") || t.closest("button[data-close]")) { $("#overlay").innerHTML = ""; return; }
  if ((el = c("mark.f"))) { const f = $(`.finding[data-fi="${el.dataset.fi}"]`); if (f) { f.scrollIntoView({ block: "center", behavior: "smooth" }); f.classList.add("hot"); setTimeout(() => f.classList.remove("hot"), 1400); } return; }
});
document.addEventListener("submit", e => {
  if (e.target.id !== "name-form") return;
  e.preventDefault();
  const v = $("#name-in").value.trim(); if (!v) return;
  store.reviewer = v; persist(); $("#who").value = v; $("#overlay").innerHTML = "";
  const ks = Object.keys(store.reviews); if (ks.length) markDirty(ks);
});
document.addEventListener("focusin", e => {
  if (needName() && (e.target.id === "corr" || e.target.id === "note")) { e.target.blur(); askName(); }
});
document.addEventListener("change", e => {
  const el = e.target.closest("[data-sel]"); if (!el) return;
  S.f[el.dataset.sel] = el.value; applyFilters(); renderList();
});
let typing, naming;
document.addEventListener("input", e => {
  const t = e.target;
  if (t.id === "who") {
    store.reviewer = t.value; persist();
    clearTimeout(naming); naming = setTimeout(() => { const ks = Object.keys(store.reviews); if (ks.length) markDirty(ks); }, 1200);
    return;
  }
  if (t.matches("[data-in=q]")) { S.f.q = t.value; clearTimeout(typing); typing = setTimeout(() => { applyFilters(); renderList(); }, 180); return; }
  if (t.id === "corr" || t.id === "note") {
    clearTimeout(typing); typing = setTimeout(() => { const k = S.sel.k; setRec(k, t.id === "corr" ? { corr: t.value } : { note: t.value }); }, 350);
  }
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape") { $("#overlay").innerHTML = ""; closeMenu(); return; }
  if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || e.metaKey || e.ctrlKey || e.altKey || !S.sel) return;
  if (e.key === "j" || e.key === "ArrowDown") { e.preventDefault(); step(1); }
  else if (e.key === "k" || e.key === "ArrowUp") { e.preventDefault(); step(-1); }
});
document.addEventListener("mouseover", e => {
  const m = e.target.closest("mark.f"), f = e.target.closest(".finding");
  document.querySelectorAll(".finding.hot, mark.f.hot").forEach(x => x.classList.remove("hot"));
  if (m) { const fd = $(`.finding[data-fi="${m.dataset.fi}"]`); if (fd) fd.classList.add("hot"); }
  if (f) document.querySelectorAll(`mark.f[data-fi="${f.dataset.fi}"]`).forEach(x => x.classList.add("hot"));
});
window.addEventListener("hashchange", route);
let wide = window.innerWidth > 860;
window.addEventListener("resize", () => { const w = window.innerWidth > 860; if (w !== wide) { wide = w; if (S.meta) route(); } });

/* ---------------- boot ---------------- */
applyTheme();
renderTop();
load().then(() => { route(); setSync(Object.keys(store.dirty).length ? "wait" : "ok"); scheduleSync(800); }).catch(() => {});
})();
