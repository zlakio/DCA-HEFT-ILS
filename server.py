"""Bridge between the Python scheduler (core/) and the browser dashboards.

Run:  python server.py
Open: http://localhost:5000          (dashboard -> dashboard.html)
      http://localhost:5000/classic  (old page -> frontend.html, if you still have it)

API:  /api/schedule          one workload scheduled four ways (+ task dependencies)
      /api/event             fail or slow down an instance mid-run and repair it
      /api/benchmark/...     averaged results (cached, they are deterministic)

Why the lock?  core/ seeds Python's *global* random generator, so two requests
running at once would corrupt each other's "reproducible" results.  Every heavy
endpoint takes LOCK so they run one at a time.
"""
import json
import math
import random
import statistics
import threading
import time

from flask import Flask, Response, jsonify, request, send_from_directory

from core.benchmark import (
    _schedule_stability,
    naive_full_reschedule,
    run_dynamic_benchmark,
    run_static_benchmark,
)
from core.cost_model import (
    compute_average_utilization,
    compute_load_balance_index,
    compute_schedule_cost,
    compute_task_cost,
)
from core.dag_generator import generate_random_dag
from core.dynamic_events import VMFailureEvent, VMSlowdownEvent
from core.heft_engine import (
    _earliest_finish_time_on_vm,
    compute_upward_ranks,
    heft_schedule,
)
from core.local_search import (
    EPSILON,
    MUTATION_OPERATORS,
    cost_aware_local_search,
    is_feasible,
    local_search,
)
from core.models import VM, Assignment, Schedule
from core.selective_reopt import handle_event
from core.vm_generator import generate_vm_pool

app = Flask(__name__)
LOCK = threading.Lock()

MAX_TASKS, MAX_VMS = 120, 16
TRACE_POINTS = 120
STRATEGIES = ("naive", "heft", "ils", "cost_aware")

# Benchmarks are deterministic for a given (trials, seed), so remember them.
# Always read and written while holding LOCK.
_BENCH_CACHE = {}
_BENCH_CACHE_MAX = 32


def cached(key, compute):
    """Return the stored result for `key`, computing it once. Call under LOCK."""
    if key not in _BENCH_CACHE:
        if len(_BENCH_CACHE) >= _BENCH_CACHE_MAX:
            _BENCH_CACHE.clear()
        _BENCH_CACHE[key] = compute()
    return _BENCH_CACHE[key]


def int_arg(name, default, lo, hi):
    """Read an integer query parameter, clamped to [lo, hi]."""
    return max(lo, min(hi, int(request.args.get(name, default))))


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def vms_to_json(vms):
    return [{"id": v.id, "speed": round(v.speed, 2),
             "cost_per_hour": round(v.cost_per_hour, 2)} for v in vms]


def schedule_to_json(schedule, dag, vms):
    """Gantt data + headline metrics + per-VM workload for one schedule."""
    vm_by_id = {vm.id: vm for vm in vms}
    busy = {v.id: 0.0 for v in vms}
    count = {v.id: 0 for v in vms}
    for a in schedule.assignments.values():
        busy[a.vm_id] += a.end_time - a.start_time
        count[a.vm_id] += 1
    makespan = schedule.makespan()
    return {
        "tasks": [
            {
                "id": a.task_id,
                "vm": a.vm_id,
                "start": round(a.start_time, 2),
                "end": round(a.end_time, 2),
                "cost": round(compute_task_cost(a.task_id, schedule, dag, vm_by_id), 2),
            }
            for a in sorted(schedule.assignments.values(), key=lambda a: a.task_id)
        ],
        "makespan": round(makespan, 2),
        "cost": round(compute_schedule_cost(schedule, dag, vms), 2),
        "utilization": round(compute_average_utilization(schedule, vms), 2),
        "loadBalance": round(compute_load_balance_index(schedule, vms), 4),
        "vmBusy": [round(busy[v.id], 2) for v in vms],
        "vmTasks": [count[v.id] for v in vms],
        "vmUtil": [round(busy[v.id] / makespan, 4) if makespan > 0 else 0.0 for v in vms],
    }


def build_instance(num_tasks, num_vms, seed):
    levels = max(3, min(14, round(math.sqrt(num_tasks)) + 1))
    dag = generate_random_dag(num_tasks, levels, edge_probability=0.3, seed=seed)
    vms = generate_vm_pool(num_vms, seed=seed, max_speed=8.0)
    return dag, vms


