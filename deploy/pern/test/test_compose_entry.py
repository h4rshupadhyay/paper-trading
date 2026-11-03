"""Deployment contract through Docker Compose's public configuration interface.

Run: python3 -m unittest discover -s deploy/pern/test -p test_compose_entry.py -v
Only renders configuration with dummy secrets; never starts a container.
"""
import json
import os
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[3]
DUMMY_ENV = {
    'PAPER_ADMIN_PASSWORD': 'test_admin_only',
    'PAPER_OWNER_PASSWORD': 'test_owner_only',
    'PAPER_APP_PASSWORD': 'test_app_only',
    'PUBLIC_ORIGIN': 'http://localhost:3000',
    'CSRF_SECRET': 'test_csrf_only',
}


def render(*args, secrets=True):
    env = {k: v for k, v in os.environ.items()
           if not k.startswith(('COMPOSE_', 'PAPER_', 'PERN_', 'MARKET_', 'TRUSTED_INGRESS_'))
           and k not in ('PUBLIC_ORIGIN', 'CSRF_SECRET', 'NODE_ENV')}
    if secrets:
        env.update(DUMMY_ENV)
    return subprocess.run(['docker', 'compose', '--env-file', '/dev/null', *args,
                           'config', '--format', 'json'], cwd=ROOT, env=env,
                          capture_output=True, text=True)


class ComposeEntryTest(unittest.TestCase):
    def test_default_entry_selects_current_stack_and_existing_volume(self):
        result = render()
        self.assertEqual(result.returncode, 0, result.stderr)
        config = json.loads(result.stdout)
        self.assertEqual(config['name'], 'paper-pern')
        self.assertEqual(set(config['services']),
                         {'db', 'migrate', 'api', 'worker', 'web', 'market-data'})
        self.assertEqual(config['volumes']['pern_data']['name'], 'paper-pern_pern_data')
        self.assertEqual(config, json.loads(render('-f', 'compose.pern.yml').stdout))
        self.assertEqual(config['services']['migrate']['command'],
                         ['node', 'apps/server/dist/src/platform/migrate.js'])

    def test_missing_secrets_fail_closed(self):
        for entry in ((), ('-f', 'compose.pern.yml')):
            with self.subTest(entry=entry):
                result = render(*entry, secrets=False)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('Set PAPER_', result.stderr)


if __name__ == '__main__':
    unittest.main()
