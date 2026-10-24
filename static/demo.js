"use strict";
/* In-browser stand-in for the Flask API, loaded only by index.html so the page
   still works on static hosting (e.g. GitHub Pages). All numbers are simulated. */
window.DEMO_API = (function () {
  function rng(a) {
    return () => {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function mockRun(n, m, beta, seed) {
    const R = rng(seed);
    const vms = Array.from({ length: m }, (_, i) => {
      const sp = Math.round((.8 + R() * 1.6) * 10) / 10;
      return { id: i + 1, speed: sp, cost_per_hour: Math.round((.2 + sp * .25 * (.8 + R() * .4)) * 100) / 100 };
    });
    const base = Array.from({ length: n }, () => 4 + R() * 16);
    const build = (as, ord) => {
      const free = Array(m).fill(0), busy = Array(m).fill(0), cnt = Array(m).fill(0), tasks = []; let cost = 0;
      ord.forEach(t => {
        const v = as[t], d = base[t] / vms[v].speed, c = d * vms[v].cost_per_hour;
        tasks.push({ id: t + 1, vm: vms[v].id, start: free[v], end: free[v] + d, cost: c });
        free[v] += d; busy[v] += d; cnt[v]++; cost += c;
      });
      const mk = Math.max(...free), mean = busy.reduce((a, b) => a + b, 0) / m;
      const sd = Math.sqrt(busy.reduce((a, b) => a + (b - mean) ** 2, 0) / m);
      return { makespan: mk, cost, utilization: mean / mk * 100, loadBalance: sd / mean, tasks, vmUtil: busy.map(b => b / mk), vmTasks: cnt };
    };
    const idx = base.map((_, i) => i), ord = idx.slice().sort((a, b) => base[b] - base[a]);
    const greedy = w => {
      const free = Array(m).fill(0), as = [];
      ord.forEach(t => {
        let b = 0, bs = 1e9;
        vms.forEach((v, i) => {
          const d = base[t] / v.speed, sc = (1 - w) * (free[i] + d) + w * d * v.cost_per_hour * 12;
          if (sc < bs) { bs = sc; b = i; }
        });
        free[b] += base[t] / vms[b].speed; as[t] = b;
      });
      return as;
    };
    const as0 = greedy(0), naive = build(idx.map(i => i % m), idx), heft = build(as0, ord), costAware = build(greedy(beta), ord);
    let as = as0.slice(), o = ord.slice(), best = heft.makespan;
    const trace = [best], N = 1500;
    const ops = { move: { a: 0, x: 0 }, swap: { a: 0, x: 0 }, reorder: { a: 0, x: 0 } }, kinds = Object.keys(ops);
    for (let k = 0; k < N; k++) {
      const kind = kinds[k % 3], a2 = as.slice(), o2 = o.slice(), i = R() * n | 0, j = R() * n | 0;
      if (kind === "move") a2[i] = R() * m | 0;
      else if (kind === "swap") { const t = a2[i]; a2[i] = a2[j]; a2[j] = t; }
      else { const t = o2[i]; o2[i] = o2[j]; o2[j] = t; }
      const mk = build(a2, o2).makespan; ops[kind].a++;
      if (mk < best - 1e-9) { best = mk; as = a2; o = o2; ops[kind].x++; }
      if (k % 25 === 24) trace.push(best);
    }
    return {
      instance: { seed }, vms, naive, heft, ils: build(as, o), cost_aware: costAware, trace, traceLength: N,
      operators: kinds.map(name => ({ name, attempts: ops[name].a, feasible: ops[name].a, accepted: ops[name].x })),
      /* the dashboard matches stages by position, so these labels are only descriptive */
      stages: Array.from({ length: 6 }, (_, i) => ({ label: "Stage " + (i + 1), ms: +(.3 + R() * 18).toFixed(1) })),
    };
  }

  return function mockApi(path) {
    const u = new URL(path, "http://x"), q = u.searchParams;
    if (u.pathname.endsWith("/schedule")) {
      const n = +q.get("tasks") || 30, m = +q.get("vms") || 6, b = +q.get("beta") || 0;
      let seed = q.get("seed") ? +q.get("seed") : Math.random() * 1e4 | 0;
      let d = mockRun(n, m, b, seed);
      if (q.get("find")) for (let k = 1; k <= 25 && d.heft.makespan - d.ils.makespan < .05; k++) { seed += k; d = mockRun(n, m, b, seed); }
      return d;
    }
    if (u.pathname.endsWith("/static")) {
      const runs = Array.from({ length: 20 }, (_, i) => mockRun(30, 6, .4, i + 1));
      const avg = (key, f) => runs.reduce((a, r) => a + r[key][f], 0) / runs.length;
      const row = (key, src) => ({ key, makespan: avg(src, "makespan"), cost: avg(src, "cost"), utilization: avg(src, "utilization"), loadBalance: avg(src, "loadBalance") });
      return { trials: 20, methods: [row("heft", "heft"), row("ls", "ils"), row("cost_aware", "cost_aware")] };
    }
    if (u.pathname.endsWith("/dynamic")) {
      const mk = Array.from({ length: 20 }, (_, i) => mockRun(30, 6, .4, i + 1).heft.makespan).reduce((a, b) => a + b, 0) / 20;
      return { trials: 20, methods: [
        { key: "selective", tasksTouched: 4.2, repairMs: .08, stability: 86.5, makespan: mk * 1.04 },
        { key: "naive", tasksTouched: 30, repairMs: 1.4, stability: 12, makespan: mk * 1.12 },
      ] };
    }
    return [0, .2, .4, .6, .8, .95].map(b => { const d = mockRun(30, 6, b, 42); return { beta: b, makespan: d.cost_aware.makespan, cost: d.cost_aware.cost }; });
  };
})();
