"use strict";
/* Cloud Fleet Optimizer: dashboard logic shared by dashboard.html and index.html.
   index.html also loads demo.js, which provides window.DEMO_API so the page keeps
   working on static hosting where there is no Flask backend. */

/* =====================================================================
   Config
   ===================================================================== */
const METHODS = [
  { key: "naive", name: "Sequential", color: "--c-naive", ref: null,
    blurb: "Baseline: tasks dealt to instances in rotation.",
    info: "Processes tasks in dependency order and assigns each to the next instance in rotation. It has no notion of priority, which leads to long idle stretches." },
  { key: "heft", name: "Priority-Optimized", color: "--c-heft", ref: "naive",
    blurb: "Standard priority-based baseline (HEFT).",
    info: "Ranks tasks by downstream workload, prioritizes bottleneck tasks, and places each on the instance that completes it soonest." },
  { key: "ils", name: "Priority + Refined", color: "--c-ils", ref: "heft",
    blurb: "Priority placement plus iterated local search.",
    info: "Starts from the priority baseline and tests thousands of small adjustments (moving or swapping tasks) to shorten completion. It periodically makes random shifts to escape dead ends." },
  { key: "cost_aware", name: "Budget-Optimized", color: "--c-cost", ref: "heft",
    blurb: "Weighs speed, budget and load balance together.",
    info: "Applies the same kind of adjustments, judged by a combined score of completion time, money spent and workload balance. The budget weight sets the trade-off." },
];
const STAGES = [
  ["Build workload", "Generate random task dependencies and an instance fleet with varied speeds and rates."],
  ["Sequential pass", "Baseline allocation: deal tasks to instances in order."],
  ["Rank priorities", "Score each task by the work that depends on it."],
  ["Priority placement", "Place tasks by priority on the instance that finishes them first."],
  ["Refinement loop", "Test small adjustments repeatedly to shorten total duration."],
  ["Budget balancing", "Judge adjustments against speed, cost and load distribution."],
];
const OP_DESC = {
  move: "Reassign one task to a different instance",
  swap: "Two tasks trade instances",
  reorder: "Two tasks on one instance trade places",
};
const BAR_METRICS = {
  makespan: { label: "Total duration", unit: "Time units. Lower finishes sooner.", get: r => r.makespan, fmt: v => v.toFixed(1) },
  cost: { label: "Budget spent", unit: "Cost of instance usage. Lower is better.", get: r => r.cost, fmt: v => "$" + v.toFixed(0) },
  utilization: { label: "Utilization", unit: "Average share of the total duration that instances are busy. Higher is better.", get: r => r.utilization, fmt: v => v.toFixed(1) + "%" },
  loadBalance: { label: "Load balance", unit: "Spread of work across instances. Lower is more even.", get: r => r.loadBalance, fmt: v => v.toFixed(3) },
};
const STAGE_REVEAL_MS = 360; /* how long the stage strip takes to fill once results are in */

/* =====================================================================
   Helpers
   ===================================================================== */
const $ = s => document.querySelector(s);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const reduceMotion = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
const pct = (from, to) => (from === 0 ? 0 : (to - from) / from * 100);
const f1 = v => v.toFixed(1);
const sgn = v => (Math.abs(v) < 0.05 ? "0.0" : (v > 0 ? "+" : "") + v.toFixed(1)) + "%";
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const listIds = a => (a.length <= 6 ? a.join(", ") : a.slice(0, 6).join(", ") + " +" + (a.length - 6) + " more");

function countTo(el, target, { dec = 1, dur = 800 } = {}) {
  if (reduceMotion || dur <= 0) { el.textContent = target.toFixed(dec); return; }
  const t0 = performance.now();
  (function tick(now) {
    const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
    el.textContent = (target * e).toFixed(dec);
    if (k < 1) requestAnimationFrame(tick);
  })(t0);
}

