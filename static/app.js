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
const MIN_WAIT_MS = 1300;

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

function countTo(el, target, { dec = 1, dur = 800 } = {}) {
  if (reduceMotion || dur <= 0) { el.textContent = target.toFixed(dec); return; }
  const t0 = performance.now();
  (function tick(now) {
    const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
    el.textContent = (target * e).toFixed(dec);
    if (k < 1) requestAnimationFrame(tick);
  })(t0);
}

const state = { data: null, trade: null, metric: "makespan", loading: false };

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

/* =====================================================================
   Controls
   ===================================================================== */
[["tasks", "tasksOut", v => v], ["vms", "vmsOut", v => v], ["beta", "betaOut", v => (+v).toFixed(2)]].forEach(([id, out, fmt]) => {
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
  const gap = Math.max(40, Math.min(220, budgetMs / Math.max(els.length, 1)));
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
  const t0 = performance.now();
  try {
    const qs = new URLSearchParams({ tasks: $("#tasks").value, vms: $("#vms").value, beta: $("#beta").value, seed: $("#seed").value.trim() });
    if (find) qs.set("find", "1");
    const data = await api("/api/schedule?" + qs);
    await revealStages(data.stages, Math.max(MIN_WAIT_MS - (performance.now() - t0), 600));
    state.data = data;
    $("#seed").value = data.instance.seed;
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
  renderBadges(d);
  renderBars(d, true);
  renderTrace(d, true);
  renderOps(d);
  renderFleet(d);
  renderGantts(d);
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

/* ---------- schedule timelines ---------- */
function niceStep(max) {
  const raw = max / 6, mag = Math.pow(10, Math.floor(Math.log10(raw))), n = raw / mag;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
}
function idleGaps(tasks, makespan) {
  const sorted = tasks.slice().sort((a, b) => a.start - b.start);
  const gaps = []; let cursor = 0;
  sorted.forEach(t => { if (t.start > cursor + 1e-6) gaps.push([cursor, t.start]); cursor = Math.max(cursor, t.end); });
  if (makespan > cursor + 1e-6) gaps.push([cursor, makespan]);
  return gaps;
}
function renderGantts(d) {
  const timeMax = Math.max(...METHODS.map(m => d[m.key].makespan)) * 1.02;
  const step = niceStep(timeMax);
  const ticks = []; for (let t = 0; t <= timeMax; t += step) ticks.push(t);
  const pos = v => (v / timeMax * 100);

  const html = METHODS.map(m => {
    const r = d[m.key], ref = m.ref ? d[m.ref] : null, refM = METHODS.find(x => x.key === m.ref);
    let chip = "";
    if (ref) {
      const ch = pct(ref.makespan, r.makespan);
      const cls = ch < -0.05 ? "good" : ch > 0.05 ? "bad" : "";
      chip = '<span class="gchip ' + cls + '">' + (Math.abs(ch) < 0.05 ? "Same as " : sgn(ch) + " vs ") + refM.name + "</span>";
    }
    const axis = '<div class="grow"><span></span><div class="taxis">' +
      ticks.map(t => '<span class="num" style="left:' + pos(t) + '%">' + (Number.isInteger(t) ? t : t.toFixed(1)) + "</span>").join("") + "</div></div>";
    const rows = d.vms.map(v => {
      const mine = r.tasks.filter(t => t.vm === v.id);
      const idle = idleGaps(mine, r.makespan).map(([a, b]) => '<div class="gap" style="left:' + pos(a) + "%;width:" + pos(b - a) + '%"></div>').join("");
      const bars = mine.map((t, k) => {
        const w = pos(t.end - t.start);
        const tip = "Task " + t.id + " · Node " + v.id + " · " + t.start.toFixed(1) + "–" + t.end.toFixed(1) + " · $" + t.cost.toFixed(1);
        return '<div class="bar" role="img" aria-label="' + tip.split(" · ").join(", ") + '" data-id="' + t.id +
          '" style="left:' + pos(t.start) + "%;width:" + w + "%;--d:" + Math.min(k * 25, 500) + 'ms" data-tip="' + tip + '">' + (w > 3.2 ? t.id : "") + "</div>";
      }).join("");
      return '<div class="grow"><span class="glabel">Node ' + v.id + " <small>×" + v.speed.toFixed(1) + '</small></span><div class="track">' + idle + bars + "</div></div>";
    }).join("");
    return '<article class="gcard" data-k="' + m.key + '" style="--c:var(' + m.color + ')" aria-label="' + m.name + ' schedule">' +
      '<div class="ghead"><div><h3 class="gname"><i class="dot"></i>' + m.name + '</h3><p class="gblurb">' + m.blurb + "</p></div>" +
      '<div class="gmeta"><span>Duration<b class="num">' + r.makespan.toFixed(1) + '</b></span><span>Cost<b class="num">$' + r.cost.toFixed(0) +
      '</b></span><span>Active<b class="num">' + r.utilization.toFixed(1) + "%</b></span>" + chip + "</div></div>" +
      '<div class="gscroll"><div class="gchart">' + axis + '<div class="gbody">' + rows +
      '<div class="goverlay"><div class="done-line" style="left:' + pos(r.makespan) + '%"><span class="flag num">' + r.makespan.toFixed(1) + "</span></div>" +
      (ref ? '<div class="ref-line" style="left:' + pos(ref.makespan) + '%"></div>' : "") + "</div></div></div></div>" +
      '<details class="info"><summary>Strategy details</summary><p>' + m.info + "</p></details></article>";
  }).join("");
  const box = $("#gantts");
  box.innerHTML = html;
  box.classList.toggle("show-idle", $("#idleToggle").checked);
}

/* ---------- shared tooltip + cross-strategy task highlight ---------- */
const tip = $("#tip");
let hlId = null;
function setHl(id) {
  if (id === hlId) return; hlId = id;
  const g = $("#gantts");
  g.querySelectorAll(".bar.hl").forEach(b => b.classList.remove("hl"));
  g.classList.toggle("hovering", id !== null);
  if (id !== null) g.querySelectorAll('.bar[data-id="' + id + '"]').forEach(b => b.classList.add("hl"));
}
document.addEventListener("pointermove", e => {
  const bar = e.target.closest && e.target.closest(".bar[data-tip]");
  if (!bar) { tip.classList.remove("on"); setHl(null); return; }
  const [a, ...rest] = bar.dataset.tip.split(" · ");
  tip.innerHTML = "<b>" + a + "</b>" + rest.map(x => "<span>" + x + "</span>").join("");
  const x = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8), y = Math.min(e.clientY + 14, innerHeight - tip.offsetHeight - 8);
  tip.style.transform = "translate(" + x + "px," + y + "px)";
  tip.classList.add("on"); setHl(bar.dataset.id);
});
document.addEventListener("mouseout", e => { if (!e.relatedTarget) { tip.classList.remove("on"); setHl(null); } });

/* =====================================================================
   Averaged benchmarks
   ===================================================================== */
const STATIC_NAMES = { heft: "Priority-Optimized", ls: "Refined (standard)", cost_aware: "Budget-Optimized" };
const DYN_NAMES = { selective: "Selective repair", naive: "Sequential re-run" };

$("#benchGo").addEventListener("click", async () => {
  const btn = $("#benchGo"), status = $("#benchStatus");
  btn.disabled = true;
  try {
    status.textContent = "Comparing static schedules…";
    const s = await api("/api/benchmark/static");
    $("#benchStatic").innerHTML = '<h3 class="panel-title">Static comparison, ' + s.trials + ' trials</h3>' +
      '<div class="tablewrap"><table><thead><tr><th scope="col">Strategy</th><th scope="col" class="r">Duration</th><th scope="col" class="r">Cost</th><th scope="col" class="r">Active %</th><th scope="col" class="r">Balance</th></tr></thead><tbody>' +
      s.methods.map(m => "<tr><td>" + STATIC_NAMES[m.key] + '</td><td class="r num">' + m.makespan.toFixed(2) + '</td><td class="r num">$' + m.cost.toFixed(1) +
        '</td><td class="r num">' + m.utilization.toFixed(1) + '</td><td class="r num">' + m.loadBalance.toFixed(3) + "</td></tr>").join("") + "</tbody></table></div>";

    status.textContent = "Simulating instance failure…";
    const dy = await api("/api/benchmark/dynamic");
    $("#benchDynamic").innerHTML = '<h3 class="panel-title">Instance failure recovery, ' + dy.trials + ' trials</h3>' +
      '<div class="tablewrap"><table><thead><tr><th scope="col">Approach</th><th scope="col" class="r">Tasks touched</th><th scope="col" class="r">Recovery ms</th><th scope="col" class="r">Stability %</th><th scope="col" class="r">Duration</th></tr></thead><tbody>' +
      dy.methods.map(m => "<tr><td>" + DYN_NAMES[m.key] + '</td><td class="r num">' + m.tasksTouched.toFixed(1) + '</td><td class="r num">' + m.repairMs.toFixed(3) +
        '</td><td class="r num">' + m.stability.toFixed(1) + '</td><td class="r num">' + m.makespan.toFixed(1) + "</td></tr>").join("") + "</tbody></table></div>";

    status.textContent = "Sweeping the budget weight…";
    state.trade = await api("/api/benchmark/tradeoff");
    renderTradeoff(state.trade);
    status.textContent = "Done.";
  } catch (err) {
    status.textContent = "Failed: " + err.message;
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
generate(false);
