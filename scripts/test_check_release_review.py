"""Tests for scripts/check_release_review.py (issue #125).

Run: python scripts/test_check_release_review.py
"""
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(__file__))
from check_release_review import GATES, WAIVABLE, validate  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent


def record(results=None, waivers="", decision="GO", rm="Alex (2026-11-01)", keyholder="Sam (2026-11-01)"):
    results = results or {}
    rows = "\n".join(
        f"| {g} | measured {g} | {results.get(g, 'PASS')} | https://ci.example/{g} | Owner {g} |" for g in GATES
    )
    return f"""# Release review: v1.0.0

## Gate results

| Gate | Measured | Result | Evidence | Owner |
|---|---|---|---|---|
{rows}

## Waivers

| Gate | Reason | Mitigation | Expires (UTC, ≤ 14 days after launch) | Approved by release manager | Approved by contract admin keyholder |
|---|---|---|---|---|---|
{waivers}

## Decision

- **Decision:** {decision}
- **Release manager sign-off:** {rm}
- **Contract admin keyholder sign-off:** {keyholder}
"""


def test_complete_go_record_passes():
    assert validate(record()) == []
    print("PASS: test_complete_go_record_passes")


def test_missing_gate_fails():
    text = "\n".join(l for l in record().splitlines() if not l.startswith("| G4 "))
    assert any("G4: missing" in e for e in validate(text))
    print("PASS: test_missing_gate_fails")


def test_go_with_a_failed_gate_fails():
    errors = validate(record({"G2": "FAIL"}))
    assert any("Decision is GO but G2 failed" in e for e in errors), errors
    assert validate(record({"G2": "FAIL"}, decision="NO-GO")) == []
    print("PASS: test_go_with_a_failed_gate_fails")


def test_missing_evidence_fails():
    text = record().replace("https://ci.example/G3", "<link>")
    assert any("G3: no evidence" in e for e in validate(text))
    print("PASS: test_missing_evidence_fails")


def test_non_waivable_gate_cannot_be_waived():
    errors = validate(record({"G1": "WAIVED"}))
    assert any("G1: cannot be waived" in e for e in errors), errors
    print("PASS: test_non_waivable_gate_cannot_be_waived")


def test_waiver_needs_both_approvals_and_expiry():
    good = "| G6 | load env not ready | launch capped at 50 matches | 2026-11-14 | Alex | Sam |"
    assert validate(record({"G6": "WAIVED"}, waivers=good)) == []
    missing_row = validate(record({"G6": "WAIVED"}))
    assert any("no row in the Waivers table" in e for e in missing_row), missing_row
    one_approval = "| G6 | x | y | 2026-11-14 | Alex | <name> |"
    assert any("keyholder approval" in e for e in validate(record({"G6": "WAIVED"}, waivers=one_approval)))
    bad_date = "| G6 | x | y | soon | Alex | Sam |"
    assert any("expiry" in e for e in validate(record({"G6": "WAIVED"}, waivers=bad_date)))
    print("PASS: test_waiver_needs_both_approvals_and_expiry")


def test_go_needs_both_signoffs():
    errors = validate(record(keyholder="<name, date>"))
    assert any("keyholder sign-off" in e for e in errors), errors
    print("PASS: test_go_needs_both_signoffs")


def test_unfilled_template_fails():
    errors = validate((ROOT / "docs/release-reviews/TEMPLATE.md").read_text())
    assert len(errors) >= len(GATES), errors
    print("PASS: test_unfilled_template_fails")


def test_gates_match_the_runbook():
    """GATES/WAIVABLE must mirror the table in docs/runbook.md §8.1."""
    runbook = (ROOT / "docs/runbook.md").read_text()
    section = runbook[runbook.index("### 8.1 Gates"):runbook.index("### 8.2 Waivers")]
    rows = re.findall(r"^\| \*\*(G\d)\*\* \|.*\| (Yes|No)[^|]*\|$", section, re.M)
    assert tuple(g for g, _ in rows) == GATES, rows
    assert {g for g, w in rows if w == "Yes"} == WAIVABLE, rows
    print("PASS: test_gates_match_the_runbook")


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
    print("All release review tests passed.")
