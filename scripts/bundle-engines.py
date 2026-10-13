#!/usr/bin/env python3
"""Reproduce the offline Linux/x86_64 engines from checksum-pinned upstream assets.
Usage: python scripts/bundle-engines.py [--skip jre]
No packages are installed and no system binaries are copied.
"""
import argparse
import concurrent.futures
import hashlib
import json
from pathlib import Path
import shutil
import tarfile
import tempfile
import urllib.request

ROOT=Path(__file__).resolve().parents[1]
LOCK=ROOT/'scripts/engines.lock.json'
DEST=ROOT/'src-tauri/resources/engines'
CACHE=ROOT/'src-tauri/target/engine-downloads'

def fetch(artifact):
    path=CACHE/(artifact['id']+'-'+artifact['sha256'])
    if not path.exists() or hashlib.sha256(path.read_bytes()).hexdigest()!=artifact['sha256']:
        with urllib.request.urlopen(artifact['url'],timeout=120) as response, tempfile.NamedTemporaryFile(dir=CACHE,delete=False) as output:
            shutil.copyfileobj(response,output)
            temporary=Path(output.name)
        if hashlib.sha256(temporary.read_bytes()).hexdigest()!=artifact['sha256']:
            temporary.unlink()
            raise ValueError('Checksum mismatch: '+artifact['id'])
        temporary.replace(path)
    output=DEST/artifact['destination']
    output.parent.mkdir(parents=True,exist_ok=True)
    if artifact.get('archive')=='tar':
        with tarfile.open(path) as archive:
            member=archive.getmember(artifact['member'])
            if not member.isfile(): raise ValueError('Expected regular archive member')
            with archive.extractfile(member) as source, output.open('wb') as target: shutil.copyfileobj(source,target)
        output.chmod(0o755)
    elif artifact.get('archive')=='tree':
        with tempfile.TemporaryDirectory(dir=CACHE) as temporary:
            with tarfile.open(path) as archive: archive.extractall(temporary,filter='data')
            entries=list(Path(temporary).iterdir())
            if len(entries)!=1 or not entries[0].is_dir(): raise ValueError('Unexpected runtime archive layout')
            if output.exists(): shutil.rmtree(output)
            shutil.copytree(entries[0],output,symlinks=True)
    else: shutil.copyfile(path,output)
    return artifact['id']

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--skip',action='append',default=[]);args=parser.parse_args()
    lock=json.loads(LOCK.read_text());CACHE.mkdir(parents=True,exist_ok=True);DEST.mkdir(parents=True,exist_ok=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for name in pool.map(fetch,[item for item in lock['artifacts'] if item['id'] not in args.skip]):print('Bundled',name,flush=True)
    for package in ['@fontsource/geist','@fontsource/geist-mono','katex']:
        notice=ROOT/'node_modules'/package/'LICENSE'
        if notice.is_file(): shutil.copyfile(notice,DEST/'licenses'/(package.replace('/','-').replace('@','')+'-LICENSE'))
    shutil.copyfile(LOCK,DEST/'manifest.json')
    if not (DEST/'jre/bin/java').is_file(): raise ValueError('Private JRE is missing; run without --skip jre')
    print('Offline engines ready at',DEST)
if __name__=='__main__':main()
