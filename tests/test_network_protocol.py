"""Mock RPC result structures; no network access."""
import importlib.util
from pathlib import Path
import unittest

file = Path(__file__).resolve().parents[1] / 'scripts' / 'check_network_protocol.py'
spec = importlib.util.spec_from_file_location('check_network_protocol', file)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

class NetworkProtocolTests(unittest.TestCase):
    def rpc(self, url, method):
        if method == 'getNetwork':
            return {'passphrase': 'Test SDF Network ; September 2015'}
        return {'protocolVersion': 27}
    def test_current_cli(self):
        self.assertEqual(mod.validate('testnet', 27, self.rpc), 27)
    def test_old_cli_rejected(self):
        with self.assertRaisesRegex(ValueError, 'older than'):
            mod.validate('testnet', 22, self.rpc)
    def test_passphrase_mismatch_rejected(self):
        with self.assertRaisesRegex(ValueError, 'mismatch'):
            mod.validate('mainnet', 27, self.rpc)
    def test_malformed_protocol_rejected(self):
        with self.assertRaisesRegex(ValueError, 'unsupported'):
            mod.validate('testnet', 27, lambda url, method: {'passphrase': 'Test SDF Network ; September 2015'} if method == 'getNetwork' else {'protocolVersion': '27'})

if __name__ == '__main__':
    unittest.main()
