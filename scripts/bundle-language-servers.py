#!/usr/bin/env python3
"""Stage pinned language servers from npm ci's lock tree and official Node 22.

No package lifecycle scripts run here. Generated resources stay out of git.
"""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / 'src-tauri/resources/language-servers'
NODE_VERSION = '22.23.3'
NODE_SHA256 = 'df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de'

def patch_untrusted_prettier(stage):
    server = stage / 'node_modules/svelte-language-server/dist/src'
    replacements = {
        'importPackage.js': [('paths.push(__dirname);', "paths.push(!isTrusted && packageName === 'svelte' ? (0, path_1.resolve)(__dirname, '../../../..') : __dirname);")],
        'ls-config.js': [('await (0, importPackage_1.importPrettier)(filePath).resolveConfig(filePath, this.getPrettierConfigLoadingOptions())', 'this.getIsTrusted() ? await (0, importPackage_1.importPrettier)(filePath).resolveConfig(filePath, this.getPrettierConfigLoadingOptions()) : null')],
        'plugins/html/HTMLPlugin.js': [('const prettierConfig = filePath &&', 'const prettierConfig = this.configManager.getIsTrusted() && filePath &&')],
        'plugins/svelte/SveltePlugin.js': [('const fileInfo = await prettier.getFileInfo(filePath, {', 'const fileInfo = await prettier.getFileInfo(filePath, { resolveConfig: this.configManager.getIsTrusted(),'), ('getMergedPrettierConfig(await p.resolveConfig(filePath, {', 'getMergedPrettierConfig(this.configManager.getIsTrusted() ? await p.resolveConfig(filePath, {'), ('                }), \n                // Be defensive', '                }) : null, \n                // Be defensive')],
    }
    for name, edits in replacements.items():
        file = server / name
        text = file.read_text()
        for before, after in edits:
            if text.count(before) != 1:
                raise RuntimeError('Svelte trust patch no longer matches pinned package: ' + name)
            text = text.replace(before, after)
        file.write_text(text)


def main():
    lock = json.loads((ROOT / 'package-lock.json').read_text())['packages']
    packages = set()
    def collect(name, parent=ROOT):
        cursor = parent
        while True:
            candidate = cursor / 'node_modules' / name
            if (candidate / 'package.json').is_file():
                break
            if cursor == ROOT:
                raise RuntimeError('Missing locked dependency: ' + name)
            cursor = cursor.parent
        key = candidate.relative_to(ROOT).as_posix()
        if key in packages:
            return
        data = json.loads((candidate / 'package.json').read_text())
        if data['version'] != lock[key]['version']:
            raise RuntimeError('Installed package differs from lock: ' + key)
        packages.add(key)
        for child in data.get('dependencies', {}):
            collect(child, candidate)
        for child in data.get('optionalDependencies', {}):
            try:
                collect(child, candidate)
            except RuntimeError:
                pass
    for name in ['typescript', 'typescript-language-server', 'svelte-language-server', 'svelte']:
        collect(name)
    cache = ROOT / 'node_modules/.cache/notation-language-servers'
    cache.mkdir(parents=True, exist_ok=True)
    archive = cache / f'node-v{NODE_VERSION}-linux-x64.tar.xz'
    if not archive.exists():
        with urllib.request.urlopen(f'https://nodejs.org/dist/v{NODE_VERSION}/{archive.name}', timeout=60) as response:
            with archive.open('wb') as output:
                shutil.copyfileobj(response, output)
    if hashlib.sha256(archive.read_bytes()).hexdigest() != NODE_SHA256:
        raise RuntimeError('Node archive checksum mismatch')
    DEST.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=DEST.parent, prefix='language-stage-') as staging:
        stage = Path(staging)
        with tarfile.open(archive) as tar:
            for member in ['bin/node', 'LICENSE']:
                source = tar.extractfile(f'node-v{NODE_VERSION}-linux-x64/{member}')
                (stage / ('node' if member == 'bin/node' else 'NODE-LICENSE')).write_bytes(source.read())
        (stage / 'node').chmod(0o755)
        for key in sorted(packages):
            shutil.copytree(ROOT / key, stage / key, ignore=shutil.ignore_patterns('node_modules', '.git'), dirs_exist_ok=True)
        patch_untrusted_prettier(stage)
        (stage / 'manifest.json').write_text(json.dumps({'notationPatches': ['svelte-untrusted-prettier-config'], 'node': NODE_VERSION, 'nodeArchiveSha256': NODE_SHA256, 'packages': {key: lock[key]['version'] for key in sorted(packages)}}, indent=2)+'\n')
        subprocess.run([str(stage / 'node'), '--version'], check=True)
        subprocess.run([str(stage / 'node'), str(stage / 'node_modules/typescript-language-server/lib/cli.mjs'), '--version'], check=True)
        if DEST.exists():
            shutil.rmtree(DEST)
        shutil.copytree(stage, DEST)
    print(f'Bundled Node and {len(packages)} locked language-server packages')

if __name__ == '__main__':
    main()
