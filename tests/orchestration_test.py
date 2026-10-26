"""Run real mount-boundary probes and offline workflow/command regressions."""
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from notation_sandbox import build, validate_writes

loader = importlib.machinery.SourceFileLoader('notation_task', str(ROOT / 'scripts/notation-task'))
spec = importlib.util.spec_from_loader(loader.name, loader)
workflow = importlib.util.module_from_spec(spec)
loader.exec_module(workflow)


class Boundaries(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='notation-boundary-')
        self.addCleanup(self.temp.cleanup)
        self.host = Path(self.temp.name)
        self.root = self.host / 'repo'
        (self.root / '.git').mkdir(parents=True)
        (self.root / 'src').mkdir()
        (self.root / 'src/allowed').write_text('original')
        (self.root / 'src/other').write_text('original')
        (self.host / 'personal-secret').write_text('private-canary')
        (self.root / '.git/config').write_text('git-canary')

    def sandbox(self, role, code, writes=()):
        return subprocess.run(build(self.root, role, ['/usr/bin/python3', '-c', code], writes=writes),
                              capture_output=True, text=True,
                              env=dict(os.environ, NOTATION_HOST_SECRET='must-not-leak'))

    def test_reviewer_hides_personal_files_and_environment_and_cannot_edit_source_or_git(self):
        code = f'''
import os
from pathlib import Path
assert not Path({str(self.host / 'personal-secret')!r}).exists()
assert not Path('/home/esshi/.codex/auth.json').exists()
assert not Path('/run/user').exists()
assert 'NOTATION_HOST_SECRET' not in os.environ
assert 'GH_TOKEN' not in os.environ
assert 'DBUS_SESSION_BUS_ADDRESS' not in os.environ
assert Path('/work/src/allowed').read_text() == 'original'
for name in ('src/allowed', '.git/config', 'injected'):
    try: Path('/work', name).write_text('bad')
    except OSError: pass
    else: raise AssertionError('unexpected write: ' + name)
Path('/tmp/result').write_text('scratch works')
Path('/agent-home/result').write_text('scratch home works')
'''
        for role in ('challenger', 'security'):
            result = self.sandbox(role, code)
            self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.root / '.git/config').read_text(), 'git-canary')

    def test_implementer_can_write_only_declared_existing_file(self):
        result = self.sandbox('deepseek', '''
from pathlib import Path
Path('/work/src/allowed').write_text('implemented')
for name in ('src/other', '.git/config', 'src/new'):
    try: Path('/work', name).write_text('bad')
    except OSError: pass
    else: raise AssertionError(name)
''', ['src/allowed'])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.root / 'src/allowed').read_text(), 'implemented')
        self.assertEqual((self.root / 'src/other').read_text(), 'original')

    def test_protected_escaping_and_symlink_writes_are_rejected(self):
        (self.root / 'src/link').symlink_to(self.host / 'personal-secret')
        for name in ('', '.', '..', '../personal-secret', '/etc', '.git', '.codex/config.toml',
                     '.githooks', 'AGENTS.md', 'opencode.json', 'scripts', 'scripts/notation-worker',
                     'src/link', 'src/missing'):
            with self.subTest(name=name), self.assertRaises(ValueError):
                validate_writes(self.root, [name])

    def test_no_sandbox_no_fallback(self):
        with patch('notation_sandbox.shutil.which', return_value=None), self.assertRaises(RuntimeError):
            build(self.root, 'security', ['/usr/bin/true'])

    def test_public_catalog_is_read_only_and_native_auth_is_absent_for_every_role(self):
        catalog = self.host / 'models.json'
        catalog.write_text('{"models":[]}')
        auth = self.host / 'native-auth'
        auth.mkdir()
        (auth / 'auth.json').write_text('native-auth-canary')
        code = '''
from pathlib import Path
assert not Path('/agent-home/.codex/auth.json').exists()
assert Path('/opt/notation-models.json').read_text() == '{"models":[]}'
try: Path('/opt/notation-models.json').write_text('bad')
except OSError: pass
else: raise AssertionError('catalog is writable')
'''
        for role in ('advisor', 'sol', 'deepseek', 'challenger', 'security'):
            with self.subTest(role=role), patch.dict(os.environ, CODEX_HOME=str(auth)):
                argv = build(self.root, role, ['/usr/bin/python3', '-c', code], model_catalog=catalog)
                result = subprocess.run(argv, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertNotIn(str(auth / 'auth.json'), argv)

    def test_review_rejects_writes_even_at_lower_policy_layer(self):
        with self.assertRaises(ValueError):
            build(self.root, 'security', ['/usr/bin/true'], writes=['src/allowed'])

    def test_linked_worktree_is_rejected(self):
        (self.root / '.git/config').unlink()
        (self.root / '.git').rmdir()
        (self.root / '.git').write_text('gitdir: /private/elsewhere')
        with self.assertRaises(RuntimeError):
            build(self.root, 'deepseek', ['/usr/bin/true'])

    def test_root_and_nested_env_secrets_are_unreadable_but_examples_remain(self):
        for name in ('.env', 'src/.env.local'):
            (self.root / name).write_text('secret-canary')
        (self.root / 'src/.env.example').write_text('example')
        result = self.sandbox('security', '''
from pathlib import Path
for name in ('.env', 'src/.env.local'):
    try: assert Path('/work', name).read_bytes() == b''
    except PermissionError: pass
assert Path('/work/src/.env.example').read_text() == 'example'
''')
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_nested_secret_symlinks_and_directories_are_rejected(self):
        secret = self.root / 'src/.env.private'
        secret.symlink_to(self.host / 'personal-secret')
        with self.assertRaises(RuntimeError):
            build(self.root, 'security', ['/usr/bin/true'])
        secret.unlink()
        secret.mkdir()
        with self.assertRaises(RuntimeError):
            build(self.root, 'security', ['/usr/bin/true'])

    def test_relative_dependency_symlink_preserves_access_without_exposing_parent(self):
        dependencies = self.host / 'shared/modules'
        dependencies.mkdir(parents=True)
        (dependencies / 'package.json').write_text('{}')
        (self.host / 'shared/private').write_text('private-canary')
        (self.root / 'node_modules').symlink_to('../shared/modules')
        code = f'''
from pathlib import Path
assert Path('/work/node_modules/package.json').read_text() == '{{}}'
assert not Path({str(self.host / 'shared/private')!r}).exists()
try: Path('/work/node_modules/package.json').write_text('bad')
except OSError: pass
else: raise AssertionError('dependency is writable')
'''
        result = self.sandbox('security', code)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_memfd_execution_preserves_arguments_and_closes_argument_descriptor(self):
        code = '''
import os, sys
from pathlib import Path
assert sys.argv[1:] == ['space value', '--option']
for fd in Path('/proc/self/fd').iterdir():
    try: target = os.readlink(fd)
    except FileNotFoundError: continue
    assert 'notation-sandbox-args' not in target, 'argument descriptor inherited'
'''
        argv = build(self.root, 'security', ['/usr/bin/python3', '-c', code, 'space value', '--option'])
        runner = 'import json,sys; sys.path.insert(0,sys.argv[1]); from notation_sandbox import exec_sandbox; exec_sandbox(json.load(sys.stdin))'
        result = subprocess.run([sys.executable, '-c', runner, str(ROOT / 'scripts')],
                                input=json.dumps(argv), capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)


class Workflow(unittest.TestCase):
    def test_scoping_accepts_cli_and_github_form_headings(self):
        for level in ('##', '###'):
            workflow.scope('\n'.join(f'{level} {h}\nConcrete criteria\n' for h in
                                     ('Problem', 'Scope', 'Non-goals', 'Acceptance')))

    def test_missing_or_empty_acceptance_is_rejected(self):
        for body in ('## Problem\nUnbounded task', '## Problem\n\n## Scope\n\n## Non-goals\n\n## Acceptance\n'):
            with self.assertRaises(ValueError):
                workflow.scope(body)

    def test_closed_unassigned_or_multiple_category_issue_is_rejected(self):
        base = dict(state='OPEN', assignees=[{'login': 'esshi1337'}], labels=[{'name': 'bug'}],
                    body='\n'.join(f'## {h}\nConcrete\n' for h in ('Problem', 'Scope', 'Non-goals', 'Acceptance')))
        with patch.object(workflow, 'gh', return_value=json.dumps(base)):
            workflow.issue(1)
        for changes in ({'state': 'CLOSED'}, {'assignees': []}, {'labels': []},
                        {'labels': [{'name': 'bug'}, {'name': 'enhancement'}]}):
            with patch.object(workflow, 'gh', return_value=json.dumps(base | changes)), self.assertRaises(ValueError):
                workflow.issue(1)

    def test_main_and_unscoped_branch_cannot_start_coding(self):
        for branch in ('main', '', 'feature/anything', 'issue/0-no', 'issue/1-../escape'):
            with patch.object(workflow, 'run', return_value=branch), self.assertRaises(ValueError):
                workflow.branch_issue()

    def test_draft_pr_keeps_scope_and_clean_checks_and_requests_draft(self):
        with tempfile.TemporaryDirectory() as directory:
            body = Path(directory) / 'pr.txt'
            body.write_text('Closes #1\n\n## Validation\nChecks pending\n\n## Review\nDraft pending review\n')
            for draft in (False, True):
                args = ['notation-task', 'pr', '--title', 'Scoped change', '--body-file', str(body)]
                if draft:
                    args.append('--draft')
                with patch.object(sys, 'argv', args), \
                        patch.object(workflow, 'branch_issue', return_value=('issue/1-test', 1)) as scoped, \
                        patch.object(workflow, 'clean') as clean, patch.object(workflow, 'run'), \
                        patch.object(workflow, 'gh', return_value='created') as gh, patch('builtins.print'):
                    workflow.main()
                    scoped.assert_called_once()
                    clean.assert_called_once()
                    self.assertEqual('--draft' in gh.call_args.args, draft)


class Entrypoints(unittest.TestCase):
    def test_worker_rejects_unbounded_or_override_arguments_before_network(self):
        for args in ([], ['sol'], ['sol', 'implement'], ['security', '--write', 'src', 'review'],
                     ['deepseek', '--write', '.git', 'implement'],
                     ['security', 'review', '--model', 'anything'], ['security', 'review', '--command', 'rm']):
            result = subprocess.run([str(ROOT / 'scripts/notation-worker'), *args], capture_output=True)
            self.assertNotEqual(result.returncode, 0, args)

    def test_check_runner_fixed_commands_and_rejection(self):
        loader = importlib.machinery.SourceFileLoader('review_check', str(ROOT / 'scripts/notation-review-check'))
        spec = importlib.util.spec_from_loader(loader.name, loader)
        runner = importlib.util.module_from_spec(spec)
        loader.exec_module(runner)
        for suite in runner.SUITES:
            command = runner.suite_command(suite)
            self.assertTrue(command[0].startswith('/usr/bin/'))
            if suite not in ('native', 'orchestration', 'sticky'):
                self.assertEqual(command, ['/usr/bin/npm', '--ignore-scripts', 'run',
                                           'check' if suite == 'check' else 'test:' + suite])
        self.assertIn('--locked', runner.suite_command('native'))
        for args in ([], ['--update'], ['../check'], ['check; touch injected'], ['check', '--update']):
            result = subprocess.run([str(ROOT / 'scripts/notation-review-check'), *args], capture_output=True)
            self.assertEqual(result.returncode, 2)

    def load_script(self, name):
        loader = importlib.machinery.SourceFileLoader(name.replace('-', '_'), str(ROOT / 'scripts' / name))
        spec = importlib.util.spec_from_loader(loader.name, loader)
        module = importlib.util.module_from_spec(spec)
        loader.exec_module(module)
        return module

    def test_native_roles_use_only_gateway_and_disable_recursive_workers(self):
        launch = self.load_script('notation-launch')
        for role, model in (('advisor', 'gpt-6-astra'), ('sol', 'gpt-6.1-sol'),
                            ('deepseek', 'combo/deepseek-auto'), ('challenger', 'zai/glm-5.3-flash'),
                            ('security', 'zai/glm-5.3-flash')):
            command = launch.codex_command(role, 'bounded packet')
            self.assertEqual(command[0], '/usr/bin/codex')
            self.assertIn(model, command)
            self.assertIn('features.multi_agent=false', command)
            self.assertIn('features.multi_agent_v2=false', command)
            self.assertIn('agents.enabled=false', command)
            self.assertIn('web_search="disabled"', command)
            self.assertIn('model_catalog_json="/opt/notation-models.json"', command)
            self.assertIn('http://127.0.0.1:10100/v1', ' '.join(command))
            self.assertNotIn('opencode', command)
            if role != 'advisor':
                self.assertEqual(command[1], 'exec')
                self.assertIn('--ignore-user-config', command)
                self.assertIn('--ephemeral', command)
            if role in ('challenger', 'security'):
                self.assertIn('features.shell_tool=false', command)
                self.assertIn('features.unified_exec=false', command)
                self.assertTrue(any(c.startswith('mcp_servers.notation_review=') and 'enabled=true' in c for c in command))
                self.assertTrue(any(c.startswith('mcp_servers.serena=') and 'enabled=false' in c for c in command))

    def test_context_profiles_are_explicit_and_preserve_role_permissions(self):
        launch = self.load_script('notation-launch')
        expected = {'advisor': (272000, 244800), 'sol': (256000, 205000),
                    'deepseek': (128000, 102000), 'challenger': (192000, 154000),
                    'security': (192000, 154000)}
        for role, (window, compact) in expected.items():
            default = launch.codex_command(role, 'packet')
            self.assertIn(f'model_context_window={window}', default)
            self.assertIn(f'model_auto_compact_token_limit={compact}', default)
            large = launch.codex_command(role, 'packet', context_profile='large')
            large_window, large_compact = ((272000, 244800) if role == 'advisor' else
                                           (500000, 400000) if role == 'sol' else (256000, 205000))
            self.assertIn(f'model_context_window={large_window}', large)
            self.assertIn(f'model_auto_compact_token_limit={large_compact}', large)
            # Changing the budget must not change tools, identity or sandbox flags.
            strip = lambda cmd: [x for x in cmd if not x.startswith(
                ('model_context_window=', 'model_auto_compact_token_limit='))]
            self.assertEqual(strip(default), strip(large))
        result = subprocess.run([str(ROOT / 'scripts/notation-worker'), 'security',
                                 '--context-profile', 'unbounded', 'review'], capture_output=True)
        self.assertEqual(result.returncode, 2)
        with patch.dict(launch.ROLES['sol']['context_profiles']['default'], compact_at=256000):
            with self.assertRaises(ValueError):
                launch.codex_command('sol', 'packet')

    def test_nested_worker_launch_is_rejected_before_network(self):
        result = subprocess.run([str(ROOT / 'scripts/notation-worker'), 'deepseek', '--read-only', 'inspect'],
                                env=dict(os.environ, NOTATION_WORKER='1'), capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('workers cannot launch nested', result.stderr)

    def test_unavailable_gateway_fails_without_fallback_or_service_start(self):
        launch = self.load_script('notation-launch')
        with patch.object(launch.urllib.request, 'urlopen', side_effect=OSError('offline')), \
                patch.object(launch.subprocess, 'Popen') as start, self.assertRaises(RuntimeError):
            launch.gateway_catalog()
        start.assert_not_called()

    def test_review_tools_have_no_general_command_or_write_surface(self):
        review = self.load_script('notation-review-tools')
        self.assertEqual({tool['name'] for tool in review.TOOLS},
                         {'read_file', 'search_files', 'list_files', 'review_diff', 'run_check'})
        for suite in ('check; touch injected', '../check', 'check --update'):
            with self.assertRaises(ValueError):
                review.call_tool('run_check', {'suite': suite})
        for path in ('/etc/passwd', '../../AGENTS.md'):
            with self.assertRaises(ValueError):
                review.call_tool('read_file', {'path': path})
        with self.assertRaises(ValueError):
            review.call_tool('shell', {'command': 'true'})
        self.assertTrue(review.call_tool('read_file', {'path': 'AGENTS.md', 'line_count': 1}).startswith('1: #'))

    def test_review_mcp_initialization_and_tools_are_real_json_rpc(self):
        messages = [dict(jsonrpc='2.0', id=1, method='initialize', params={'protocolVersion': '2024-11-05'}),
                    dict(jsonrpc='2.0', method='notifications/initialized'),
                    dict(jsonrpc='2.0', id=2, method='tools/list'),
                    dict(jsonrpc='2.0', id=3, method='tools/call', params={'name': 'read_file',
                         'arguments': {'path': 'AGENTS.md', 'line_count': 1}})]
        result = subprocess.run([str(ROOT / 'scripts/notation-review-tools')],
            input=''.join(json.dumps(m) + '\n' for m in messages), capture_output=True, text=True, check=True)
        replies = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual([reply['id'] for reply in replies], [1, 2, 3])
        self.assertEqual(replies[0]['result']['serverInfo']['name'], 'notation-review')
        self.assertEqual(len(replies[1]['result']['tools']), 5)
        self.assertIn('1: #', replies[2]['result']['content'][0]['text'])


if __name__ == '__main__':
    unittest.main()
