"""Tests for scripts/network_config.py (issue #118).

Run: python scripts/test_network_config.py
"""
import copy
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, os.path.dirname(__file__))
import network_config as nc  # noqa: E402

CONTRACT = "C" + "A" * 55
OTHER_CONTRACT = "C" + "B" * 55


def base():
    return copy.deepcopy(nc.load())


def errors_for(mutate):
    data = base()
    mutate(data)
    return nc.validate(data)


def expect(errors, needle):
    assert any(needle in e for e in errors), f"expected {needle!r} in {errors}"


def test_repository_is_consistent():
    assert nc.check(nc.load()) == [], nc.check(nc.load())
    print("PASS: test_repository_is_consistent")


def test_rejects_passphrase_under_the_wrong_network():
    def swap(d):
        d["testnet"]["network_passphrase"], d["mainnet"]["network_passphrase"] = (
            d["mainnet"]["network_passphrase"], d["testnet"]["network_passphrase"])
    errs = errors_for(swap)
    expect(errs, "[testnet] network_passphrase")
    expect(errs, "[mainnet] network_passphrase")
    print("PASS: test_rejects_passphrase_under_the_wrong_network")


def test_rejects_a_private_network_claiming_a_public_identity():
    expect(errors_for(lambda d: d["standalone"].update(network_passphrase=nc.KNOWN_PASSPHRASES["mainnet"])),
           "reuses the passphrase of a public network")
    print("PASS: test_rejects_a_private_network_claiming_a_public_identity")


def test_rejects_shared_endpoints_and_rpc_naming_another_network():
    expect(errors_for(lambda d: d["mainnet"].update(rpc_url=d["testnet"]["rpc_url"])), "also used by [testnet]")
    expect(errors_for(lambda d: d["mainnet"].update(rpc_url="https://soroban-testnet.example.org")), "names another network (testnet)")
    print("PASS: test_rejects_shared_endpoints_and_rpc_naming_another_network")


def test_rejects_name_mismatch_missing_keys_unknown_keys_and_insecure_urls():
    expect(errors_for(lambda d: d["testnet"].update(network="mainnet")), "must equal the table name")
    expect(errors_for(lambda d: d["testnet"].pop("horizon_url")), "missing required key horizon_url")
    expect(errors_for(lambda d: d["testnet"].update(rpc_ulr="x")), "unknown keys: rpc_ulr")
    expect(errors_for(lambda d: d["testnet"].update(rpc_url="http://soroban-testnet.stellar.org")), "must be https")
    assert errors_for(lambda d: None) == []  # http://localhost is fine for standalone
    print("PASS: test_rejects_name_mismatch_missing_keys_unknown_keys_and_insecure_urls")


def test_contract_ids_must_be_valid_and_unique_across_networks():
    expect(errors_for(lambda d: d["testnet"]["contracts"].update(escrow="not-an-id")), "is not a contract id")

    def same(d):
        d["testnet"]["contracts"]["escrow"] = CONTRACT
        d["mainnet"]["contracts"]["escrow"] = CONTRACT
    expect(errors_for(same), "also deployed under [testnet.escrow]")
    assert errors_for(lambda d: d["testnet"]["contracts"].update(escrow=CONTRACT)) == []
    print("PASS: test_contract_ids_must_be_valid_and_unique_across_networks")


def test_env_example_must_agree():
    data = base()
    with tempfile.TemporaryDirectory() as tmp:
        p = Path(tmp) / ".env.example"
        p.write_text("STELLAR_NETWORK=mainnet\nSTELLAR_RPC_URL=https://soroban-testnet.stellar.org\nVITE_STELLAR_NETWORK=testnet\n")
        errs = nc.check_env_example(data, p)
        expect(errs, "STELLAR_RPC_URL=https://soroban-testnet.stellar.org disagrees with [mainnet].rpc_url")
        expect(errs, "backend STELLAR_NETWORK=mainnet but frontend VITE_STELLAR_NETWORK=testnet")
        p.write_text("STELLAR_NETWORK=moonnet\n")
        expect(nc.check_env_example(data, p), "not defined in environments.toml")
        data["testnet"]["contracts"]["escrow"] = CONTRACT
        p.write_text(f"STELLAR_NETWORK=testnet\nCONTRACT_ESCROW={OTHER_CONTRACT}\nCONTRACT_ORACLE=YOUR_CONTRACT_ORACLE_ID_HERE\n")
        expect(nc.check_env_example(data, p), "CONTRACT_ESCROW=")
    print("PASS: test_env_example_must_agree")


def test_deploy_scripts_must_agree():
    data = base()
    with tempfile.TemporaryDirectory() as tmp:
        script = Path(nc.ROOT) / "scripts" / f"_tmp_deploy_{os.getpid()}.sh"
        script.write_text('RPC_URL="https://soroban-mainnet.stellar.org"\nNETWORK_PASSPHRASE="Test SDF Network ; September 2015"\n')
        try:
            expect(nc.check_deploy_scripts(data, {"testnet": script}), "RPC_URL='https://soroban-mainnet.stellar.org' disagrees")
        finally:
            script.unlink()
    print("PASS: test_deploy_scripts_must_agree")


def test_rejects_hard_coded_network_values_in_app_code():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "apps/frontend/src").mkdir(parents=True)
        (root / "apps/backend/src").mkdir(parents=True)
        (root / "apps/frontend/src/Bad.tsx").write_text("const u = 'https://soroban-testnet.stellar.org';\nconst p = Networks.PUBLIC;\n")
        (root / "apps/frontend/src/Bad.test.tsx").write_text("const u = 'https://soroban-testnet.stellar.org';\n")
        errs = nc.check_hardcoded(base(), root)
        expect(errs, "apps/frontend/src/Bad.tsx: hard-codes 'https://soroban-testnet.stellar.org'")
        expect(errs, "uses Networks.PUBLIC")
        assert not any("Bad.test.tsx" in e for e in errs), errs
    print("PASS: test_rejects_hard_coded_network_values_in_app_code")


def test_generated_modules_track_the_source():
    data = base()
    data["testnet"]["contracts"]["escrow"] = CONTRACT
    rendered = nc.render(data, "frontend")
    assert f'"escrow": "{CONTRACT}"' in rendered
    assert rendered != Path(nc.GENERATED["frontend"]).read_text()  # so --check would flag it stale
    print("PASS: test_generated_modules_track_the_source")


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
    print("All network config tests passed.")
