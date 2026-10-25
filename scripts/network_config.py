#!/usr/bin/env python3
"""Network and contract metadata: one source, every consumer checked (issue #118).

    python scripts/network_config.py --check   # CI: fail on any disagreement
    python scripts/network_config.py --write   # regenerate the generated modules

Source of truth: environments.toml. This script
  1. validates its schema and network identities (a passphrase must belong to
     the network it is listed under, and no two environments may claim the
     same passphrase, RPC endpoint or contract id);
  2. generates apps/{frontend,backend}/src/config/networks.generated.ts;
  3. checks .env.example and the deploy scripts against it; and
  4. rejects RPC/Horizon URLs or passphrases hard-coded in apps/*/src outside
     the generated modules and tests.
"""
from __future__ import annotations

import json
import re
import sys
import tomllib
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "environments.toml"
GENERATED = {
    "frontend": ROOT / "apps/frontend/src/config/networks.generated.ts",
    "backend": ROOT / "apps/backend/src/config/networks.generated.ts",
}
DEPLOY_SCRIPTS = {"testnet": ROOT / "scripts/deploy_testnet.sh", "mainnet": ROOT / "scripts/deploy_mainnet.sh"}

# The real networks' identities. A passphrase is how Stellar tells networks
# apart, so listing one under the wrong name is the conflict that matters most.
KNOWN_PASSPHRASES = {
    "testnet": "Test SDF Network ; September 2015",
    "mainnet": "Public Global Stellar Network ; September 2015",
    "futurenet": "Test SDF Future Network ; October 2022",
}
LOCAL_NETWORKS = {"standalone"}
REQUIRED = ("network", "network_passphrase", "rpc_url", "horizon_url")
OPTIONAL = ("friendbot_url",)
CONTRACT_KEYS = ("escrow", "oracle")
CONTRACT_ID_RE = re.compile(r"^C[A-Z2-7]{55}$")
PLACEHOLDER_RE = re.compile(r"^(|YOUR_[A-Z0-9_]+_HERE)$")


def load(path: Path = SOURCE) -> dict:
    with open(path, "rb") as f:
        return tomllib.load(f)


def _url_ok(url: str, local: bool) -> bool:
    parsed = urlparse(url)
    if parsed.scheme == "https" and parsed.netloc:
        return True
    return local and parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1"}


def validate(data: dict) -> list[str]:
    errors: list[str] = []
    seen: dict[str, dict[str, str]] = {"network_passphrase": {}, "rpc_url": {}, "horizon_url": {}, "contract": {}}
    for name, env in data.items():
        if not isinstance(env, dict):
            errors.append(f"[{name}] must be a table")
            continue
        local = name in LOCAL_NETWORKS
        for key in REQUIRED:
            if not isinstance(env.get(key), str) or not env[key]:
                errors.append(f"[{name}] missing required key {key}")
        unknown = set(env) - set(REQUIRED) - set(OPTIONAL) - {"contracts"}
        if unknown:
            errors.append(f"[{name}] unknown keys: {', '.join(sorted(unknown))}")
        if env.get("network") and env["network"] != name:
            errors.append(f"[{name}] network = {env['network']!r} must equal the table name")
        passphrase = env.get("network_passphrase")
        if name in KNOWN_PASSPHRASES and passphrase and passphrase != KNOWN_PASSPHRASES[name]:
            errors.append(f"[{name}] network_passphrase {passphrase!r} is not {name}'s passphrase")
        if name not in KNOWN_PASSPHRASES and passphrase in KNOWN_PASSPHRASES.values():
            errors.append(f"[{name}] reuses the passphrase of a public network")
        for key in ("rpc_url", "horizon_url", "friendbot_url"):
            url = env.get(key)
            if isinstance(url, str) and url and not _url_ok(url, local):
                errors.append(f"[{name}] {key} {url!r} must be https (http only for localhost on local networks)")
        for other, phrase in KNOWN_PASSPHRASES.items():
            if other != name and isinstance(env.get("rpc_url"), str) and re.search(rf"\b{other}\b", env["rpc_url"]):
                errors.append(f"[{name}] rpc_url {env['rpc_url']!r} names another network ({other})")
        for key in ("network_passphrase", "rpc_url", "horizon_url"):
            value = env.get(key)
            if isinstance(value, str) and value:
                if value in seen[key]:
                    errors.append(f"[{name}] {key} is also used by [{seen[key][value]}]")
                seen[key][value] = name
        contracts = env.get("contracts", {})
        if not isinstance(contracts, dict):
            errors.append(f"[{name}.contracts] must be a table")
            continue
        for key, value in contracts.items():
            if key not in CONTRACT_KEYS:
                errors.append(f"[{name}.contracts] unknown contract {key!r}")
            if value and not CONTRACT_ID_RE.match(value):
                errors.append(f"[{name}.contracts] {key} {value!r} is not a contract id (C + 55 base32 chars)")
            if value:
                if value in seen["contract"]:
                    errors.append(f"[{name}.contracts] {key} is also deployed under [{seen['contract'][value]}]")
                seen["contract"][value] = f"{name}.{key}"
    return errors