function download(name, blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const state = {
  data: null,      /* last /api/schedule result */
  deps: null,      /* { preds, succs } maps built from data.edges, or null (demo mode) */
  repair: null,    /* last /api/event result */
  trade: null,
  metric: "makespan",
  loading: false,
  shown: new Set(METHODS.map(m => m.key)),
};

/* =====================================================================
   API (falls back to window.DEMO_API only when there is no backend)
   ===================================================================== */
async function fetchJson(path) {
  const res = await fetch(path);
  if (!res.ok) {
    let msg = "HTTP " + res.status;
    try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (e) { /* not JSON */ }
    const err = new Error(msg); err.status = res.status; throw err;
  }
  return res.json();
}
async function api(path) {
  try { return await fetchJson(path); }
  catch (err) {
    const noBackend = !err.status || err.status === 404 || err.status === 405;
    if (window.DEMO_API && noBackend) { const note = $("#demoNote"); if (note) note.hidden = false; return window.DEMO_API(path); }
    throw err;
  }
}

function buildDeps(edges) {
  if (!Array.isArray(edges)) return null;
  const preds = new Map(), succs = new Map();
  const add = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
  edges.forEach(([a, b]) => { add(succs, a, b); add(preds, b, a); });
  return { preds, succs };
}
function depsOf(id) {
  const D = state.deps;
  return D ? { up: D.preds.get(id) || [], down: D.succs.get(id) || [] } : { up: [], down: [] };
}

/* =====================================================================
   Controls
   ===================================================================== */
[["tasks", "tasksOut", v => v], ["vms", "vmsOut", v => v], ["beta", "betaOut", v => (+v).toFixed(2)],
 ["evAt", "evAtOut", v => v + "%"], ["evFactor", "evFactorOut", v => "×" + (+v).toFixed(2)]].forEach(([id, out, fmt]) => {
  const input = $("#" + id), o = $("#" + out);
  const sync = () => { o.textContent = fmt(input.value); input.style.setProperty("--pct", ((input.value - input.min) / (input.max - input.min) * 100) + "%"); };
  input.addEventListener("input", sync); sync();
});
$("#go").addEventListener("click", () => generate(false));
$("#find").addEventListener("click", () => generate(true));
$("#shuffle").addEventListener("click", () => { $("#seed").value = Math.floor(Math.random() * 10000); generate(false); });
$("#seed").addEventListener("keydown", e => { if (e.key === "Enter") generate(false); });
$("#idleToggle").addEventListener("change", e => $("#gantts").classList.toggle("show-idle", e.target.checked));

function showError(err) {
  const el = $("#error"), strong = document.createElement("strong");
  el.replaceChildren();
  if (err.status && err.status !== 404 && err.status !== 405) { /* 404/405 mean there is no API here at all */
    strong.textContent = "The scheduler rejected the request. ";
    el.append(strong, document.createTextNode(err.message + "."));
  } else {
    strong.textContent = "Couldn't reach the scheduler. ";
    const code = document.createElement("code"); code.textContent = "python server.py";
    el.append(strong, document.createTextNode("Start the server with "), code, document.createTextNode(" and reload this page."));
  }
  el.hidden = false;
}
const hideError = () => { $("#error").hidden = true; };

/* ---------- shareable link: the run's settings live in the query string ---------- */
function readUrl() {
  const q = new URLSearchParams(location.search);
  ["tasks", "vms", "beta"].forEach(id => {
    const raw = q.get(id), el = $("#" + id);
    if (raw === null || raw.trim() === "") return;
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    el.value = Math.min(+el.max, Math.max(+el.min, n));
    el.dispatchEvent(new Event("input"));
  });
  const seed = q.get("seed");
  if (seed !== null && /^\d{1,9}$/.test(seed)) $("#seed").value = seed;
}
function writeUrl(d) {
  const q = new URLSearchParams({
    tasks: d.heft.tasks.length, vms: d.vms.length,
    beta: d.instance.beta !== undefined ? d.instance.beta : $("#beta").value, seed: d.instance.seed,
  });
  try { history.replaceState(null, "", "?" + q.toString()); } catch (e) { /* e.g. sandboxed frames */ }
}
function legacyCopy(text) {
  const ta = document.createElement("textarea");
  ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.append(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch (e) { /* ignore */ }
  ta.remove();
  return ok;
}
$("#copyLink").addEventListener("click", async () => {
  const btn = $("#copyLink");
  let ok = false;
  try { await navigator.clipboard.writeText(location.href); ok = true; } catch (e) { ok = legacyCopy(location.href); }
  btn.textContent = ok ? "Link copied" : "Copy failed";
  $("#status").textContent = ok ? "Link copied to the clipboard." : "Couldn't copy the link. Copy it from the address bar.";
  setTimeout(() => { btn.textContent = "Copy link"; }, 1600);
});

/* =====================================================================
   Pipeline strip
   ===================================================================== */
function buildSteps() {
  $("#steps").innerHTML = STAGES.map(([label]) =>
    '<li class="stage"><div class="t">' + label + '</div><span class="ms num"></span><i class="fill"></i></li>').join("");
  $("#howList").innerHTML = STAGES.map(([label, desc]) => "<dt>" + label + "</dt><dd>" + desc + "</dd>").join("");
}
const stepEls = () => Array.from(document.querySelectorAll(".stage"));

let spinTimer = null;
function startSpin() {
  const els = stepEls();
  els.forEach(s => { s.classList.remove("done", "active"); s.querySelector(".fill").style.width = "0"; s.querySelector(".ms").textContent = ""; });
  let i = 0;
  const advance = () => { els.forEach((s, k) => s.classList.toggle("active", k === i % els.length)); i++; };
  advance(); spinTimer = setInterval(advance, 260);
}
function stopSpin() { clearInterval(spinTimer); stepEls().forEach(s => s.classList.remove("active")); }

async function revealStages(stages, budgetMs) {
  stopSpin();
  const els = stepEls();
  const slowest = Math.max(...stages.map(s => s.ms), 0.001);
  const gap = Math.max(30, Math.min(220, budgetMs / Math.max(els.length, 1)));
  for (let i = 0; i < els.length; i++) {
    const st = stages[i]; /* the server reports stages in pipeline order, under its own labels */
    els[i].classList.add("active");
    await sleep(reduceMotion ? 0 : gap * 0.5);
    els[i].classList.remove("active"); els[i].classList.add("done");
    if (st) {
      els[i].querySelector(".ms").textContent = st.ms < 10 ? st.ms.toFixed(1) + " ms" : Math.round(st.ms) + " ms";
      els[i].querySelector(".fill").style.width = Math.max(4, st.ms / slowest * 100) + "%";
    }
    await sleep(reduceMotion ? 0 : gap * 0.5);
  }
}

/* =====================================================================
   Main action
   ===================================================================== */
async function generate(find) {
  if (state.loading) return;
  state.loading = true; hideError();
  const buttons = [$("#go"), $("#find"), $("#shuffle")];
  buttons.forEach(b => { b.disabled = true; });
  $("#results").classList.add("loading");
  startSpin();
  try {
    const qs = new URLSearchParams({ tasks: $("#tasks").value, vms: $("#vms").value, beta: $("#beta").value, seed: $("#seed").value.trim() });
    if (find) qs.set("find", "1");
    const data = await api("/api/schedule?" + qs);
    await revealStages(data.stages, STAGE_REVEAL_MS);
    state.data = data; state.repair = null;
    state.deps = buildDeps(data.edges);
    $("#seed").value = data.instance.seed;
    writeUrl(data);
    renderAll(data);
  } catch (err) {
    stopSpin();
    showError(err);
  } finally {
    state.loading = false;
    buttons.forEach(b => { b.disabled = false; });
    $("#results").classList.remove("loading");
  }
}

/* =====================================================================
   Rendering
   ===================================================================== */
function renderAll(d) {
  $("#results").hidden = false;
  resetHighlight();
  renderBadges(d);
  renderBars(d, true);
  renderTrace(d, true);
  renderOps(d);
  renderFleet(d);
  renderGantts(d);
  renderRepairPanel(d);
  $("#guideRel").hidden = !state.deps;
  $("#status").textContent = "Scheduled " + d.heft.tasks.length + " tasks on " + d.vms.length + " instances, seed " + d.instance.seed + ".";
}

/* ---------- headline stats ---------- */
function headline(gain, up, down) { /* gain > 0 means better */
  if (gain >= 0.05) return { cls: "pos", num: gain, word: up };
  if (gain <= -0.05) return { cls: "neg", num: -gain, word: down };
  return { cls: "", num: null, word: "No change" };
}
function renderBadges(d) {
  const ilsGain = -pct(d.heft.makespan, d.ils.makespan);
  const costChg = pct(d.heft.cost, d.cost_aware.cost);
  const msChg = pct(d.heft.makespan, d.cost_aware.makespan);
  const heftGain = -pct(d.naive.makespan, d.heft.makespan);

  const ils = headline(ilsGain, "faster", "slower");
  let ilsNote = "Duration " + f1(d.heft.makespan) + " to " + f1(d.ils.makespan) + " time units.";
  if (ils.num === null) {
    ilsNote = d.scan && !d.scan.found
      ? "No run where refinement helps turned up in " + d.scan.tries + " seeds."
      : "Priority placement is already a local optimum here, so refinement found nothing faster.";
  }
  const stats = [
    { c: "--c-ils", lab: "Refined vs baseline, duration", h: ils, note: ilsNote },
    { c: "--c-cost", lab: "Budget-optimized vs baseline, cost", h: headline(-costChg, "cheaper", "costlier"),
      note: "$" + d.heft.cost.toFixed(0) + " to $" + d.cost_aware.cost.toFixed(0) + ", with duration " + sgn(msChg) + "." },
    { c: "--c-heft", lab: "Priority vs sequential, duration", h: headline(heftGain, "faster", "slower"),
      note: "Duration " + f1(d.naive.makespan) + " to " + f1(d.heft.makespan) + " time units." },
  ];
  const box = $("#badges");
  box.innerHTML = stats.map((s, i) =>
    '<div class="stat"><div class="lab"><i style="--c:var(' + s.c + ')"></i>' + s.lab + '</div>' +
    '<div class="big num ' + s.h.cls + '" data-i="' + i + '">' +
    (s.h.num === null ? s.h.word : '<span class="v">0.0</span>%<small>' + s.h.word + "</small>") + "</div>" +
    '<p class="note">' + s.note + "</p></div>").join("");
  stats.forEach((s, i) => {
    if (s.h.num !== null) countTo(box.querySelector('[data-i="' + i + '"] .v'), s.h.num, { dec: 1 });
  });
}

/* ---------- comparison bars ---------- */
function buildBars() {
  $("#metricSeg").innerHTML = Object.entries(BAR_METRICS).map(([k, m]) =>
    '<button type="button" data-k="' + k + '" aria-pressed="' + (k === state.metric) + '">' + m.label + "</button>").join("");
  $("#bars").innerHTML = METHODS.map(m =>
    '<div class="brow" data-k="' + m.key + '" style="--c:var(' + m.color + ')"><span class="blabel"><i class="dot"></i>' + m.name + "</span>" +
    '<div class="btrack"><div class="bfill"></div><i class="bmark"></i></div><span class="bval num"></span><span class="bdelta num"></span></div>').join("");
  $("#metricSeg").addEventListener("click", e => {
    const b = e.target.closest("button[data-k]"); if (!b) return;
    state.metric = b.dataset.k;
    document.querySelectorAll("#metricSeg button").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
    if (state.data) renderBars(state.data, false);
  });
}
function renderBars(d, fresh) {
  const spec = BAR_METRICS[state.metric];
  $("#metricUnit").textContent = spec.unit;
  const vals = METHODS.map(m => spec.get(d[m.key]));
  const max = Math.max(...vals, 1e-9);
  const lowerBetter = state.metric !== "utilization";
  const base = spec.get(d.heft);
  const apply = () => METHODS.forEach((m, i) => {
    const row = document.querySelector('.brow[data-k="' + m.key + '"]');
    row.querySelector(".bfill").style.width = (vals[i] / max * 100) + "%";
    const mk = row.querySelector(".bmark"); mk.style.left = (base / max * 100) + "%"; mk.hidden = m.key === "heft";
    row.querySelector(".bval").textContent = spec.fmt(vals[i]);
    const dl = row.querySelector(".bdelta");
    if (m.key === "heft") { dl.textContent = "baseline"; dl.className = "bdelta"; return; }
    const ch = pct(base, vals[i]);
    dl.textContent = sgn(ch);
    const better = lowerBetter ? ch < -0.05 : ch > 0.05, worse = lowerBetter ? ch > 0.05 : ch < -0.05;
    dl.className = "bdelta num " + (better ? "good" : worse ? "bad" : "");
  });
  if (fresh) {
    document.querySelectorAll(".bfill").forEach(f => { f.style.width = "0"; });
    requestAnimationFrame(() => requestAnimationFrame(() => renderBars(state.data || d, false)));
  } else apply();
}

/* ---------- convergence trace ---------- */
function renderTrace(d, animate) {
  const box = $("#traceBox"), t = d.trace;
  const W = Math.max(280, Math.round(box.clientWidth)), H = 200, pl = 44, pr = 12, pt = 12, pb = 28;
  let lo = Math.min(...t), hi = Math.max(...t);
  /* keep the scale honest: a 0.1% gain must not look like a cliff */
  const minSpan = hi * 0.05;
  if (hi - lo < minSpan) { const extra = (minSpan - (hi - lo)) / 2; lo -= extra; hi += extra; }
  const padv = (hi - lo) * 0.08; lo -= padv; hi += padv;
  const x = i => pl + (t.length > 1 ? i / (t.length - 1) : 0) * (W - pl - pr);
  const y = v => pt + (1 - (v - lo) / (hi - lo)) * (H - pt - pb);
  const line = "M" + t.map((v, i) => x(i).toFixed(1) + "," + y(v).toFixed(1)).join(" L");
  const area = line + " L" + x(t.length - 1).toFixed(1) + "," + (H - pb) + " L" + pl + "," + (H - pb) + " Z";
  const ticks = [0, 0.5, 1].map(k => {
    const v = lo + (hi - lo) * (1 - k), yy = pt + k * (H - pt - pb);
    return '<line class="grid" x1="' + pl + '" x2="' + (W - pr) + '" y1="' + yy + '" y2="' + yy + '"/>' +
      '<text class="axis num" x="' + (pl - 8) + '" y="' + (yy + 4) + '" text-anchor="end">' + v.toFixed(1) + "</text>";
  }).join("");
  const steps = d.traceLength.toLocaleString();
  box.innerHTML =
    '<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Best duration found so far, by search step">' + ticks +
    '<path class="area" d="' + area + '"/><path class="line" pathLength="1" d="' + line + '"/>' +
    '<circle class="tdot" r="4" cx="' + x(t.length - 1).toFixed(1) + '" cy="' + y(t[t.length - 1]).toFixed(1) + '"/>' +
    '<text class="axis num" x="' + pl + '" y="' + (H - 6) + '">0</text>' +
    '<text class="axis num" x="' + (W - pr) + '" y="' + (H - 6) + '" text-anchor="end">' + steps + " steps</text></svg>";
  box.closest(".trace").classList.toggle("draw", !!animate && !reduceMotion);
  const gain = -pct(d.heft.makespan, d.ils.makespan);
  $("#traceNote").textContent = gain < 0.05
    ? "Duration held at " + f1(d.heft.makespan) + " across " + steps + " steps. Priority placement was already a local optimum."
    : "Duration fell from " + f1(d.heft.makespan) + " to " + f1(d.ils.makespan) + " over " + steps + " steps.";
}

/* ---------- operator table ---------- */
function renderOps(d) {
  $("#opsTable").innerHTML =
    '<thead><tr><th scope="col">Action type</th><th scope="col" class="r">Tested</th><th scope="col" class="r">Feasible</th><th scope="col" class="r">Improved</th><th scope="col" class="r">Success rate</th></tr></thead><tbody>' +
    d.operators.map(o => {
      const rate = o.attempts ? o.accepted / o.attempts * 100 : 0;
      return '<tr><td><b>' + esc(o.name) + '</b><div class="opdesc">' + (OP_DESC[o.name] || "") + "</div></td>" +
        '<td class="r num">' + o.attempts + '</td><td class="r num">' + o.feasible + '</td><td class="r num">' + o.accepted +
        '</td><td class="r num">' + rate.toFixed(1) + "%</td></tr>";
    }).join("") + "</tbody>";
}

/* ---------- instance fleet ---------- */
function renderFleet(d) {
  const mxS = Math.max(...d.vms.map(v => v.speed)), mxR = Math.max(...d.vms.map(v => v.cost_per_hour));
  const bar = (c, w, txt) => '<div class="mini" style="--c:' + c + '"><span class="mb"><i data-w="' + w + '"></i></span><span class="num">' + txt + "</span></div>";
  const head = '<thead><tr><th scope="col">Instance</th><th scope="col">Speed</th><th scope="col">Hourly rate</th>' +
    METHODS.map(m => '<th scope="col"><i class="dot" style="--c:var(' + m.color + ')"></i>' + m.name + "</th>").join("") + "</tr></thead>";
  const rows = d.vms.map((v, i) =>
    '<tr><th scope="row">Node ' + v.id + "</th>" +
    "<td>" + bar("var(--accent)", v.speed / mxS * 100, "×" + v.speed.toFixed(1)) + "</td>" +
    "<td>" + bar("var(--c-heft)", v.cost_per_hour / mxR * 100, "$" + v.cost_per_hour.toFixed(2) + "/hr") + "</td>" +
    METHODS.map(m => "<td>" + bar("var(" + m.color + ")", d[m.key].vmUtil[i] * 100, d[m.key].vmTasks[i] + " tasks") + "</td>").join("") + "</tr>").join("");
  const box = $("#fleet");
  box.innerHTML = head + "<tbody>" + rows + "</tbody>";
  requestAnimationFrame(() => requestAnimationFrame(() => box.querySelectorAll("i[data-w]").forEach(el => { el.style.width = el.dataset.w + "%"; })));
}

/* =====================================================================
   Timelines (shared by the four strategy cards and the repair result)
   ===================================================================== */
function niceStep(max) {
  const raw = max / 6, mag = Math.pow(10, Math.floor(Math.log10(raw))), n = raw / mag;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
}
function idleGaps(tasks, endAt) {
  const sorted = tasks.slice().sort((a, b) => a.start - b.start);
  const gaps = []; let cursor = 0;
  sorted.forEach(t => { if (t.start > cursor + 1e-6) gaps.push([cursor, t.start]); cursor = Math.max(cursor, t.end); });
  if (endAt > cursor + 1e-6) gaps.push([cursor, endAt]);
  return gaps;
}
function chartScale(maxValue) {
  const timeMax = maxValue * 1.02, step = niceStep(timeMax);
  const ticks = []; for (let t = 0; t <= timeMax; t += step) ticks.push(t);
  return { timeMax, ticks, pos: v => v / timeMax * 100 };
}
function axisHtml(sc) {
  return '<div class="grow"><span></span><div class="taxis">' +
    sc.ticks.map(t => '<span class="num" style="left:' + sc.pos(t) + '%">' + (Number.isInteger(t) ? t : t.toFixed(1)) + "</span>").join("") + "</div></div>";
}
/* o.affected: Set of re-planned task ids; o.down: {vm, time}; o.slow: {vm, factor} */
function rowsHtml(r, vms, sc, o) {
  o = o || {};
  return vms.map(v => {
    const mine = r.tasks.filter(t => t.vm === v.id).sort((a, b) => a.start - b.start);
    const isDown = o.down && o.down.vm === v.id;
    const idle = idleGaps(mine, isDown ? o.down.time : r.makespan).map(([a, b]) => '<div class="gap" style="left:' + sc.pos(a) + "%;width:" + sc.pos(b - a) + '%"></div>').join("");
    const gone = isDown ? '<div class="down" style="left:' + sc.pos(o.down.time) + "%;width:" + (100 - sc.pos(o.down.time)) + '%"></div>' : "";
    const bars = mine.map((t, k) => {
      const w = sc.pos(t.end - t.start);
      const replanned = o.affected && o.affected.has(t.id);
      const tipText = "Task " + t.id + " · Node " + v.id + " · " + t.start.toFixed(1) + "–" + t.end.toFixed(1) + " · $" + t.cost.toFixed(1);
      const { up, down } = depsOf(t.id);
      const spoken = "Task " + t.id + ", Node " + v.id + ", " + t.start.toFixed(1) + " to " + t.end.toFixed(1) + ", $" + t.cost.toFixed(1) +
        (replanned ? ", re-planned" : "") + (state.deps ? (up.length ? ", after tasks " + listIds(up) : ", no prerequisites") + (down.length ? ", before tasks " + listIds(down) : ", no dependents") : "");
      return '<div class="bar' + (replanned ? " replanned" : "") + '" role="button" tabindex="' + (k === 0 && v === vms[0] ? 0 : -1) + '" aria-label="' + spoken +
        '" data-id="' + t.id + '" data-start="' + t.start + '" style="left:' + sc.pos(t.start) + "%;width:" + w + "%;--d:" + Math.min(k * 25, 500) + 'ms" data-tip="' + tipText + '">' + (w > 3.2 ? t.id : "") + "</div>";
    }).join("");
    let label = "Node " + v.id + " <small>×" + v.speed.toFixed(1) + "</small>";
    if (o.slow && o.slow.vm === v.id) label = "Node " + v.id + " <small>×" + v.speed.toFixed(1) + ' <span class="to">→ ×' + (v.speed * o.slow.factor).toFixed(1) + "</span></small>";
    return '<div class="grow"><span class="glabel">' + label + '</span><div class="track">' + idle + gone + bars + "</div></div>";
  }).join("");
}
/* o: {key,name,blurb,color,r,ref,sc,vms,meta,info,rowOpts,eventTime} */
function gcardHtml(o) {
  const { r, ref, sc } = o;
  const overlay = '<div class="goverlay"><div class="done-line" style="left:' + sc.pos(r.makespan) + '%"><span class="flag num">' + r.makespan.toFixed(1) + "</span></div>" +
    (ref ? '<div class="ref-line" style="left:' + sc.pos(ref.makespan) + '%"></div>' : "") +
    (o.eventTime != null ? '<div class="event-line" style="left:' + sc.pos(o.eventTime) + '%"></div>' : "") + "</div>";
  return '<article class="gcard" data-k="' + o.key + '" style="--c:var(' + o.color + ')" aria-label="' + esc(o.name) + ' schedule">' +
    '<div class="ghead"><div><h3 class="gname"><i class="dot"></i>' + esc(o.name) + '</h3><p class="gblurb">' + o.blurb + '</p></div><div class="gmeta">' + o.meta + "</div></div>" +
    '<div class="gscroll"><div class="gchart">' + axisHtml(sc) + '<div class="gbody">' + rowsHtml(r, o.vms, sc, o.rowOpts) + overlay + "</div></div></div>" + (o.info || "") + "</article>";
}
function metaHtml(r, chip) {
  return '<span>Duration<b class="num">' + r.makespan.toFixed(1) + '</b></span><span>Cost<b class="num">$' + r.cost.toFixed(0) +
    '</b></span><span>Active<b class="num">' + r.utilization.toFixed(1) + "%</b></span>" + (chip || "");
}

function renderGantts(d) {
  const sc = chartScale(Math.max(...METHODS.map(m => d[m.key].makespan)));
  $("#gantts").innerHTML = METHODS.map(m => {
    const r = d[m.key], ref = m.ref ? d[m.ref] : null, refM = METHODS.find(x => x.key === m.ref);
    let chip = "";
    if (ref) {
      const ch = pct(ref.makespan, r.makespan);
      const cls = ch < -0.05 ? "good" : ch > 0.05 ? "bad" : "";
      chip = '<span class="gchip ' + cls + '">' + (Math.abs(ch) < 0.05 ? "Same as " : sgn(ch) + " vs ") + refM.name + "</span>";
    }
    return gcardHtml({
      key: m.key, name: m.name, blurb: m.blurb, color: m.color, r, ref, sc, vms: d.vms, meta: metaHtml(r, chip),
      info: '<details class="info"><summary>Strategy details</summary><p>' + m.info + "</p></details>",
    });
  }).join("");
  $("#gantts").classList.toggle("show-idle", $("#idleToggle").checked);
  applyShown();
}

/* ---------- choose which strategies to compare ---------- */
function buildToggles() {
  $("#cardToggles").innerHTML = METHODS.map(m =>
    '<button type="button" data-k="' + m.key + '" aria-pressed="true"><i class="dot" style="--c:var(' + m.color + ')"></i>' + m.name + "</button>").join("");
  $("#cardToggles").addEventListener("click", e => {
    const b = e.target.closest("button[data-k]"); if (!b) return;
    const k = b.dataset.k;
    if (state.shown.has(k)) { if (state.shown.size === 1) return; state.shown.delete(k); } else state.shown.add(k);
    resetHighlight();
    applyShown();
  });
}
function applyShown() {
  document.querySelectorAll("#gantts .gcard").forEach(c => { c.hidden = !state.shown.has(c.dataset.k); });
  document.querySelectorAll("#cardToggles button").forEach(b => b.setAttribute("aria-pressed", String(state.shown.has(b.dataset.k))));
}

/* =====================================================================
   Pointing at a task: tooltip, related tasks, keyboard and touch
   ===================================================================== */
const tip = $("#tip");
let hover = null, focused = null, pinned = null, lit = null;
const targetOf = bar => ({ id: +bar.dataset.id, root: bar.closest("[data-hl]"), bar });
const sameTarget = (a, b) => !!a && !!b && a.id === b.id && a.root === b.root;

function clearLit() {
  if (!lit) return;
  lit.root.classList.remove("hovering");
  lit.root.querySelectorAll(".bar.hl, .bar.rel").forEach(b => b.classList.remove("hl", "rel"));
  lit = null;
}
function light(t) {
  if (sameTarget(t, lit)) return;
  clearLit();
  if (!t || !t.root) return;
  const { up, down } = depsOf(t.id), related = new Set(up.concat(down));
  t.root.classList.add("hovering");
  t.root.querySelectorAll(".bar").forEach(b => {
    const id = +b.dataset.id;
    if (id === t.id) b.classList.add("hl"); else if (related.has(id)) b.classList.add("rel");
  });
  lit = { id: t.id, root: t.root };
}
function moveTip(x, y) {
  const px = Math.max(8, Math.min(x + 14, innerWidth - tip.offsetWidth - 8));
  const py = Math.max(8, Math.min(y + 14, innerHeight - tip.offsetHeight - 8));
  tip.style.transform = "translate(" + px + "px," + py + "px)";
}
function showTip(bar, x, y) {
  const { up, down } = depsOf(+bar.dataset.id);
  const [head, ...rest] = bar.dataset.tip.split(" · ");
  let html = "<b>" + head + "</b>" + rest.map(s => "<span>" + s + "</span>").join("");
  if (bar.classList.contains("replanned")) html += "<span>Re-planned after the event</span>";
  if (state.deps) html += "<span>" + (up.length ? "After " + listIds(up) : "No prerequisites") + "</span><span>" + (down.length ? "Before " + listIds(down) : "No dependents") + "</span>";
  tip.innerHTML = html;
  if (x == null) { const r = bar.getBoundingClientRect(); x = r.left; y = r.bottom - 14; }
  moveTip(x, y);
  tip.classList.add("on");
}
function settle() { /* show whichever of hover / keyboard focus / pinned wins */
  const t = hover || focused || pinned;
  light(t);
  if (!t) tip.classList.remove("on");
  else if (!hover) showTip(t.bar);
}
function resetHighlight() {
  hover = focused = pinned = null;
  clearLit();
  tip.classList.remove("on");
}

document.addEventListener("pointermove", e => {
  if (e.pointerType === "touch") return;
  const bar = e.target.closest && e.target.closest(".bar[data-tip]");
  if (!bar) { if (hover) { hover = null; settle(); } return; }
  if (hover && hover.bar === bar) { moveTip(e.clientX, e.clientY); return; }
  hover = targetOf(bar);
  showTip(bar, e.clientX, e.clientY);
  light(hover);
});
document.addEventListener("mouseout", e => { if (!e.relatedTarget && hover) { hover = null; settle(); } });
document.addEventListener("click", e => { /* click or tap pins a task; click elsewhere lets go */
  const bar = e.target.closest && e.target.closest(".bar[data-tip]");
  if (!bar) { if (pinned && !e.target.closest("#tip")) { pinned = null; settle(); } return; }
  const t = targetOf(bar);
  pinned = sameTarget(pinned, t) ? null : t;
  settle();
});
document.addEventListener("focusin", e => {
  const bar = e.target.closest && e.target.closest(".bar[data-tip]");
  if (!bar || !bar.matches(":focus-visible")) return;
  focused = targetOf(bar); settle();
});
document.addEventListener("focusout", e => {
  if (e.target.closest && e.target.closest(".bar[data-tip]") && focused) { focused = null; settle(); }
});
document.addEventListener("keydown", e => {
  const bar = e.target.closest && e.target.closest(".bar[data-tip]");
  if (!bar) return;
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); bar.click(); return; }
  if (e.key === "Escape") { pinned = null; settle(); return; }
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
  e.preventDefault();
  const row = bar.closest(".track"), bars = Array.from(row.querySelectorAll(".bar")), i = bars.indexOf(bar);
  let next = null;
  if (e.key === "ArrowRight") next = bars[i + 1];
  else if (e.key === "ArrowLeft") next = bars[i - 1];
  else { /* up/down: the nearest-starting task on the neighbouring instance that has any */
    const rows = Array.from(bar.closest(".gchart").querySelectorAll(".track")), dir = e.key === "ArrowDown" ? 1 : -1;
    let j = rows.indexOf(row) + dir;
    while (rows[j] && !rows[j].querySelector(".bar")) j += dir;
    if (rows[j]) {
      const s = +bar.dataset.start;
      next = Array.from(rows[j].querySelectorAll(".bar")).reduce((a, b) => (Math.abs(+b.dataset.start - s) < Math.abs(+a.dataset.start - s) ? b : a));
    }
  }
  if (next) { bar.tabIndex = -1; next.tabIndex = 0; next.focus(); }
});

