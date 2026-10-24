"""
Benchmark suite for DCA-HEFT-ILS.

Two kinds of comparison, matching the project's two "novelty" claims:

  1. STATIC comparison: across many random (DAG, VM pool) pairs, compare
     plain HEFT vs HEFT+local search vs HEFT+cost-aware local search.
     This demonstrates Novelty A (cost-awareness) has a real, measurable
     effect beyond just makespan.

  2. DYNAMIC comparison: for a random disruption mid-schedule, compare
     SELECTIVE re-optimization against a NAIVE baseline that just
     reschedules the ENTIRE remaining DAG from scratch with plain HEFT.
     This demonstrates Novelty C (selective repair) actually saves
     computation time, which is the whole point of "selective."
"""

import random
import statistics
import time
from typing import Dict, List

from core.cost_model import (
    compute_average_utilization,
    compute_imbalance,
    compute_load_balance_index,
    compute_schedule_cost,
)
from core.dag_generator import generate_random_dag
from core.dynamic_events import VMFailureEvent, get_affected_task_ids
from core.heft_engine import (
    _earliest_finish_time_on_vm,
    compute_upward_ranks,
    heft_schedule,
)
from core.local_search import cost_aware_local_search, local_search
from core.models import Assignment, Schedule
from core.selective_reopt import selective_reoptimize
from core.vm_generator import generate_vm_pool

# ---------------------------------------------------------------------------
# 1. Static benchmark: HEFT vs local search vs cost-aware local search
# ---------------------------------------------------------------------------


def run_static_benchmark(
    num_trials: int = 20,
    num_tasks: int = 20,
    num_levels: int = 6,
    num_vms: int = 5,
    ls_iterations: int = 500,
    seed_base: int = 1000,
) -> List[Dict]:
    """
    Runs `num_trials` independent random (DAG, VM pool) pairs. For each,
    computes makespan and cost under three approaches. Returns one result
    dict per trial for further analysis (averaging, plotting, etc).
    """
    results = []

    for trial in range(num_trials):
        seed = seed_base + trial
        dag = generate_random_dag(
            num_tasks=num_tasks, num_levels=num_levels, edge_probability=0.35, seed=seed
        )
        vms = generate_vm_pool(num_vms=num_vms, seed=seed, max_speed=8.0)

        heft_result = heft_schedule(dag, vms)
        ls_result = local_search(
            heft_result, dag, vms, max_iterations=ls_iterations, seed=seed
        )
        ca_result, _ = cost_aware_local_search(
            heft_result,
            dag,
            vms,
            alpha=0.5,
            beta=0.4,
            gamma=0.1,
            max_iterations=ls_iterations,
            seed=seed,
        )

        results.append(
            {
                "trial": trial,
                "heft_makespan": heft_result.makespan(),
                "heft_cost": compute_schedule_cost(heft_result, dag, vms),
                "heft_utilization": compute_average_utilization(heft_result, vms),
                "heft_load_balance": compute_load_balance_index(heft_result, vms),
                "ls_makespan": ls_result.makespan(),
                "ls_cost": compute_schedule_cost(ls_result, dag, vms),
                "ls_utilization": compute_average_utilization(ls_result, vms),
                "ls_load_balance": compute_load_balance_index(ls_result, vms),
                "cost_aware_makespan": ca_result.makespan(),
                "cost_aware_cost": compute_schedule_cost(ca_result, dag, vms),
                "cost_aware_utilization": compute_average_utilization(ca_result, vms),
                "cost_aware_load_balance": compute_load_balance_index(ca_result, vms),
            }
        )

    return results


