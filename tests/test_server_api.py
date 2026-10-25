"""
Verifies the dashboard API (server.py), using Flask's test client:
  - /api/schedule returns the task dependency edges, and they match the DAG.
  - /api/event reproduces the same "before" schedule the dashboard shows,
    for every strategy.
  - After a VM failure: nothing that starts at or after the event runs on the
    failed VM, every task the repair did not re-plan is untouched, and the
    repaired schedule respects every dependency.
  - After a slowdown: the same freeze rule holds and the schedule is feasible.
  - A failure with no unfinished work on that VM is reported as ignored.
  - Bad input is rejected with a 400, not a 500.
  - Benchmark results are cached and their inputs are clamped.

Run:  python -m tests.test_server_api      (needs flask)
"""

import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import server  # noqa: E402

CLIENT = server.app.test_client()
BASE = "tasks=30&vms=6&seed=42&beta=0.4"


def get(path):
    resp = CLIENT.get(path)
    return resp.status_code, resp.get_json()


def by_task(schedule_json):
    return {t["id"]: t for t in schedule_json["tasks"]}


def assert_dependencies_respected(schedule_json, edges):
    tasks = by_task(schedule_json)
    for pred, succ in edges:
        assert tasks[succ]["start"] >= tasks[pred]["end"] - 1e-6, (
            f"task {succ} starts at {tasks[succ]['start']} before its "
            f"prerequisite {pred} ends at {tasks[pred]['end']}"
        )


def assert_no_overlap(schedule_json):
    per_vm = {}
    for t in schedule_json["tasks"]:
        per_vm.setdefault(t["vm"], []).append((t["start"], t["end"]))
    for vm, spans in per_vm.items():
        spans.sort()
        for (_, end_a), (start_b, _) in zip(spans, spans[1:]):
            assert start_b >= end_a - 1e-6, f"instance {vm} runs two tasks at once"


def test_schedule_returns_edges():
    status, run = get("/api/schedule?" + BASE)
    assert status == 200
    assert len(run["edges"]) == run["instance"]["num_edges"]
    ids = {t["id"] for t in run["heft"]["tasks"]}
    assert all(a in ids and b in ids and a != b for a, b in run["edges"])
    print(f"/api/schedule: {len(run['edges'])} dependency edges, all between real tasks.")


def test_event_reproduces_dashboard_schedule():
    _, run = get("/api/schedule?" + BASE)
    for strategy in server.STRATEGIES:
        status, ev = get(f"/api/event?{BASE}&strategy={strategy}&type=failure&vm=3&at=0.4")
        assert status == 200, ev
        assert abs(ev["before"]["makespan"] - run[strategy]["makespan"]) < 1e-9, strategy
        assert abs(ev["before"]["cost"] - run[strategy]["cost"]) < 1e-9, strategy
    print("/api/event: 'before' matches the dashboard for all four strategies.")


def test_failure_repair_rules():
    _, run = get("/api/schedule?" + BASE)
    for strategy in server.STRATEGIES:
        for vm in (0, 2, 3):
            status, ev = get(f"/api/event?{BASE}&strategy={strategy}&type=failure&vm={vm}&at=0.4")
            assert status == 200, ev
            t = ev["event"]["time"]
            before, after = by_task(ev["before"]), by_task(ev["after"])
            affected = set(ev["affected"])

            # same set of tasks, every one still scheduled
            assert set(before) == set(after)
            # nothing is placed on the failed instance after the failure
            for task in after.values():
                if task["vm"] == vm:
                    assert task["end"] <= t + 1e-6, "work left on the failed instance"
            # everything the repair did not re-plan is exactly where it was
            for tid, old in before.items():
                if tid not in affected:
                    new = after[tid]
                    assert (new["vm"], new["start"], new["end"]) == (old["vm"], old["start"], old["end"]), tid
            # re-planned tasks never start before the failure
            for tid in affected:
                assert after[tid]["start"] >= t - 1e-6, tid
            # moved is a subset of the re-planned tasks
            assert set(ev["moved"]) <= affected
            assert_dependencies_respected(ev["after"], run["edges"])
            assert_no_overlap(ev["after"])
    print("/api/event failure: frozen tasks untouched, nothing left on the failed instance, feasible.")


def test_slowdown_repair_rules():
    _, run = get("/api/schedule?" + BASE)
    status, ev = get(f"/api/event?{BASE}&strategy=heft&type=slowdown&vm=3&at=0.4&factor=0.3")
    assert status == 200, ev
    before, after = by_task(ev["before"]), by_task(ev["after"])
    affected = set(ev["affected"])
    assert affected, "the busiest instance should have work to re-plan"
    for tid, old in before.items():
        if tid not in affected:
            new = after[tid]
            assert (new["vm"], new["start"], new["end"]) == (old["vm"], old["start"], old["end"]), tid
    assert_dependencies_respected(ev["after"], run["edges"])
    assert_no_overlap(ev["after"])
    print("/api/event slowdown: frozen tasks untouched, feasible.")


def test_ignored_when_no_unfinished_work():
    # At 95% of the run most instances have nothing left; find one that is idle.
    _, ev0 = get(f"/api/event?{BASE}&strategy=heft&type=failure&vm=0&at=0.95")
    busy_late = {t["vm"] for t in ev0["before"]["tasks"] if t["end"] > ev0["event"]["time"]}
    idle = [v["id"] for v in get("/api/schedule?" + BASE)[1]["vms"] if v["id"] not in busy_late]
    assert idle, "expected at least one instance with no unfinished work at 95%"
    status, ev = get(f"/api/event?{BASE}&strategy=heft&type=failure&vm={idle[0]}&at=0.95")
    assert status == 200 and ev["ignored"] is True
    assert ev["affected"] == [] and ev["moved"] == []
    assert ev["after"]["makespan"] == ev["before"]["makespan"]
    print("/api/event: a failure with no unfinished work is reported as ignored.")


def test_bad_input_is_rejected():
    bad = [
        f"/api/event?{BASE}&type=explode&vm=1",
        f"/api/event?{BASE}&strategy=magic&vm=1",
        f"/api/event?{BASE}&vm=99",
        f"/api/event?{BASE}&vm=abc",
        f"/api/event?{BASE}",  # vm missing
        "/api/event?tasks=30&vms=6&beta=0.4&vm=1",  # seed missing: cannot reproduce the run
        f"/api/event?{BASE}&vm=1&at=nan",
        "/api/schedule?tasks=abc",
        "/api/benchmark/static?trials=abc",
    ]
    for path in bad:
        status, body = get(path)
        assert status == 400 and "error" in body, (path, status)
    print(f"{len(bad)} bad requests were rejected with 400.")


def test_benchmarks_are_cached_and_clamped():
    server._BENCH_CACHE.clear()
    status, a = get("/api/benchmark/dynamic?trials=3&seed=2000")
    assert status == 200 and ("dynamic", 3, 2000) in server._BENCH_CACHE
    status, b = get("/api/benchmark/dynamic?trials=3&seed=2000")
    assert a == b
    # an absurd request is clamped instead of running for minutes
    status, big = get("/api/benchmark/dynamic?trials=999999")
    assert status == 200 and ("dynamic", 100, 2000) in server._BENCH_CACHE
    print("Benchmarks: cached after the first call, trial counts clamped to 100.")


if __name__ == "__main__":
    test_schedule_returns_edges()
    test_event_reproduces_dashboard_schedule()
    test_failure_repair_rules()
    test_slowdown_repair_rules()
    test_ignored_when_no_unfinished_work()
    test_bad_input_is_rejected()
    test_benchmarks_are_cached_and_clamped()
    print("All server API checks passed.")