/* =====================================================================
   What if an instance fails?
   ===================================================================== */
const EV = { type: $("#evType"), vm: $("#evVm"), at: $("#evAt"), factor: $("#evFactor"), strategy: $("#evStrategy") };
EV.strategy.innerHTML = METHODS.map(m => '<option value="' + m.key + '"' + (m.key === "heft" ? " selected" : "") + ">" + m.name + "</option>").join("");
EV.type.addEventListener("change", () => { $("#evFactorField").hidden = EV.type.value !== "slowdown"; });
$("#evGo").addEventListener("click", simulate);

function busiestNode(r, frac, vms) { /* the instance with the most unfinished work at that moment */
  const t = r.makespan * frac;
  let best = vms[0].id, bestWork = -1;
  vms.forEach(v => {
    const work = r.tasks.filter(x => x.vm === v.id).reduce((sum, x) => sum + Math.max(0, x.end - Math.max(x.start, t)), 0);
    if (work > bestWork) { bestWork = work; best = v.id; }
  });
  return best;
}
function renderRepairPanel(d) {
  const live = Array.isArray(d.edges);
  $("#repairLive").hidden = !live;
  $("#repairOffline").hidden = live;
  $("#repairResult").hidden = true; $("#repairNote").hidden = true;
  if (!live) return;
  const prev = EV.vm.value;
  EV.vm.innerHTML = d.vms.map(v => '<option value="' + v.id + '">Node ' + v.id + " (×" + v.speed.toFixed(1) + ")</option>").join("");
  EV.vm.value = d.vms.some(v => String(v.id) === prev) ? prev : String(busiestNode(d.heft, +EV.at.value / 100, d.vms));
}