def summarize_static_results(results: List[Dict]) -> None:
    """Prints averaged metrics across all trials -- this is the table you
    want for your report."""

    def avg(key):
        return statistics.mean(r[key] for r in results)

    header = (
        f"{'Approach':<20}{'Avg Makespan':>15}{'Avg Cost':>12}"
        f"{'Avg Util %':>13}{'Load Bal. Idx':>16}"
    )
    print(header)
    print("-" * len(header))
    print(
        f"{'HEFT only':<20}{avg('heft_makespan'):>15.2f}{avg('heft_cost'):>12.2f}"
        f"{avg('heft_utilization'):>13.1f}{avg('heft_load_balance'):>16.3f}"
    )
    print(
        f"{'HEFT + LS':<20}{avg('ls_makespan'):>15.2f}{avg('ls_cost'):>12.2f}"
        f"{avg('ls_utilization'):>13.1f}{avg('ls_load_balance'):>16.3f}"
    )
    print(
        f"{'HEFT + Cost-ILS':<20}{avg('cost_aware_makespan'):>15.2f}{avg('cost_aware_cost'):>12.2f}"
        f"{avg('cost_aware_utilization'):>13.1f}{avg('cost_aware_load_balance'):>16.3f}"
    )

    ls_improvement = (
        (avg("heft_makespan") - avg("ls_makespan")) / avg("heft_makespan") * 100
    )
    cost_savings = (avg("heft_cost") - avg("cost_aware_cost")) / avg("heft_cost") * 100
    utilization_gain = avg("cost_aware_utilization") - avg("heft_utilization")
    load_balance_improvement = (
        (avg("heft_load_balance") - avg("cost_aware_load_balance"))
        / avg("heft_load_balance")
        * 100
        if avg("heft_load_balance") > 0
        else 0.0
    )
    print(
        f"\nLocal search improves makespan by {ls_improvement:.1f}% on average vs plain HEFT."
    )
    print(
        f"Cost-aware search reduces cost by {cost_savings:.1f}% on average vs plain HEFT."
    )
    print(
        f"Cost-aware search raises average VM utilization by {utilization_gain:+.1f} "
        f"percentage points vs plain HEFT (HEFT tends to overload the fastest VMs and "
        f"leave the rest idle)."
    )
    print(
        f"Cost-aware search improves the load-balance index by {load_balance_improvement:.1f}% "
        f"vs plain HEFT (lower index = work spread more evenly across the VM pool)."
    )


# ---------------------------------------------------------------------------
# 2. Dynamic benchmark: selective repair vs naive full reschedule
# ---------------------------------------------------------------------------


def naive_full_reschedule(dag, vms, schedule, event, current_time) -> Schedule:
    """
    The BASELINE your selective re-optimization is compared against: on
    any disruption, throw away the ENTIRE schedule for tasks not yet
    finished and re-run plain HEFT on all of them from scratch (using the
    updated VM pool, e.g. with the failed VM removed).

    This is intentionally the "obvious, unsophisticated" approach --
    the whole point of the benchmark is to show selective repair gets a
    comparable (or better) result in much less computation time.
    """
    # Freeze already-finished tasks; treat everything else as needing a
    # fresh HEFT pass.
    finished_ids = {
        tid for tid, a in schedule.assignments.items() if a.end_time <= current_time
    }
    unfinished_ids = set(dag.tasks.keys()) - finished_ids

    vms_for_reschedule = (
        [vm for vm in vms if vm.id != event.vm_id]
        if isinstance(event, VMFailureEvent)
        else list(vms)
    )

    frozen = Schedule()
    for tid in finished_ids:
        a = schedule.assignments[tid]
        frozen.assignments[tid] = Assignment(
            a.task_id, a.vm_id, a.start_time, a.end_time
        )

    compute_upward_ranks(dag)
    priority_order = sorted(
        unfinished_ids, key=lambda tid: dag.tasks[tid].upward_rank, reverse=True
    )

    for task_id in priority_order:
        task = dag.tasks[task_id]
        best_vm_id, best_start, best_end = None, None, float("inf")
        for vm in vms_for_reschedule:
            start, end = _earliest_finish_time_on_vm(
                task, vm, dag, frozen, min_start=current_time
            )
            if end < best_end:
                best_vm_id, best_start, best_end = vm.id, start, end
        frozen.assignments[task_id] = Assignment(
            task_id, best_vm_id, best_start, best_end
        )

    return frozen


def _schedule_stability(original: Schedule, repaired: Schedule) -> float:
    """Percentage of tasks whose (VM, start_time) assignment in `repaired`
    is IDENTICAL to `original` -- i.e. how much of the pre-disruption plan
    survives a repair unchanged. A naive full reschedule is free to move
    almost every task (even ones that had nothing to do with the failure),
    which is disruptive in practice (cached data, in-flight reservations,
    operator trust in the plan); selective repair freezes everything
    outside the affected region by construction, so this should be much
    higher for selective than for naive.
    """
    if not original.assignments:
        return 100.0
    unchanged = 0
    for task_id, orig_a in original.assignments.items():
        repaired_a = repaired.assignments.get(task_id)
        if (
            repaired_a is not None
            and repaired_a.vm_id == orig_a.vm_id
            and abs(repaired_a.start_time - orig_a.start_time) < 1e-6
        ):
            unchanged += 1
    return unchanged / len(original.assignments) * 100.0