def round_robin_schedule(dag, vms):
    """Naive baseline: deal tasks to VMs in turn, in dependency order."""
    schedule = Schedule()
    for i, task_id in enumerate(dag.topological_order()):
        vm = vms[i % len(vms)]
        start, end = _earliest_finish_time_on_vm(dag.tasks[task_id], vm, dag, schedule)
        schedule.assignments[task_id] = Assignment(task_id, vm.id, start, end)
    return schedule


def iteration_budget(num_tasks):
    """Shrink the search budget as graphs grow so a click stays responsive."""
    return max(300, min(1000, int(1000 * (40 / max(num_tasks, 1)) ** 1.5)))


def traced_ils(initial, dag, vms, iterations, seed, per_round=100, kick=5):
    """Iterated local search, same algorithm as core.local_search.iterated_local_search,
    but it also records (a) the best makespan after every iteration and
    (b) per-operator attempts / feasible / accepted counts."""
    random.seed(seed)
    ops = {op.__name__.replace("mutate_", ""): {"attempts": 0, "feasible": 0, "accepted": 0}
           for op in MUTATION_OPERATORS}
    current = best = initial
    trace = [initial.makespan()]
    rounds = max(1, iterations // per_round)

    for _ in range(rounds):
        for _ in range(per_round):
            op = random.choice(MUTATION_OPERATORS)
            stats = ops[op.__name__.replace("mutate_", "")]
            stats["attempts"] += 1
            candidate = op(current, dag, vms)
            if is_feasible(candidate, dag):
                stats["feasible"] += 1
                if candidate.makespan() < current.makespan() - EPSILON:
                    current = candidate
                    stats["accepted"] += 1
            trace.append(min(best.makespan(), current.makespan()))
        if current.makespan() < best.makespan() - EPSILON:
            best = current
        for _ in range(kick):  # perturbation: accept feasible-but-worse moves
            op = random.choice(MUTATION_OPERATORS)
            candidate = op(current, dag, vms)
            if is_feasible(candidate, dag):
                current = candidate

    if current.makespan() < best.makespan() - EPSILON:
        best = current
    trace.append(best.makespan())
    return best, trace, ops


def downsample(values, points=TRACE_POINTS):
    if len(values) <= points:
        return [round(v, 2) for v in values]
    step = (len(values) - 1) / (points - 1)
    return [round(values[round(i * step)], 2) for i in range(points)]


def find_improving_seed(num_tasks, num_vms, start_seed, iterations, tries=30, min_gain=0.5):
    """Scan seeds until the local search beats HEFT by at least `min_gain` %."""
    for k in range(tries):
        seed = start_seed + k
        dag, vms = build_instance(num_tasks, num_vms, seed)
        heft = heft_schedule(dag, vms)
        best, _, _ = traced_ils(heft, dag, vms, iterations, seed)
        gain = (heft.makespan() - best.makespan()) / heft.makespan() * 100
        if gain >= min_gain:
            return seed, k + 1
    return None, tries


def run_pipeline(num_tasks, num_vms, seed, beta, iterations):
    stages = []

    def timed(label, fn):
        t0 = time.perf_counter()
        value = fn()
        stages.append({"label": label, "ms": round((time.perf_counter() - t0) * 1000, 2)})
        return value

    dag, vms = timed("Generate workflow", lambda: build_instance(num_tasks, num_vms, seed))
    naive = timed("Round-robin", lambda: round_robin_schedule(dag, vms))
    timed("Rank tasks", lambda: compute_upward_ranks(dag))
    heft = timed("HEFT", lambda: heft_schedule(dag, vms))
    ils, trace, ops = timed(
        "Iterated local search", lambda: traced_ils(heft, dag, vms, iterations, seed)
    )
    cost_aware, _ = timed(
        "Cost-aware search",
        lambda: cost_aware_local_search(
            heft, dag, vms,
            alpha=(1.0 - beta) * 0.8, beta=beta, gamma=(1.0 - beta) * 0.2,
            max_iterations=max(200, iterations // 2), seed=seed,
        ),
    )

    return {
        "instance": {
            "num_tasks": num_tasks,
            "num_vms": num_vms,
            "num_edges": sum(len(t.successors) for t in dag.tasks.values()),
            "seed": seed,
            "beta": beta,
            "iterations": iterations,
        },
        "vms": vms_to_json(vms),
        # [predecessor, successor] pairs, so the dashboard can show what each task waits on
        "edges": [[t.id, s] for t in dag.tasks.values() for s in t.successors],
        "stages": stages,
        "naive": schedule_to_json(naive, dag, vms),
        "heft": schedule_to_json(heft, dag, vms),
        "ils": schedule_to_json(ils, dag, vms),
        "cost_aware": schedule_to_json(cost_aware, dag, vms),
        "trace": downsample(trace),
        "traceLength": len(trace),
        "operators": [{"name": k, **v} for k, v in ops.items()],
    }


# ---------------------------------------------------------------------------
# Pages
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return send_from_directory(".", "dashboard.html")


@app.route("/classic")
def classic():
    return send_from_directory(".", "frontend.html")


# ---------------------------------------------------------------------------
# New dashboard API
# ---------------------------------------------------------------------------

def parse_instance_args(require_seed=False):
    """Read tasks / vms / beta / seed from the query string (raises ValueError)."""
    num_tasks = max(5, min(MAX_TASKS, int(request.args.get("tasks", 30))))
    num_vms = max(2, min(MAX_VMS, int(request.args.get("vms", 6))))
    beta = float(request.args.get("beta", 0.4))
    if not math.isfinite(beta):
        raise ValueError("beta must be a finite number")
    beta = max(0.0, min(0.95, beta))
    seed_arg = request.args.get("seed", "").strip()
    if seed_arg:
        seed = int(seed_arg)
    elif require_seed:
        raise ValueError("seed is required")
    else:
        seed = random.randrange(10_000)
    return num_tasks, num_vms, beta, seed


@app.route("/api/schedule")
def api_schedule():
    """Generate a workflow and schedule it five ways. Query params:
    tasks, vms, seed (blank = random), beta, find=1 (scan for a seed where search helps)."""
    try:
        num_tasks, num_vms, beta, seed = parse_instance_args()
    except ValueError:
        return jsonify({"error": "tasks, vms, seed and beta must be numbers"}), 400

    iterations = iteration_budget(num_tasks)
    scan = None
    with LOCK:
        if request.args.get("find") == "1":
            found, tries = find_improving_seed(num_tasks, num_vms, seed, iterations)
            scan = {"found": found is not None, "tries": tries}
            if found is not None:
                seed = found
        result = run_pipeline(num_tasks, num_vms, seed, beta, iterations)
    if scan:
        result["scan"] = scan
    return jsonify(result)


# ---------------------------------------------------------------------------
# Disruption: fail or slow down one instance, then repair selectively
# ---------------------------------------------------------------------------

def schedule_for_strategy(name, dag, vms, num_tasks, seed, beta):
    """Rebuild one of the four dashboard schedules. Mirrors run_pipeline, and the
    searches are seeded, so this reproduces exactly what /api/schedule returned."""
    if name == "naive":
        return round_robin_schedule(dag, vms)
    heft = heft_schedule(dag, vms)
    if name == "heft":
        return heft
    iterations = iteration_budget(num_tasks)
    if name == "ils":
        best, _, _ = traced_ils(heft, dag, vms, iterations, seed)
        return best
    result, _ = cost_aware_local_search(
        heft, dag, vms,
        alpha=(1.0 - beta) * 0.8, beta=beta, gamma=(1.0 - beta) * 0.2,
        max_iterations=max(200, iterations // 2), seed=seed,
    )
    return result


def _moved_task_ids(before, after):
    """Tasks whose instance or start time differs between two schedules."""
    moved = []
    for tid, old in before.assignments.items():
        new = after.assignments.get(tid)
        if new is None or new.vm_id != old.vm_id or abs(new.start_time - old.start_time) > 1e-6:
            moved.append(tid)
    return sorted(moved)


@app.route("/api/event")
def api_event():
    """Fail or slow down one instance partway through a schedule and repair it.
    Params: tasks, vms, beta, seed (all required to reproduce the run on screen),
    strategy (naive|heft|ils|cost_aware), type (failure|slowdown), vm (instance id),
    at (0-0.95, fraction of the schedule's duration), factor (slowdown speed, 0.1-0.9).
    Compares the selective repair against a full re-plan of every unfinished task."""
    try:
        num_tasks, num_vms, beta, seed = parse_instance_args(require_seed=True)
        strategy = request.args.get("strategy", "heft")
        kind = request.args.get("type", "failure")
        vm_id = int(request.args.get("vm", ""))
        at = float(request.args.get("at", 0.4))
        factor = float(request.args.get("factor", 0.5))
    except ValueError as exc:
        return jsonify({"error": "invalid parameters: " + str(exc)}), 400
    if strategy not in STRATEGIES:
        return jsonify({"error": "strategy must be one of " + ", ".join(STRATEGIES)}), 400
    if kind not in ("failure", "slowdown"):
        return jsonify({"error": "type must be failure or slowdown"}), 400
    if not (math.isfinite(at) and math.isfinite(factor)):
        return jsonify({"error": "at and factor must be finite numbers"}), 400
    at = max(0.0, min(0.95, at))
    factor = max(0.1, min(0.9, factor))

    with LOCK:
        dag, vms = build_instance(num_tasks, num_vms, seed)
        if vm_id not in {v.id for v in vms}:
            return jsonify({"error": "instance %d does not exist in this run" % vm_id}), 400
        before = schedule_for_strategy(strategy, dag, vms, num_tasks, seed, beta)
        current_time = before.makespan() * at

        if kind == "failure":
            event = VMFailureEvent(vm_id=vm_id, time=current_time)
            replan_vms = vms
        else:
            event = VMSlowdownEvent(vm_id=vm_id, time=current_time, speed_multiplier=factor)
            # a full re-plan has to see the slowed instance too
            replan_vms = [VM(v.id, v.speed * factor, v.cost_per_hour) if v.id == vm_id else v
                          for v in vms]

        t0 = time.perf_counter()
        after, _, _, affected = handle_event(dag, vms, before, event, current_time, threshold=0.0)
        selective_ms = (time.perf_counter() - t0) * 1000

        t0 = time.perf_counter()
        full = naive_full_reschedule(dag, replan_vms, before, event, current_time)
        full_ms = (time.perf_counter() - t0) * 1000

        unfinished = sum(1 for a in before.assignments.values() if a.end_time > current_time)
        result = {
            "event": {"type": kind, "vm": vm_id, "time": round(current_time, 2), "at": at,
                      "factor": factor, "strategy": strategy},
            "ignored": not affected,
            "before": schedule_to_json(before, dag, vms),
            "after": schedule_to_json(after, dag, vms),
            "affected": sorted(affected),
            "moved": _moved_task_ids(before, after),
            "selective": {
                "touched": len(affected),
                "ms": round(selective_ms, 3),
                "makespan": round(after.makespan(), 2),
                "stability": round(_schedule_stability(before, after), 1),
            },
            "naive": {
                "touched": unfinished,
                "ms": round(full_ms, 3),
                "makespan": round(full.makespan(), 2),
                "stability": round(_schedule_stability(before, full), 1),
            },
        }
    return jsonify(result)


# ---------------------------------------------------------------------------
# Averaged benchmarks (same shapes as STATIC / DYNAMIC / TRADEOFF)
# ---------------------------------------------------------------------------

def _avg(rows, key):
    return statistics.mean(r[key] for r in rows)


@app.route("/api/benchmark/static")
def benchmark_static():
    try:
        trials = int_arg("trials", 30, 1, 100)
        seed_base = int_arg("seed", 1000, 0, 10**9)
    except ValueError:
        return jsonify({"error": "trials and seed must be whole numbers"}), 400

    def compute():
        rows = run_static_benchmark(
            num_trials=trials, num_tasks=20, num_levels=6, num_vms=5,
            ls_iterations=500, seed_base=seed_base,
        )
        return {
            "trials": len(rows),
            "methods": [
                {
                    "key": key,
                    "makespan": round(_avg(rows, f"{key}_makespan"), 2),
                    "cost": round(_avg(rows, f"{key}_cost"), 2),
                    "utilization": round(_avg(rows, f"{key}_utilization"), 2),
                    "loadBalance": round(_avg(rows, f"{key}_load_balance"), 4),
                }
                for key in ("heft", "ls", "cost_aware")
            ],
        }

    with LOCK:
        return jsonify(cached(("static", trials, seed_base), compute))


@app.route("/api/benchmark/dynamic")
def benchmark_dynamic():
    try:
        trials = int_arg("trials", 20, 1, 100)
        seed_base = int_arg("seed", 2000, 0, 10**9)
    except ValueError:
        return jsonify({"error": "trials and seed must be whole numbers"}), 400

    def compute():
        rows = run_dynamic_benchmark(
            num_trials=trials, num_tasks=25, num_levels=7, num_vms=6, seed_base=seed_base,
        )
        return {
            "trials": len(rows),
            "methods": [
                {
                    "key": "selective",
                    "tasksTouched": round(_avg(rows, "tasks_touched_selective"), 2),
                    "repairMs": round(_avg(rows, "selective_time_sec") * 1000, 4),
                    "stability": round(_avg(rows, "stability_selective"), 1),
                    "makespan": round(_avg(rows, "selective_makespan"), 2),
                },
                {
                    "key": "naive",
                    "tasksTouched": round(_avg(rows, "tasks_touched_naive"), 2),
                    "repairMs": round(_avg(rows, "naive_time_sec") * 1000, 4),
                    "stability": round(_avg(rows, "stability_naive"), 1),
                    "makespan": round(_avg(rows, "naive_makespan"), 2),
                },
            ],
        }

    with LOCK:
        return jsonify(cached(("dynamic", trials, seed_base), compute))


@app.route("/api/benchmark/tradeoff")
def benchmark_tradeoff():
    """Sweep the cost weight beta -> one (makespan, cost) point per beta.
    Mirrors core/plots.py (re-implemented so matplotlib isn't required)."""
    try:
        num_dags = int_arg("dags", 8, 1, 20)
        seed_base = int_arg("seed", 3000, 0, 10**9)
    except ValueError:
        return jsonify({"error": "dags and seed must be whole numbers"}), 400
    betas = [0.0, 0.2, 0.4, 0.6, 0.8, 0.95]

    def compute():
        instances = []
        for i in range(num_dags):
            seed = seed_base + i
            dag = generate_random_dag(num_tasks=18, num_levels=6, edge_probability=0.35, seed=seed)
            vms = generate_vm_pool(num_vms=5, seed=seed, max_speed=8.0)
            instances.append((dag, vms, heft_schedule(dag, vms)))

        points = []
        for beta in betas:
            makespans, costs = [], []
            for dag, vms, heft_result in instances:
                result, _ = cost_aware_local_search(
                    heft_result, dag, vms,
                    alpha=(1.0 - beta) * 0.8, beta=beta, gamma=(1.0 - beta) * 0.2,
                    max_iterations=400, seed=42,
                )
                makespans.append(result.makespan())
                costs.append(compute_schedule_cost(result, dag, vms))
            points.append({"beta": beta,
                           "makespan": round(statistics.mean(makespans), 2),
                           "cost": round(statistics.mean(costs), 2)})
        return points

    with LOCK:
        return jsonify(cached(("tradeoff", num_dags, seed_base), compute))


# ---------------------------------------------------------------------------
# Old endpoints (still used by /classic)
# ---------------------------------------------------------------------------

@app.route("/api/run")
def run():
    """One-shot: HEFT, HEFT+LS and HEFT+Cost-ILS on a fresh random instance."""
    seed = int(request.args.get("seed", 1))
    dag = generate_random_dag(
        num_tasks=int(request.args.get("tasks", 14)),
        num_levels=int(request.args.get("levels", 5)),
        edge_probability=0.35, seed=seed,
    )
    vms = generate_vm_pool(num_vms=int(request.args.get("vms", 4)), seed=seed, max_speed=8.0)
    iters = int(request.args.get("iters", 500))
    with LOCK:
        heft = heft_schedule(dag, vms)
        ls = local_search(heft, dag, vms, max_iterations=iters, seed=seed)
        ca, _ = cost_aware_local_search(
            heft, dag, vms, alpha=0.5, beta=float(request.args.get("beta", 0.4)),
            gamma=0.1, max_iterations=iters, seed=seed,
        )
    return jsonify({
        "vms": vms_to_json(vms),
        "heft": schedule_to_json(heft, dag, vms),
        "ls": schedule_to_json(ls, dag, vms),
        "cost_aware": schedule_to_json(ca, dag, vms),
    })


@app.route("/api/stream")
def stream():
    """Live: run local search in small rounds and push each result (SSE)."""
    seed = int(request.args.get("seed", 1))
    dag = generate_random_dag(
        num_tasks=int(request.args.get("tasks", 14)),
        num_levels=int(request.args.get("levels", 5)),
        edge_probability=0.35, seed=seed,
    )
    vms = generate_vm_pool(num_vms=int(request.args.get("vms", 4)), seed=seed, max_speed=8.0)
    rounds = int(request.args.get("rounds", 30))
    per_round = int(request.args.get("per_round", 20))

    def gen():
        with LOCK:
            current = heft_schedule(dag, vms)
        first = {"round": 0, "vms": vms_to_json(vms), **schedule_to_json(current, dag, vms)}
        yield f"data: {json.dumps(first)}\n\n"
        for r in range(1, rounds + 1):
            with LOCK:
                current = local_search(current, dag, vms, max_iterations=per_round, seed=seed + r)
            yield f"data: {json.dumps({'round': r, **schedule_to_json(current, dag, vms)})}\n\n"
            time.sleep(0.15)
        yield "event: done\ndata: {}\n\n"

    return Response(gen(), mimetype="text/event-stream", headers={"Cache-Control": "no-cache"})


if __name__ == "__main__":
    app.run(debug=True, port=5000)