async function simulate() {
  const d = state.data;
  if (!d || !Array.isArray(d.edges)) return;
  const btn = $("#evGo"), note = $("#repairNote");
  btn.disabled = true; note.hidden = true;
  const i = d.instance;
  const qs = new URLSearchParams({
    tasks: d.heft.tasks.length, vms: d.vms.length, beta: i.beta, seed: i.seed, /* the run on screen, not whatever the sliders say now */
    strategy: EV.strategy.value, type: EV.type.value, vm: EV.vm.value, at: +EV.at.value / 100, factor: EV.factor.value,
  });
  try {
    const res = await fetchJson("/api/event?" + qs);
    if (state.data !== d) return; /* a new run replaced this one while we waited */
    state.repair = res;
    renderRepair(res);
  } catch (err) {
    note.textContent = "Couldn't run the simulation: " + err.message + ".";
    note.hidden = false;
    $("#repairResult").hidden = true;
  } finally { btn.disabled = false; }
}

function statBlock(c, lab, big, cls, note) {
  return '<div class="stat"><div class="lab"><i style="--c:var(' + c + ')"></i>' + lab + '</div><div class="big num ' + cls + '">' + big + '</div><p class="note">' + note + "</p></div>";
}
function renderRepair(res) {
  resetHighlight();
  const ev = res.event, method = METHODS.find(m => m.key === ev.strategy);
  const vmName = "Node " + ev.vm, n = res.before.tasks.length, sel = res.selective, full = res.naive;
  const note = $("#repairNote"), box = $("#repairResult");
  if (res.ignored) {
    note.textContent = vmName + " has no unfinished work at t=" + ev.time.toFixed(1) + ", so nothing needed repair. Try an earlier time or a busier instance.";
    note.hidden = false; box.hidden = true;
    return;
  }
  note.hidden = true;

  const chg = pct(res.before.makespan, res.after.makespan), dur = headline(-chg, "shorter", "longer");
  const stats =
    statBlock("--accent", "Tasks re-planned", sel.touched + "<small>of " + n + " tasks</small>", sel.touched < full.touched ? "pos" : "",
      "A full re-plan would redo all " + full.touched + " unfinished tasks.") +
    statBlock(method.color, "Duration after repair", dur.num === null ? dur.word : f1(dur.num) + "%<small>" + dur.word + "</small>", dur.cls,
      f1(res.before.makespan) + " to " + f1(res.after.makespan) + " time units. A full re-plan ends at " + f1(full.makespan) + ".") +
    statBlock("--c-heft", "Original plan kept", sel.stability.toFixed(0) + "%<small>of tasks unchanged</small>", sel.stability > full.stability ? "pos" : "",
      "A full re-plan keeps " + full.stability.toFixed(0) + "%.");

  const row = (name, x) => "<tr><td>" + name + '</td><td class="r num">' + x.touched + '</td><td class="r num">' + x.ms.toFixed(3) + '</td><td class="r num">' +
    x.stability.toFixed(1) + '</td><td class="r num">' + x.makespan.toFixed(1) + "</td></tr>";
  const table = '<div class="tablewrap"><table><thead><tr><th scope="col">Approach</th><th scope="col" class="r">Tasks touched</th><th scope="col" class="r">Repair ms</th><th scope="col" class="r">Plan kept %</th><th scope="col" class="r">Duration</th></tr></thead><tbody>' +
    row("Selective repair", sel) + row("Full re-plan", full) + "</tbody></table></div>";

  const isFail = ev.type === "failure";
  const guide = '<div class="guide"><span><i class="sw ring"></i>Re-planned task</span>' + (isFail ? '<span><i class="sw down"></i>Instance down</span>' : "") +
    '<span><i class="sw ev"></i>When it happened</span><span><i class="sw dash"></i>Duration before</span></div>';
  const sc = chartScale(Math.max(res.before.makespan, res.after.makespan));
  const what = isFail ? vmName + " fails" : vmName + " slows to ×" + ev.factor.toFixed(2);
  const card = gcardHtml({
    key: ev.strategy, name: method.name + " after the event", color: method.color, r: res.after, ref: res.before, sc, vms: d_vms(),
    blurb: what + " at t=" + ev.time.toFixed(1) + ". " + sel.touched + " tasks re-planned, the rest kept in place.",
    meta: metaHtml(res.after, '<span class="gchip ' + (chg > 0.05 ? "bad" : chg < -0.05 ? "good" : "") + '">' + sgn(chg) + " vs before</span>"),
    eventTime: ev.time,
    rowOpts: { affected: new Set(res.affected), down: isFail ? { vm: ev.vm, time: ev.time } : null, slow: isFail ? null : { vm: ev.vm, factor: ev.factor } },
  });
  box.innerHTML = '<div class="stats">' + stats + "</div>" + table + guide + '<div data-hl id="repairChart" class="show-idle">' + card + "</div>";
  box.hidden = false;
  $("#status").textContent = what + " at t=" + ev.time.toFixed(1) + ": " + sel.touched + " of " + n + " tasks re-planned.";
}
const d_vms = () => state.data.vms;

