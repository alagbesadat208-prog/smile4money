"""Pure offline checks; no Github API, tokens, or deployment required."""
import importlib.util
from pathlib import Path
import unittest

source = Path(__file__).resolve().parents[1] / 'scripts' / 'verify_production_approval.py'
spec = importlib.util.spec_from_file_location('production_approval', source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

ACCOUNT = 'G' + 'A' * 55
CONTRACT = 'C' + 'A' * 55


def request(actor='alice'):
    return dict(repository='example/repo', run_id=100, sha='a'*40, actor=actor,
                token_address=CONTRACT, oracle_address=ACCOUNT)


def environment(protected=True):
    return {'protection_rules': [{'type': 'required_reviewers',
                                  'prevent_self_review': protected,
                                  'reviewers': [{'type': 'User', 'reviewer': {'login': 'bob'}}]}]}


def review(user='bob', state='approved'):
    return [{'state': state, 'user': {'login': user}, 'environments': [{'name': 'production'}]}]


class ApprovalTests(unittest.TestCase):
    def test_independent_approval_and_bound_values(self):
        evidence = module.validate(request(), environment(), review())
        self.assertEqual(evidence['approved_by'], 'bob')
        self.assertEqual(evidence['reviewed_token_address'], CONTRACT)
    def test_no_approval_rejected(self):
        with self.assertRaises(module.ApprovalError):
            module.validate(request(), environment(), [])
    def test_self_approval_rejected(self):
        with self.assertRaises(module.ApprovalError):
            module.validate(request(), environment(), review('alice'))
    def test_unprotected_environment_rejected(self):
        with self.assertRaises(module.ApprovalError):
            module.validate(request(), environment(False), review())
    def test_invalid_address_rejected(self):
        cfg = request(); cfg['token_address'] = 'not-an-address'
        with self.assertRaises(module.ApprovalError):
            module.validate(cfg, environment(), review())
    def test_rejected_review_not_authorization(self):
        with self.assertRaises(module.ApprovalError):
            module.validate(request(), environment(), review(state='rejected'))


if __name__ == '__main__':
    unittest.main()
