#!/usr/bin/env python3
"""Read-only Jellyfin/plugin verification. Never prints API credentials or users."""
import argparse
import json
import pathlib
import urllib.request

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--url',default='http://127.0.0.1:8096')
parser.add_argument('--credentials',type=pathlib.Path,default=pathlib.Path('/home/gold/server-platform/fam-jellyfin-sync/config.json'))
args=parser.parse_args()
credentials=json.loads(args.credentials.read_text())

def get(path,raw=False):
    request=urllib.request.Request(args.url.rstrip('/')+path,headers={'X-Emby-Token':credentials['api_key']})
    with urllib.request.urlopen(request,timeout=15) as response:data=response.read().decode()
    return data if raw else json.loads(data)

assert 'Healthy' in get('/health',True)
info=get('/System/Info/Public')
assert info['Version']=='10.11.9',info['Version']
plugins=get('/Plugins')
expected={'Jellyscribe':'2.13.2.0','StarTrack':'1.8.1.0'}
for name,version in expected.items():
    p=next(p for p in plugins if p['Name']==name)
    assert p['Version']==version and p['Status']=='Active',p
    print(name+' '+version+': Active')
for name in ['File Transformation','Jellyfin Enhanced','Media Bar']:
    assert any(p['Name']==name and p['Status']=='Active' for p in plugins),name
cfg=get('/Plugins/c7a3e1b9-5d42-4f8a-9c06-2b7d8e4f1a35/Configuration')
assert not cfg.get('Telemetry',{}).get('Enabled')
# Account contents are private and are deliberately not printed.
print('Jellyscribe: '+str(len(cfg.get('Accounts',[])))+' linked film accounts, telemetry off')
star=get('/Plugins/a8b5e2f3-4c1d-4e8a-b2f9-6d3c7e1a5b2f/Configuration')
assert star['HideLetterboxdButton'] and star['HideExternalSyncButton'] and star['MirrorToNativeRating']
html=get('/web/index.html',True).lower()
assert 'startrack' in html and 'letterboxd' in html and 'jellyfinenhanced' in html
report=get('/Plugins/StarTrack/Debug',True)
assert 'Plugin loaded         : YES' in report
print('Existing plugins, injected web UI, native rating bridge, and single external-sync UI: verified')
print('Jellyfin '+info['Version']+': healthy')
