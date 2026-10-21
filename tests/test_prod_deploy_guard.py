"""The mainnet deployment entrypoint must fail before any Stellar CLI call."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]

class GuardTests(unittest.TestCase):
    def test_unapproved_manual_deploy_fails_without_mutation(self):
        with tempfile.TemporaryDirectory() as folder:
            cli = Path(folder) / 'stellar'
            marker = Path(folder) / 'called'
            cli.write_text('#!/bin/sh\ntouch "' + str(marker) + '"\nexit 0\n')
            cli.chmod(0o755)
            env = dict(os.environ, PATH=folder + os.pathsep + os.environ.get('PATH', ''))
            for name in ('GITHUB_ACTIONS', 'GITHUB_TOKEN', 'GITHUB_RUN_ID', 'PRODUCTION_APPROVAL_EVIDENCE'):
                env.pop(name, None)
            result = subprocess.run(['bash', str(ROOT / 'scripts/deploy_mainnet.sh')],
                                    cwd=ROOT, env=env, capture_output=True, text=True, timeout=10)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('APPROVAL DENIED', result.stderr)
            self.assertFalse(marker.exists())

if __name__ == '__main__':
    unittest.main()