def run_dynamic_benchmark(
    num_trials: int = 15,
    num_tasks: int = 25,
    num_levels: int = 7,
    num_vms: int = 6,
    seed_base: int = 2000,
) -> List[Dict]:
    """
    For each trial: build a schedule, fail a random VM partway through,
    and compare SELECTIVE repair vs NAIVE full reschedule on:
      - wall-clock repair time (the headline metric for "selective" claims)
      - resulting makespan (quality check -- selective shouldn't be much worse)
      - number of tasks actually touched (0 for frozen tasks in selective,
        vs potentially everything in naive)
      - schedule stability (% of tasks whose VM/start-time is unchanged
        from the pre-disruption plan)
    """
    results = []

    for trial in range(num_trials):
        seed = seed_base + trial
        dag = generate_random_dag(
            num_tasks=num_tasks, num_levels=num_levels, edge_probability=0.35, seed=seed
        )
        vms = generate_vm_pool(num_vms=num_vms, seed=seed, max_speed=8.0)
        schedule = heft_schedule(dag, vms)

        # Pick a VM that actually has unfinished work at the failure time.
        current_time = schedule.makespan() * 0.4
        busy_at_time = {
            a.vm_id for a in schedule.assignments.values() if a.end_time > current_time
        }
        if not busy_at_time:
            continue
        random.seed(seed)
        target_vm = random.choice(list(busy_at_time))
        event = VMFailureEvent(vm_id=target_vm, time=current_time)

        # --- Selective repair ---
        t0 = time.perf_counter()
        selective_result, _, _, affected = selective_reoptimize(
            dag, vms, schedule, event, current_time
        )
        selective_time = time.perf_counter() - t0

        # --- Naive full reschedule ---
        t0 = time.perf_counter()
        naive_result = naive_full_reschedule(dag, vms, schedule, event, current_time)
        naive_time = time.perf_counter() - t0

        results.append(
            {
                "trial": trial,
                "tasks_touched_selective": len(affected),
                "tasks_touched_naive": len(dag.tasks)
                - sum(
                    1
                    for a in schedule.assignments.values()
                    if a.end_time <= current_time
                ),
                "selective_time_sec": selective_time,
                "naive_time_sec": naive_time,
                "selective_makespan": selective_result.makespan(),
                "naive_makespan": naive_result.makespan(),
                "stability_selective": _schedule_stability(schedule, selective_result),
                "stability_naive": _schedule_stability(schedule, naive_result),
            }
        )

    return results


def summarize_dynamic_results(results: List[Dict]) -> None:
    def avg(key):
        return statistics.mean(r[key] for r in results)

    print(f"{'Metric':<28}{'Selective':>15}{'Naive (full)':>15}")
    print("-" * 58)
    print(
        f"{'Avg tasks touched':<28}{avg('tasks_touched_selective'):>15.1f}{avg('tasks_touched_naive'):>15.1f}"
    )
    print(
        f"{'Avg repair time (sec)':<28}{avg('selective_time_sec'):>15.5f}{avg('naive_time_sec'):>15.5f}"
    )
    print(
        f"{'Avg resulting makespan':<28}{avg('selective_makespan'):>15.2f}{avg('naive_makespan'):>15.2f}"
    )
    print(
        f"{'Avg schedule stability %':<28}{avg('stability_selective'):>15.1f}{avg('stability_naive'):>15.1f}"
    )

    speedup = avg("naive_time_sec") / avg("selective_time_sec")
    makespan_gap = (
        (avg("selective_makespan") - avg("naive_makespan"))
        / avg("naive_makespan")
        * 100
    )
    stability_gain = avg("stability_selective") - avg("stability_naive")
    print(
        f"\nSelective repair is {speedup:.1f}x faster than a full reschedule on average,"
    )
    print(f"with a {makespan_gap:+.1f}% difference in resulting makespan.")
    print(
        f"Selective repair also leaves {stability_gain:+.1f} percentage points more of "
        f"the original plan untouched, avoiding disruptive changes to tasks that had "
        f"nothing to do with the failure."
    )


if __name__ == "__main__":
    print("=" * 58)
    print("STATIC BENCHMARK: HEFT vs Local Search vs Cost-Aware ILS")
    print("=" * 58)
    static_results = run_static_benchmark(num_trials=20)
    summarize_static_results(static_results)

    print()
    print("=" * 58)
    print("DYNAMIC BENCHMARK: Selective Repair vs Naive Full Reschedule")
    print("=" * 58)
    dynamic_results = run_dynamic_benchmark(num_trials=15)
    summarize_dynamic_results(dynamic_results)