def render(data: dict, consumer: str) -> str:
    networks = {}
    for name, env in data.items():
        networks[name] = {
            "network": env["network"],
            "networkPassphrase": env["network_passphrase"],
            "rpcUrl": env["rpc_url"],
            "horizonUrl": env["horizon_url"],
            "friendbotUrl": env.get("friendbot_url") or None,
            "contracts": {k: (env.get("contracts", {}).get(k) or None) for k in CONTRACT_KEYS},
        }
    body = json.dumps(networks, indent=2)
    return f"""// GENERATED by scripts/network_config.py from environments.toml. Do not edit.
// Change environments.toml and run: python scripts/network_config.py --write
// ({consumer}; issue #118)

export const NETWORKS = {body} as const;

export type NetworkName = keyof typeof NETWORKS;
export type NetworkConfig = (typeof NETWORKS)[NetworkName];

export const NETWORK_NAMES = Object.keys(NETWORKS) as NetworkName[];

export function isNetworkName(value: unknown): value is NetworkName {{
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(NETWORKS, value);
}}

/** The canonical record for `name`; throws for a network environments.toml doesn't define. */
export function networkConfig(name: string): NetworkConfig {{
  if (!isNetworkName(name)) {{
    throw new Error(`Unknown Stellar network "${{name}}"; expected one of ${{NETWORK_NAMES.join(", ")}}`);
  }}
  return NETWORKS[name];
}}
"""


def _env_file(path: Path) -> dict[str, str]:
    out = {}
    for line in path.read_text().splitlines():
        m = re.match(r"^([A-Z0-9_]+)=(.*)$", line.strip())
        if m:
            out[m.group(1)] = m.group(2).strip().strip('"')
    return out


def check_env_example(data: dict, path: Path) -> list[str]:
    errors: list[str] = []
    env = _env_file(path)
    for net_key, rpc_key in (("STELLAR_NETWORK", "STELLAR_RPC_URL"), ("VITE_STELLAR_NETWORK", "VITE_STELLAR_RPC_URL")):
        net = env.get(net_key)
        if net is None:
            continue
        if net not in data:
            errors.append(f"{path.name}: {net_key}={net} is not defined in environments.toml")
            continue
        if rpc_key in env and env[rpc_key] != data[net]["rpc_url"]:
            errors.append(f"{path.name}: {rpc_key}={env[rpc_key]} disagrees with [{net}].rpc_url {data[net]['rpc_url']}")
    if env.get("STELLAR_NETWORK") and env.get("VITE_STELLAR_NETWORK") and env["STELLAR_NETWORK"] != env["VITE_STELLAR_NETWORK"]:
        errors.append(f"{path.name}: backend STELLAR_NETWORK={env['STELLAR_NETWORK']} but frontend VITE_STELLAR_NETWORK={env['VITE_STELLAR_NETWORK']}")
    net = env.get("STELLAR_NETWORK")
    for key, contract in (("CONTRACT_ESCROW", "escrow"), ("CONTRACT_ORACLE", "oracle")):
        value = env.get(key)
        if value is None or PLACEHOLDER_RE.match(value) or net not in data:
            continue
        canonical = data[net].get("contracts", {}).get(contract) or ""
        if value != canonical:
            errors.append(f"{path.name}: {key}={value} disagrees with [{net}.contracts].{contract} ({canonical or 'unset'})")
    return errors


def check_deploy_scripts(data: dict, scripts: dict[str, Path] = DEPLOY_SCRIPTS) -> list[str]:
    errors: list[str] = []
    for net, path in scripts.items():
        if not path.exists():
            continue
        text = path.read_text()
        for var, key in (("RPC_URL", "rpc_url"), ("NETWORK_PASSPHRASE", "network_passphrase")):
            m = re.search(rf'^{var}="([^"]*)"', text, re.M)
            if m and m.group(1) != data[net][key]:
                errors.append(f"{path.relative_to(ROOT)}: {var}={m.group(1)!r} disagrees with [{net}].{key} {data[net][key]!r}")
    return errors


def check_hardcoded(data: dict, root: Path = ROOT) -> list[str]:
    """Consumers must import the generated module rather than repeat its values."""
    needles = set()
    for env in data.values():
        needles.update(v for k, v in env.items() if k in ("rpc_url", "horizon_url", "network_passphrase") and v)
    errors = []
    for app in ("frontend", "backend"):
        for f in sorted((root / f"apps/{app}/src").rglob("*.ts*")):
            rel = f.relative_to(root).as_posix()
            if f.name == "networks.generated.ts" or ".test." in f.name or "/__tests__/" in rel:
                continue
            text = f.read_text()
            for needle in sorted(needles):
                if needle in text:
                    errors.append(f"{rel}: hard-codes {needle!r}; import it from config/networks.generated")
            for sdk in re.findall(r"\bNetworks\.(TESTNET|PUBLIC|FUTURENET|STANDALONE)\b", text):
                errors.append(f"{rel}: uses Networks.{sdk}; use NETWORKS.<name>.networkPassphrase from config/networks.generated")
    return errors


def check(data: dict) -> list[str]:
    errors = validate(data)
    if errors:
        return errors
    for consumer, path in GENERATED.items():
        if not path.exists() or path.read_text() != render(data, consumer):
            errors.append(f"{path.relative_to(ROOT)} is stale: run python scripts/network_config.py --write")
    errors += check_env_example(data, ROOT / ".env.example")
    errors += check_deploy_scripts(data)
    errors += check_hardcoded(data)
    return errors


def main(argv: list[str]) -> int:
    data = load()
    if argv[:1] == ["--write"]:
        errors = validate(data)
        if errors:
            for e in errors:
                print(f"ERROR: {e}")
            return 1
        for consumer, path in GENERATED.items():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(render(data, consumer))
            print(f"wrote {path.relative_to(ROOT)}")
        return 0
    errors = check(data)
    for e in errors:
        print(f"ERROR: {e}")
    if errors:
        return 1
    print("network config: every consumer matches environments.toml")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
