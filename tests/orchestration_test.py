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
            if suite not in ('native', 'orchestration'):
                self.assertEqual(command, ['/usr/bin/npm', '--ignore-scripts', 'run',
                                           'check' if suite == 'check' else 'test:' + suite])
        self.assertIn('--locked', runner.suite_command('native'))
        for args in ([], ['--update'], ['../check'], ['check; touch injected'], ['check', '--update']):
            result = subprocess.run([str(ROOT / 'scripts/notation-review-check'), *args], capture_output=True)
            self.assertEqual(result.returncode, 2)

    def test_v2_reviewer_policy_denies_general_shell_delegation_and_edits(self):
        config = json.loads((ROOT / 'opencode.json').read_text())
        for name in ('glm-reviewer', 'glm-security-reviewer'):
            rules = config['agents'][name]['permissions']
            def effect(action, resource):
                import fnmatch
                matches = [r['effect'] for r in rules if fnmatch.fnmatchcase(action, r['action'])
                           and fnmatch.fnmatchcase(resource, r['resource'])]
                return matches[-1] if matches else None
            self.assertEqual(effect('shell', 'printf UNEXPECTED_GENERAL_SHELL'), 'deny')
            self.assertEqual(effect('edit', 'src/store.ts'), 'deny')
            self.assertEqual(effect('subagent', 'sol-implementer'), 'deny')
            self.assertEqual(effect('shell', 'scripts/notation-review-check check'), 'allow')
            self.assertEqual(effect('shell', 'scripts/notation-review-check check --update'), 'deny')


if __name__ == '__main__':
    unittest.main()
