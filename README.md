# DCA-HEFT-ILS

**Dynamic Cost-Aware HEFT Scheduling Optimizer with Iterative Local Search**

A cloud workflow scheduler that starts from classical HEFT, refines it with iterated local search, balances speed against cost with a multi-objective score, and repairs the schedule on the fly when a VM fails or slows down, touching only the tasks that are actually affected. Built as a cloud computing course project, with an interactive dashboard that shows every strategy side by side.

> **Scope note:** VM speeds, prices, failures and slowdowns are *simulated* to run controlled experiments. This project does not call AWS, Azure or GCP and does not claim to reproduce real billing or infrastructure behaviour.

> **Live demo note:** the hosted demo page uses simulated data. To see the real optimizer run, start `server.py` locally (see [Quick start](#quick-start)).

---

## What this is

A **workflow** is a set of tasks where some must finish before others can start (a DAG). A pool of **heterogeneous VMs** (different speeds, different hourly prices) is available to run them. The scheduler decides which task runs on which VM and when, so that the job finishes quickly, costs little, and keeps the VMs reasonably busy.

Classical HEFT solves the "finish quickly" part well, but it has three limitations that this project addresses:

| Limitation of HEFT | What this project adds |
|---|---|
| Only optimizes completion time and ignores cost | **Cost-aware multi-objective scoring**: weighs makespan, cost and load balance, and can deliberately pick a slower but cheaper schedule |
| One-shot: never revisits a decision | **Iterated local search**: tries thousands of small move / swap / reorder tweaks and keeps the improvements, with random "kicks" to escape local optima |
| Static: cannot react when conditions change | **Dynamic events + selective re-optimization**: simulates VM slowdown, VM failure and new task arrival, then repairs only the affected region and freezes everything else |

## How it relates to the cloud

| In the project | In a real cloud |
|---|---|
| Workflow DAG | Data pipelines, ETL jobs, CI/CD, ML training pipelines |
| VM pool with different speeds and prices | Instance families where faster generally costs more |
| Cost per hour | Pay-as-you-go billing |
| Cost-aware score | Balancing deadline against the bill |
| VM failure / slowdown event | Instance crashes, Spot reclamation, noisy-neighbour contention |
| Selective repair | A control-plane scheduler re-planning only what broke |

## Architecture

```
DAG + VM pool (seeded random generators)
      |
      v
  HEFT Engine           upward rank + insertion-based earliest-finish-time
      |
      v
  Local Search / ILS    move / swap / reorder mutations, feasibility-checked
      |
      v
  Cost-Aware Scoring    alpha*makespan + beta*cost + gamma*imbalance (normalized)
      |
      v
  Dynamic Monitor       slowdown / failure / new task, with a change-significance threshold
      |
      v
  Selective Repair      reschedule only affected tasks and their dependents
```

The browser dashboard talks to a small Flask server (`server.py`) that runs the real Python scheduler and returns JSON.

## Quick start

```bash
git clone https://github.com/zlakio/DCA-HEFT-ILS.git
cd DCA-HEFT-ILS

python -m venv venv
venv\Scripts\activate            # Windows
# source venv/bin/activate       # macOS / Linux

pip install flask matplotlib
python server.py
```

Then open **http://localhost:5000** and press **Generate & schedule**.

- `flask` is required for the server and dashboard.
- `matplotlib` is only needed for `python -m core.plots` (the report figures). The scheduler itself uses the Python standard library.

## The dashboard

The dashboard schedules one random workload four ways and compares them:

| Dashboard name | What it is |
|---|---|
| **Sequential** | Naive baseline: tasks dealt to VMs in rotation, in dependency order |
| **Priority-Optimized** | Classical HEFT (the main baseline) |
| **Priority + Refined** | HEFT followed by iterated local search (minimizes makespan) |
| **Budget-Optimized** | HEFT followed by cost-aware local search (multi-objective score) |

**Controls:** number of tasks (10-120), number of instances (2-12), budget priority beta (0-0.95), a seed (blank = random), a **Find a run where refinement helps** button that scans seeds until local search beats HEFT, and an idle-time highlight toggle.

**Panels:**

- **Optimization Workflow Stages**: real measured time (ms) for each pipeline stage.
- **Headline badges**: refined vs baseline duration, budget-optimized vs baseline cost, priority vs sequential duration.
- **Strategy Comparison**: bar chart switchable between Total Duration, Budget Spent, Utilization and Load Balance, with the HEFT baseline marked.
- **Refinement progress**: best makespan found so far at each search step. A flat line means HEFT was already a local optimum for that input.
- **Adjustment attempts**: per mutation type (move, swap, reorder): tested, feasible, improved, success rate.
- **Instance Fleet Performance**: speed, hourly rate, and per-strategy task count and utilization for each node.
- **Schedule Timelines**: one Gantt chart per strategy on a shared time axis; red hatching shows idle time, the solid line is the completion time, the dashed line is the comparison strategy's completion time. Hovering a task highlights it across all four charts.
- **Historical Performance Averages**: averaged static comparison, VM-failure recovery comparison, and the cost-vs-duration trade-off curve over many random scenarios.

### Server endpoints

| Endpoint | Purpose |
|---|---|
| `GET /` | Serves `dashboard.html` |
| `GET /api/schedule` | Generates a workload and returns all four schedules, stage timings, search trace and operator stats. Params: `tasks`, `vms`, `seed`, `beta`, `find=1` |
| `GET /api/benchmark/static` | Averaged HEFT vs local search vs cost-aware results |
| `GET /api/benchmark/dynamic` | Averaged selective repair vs naive full reschedule |
| `GET /api/benchmark/tradeoff` | Cost-vs-makespan points as beta is swept |
| `GET /api/run`, `GET /api/stream` | Older one-shot and live-streaming endpoints |

Heavy endpoints take a lock, because the scheduler seeds Python's global random generator and two simultaneous requests would corrupt each other's reproducibility.

## Command-line usage

Run from the project root, with the virtual environment active.

```bash
# Tests (one module per component)
python -m tests.test_generators
python -m tests.test_heft_engine
python -m tests.test_local_search
python -m tests.test_cost_model
python -m tests.test_dynamic_events
python -m tests.test_selective_reopt

# Benchmark suite: prints comparison tables
python -m core.benchmark

# Report-ready figures, saved to plots/
python -m core.plots
```

## Project structure

```
DCA-HEFT-ILS/
├── core/
│   ├── models.py            # Task, VM, DAG, Schedule, Assignment
│   ├── dag_generator.py     # Seeded random layered DAG generator (acyclic by construction)
│   ├── vm_generator.py      # Heterogeneous VM pool (speed and cost positively correlated, with noise)
│   ├── heft_engine.py       # HEFT: upward rank + insertion-based earliest finish time
│   ├── local_search.py      # Mutation operators, local search, iterated local search, cost-aware search
│   ├── cost_model.py        # Cost, utilization and load-balance metrics + multi-objective score
│   ├── dynamic_events.py    # Event types, affected-task detection, change-significance threshold
│   ├── selective_reopt.py   # Repairs only the disrupted part of a running schedule
│   ├── benchmark.py         # Static and dynamic benchmark suites with baselines
│   └── plots.py             # Generates report figures
├── tests/                   # One test module per core component
├── plots/                   # Generated figures
├── server.py                # Flask bridge between core/ and the dashboard
<<<<<<< HEAD
├── static/                  # Shared dashboard assets: style.css, app.js, demo.js (demo-mode data), self-hosted Geist font
=======
>>>>>>> c91dcd74e5078970b1a7dfa62767f1529088dba9
├── dashboard.html           # Interactive dashboard (needs server.py)
├── index.html               # Static demo page (simulated data)
└── README.md
```

## Key results

Averaged over many random workloads (exact numbers vary slightly with trial count and seeds):

- **Cost-vs-makespan trade-off.** Sweeping the cost weight beta from 0 to 0.95 traces a smooth curve: average cost falls about 4.5% (517 to 494) while average makespan rises from about 80 to about 167. Beta works as a dial between deadline and budget, with a sensible "knee" around 0.4-0.6.
- **Balanced cost-aware setting.** At alpha = 0.5, beta = 0.4, gamma = 0.1, cost dropped about 2.1% for about 4.3% longer makespan versus plain HEFT.
- **Selective repair vs naive full reschedule** (one VM fails mid-run): about 5.4 tasks touched vs 15.2 (roughly one third), about 1.8x faster, with only about 0.8% difference in resulting makespan.
- **Plain local search vs HEFT.** Plain (non-iterated) local search often finds no improvement because HEFT's output is already a local optimum. The iterated version, which perturbs the schedule to escape that trap, improved makespan by up to about 4.7% in isolated tests. This is the reason the project uses *iterated* local search.

## Why the numbers aren't random

- Workflows and VM pools are generated from a **seed**, so any run can be reproduced exactly.
- Every reported value (execution time, start/end time, makespan, cost, utilization) is **computed by formula** from those inputs:
  - execution time = `computation_cost / vm.speed`
  - task cost = `execution duration x VM hourly rate`; schedule cost = sum over tasks
  - makespan = latest task end time
- Every accepted schedule passes a **feasibility check**: dependencies respected (including transfer delay across VMs) and no VM runs two tasks at once.
- Upward ranks were **verified by hand** on a small example and match the code exactly.
- Local search never accepts a worse schedule, and ILS returns the best schedule seen.
- Each claim is a **comparison against a baseline**, averaged over many random scenarios.

## Limitations

- All speeds, prices, failures and slowdowns are simulated.
- Cost counts busy execution time only; real clouds usually bill a running instance whether or not it is idle.
- Task rank uses the task's computation cost directly rather than averaging across VM speeds as in the original HEFT paper.
- Communication cost is a fixed per-edge value rather than depending on the VM pair.
- A disrupted task restarts from scratch; partial progress and checkpointing are not modelled.
- Benchmarks use small synthetic workloads (roughly 14-30 tasks).
- This is a heuristic: it does not claim the optimal schedule.

## Possible extensions

- Bill idle time from first use to last use per VM.
- Use real instance catalogs and pricing data.
- Model Spot-style interruptions and checkpointed tasks.
- Learn the objective weights automatically instead of fixing them.
- Evaluate on larger and real-world workflow shapes.

## References

1. H. Topcuoglu, S. Hariri, and M.-Y. Wu, "Performance-effective and low-complexity task scheduling for heterogeneous computing," *IEEE Transactions on Parallel and Distributed Systems*, vol. 13, no. 3, pp. 260-274, 2002. Introduces HEFT and CPOP; defines the upward-rank priority scheme and insertion-based earliest-finish-time scheduling used as the baseline in this project.
