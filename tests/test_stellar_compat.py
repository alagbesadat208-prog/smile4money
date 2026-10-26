"""Mock Stellar CLI in PATH so compatibility checks do not need installation."""
import os
import subprocess
import tempfile
from pathlib import Path
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'check_stellar_compat.sh'

class CompatibilityTests(unittest.TestCase):
    def run_check(self, version, decode_ok=True):
        with tempfile.TemporaryDirectory() as folder:
            cli = Path(folder) / 'stellar'
            cli.write_text('#!/bin/sh\n'
                           'if [ "$1" = "--version" ]; then echo "stellar '+version+'"; exit 0; fi\n'
                           + ('exit 0\n' if decode_ok else 'exit 1\n'))
            cli.chmod(0o755)
            env = dict(os.environ, PATH=folder + os.pathsep + os.environ.get('PATH', ''))
            wasm1, wasm2 = Path(folder)/'escrow.wasm', Path(folder)/'oracle.wasm'
            wasm1.write_bytes(b'wasm'); wasm2.write_bytes(b'wasm')
            return subprocess.run(['bash', str(SCRIPT), str(wasm1), str(wasm2)],
                                  env=env, capture_output=True, text=True)
    def test_supported_cli_with_decodable_spec(self):
        self.assertEqual(self.run_check('22.0.1').returncode, 0)
    def test_old_cli_fails(self):
        self.assertNotEqual(self.run_check('21.1.0').returncode, 0)
    def test_unknown_future_cli_fails(self):
        self.assertNotEqual(self.run_check('99.0.0').returncode, 0)
    def test_unreadable_spec_fails(self):
        self.assertNotEqual(self.run_check('22.0.1', False).returncode, 0)


if __name__ == '__main__':
    unittest.main()
