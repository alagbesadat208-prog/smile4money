"""Offline authorization regression checks. Does not call a live network."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "verify_admin_readback.sh"
PUBLIC = "G" + "A" * 55
OTHER = "G" + "B" * 55


class AdminReadbackTests(unittest.TestCase):
    def invoke(self, mode):
        with tempfile.TemporaryDirectory() as directory:
            fake = Path(directory) / "stellar"
            fake.write_text("""#!/usr/bin/env bash
if [[ $1 == keys ]]; then printf '%s\n' "$GOOD"; exit 0; fi
if [[ $1 == contract ]]; then
  case "$CASE" in
    match) printf '"%s"\n' "$GOOD" ;;
    mismatch) printf '%s\n' "$BAD" ;;
    failed) echo 'private server information' >&2; exit 1 ;;
  esac
fi
""")
            fake.chmod(0o755)
            env = dict(os.environ, PATH=directory + os.pathsep + os.environ["PATH"],
                       GOOD=PUBLIC, BAD=OTHER, CASE=mode)
            result = subprocess.run(["bash", str(SCRIPT), "escrow", "C" + "A" * 55,
                                     "deployer", "testnet", "https://example.org",
                                     "Test SDF Network ; September 2015"],
                                    env=env, capture_output=True, text=True)
        return result

    def test_matching_admin_succeeds(self):
        self.assertEqual(self.invoke("match").returncode, 0)

    def test_mismatch_fails_without_exposing_addresses(self):
        result = self.invoke("mismatch")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("mismatch", result.stderr)
        self.assertNotIn(PUBLIC, result.stderr)
        self.assertNotIn(OTHER, result.stderr)

    def test_readback_failure_is_redacted(self):
        result = self.invoke("failed")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("private server information", result.stderr)


if __name__ == "__main__":
    unittest.main()
