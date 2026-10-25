#!/usr/bin/env python3
"""Validate a mainnet release review record (issue #125).

    python scripts/check_release_review.py docs/release-reviews/<release>.md

Gates and their rules are defined in docs/runbook.md §8. The record must
report every gate with a result, evidence and owner; waivers must be allowed
for that gate and carry both approvals and an expiry; and the decision may be
GO only when no gate failed. Exits non-zero, listing every problem, otherwise.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

GATES = ("G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8")
WAIVABLE = {"G5", "G6", "G8"}
RESULTS = {"PASS", "FAIL", "WAIVED"}
PLACEHOLDER = re.compile(r"^<.*>$")


def _cells(line: str) -> list[str]:
    return [c.strip() for c in line.strip().strip("|").split("|")]


def _table(text: str, heading: str) -> list[list[str]]:
    """Rows (header and separator excluded) of the first table under `## heading`."""
    m = re.search(rf"^## {re.escape(heading)}\s*$(.*?)(?=^## |\Z)", text, re.M | re.S)
    if not m:
        return []
    lines = [ln for ln in m.group(1).splitlines() if ln.strip().startswith("|")]
    return [_cells(ln) for ln in lines[2:]]


def _filled(value: str) -> bool:
    return bool(value) and not PLACEHOLDER.match(value)


def _field(text: str, label: str) -> str:
    m = re.search(rf"^- \*\*{re.escape(label)}:\*\*\s*(.+)$", text, re.M)
    return m.group(1).strip() if m else ""


def validate(text: str) -> list[str]:
    errors: list[str] = []
    rows = {r[0]: r for r in _table(text, "Gate results") if r and r[0] in GATES}
    results: dict[str, str] = {}

    for gate in GATES:
        row = rows.get(gate)
        if row is None or len(row) < 5:
            errors.append(f"{gate}: missing from the Gate results table")
            continue
        _, measured, result, evidence, owner = row[:5]
        result = result.upper()
        results[gate] = result
        if result not in RESULTS:
            errors.append(f"{gate}: result must be PASS, FAIL or WAIVED, got {row[2]!r}")
        if not _filled(measured):
            errors.append(f"{gate}: no measured value recorded")
        if not _filled(evidence):
            errors.append(f"{gate}: no evidence linked (a gate without evidence is a FAIL)")
        if not _filled(owner):
            errors.append(f"{gate}: no evidence owner named")

    waivers = {r[0]: r for r in _table(text, "Waivers") if r and r[0] in GATES}
    for gate, result in results.items():
        if result != "WAIVED":
            continue
        if gate not in WAIVABLE:
            errors.append(f"{gate}: cannot be waived (only {', '.join(sorted(WAIVABLE))} can)")
            continue
        w = waivers.get(gate)
        if w is None or len(w) < 6:
            errors.append(f"{gate}: WAIVED but has no row in the Waivers table")
            continue
        _, reason, mitigation, expires, rm, keyholder = w[:6]
        for label, value in (("reason", reason), ("mitigation", mitigation),
                             ("release manager approval", rm), ("contract admin keyholder approval", keyholder)):
            if not _filled(value):
                errors.append(f"{gate}: waiver has no {label}")
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", expires):
            errors.append(f"{gate}: waiver expiry must be a YYYY-MM-DD date, got {expires!r}")

    decision = _field(text, "Decision").upper()
    if decision not in {"GO", "NO-GO"}:
        errors.append(f"Decision must be GO or NO-GO, got {decision or 'nothing'!r}")
    elif decision == "GO":
        failed = [g for g, r in results.items() if r == "FAIL"]
        if failed:
            errors.append(f"Decision is GO but {', '.join(failed)} failed")
        for label in ("Release manager sign-off", "Contract admin keyholder sign-off"):
            if not _filled(_field(text, label)):
                errors.append(f"Decision is GO but has no {label.lower()}")
    return errors


def main(argv: list[str]) -> int:
    if len(argv) != 1:
        print(__doc__.strip().splitlines()[2].strip())
        return 2
    path = Path(argv[0])
    if not path.is_file():
        print(f"NO-GO: release review record {path} does not exist (copy docs/release-reviews/TEMPLATE.md)")
        return 1
    errors = validate(path.read_text())
    for e in errors:
        print(f"NO-GO: {e}")
    if errors:
        return 1
    decision = _field(path.read_text(), "Decision").upper()
    if decision != "GO":
        print("NO-GO: the release review decided NO-GO")
        return 1
    print(f"GO: {path} records every gate and a GO decision")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