/* =====================================================================
   Export
   ===================================================================== */
function exportName(ext) {
  const d = state.data;
  return "fleet-seed" + d.instance.seed + "-" + d.heft.tasks.length + "t-" + d.vms.length + "n." + ext;
}
$("#exportCsv").addEventListener("click", () => {
  const d = state.data; if (!d) return;
  const lines = ["strategy,task,node,start,end,cost"];
  METHODS.forEach(m => d[m.key].tasks.forEach(t => lines.push([m.name, t.id, t.vm, t.start, t.end, t.cost].join(","))));
  download(exportName("csv"), new Blob([lines.join("\n") + "\n"], { type: "text/csv" }));
});

function timelinesSvg(d) { /* all four timelines as one picture, in the current theme's colours */
  const cs = getComputedStyle(document.documentElement), v = n => cs.getPropertyValue(n).trim();
  const W = 1080, P = 24, L = 104, R = 16, rowH = 20, gap = 4, head = 46, axis = 22, foot = 30, between = 20;
  const sc = chartScale(Math.max(...METHODS.map(m => d[m.key].makespan)));
  const x = t => P + L + t / sc.timeMax * (W - 2 * P - L - R);
  const cardH = head + axis + d.vms.length * (rowH + gap) + foot;
  const H = 2 * P + METHODS.length * cardH + (METHODS.length - 1) * between;
  const text = (s, tx, ty, size, fill, anchor, weight) => '<text x="' + tx + '" y="' + ty + '" font-size="' + size + '" fill="' + fill + '"' +
    (anchor ? ' text-anchor="' + anchor + '"' : "") + (weight ? ' font-weight="' + weight + '"' : "") + ">" + esc(s) + "</text>";
  let out = '<rect width="' + W + '" height="' + H + '" fill="' + v("--bg") + '"/>', y = P;
  METHODS.forEach(m => {
    const r = d[m.key], col = v(m.color);
    out += '<rect x="' + P + '" y="' + y + '" width="' + (W - 2 * P) + '" height="' + cardH + '" rx="8" fill="' + v("--panel") + '" stroke="' + v("--border") + '"/>';
    out += '<rect x="' + (P + 16) + '" y="' + (y + 17) + '" width="8" height="8" rx="2" fill="' + col + '"/>';
    out += text(m.name, P + 32, y + 26, 15, v("--text"), null, 600);
    out += text("Duration " + r.makespan.toFixed(1) + "   Cost $" + r.cost.toFixed(0) + "   Active " + r.utilization.toFixed(1) + "%", W - P - 16, y + 26, 12, v("--text2"), "end");
    sc.ticks.forEach(t => { out += text(Number.isInteger(t) ? t : t.toFixed(1), x(t), y + head + 12, 11, v("--muted"), "middle"); });
    d.vms.forEach((vm, i) => {
      const ry = y + head + axis + i * (rowH + gap);
      out += text("Node " + vm.id, P + 16, ry + 14, 11, v("--text2"));
      out += '<rect x="' + x(0) + '" y="' + ry + '" width="' + (x(sc.timeMax) - x(0)) + '" height="' + rowH + '" rx="3" fill="' + v("--sunken") + '"/>';
      r.tasks.filter(t => t.vm === vm.id).forEach(t => {
        const bw = x(t.end) - x(t.start);
        out += '<rect x="' + x(t.start) + '" y="' + (ry + 3) + '" width="' + Math.max(bw, 1) + '" height="' + (rowH - 6) + '" rx="2" fill="' + col + '" stroke="' + v("--sunken") + '"/>';
        if (bw > 18) out += text(t.id, x(t.start) + 4, ry + 14, 9, v("--bar-ink"), null, 600);
      });
    });
    const lineTop = y + head + axis - 2, lineBottom = y + head + axis + d.vms.length * (rowH + gap) - gap + 2;
    out += '<line x1="' + x(r.makespan) + '" x2="' + x(r.makespan) + '" y1="' + lineTop + '" y2="' + lineBottom + '" stroke="' + v("--text") + '" stroke-width="2"/>';
    out += text(r.makespan.toFixed(1), x(r.makespan), lineBottom + 16, 11, v("--text"), "middle", 600);
    y += cardH + between;
  });
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + " " + H + '" font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif">' + out + "</svg>";
}
$("#exportPng").addEventListener("click", () => {
  const d = state.data; if (!d) return;
  const img = new Image();
  img.onload = () => {
    const c = document.createElement("canvas"), k = 2;
    c.width = img.width * k; c.height = img.height * k;
    const g = c.getContext("2d"); g.scale(k, k); g.drawImage(img, 0, 0);
    c.toBlob(b => { if (b) download(exportName("png"), b); }, "image/png");
  };
  img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(timelinesSvg(d));
});

