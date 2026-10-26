#!/usr/bin/env python3
"""Fail-closed GitHub deployment approval validation and audit record creation.

Approval evidence is re-queried from GitHub at the time of authorization; a
locally edited JSON file or a self-asserted environment variable is not evidence.
"""
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

VALID_ADDRESS = re.compile(r"^[GC][A-Z2-7]{55}$")
VALID_SHA = re.compile(r"^[0-9a-f]{40}$")

class ApprovalError(ValueError):
    pass


def api_json(path, token, api_base="https://api.github.com"):
    req = urllib.request.Request(
        api_base.rstrip("/") + path,
        headers={
            "Authorization": "Bearer " + token,
            "Accept": "application/vnd.github+json",
            "User-Agent": "smile4money-prod-governance",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            return json.load(response)
    except (ValueError, OSError, urllib.error.URLError) as exc:
        raise ApprovalError("GitHub approval API request failed; production change is blocked") from exc


def validate(config, environment, reviews):
    if not VALID_SHA.fullmatch(config["sha"]):
        raise ApprovalError("Invalid source SHA")
    if config["actor"].casefold() == "":
        raise ApprovalError("Missing deployment initiator")
    for name in ("token_address", "oracle_address"):
        if not VALID_ADDRESS.fullmatch(config[name]):
            raise ApprovalError("Invalid reviewed " + name + " (expected Stellar G/C address)")
    rules = environment.get("protection_rules", [])
    protected = any(
        rule.get("type") == "required_reviewers"
        and rule.get("prevent_self_review") is True
        and bool(rule.get("reviewers"))
        for rule in rules
    )
    if not protected:
        raise ApprovalError("Production environment must have required reviewers and prevent self-review enabled")
    approved = [
        entry for entry in reviews
        if entry.get("state") == "approved"
        and any(env.get("name", "").casefold() == "production" for env in entry.get("environments", []))
        and entry.get("user", {}).get("login", "").casefold() != config["actor"].casefold()
        and entry.get("user", {}).get("login")
    ]
    if not approved:
        raise ApprovalError("No independent GitHub environment approval for this workflow run")
    reviewer = approved[-1]["user"]["login"]
    return {
        "schema": "smile4money.production-change.v1",
        "repository": config["repository"],
        "source_sha": config["sha"],
        "workflow_run_id": config["run_id"],
        "requested_by": config["actor"],
        "approved_by": reviewer,
        "network": "mainnet",
        "reviewed_token_address": config["token_address"],
        "reviewed_oracle_address": config["oracle_address"],
        "review_type": "GitHub production environment required reviewer",
    }


def main():
    try:
        env = os.environ
        token = env.get("GITHUB_TOKEN", "")
        repo = env.get("GITHUB_REPOSITORY", "")
        run_id = env.get("GITHUB_RUN_ID", "")
        if not token or not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo) or not run_id.isdecimal():
            raise ApprovalError("GitHub authorization context missing; refuse local/unreviewed mainnet deployment")
        if env.get("GITHUB_ACTIONS") != "true":
            raise ApprovalError("Production authorizations are restricted to protected GitHub Actions jobs")
        config = {
            "repository": repo,
            "run_id": int(run_id),
            "sha": env.get("GITHUB_SHA", ""),
            "actor": env.get("GITHUB_ACTOR", ""),
            "token_address": env.get("PRODUCTION_TOKEN_ADDRESS", ""),
            "oracle_address": env.get("PRODUCTION_ORACLE_ADDRESS", ""),
        }
        root = Path(__file__).resolve().parents[1]
        import subprocess
        committed_sha = subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=root, text=True
        ).strip()
        if committed_sha != config["sha"]:
            raise ApprovalError("Checked-out source does not match approved workflow source SHA")
        event_path = env.get("GITHUB_EVENT_PATH", "")
        if not event_path or not Path(event_path).is_file():
            raise ApprovalError("GitHub workflow dispatch event context unavailable")
        try:
            dispatched = json.loads(Path(event_path).read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise ApprovalError("Cannot validate reviewed workflow inputs") from exc
        inputs = dispatched.get("inputs") or {}
        if (inputs.get("token_address") != config["token_address"]
                or inputs.get("oracle_address") != config["oracle_address"]):
            raise ApprovalError("Current trust values do not match reviewed workflow-dispatch inputs")
        run = api_json(f"/repos/{repo}/actions/runs/{run_id}", token)
        if (run.get("head_sha") != config["sha"]
                or run.get("event") != "workflow_dispatch"
                or run.get("actor", {}).get("login", "").casefold() != config["actor"].casefold()):
            raise ApprovalError("Workflow run source revision/requester does not match review context")
        environment = api_json(f"/repos/{repo}/environments/production", token)
        reviews = api_json(f"/repos/{repo}/actions/runs/{run_id}/approvals", token)
        evidence = validate(config, environment, reviews)
        output = env.get("PRODUCTION_APPROVAL_EVIDENCE", "")
        if not output:
            raise ApprovalError("Set PRODUCTION_APPROVAL_EVIDENCE to an output JSON path")
        target = Path(output)
        target.parent.mkdir(parents=True, exist_ok=True)
        # Only nonsecret contract/account addresses and GitHub identifiers are recorded.
        target.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        print("Independent approval verified for source revision; audit evidence created.")
    except (ApprovalError, KeyError) as exc:
        print("PRODUCTION APPROVAL DENIED: " + str(exc), file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
