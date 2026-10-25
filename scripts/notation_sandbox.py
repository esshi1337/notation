"""Bubblewrap mount policy shared by launchers and real boundary tests (Linux)."""
import os
from pathlib import Path
import shutil

PROTECTED = {'.git', '.codex', '.github', '.githooks', '.serena', 'orchestration',
             'AGENTS.md', 'opencode.json', 'node_modules', '.agent-state',
             'test-results', 'playwright-report'}


def validate_writes(root, paths):
    root = Path(root).resolve()
    for name in paths:
        path = Path(name)
        if (not path.parts or path.is_absolute() or '..' in path.parts or
                path.parts[0] in PROTECTED or
                (path.parts[0] == 'scripts' and
                 (len(path.parts) == 1 or path.parts[1].startswith(('notation', 'sandbox-bin'))))):
            raise ValueError(f'protected or invalid write-set: {name}')
        target = root / path
        if not target.exists() or any(part.is_symlink() for part in [target, *target.parents]):
            raise ValueError(f'write-set must exist without symlink components: {name}')
        if root not in target.resolve().parents:
            raise ValueError(f'write-set escapes repository: {name}')


def build(root, role, command, extra_env=None, writes=()):
    root = Path(root).resolve()
    validate_writes(root, writes)
    if role not in ('advisor', 'sol', 'deepseek', 'challenger', 'security'):
        raise ValueError('unknown sandbox role')
    if role in ('challenger', 'security') and writes:
        raise ValueError('reviewers cannot request writable source')
    bwrap = shutil.which('bwrap')
    if not bwrap:
        raise RuntimeError('Bubblewrap required; refusing unsandboxed execution')
    argv = [bwrap, '--die-with-parent', '--new-session', '--unshare-user', '--unshare-pid',
            '--unshare-ipc', '--unshare-uts', '--cap-drop', 'ALL', '--clearenv',
            '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin',
            '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib', '/lib64',
            '--dir', '/etc', '--proc', '/proc', '--dev', '/dev',
            '--tmpfs', '/tmp', '--tmpfs', '/agent-home', '--dir', '/work',
            '--bind' if role == 'advisor' else '--ro-bind', str(root), '/work']
    # Only public system inputs, never the host's complete configuration tree.
    for name in ('resolv.conf', 'hosts', 'nsswitch.conf', 'passwd', 'group',
                 'ld.so.cache', 'localtime', 'ssl/certs', 'ssl/cert.pem',
                 'ca-certificates/extracted'):
        source = Path('/etc') / name
        if source.exists():
            argv += ['--ro-bind', str(source.resolve()), '/etc/' + name]
    dependencies = root / 'node_modules'
    if dependencies.exists():
        # Resolve the link as seen from /work, not from the host checkout path.
        destination = os.path.normpath(os.path.join('/work', os.readlink(dependencies))) if dependencies.is_symlink() else '/work/node_modules'
        argv += ['--ro-bind', str(dependencies.resolve()), destination]
        for cache in ('.vite', '.vite-temp', '.cache'):
            target = dependencies / cache
            if target.is_symlink():
                raise RuntimeError('Dependency cache must not be a symlink')
            target.mkdir(exist_ok=True)
            argv += ['--tmpfs', destination + '/' + cache]
    git = root / '.git'
    if not git.is_dir():
        raise RuntimeError('Use an independent clone; linked worktrees are not supported')
    if role != 'advisor':
        argv += ['--ro-bind', str(git), '/work/.git']
    for name in writes:
        argv += ['--bind', str(root / name), '/work/' + name]
    for name in ('test-results', 'playwright-report', 'public/pdfjs', '.serena/cache', '.serena/memories'):
        target = root / name
        if any(part.is_symlink() for part in [target, *target.parents]):
            raise RuntimeError('Scratch directories must not contain symlink components')
        target.mkdir(parents=True, exist_ok=True)
        argv += ['--tmpfs', '/work/' + name]
    # Dependencies, Git internals and masked agent history are not source trees.
    # Do not follow directory links out of the checkout while finding secrets.
    for directory, children, files in os.walk(root, followlinks=False):
        children[:] = [name for name in children if name not in ('.git', 'node_modules', '.agent-state')]
        for name in children + files:
            if name.startswith('.env') and name != '.env.example':
                secret = Path(directory) / name
                if secret.is_symlink() or not secret.is_file():
                    raise RuntimeError('Secret paths must be regular files, not symlinks or directories')
                argv += ['--ro-bind', '/dev/null', '/work/' + secret.relative_to(root).as_posix()]
    env = {'HOME': '/agent-home', 'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8',
           'TMPDIR': '/tmp', 'XDG_DATA_HOME': '/agent-home/data',
           'XDG_STATE_HOME': '/agent-home/state', 'XDG_CACHE_HOME': '/agent-home/cache',
           'XDG_CONFIG_HOME': '/agent-home/config', 'UV_CACHE_DIR': '/tmp/uv-cache',
           'UV_TOOL_DIR': '/tmp/uv-tools', 'SERENA_HOME': '/tmp/serena',
           'CARGO_HOME': '/tmp/cargo', 'CARGO_TARGET_DIR': '/tmp/cargo-target',
           'GIT_CONFIG_COUNT': '3', 'GIT_CONFIG_KEY_0': 'safe.directory',
           'GIT_CONFIG_VALUE_0': '/work', 'GIT_CONFIG_KEY_1': 'core.hooksPath',
           'GIT_CONFIG_VALUE_1': '/work/.githooks',
           'GIT_CONFIG_KEY_2': 'credential.https://github.com.helper',
           'GIT_CONFIG_VALUE_2': '!gh auth git-credential'}
    env.update(extra_env or {})
    if role != 'advisor':
        env.pop('GH_TOKEN', None)
    else:
        auth = Path(os.environ.get('CODEX_HOME', str(Path.home() / '.codex'))) / 'auth.json'
        if not auth.is_file():
            raise RuntimeError('Existing Codex authentication required')
        argv += ['--dir', '/agent-home/.codex', '--ro-bind', str(auth), '/agent-home/.codex/auth.json']
        state = root / '.agent-state'
        state.mkdir(exist_ok=True, mode=0o700)
        argv += ['--bind', str(state), '/agent-home/.codex/sessions']
    python = Path(os.environ.get('UV_PYTHON_INSTALL_DIR', str(Path.home() / '.local/share/uv/python')))
    if python.is_dir():
        argv += ['--ro-bind', str(python), '/opt/uv-python']
        env['UV_PYTHON_INSTALL_DIR'] = '/opt/uv-python'
    rust = Path(os.environ.get('RUSTUP_HOME', str(Path.home() / '.rustup')))
    if rust.is_dir():
        argv += ['--ro-bind', str(rust), '/opt/rustup']
        env['RUSTUP_HOME'] = '/opt/rustup'
    if role != 'advisor' and (root / '.agent-state').is_dir():
        argv += ['--tmpfs', '/work/.agent-state']
    for key, value in env.items():
        argv += ['--setenv', key, value]
    return argv + ['--chdir', '/work', '--', *command]


def exec_sandbox(argv):
    """Keep injected credentials out of process argv and off the filesystem."""
    descriptor = os.memfd_create('notation-sandbox-args', flags=0)
    try:
        separator = argv.index('--')
        options, command = argv[1:separator], argv[separator + 1:]
        payload = b'\0'.join(os.fsencode(arg) for arg in options) + b'\0'
        with os.fdopen(os.dup(descriptor), 'wb') as stream:
            stream.write(payload)
        os.lseek(descriptor, 0, os.SEEK_SET)
        os.execv(argv[0], [argv[0], '--args', str(descriptor), '--', *command])
    finally:
        os.close(descriptor)