/* =====================================================================
   Averaged benchmarks
   ===================================================================== */
const STATIC_NAMES = { heft: "Priority-Optimized", ls: "Refined (standard)", cost_aware: "Budget-Optimized" };
const DYN_NAMES = { selective: "Selective repair", naive: "Full re-plan" };

function benchStep(n) {
  const prog = $("#benchProg");
  prog.hidden = false;
  prog.setAttribute("aria-valuenow", String(n));
  prog.firstElementChild.style.width = (n / 3 * 100) + "%";
}

$("#benchGo").addEventListener("click", async () => {
  const btn = $("#benchGo"), status = $("#benchStatus");
  btn.disabled = true;
  try {
    benchStep(0);
    status.textContent = "Step 1 of 3: comparing static schedules…";
    const s = await api("/api/benchmark/static");
    $("#benchStatic").innerHTML = '<h3 class="panel-title">Static comparison, ' + s.trials + ' trials</h3>' +
      '<div class="tablewrap"><table><thead><tr><th scope="col">Strategy</th><th scope="col" class="r">Duration</th><th scope="col" class="r">Cost</th><th scope="col" class="r">Active %</th><th scope="col" class="r">Balance</th></tr></thead><tbody>' +
      s.methods.map(m => "<tr><td>" + STATIC_NAMES[m.key] + '</td><td class="r num">' + m.makespan.toFixed(2) + '</td><td class="r num">$' + m.cost.toFixed(1) +
        '</td><td class="r num">' + m.utilization.toFixed(1) + '</td><td class="r num">' + m.loadBalance.toFixed(3) + "</td></tr>").join("") + "</tbody></table></div>";

    benchStep(1);
    status.textContent = "Step 2 of 3: simulating instance failure…";
    const dy = await api("/api/benchmark/dynamic");
    $("#benchDynamic").innerHTML = '<h3 class="panel-title">Instance failure recovery, ' + dy.trials + ' trials</h3>' +
      '<div class="tablewrap"><table><thead><tr><th scope="col">Approach</th><th scope="col" class="r">Tasks touched</th><th scope="col" class="r">Recovery ms</th><th scope="col" class="r">Stability %</th><th scope="col" class="r">Duration</th></tr></thead><tbody>' +
      dy.methods.map(m => "<tr><td>" + DYN_NAMES[m.key] + '</td><td class="r num">' + m.tasksTouched.toFixed(1) + '</td><td class="r num">' + m.repairMs.toFixed(3) +
        '</td><td class="r num">' + m.stability.toFixed(1) + '</td><td class="r num">' + m.makespan.toFixed(1) + "</td></tr>").join("") + "</tbody></table></div>";

    benchStep(2);
    status.textContent = "Step 3 of 3: sweeping the budget weight…";
    state.trade = await api("/api/benchmark/tradeoff");
    renderTradeoff(state.trade);
    benchStep(3);
    status.textContent = "Done.";
    setTimeout(() => { $("#benchProg").hidden = true; }, 700);
  } catch (err) {
    status.textContent = "Failed: " + err.message;
    $("#benchProg").hidden = true;
  } finally { btn.disabled = false; }
});

