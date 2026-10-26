"""Tests for scripts/check_compat_matrix.py (issue #124).

Run: python scripts/test_check_compat_matrix.py
"""
import copy
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, os.path.dirname(__file__))
import check_compat_matrix as c  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent


def _copy_repo_pins() -> Path:
    """A temp tree holding just the files the drift check reads."""
    tmp = Path(tempfile.mkdtemp())
    for rel in ["rust-toolchain.toml", "Cargo.toml", "Cargo.lock", "docs/compatibility.md",
                "apps/backend/package.json", "apps/backend/package-lock.json",
                "apps/frontend/package.json", "apps/frontend/package-lock.json"]:
        (tmp / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(ROOT / rel, tmp / rel)
    shutil.copytree(ROOT / ".github" / "workflows", tmp / ".github" / "workflows")
    return tmp


def test_repo_matches_matrix():
    errors = c.check_drift(c.load_matrix())
    assert errors == [], errors
    print("PASS: test_repo_matches_matrix")


def test_detects_toolchain_drift():
    tmp = _copy_repo_pins()
    try:
        p = tmp / "rust-toolchain.toml"
        p.write_text(p.read_text().replace('channel = "1.88.0"', 'channel = "1.90.0"'))
        errors = c.check_drift(c.load_matrix(), tmp)
        assert any("rust-toolchain.toml" in e for e in errors), errors
    finally:
        shutil.rmtree(tmp)
    print("PASS: test_detects_toolchain_drift")


def test_detects_js_sdk_drift_in_one_app():
    tmp = _copy_repo_pins()
    try:
        p = tmp / "apps/frontend/package.json"
        pkg = json.loads(p.read_text())
        pkg["dependencies"]["@stellar/stellar-sdk"] = "17.0.0"
        p.write_text(json.dumps(pkg))
        errors = c.check_drift(c.load_matrix(), tmp)
        assert any("apps/frontend/package.json" in e for e in errors), errors
        assert not any("apps/backend/package.json" in e for e in errors), errors
    finally:
        shutil.rmtree(tmp)
    print("PASS: test_detects_js_sdk_drift_in_one_app")


def test_detects_workflow_pin_drift():
    tmp = _copy_repo_pins()
    try:
        p = tmp / ".github/workflows/deploy.yml"
        p.write_text(p.read_text().replace("v22.0.1/", "v23.0.0/"))
        errors = c.check_drift(c.load_matrix(), tmp)
        assert any("deploy.yml stellar-cli" in e for e in errors), errors
    finally:
        shutil.rmtree(tmp)
    print("PASS: test_detects_workflow_pin_drift")


def test_matrix_change_without_doc_update_is_stale():
    m = copy.deepcopy(c.load_matrix())
    m["candidates"][0]["js_stellar_sdk"] = "16.9.9"
    errors = c.check_drift(m)
    assert any("table is stale" in e for e in errors), errors
    print("PASS: test_matrix_change_without_doc_update_is_stale")


def test_plan_always_includes_the_baseline():
    m = c.load_matrix()
    ids = [e["id"] for e in c.plan(m)]
    assert ids[0] == "current" and "protocol-23" in ids, ids
    only = [e["id"] for e in c.plan(m, "protocol-23")]
    assert only == ["current", "protocol-23"], only
    required = {e["id"]: e["required"] for e in c.plan(m)}
    assert required["current"] and required["js-sdk-16-latest"] and not required["latest"], required
    print("PASS: test_plan_always_includes_the_baseline")


def test_plan_rejects_unknown_candidate():
    try:
        c.plan(c.load_matrix(), "nope")
    except SystemExit:
        print("PASS: test_plan_rejects_unknown_candidate")
        return
    raise AssertionError("expected SystemExit")


def test_resolve_latest_without_network():
    def fake(url):
        if "crates.io" in url:
            return {"crate": {"max_stable_version": "29.0.1"}}
        return {"dist-tags": {"latest": "17.2.1"}}
    out = c.resolve(c.load_matrix(), "latest", fetch=fake)
    assert out == {"stellar_protocol": "29", "rust": "stable", "soroban_sdk": "29.0.1", "js_stellar_sdk": "17.2.1"}, out
    pinned = c.resolve(c.load_matrix(), "current", fetch=lambda _u: (_ for _ in ()).throw(AssertionError("no fetch")))
    assert pinned["soroban_sdk"] == "22.0.11", pinned
    print("PASS: test_resolve_latest_without_network")


def _report(*failed, ok=(), broken=()):
    suites = [{"name": "/x/a.test.ts", "status": "failed" if failed else "passed",
               "assertionResults": [{"fullName": n, "status": "failed"} for n in failed]
               + [{"fullName": n, "status": "passed"} for n in ok]}]
    suites += [{"name": f"/x/{b}", "status": "failed", "assertionResults": []} for b in broken]
    return {"testResults": suites}


def test_compare_only_reports_new_failures():
    baseline = _report("already broken", ok=["fine"])
    candidate = _report("already broken", "fine", broken=["b.test.ts"])
    new = c.compare_vitest(baseline, candidate)
    assert new == ["a.test.ts > fine", "b.test.ts (suite failed to load)"], new
    assert c.compare_vitest(baseline, baseline) == []
    print("PASS: test_compare_only_reports_new_failures")


def test_compare_cargo_only_reports_new_failures():
    base = "test a::ok ... ok\ntest a::old ... FAILED\n"
    cand = "test a::ok ... FAILED\ntest a::old ... FAILED\nerror: could not compile `smile4money-oracle` (lib)\n"
    assert c.compare_cargo(base, cand) == ["a::ok", "smile4money-oracle (does not compile)"]
    assert c.compare_cargo(cand, cand) == []
    print("PASS: test_compare_cargo_only_reports_new_failures")


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
    print("All compatibility matrix tests passed.")