function renderTradeoff(pts) {
  const box = $("#benchTrade");
  const W = Math.max(320, Math.round(box.clientWidth) || 640), H = 260, pl = 60, pr = 28, pt = 24, pb = 48;
  const ms = pts.map(p => p.makespan), cs = pts.map(p => p.cost);
  const x0 = Math.min(...ms), x1 = Math.max(...ms), y0 = Math.min(...cs), y1 = Math.max(...cs);
  const x = v => pl + (x1 === x0 ? 0.5 : (v - x0) / (x1 - x0)) * (W - pl - pr);
  const y = v => pt + (1 - (y1 === y0 ? 0.5 : (v - y0) / (y1 - y0))) * (H - pt - pb);
  box.innerHTML = '<h3 class="panel-title">Cost versus duration across budget weights</h3>' +
    '<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Cost versus duration for budget weights from ' + pts[0].beta.toFixed(2) + " to " + pts[pts.length - 1].beta.toFixed(2) + '">' +
    '<line class="grid" x1="' + pl + '" x2="' + pl + '" y1="' + pt + '" y2="' + (H - pb) + '"/><line class="grid" x1="' + pl + '" x2="' + (W - pr) + '" y1="' + (H - pb) + '" y2="' + (H - pb) + '"/>' +
    '<polyline class="ln" points="' + pts.map(p => x(p.makespan).toFixed(1) + "," + y(p.cost).toFixed(1)).join(" ") + '"/>' +
    pts.map((p, i) => {
      const last = i === pts.length - 1; /* labels sit up and to the right of each point; the last one flips left to stay inside the chart */
      return '<circle class="pt" r="4" cx="' + x(p.makespan).toFixed(1) + '" cy="' + y(p.cost).toFixed(1) + '"/>' +
        '<text class="axis num" text-anchor="' + (last ? "end" : "start") + '" x="' + (x(p.makespan) + (last ? -8 : 8)).toFixed(1) + '" y="' + (y(p.cost) - 8).toFixed(1) + '">β ' + p.beta.toFixed(2) + "</text>";
    }).join("") +
    '<text class="axis num" x="' + (pl - 8) + '" y="' + (pt + 4) + '" text-anchor="end">$' + y1.toFixed(0) + '</text>' +
    '<text class="axis num" x="' + (pl - 8) + '" y="' + (H - pb + 4) + '" text-anchor="end">$' + y0.toFixed(0) + "</text>" +
    '<text class="axis num" x="' + pl + '" y="' + (H - pb + 18) + '">' + x0.toFixed(0) + "</text>" +
    '<text class="axis num" x="' + (W - pr) + '" y="' + (H - pb + 18) + '" text-anchor="end">' + x1.toFixed(0) + "</text>" +
    '<text class="axis-title" x="' + ((pl + W - pr) / 2) + '" y="' + (H - 8) + '" text-anchor="middle">Duration (time units)</text>' +
    '<text class="axis-title" transform="rotate(-90 14 ' + ((pt + H - pb) / 2) + ')" x="14" y="' + ((pt + H - pb) / 2) + '" text-anchor="middle">Cost</text></svg>';
}

/* =====================================================================
   Theme + boot
   ===================================================================== */
(function theme() {
  const root = document.documentElement, btn = $("#themeBtn"), meta = document.querySelector('meta[name="theme-color"]');
  const paint = () => {
    const dark = root.dataset.theme === "dark", label = dark ? "Switch to light theme" : "Switch to dark theme";
    btn.setAttribute("aria-label", label); btn.title = label;
    if (meta) meta.content = dark ? "#07090a" : "#eef1f2";
  };
  btn.addEventListener("click", () => {
    const next = root.dataset.theme === "dark" ? "light" : "dark";
    root.dataset.theme = next;
    try { localStorage.setItem("fleet-theme", next); } catch (e) { /* storage unavailable */ }
    paint();
  });
  paint();
})();

/* charts are drawn at their real pixel width, so redraw them when the width changes */
if ("ResizeObserver" in window) {
  let lastW = 0, raf = 0;
  new ResizeObserver(entries => {
    const w = Math.round(entries[0].contentRect.width);
    if (w === lastW) return;
    lastW = w;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      if (state.data && !$("#results").hidden) renderTrace(state.data, false);
      if (state.trade) renderTradeoff(state.trade);
    });
  }).observe(document.querySelector(".page"));
}

buildSteps();
buildBars();
buildToggles();
readUrl();
generate(false);
