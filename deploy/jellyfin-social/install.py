#!/usr/bin/env python3
"""Stage verified upstream plugins into a stopped or disposable Jellyfin config.
Does not restart services, change existing plugin settings, or link user accounts.
"""
import argparse
import hashlib
import json
import pathlib
import stat
import urllib.request
import zipfile
import xml.etree.ElementTree as ET

ROOT=pathlib.Path(__file__).resolve().parent

def write_config(path,values):
    if path.exists():return
    root=ET.Element('PluginConfiguration',{'xmlns:xsi':'http://www.w3.org/2001/XMLSchema-instance','xmlns:xsd':'http://www.w3.org/2001/XMLSchema'})
    for key,value in values.items():
        el=ET.SubElement(root,key)
        if isinstance(value,dict):
            for k,v in value.items():ET.SubElement(el,k).text=str(v).lower()
        elif value is not None:el.text=str(value).lower() if isinstance(value,bool) else str(value)
    ET.indent(root)
    path.parent.mkdir(parents=True,exist_ok=True)
    ET.ElementTree(root).write(path,encoding='utf-8',xml_declaration=True)

def install(config,artifacts):
    lock=json.loads((ROOT/'plugins.lock.json').read_text())
    artifacts.mkdir(parents=True,exist_ok=True)
    for plugin in lock['plugins']:
        archive=artifacts/(plugin['name']+'-'+plugin['version']+'.zip')
        if not archive.exists():
            req=urllib.request.Request(plugin['url'],headers={'User-Agent':'HomelabPluginInstaller/1.0'})
            with urllib.request.urlopen(req,timeout=60) as response:archive.write_bytes(response.read())
        payload=archive.read_bytes()
        if hashlib.sha256(payload).hexdigest()!=plugin['sha256'] or hashlib.md5(payload).hexdigest()!=plugin['md5']:
            raise ValueError('Release checksum mismatch: '+plugin['name'])
        dest=config/'plugins'/(plugin['name']+'_'+plugin['version'])
        with zipfile.ZipFile(archive) as source:
            for entry in source.infolist():
                p=pathlib.PurePosixPath(entry.filename)
                if p.is_absolute() or '..' in p.parts or stat.S_ISLNK(entry.external_attr>>16):
                    raise ValueError('Unsafe archive entry')
            for entry in source.infolist():
                if entry.is_dir():continue
                out=dest/entry.filename
                out.parent.mkdir(parents=True,exist_ok=True)
                expected=source.read(entry)
                if out.exists() and out.read_bytes()!=expected:raise ValueError('Existing file differs: '+str(out))
                out.write_bytes(expected)
        # Explicit metadata keeps the validated release active and version-pinned.
        meta={k:plugin[k] for k in ['name','guid','owner','version','targetAbi']}
        meta.update({'status':'Active','autoUpdate':False,'assemblies':[]})
        (dest/'meta.json').write_text(json.dumps(meta,indent=2)+'\n')
        print(plugin['name']+' '+plugin['version']+': verified and staged')
    settings=config/'plugins/configurations'
    write_config(settings/'LetterboxdSync.xml',{'Accounts':None,'SerializdAccounts':None,'Telemetry':{'Enabled':False},'CatalogMigrationDone':True,'AutoApproveJellyseerrRequests':False})
    write_config(settings/'Jellyfin.Plugin.InternalRating.xml',{'HideLetterboxdButton':True,'HideExternalSyncButton':True,'MirrorToNativeRating':True,'PosterRatingPosition':'top-left'})

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config',type=pathlib.Path,required=True)
    parser.add_argument('--artifacts',type=pathlib.Path,required=True)
    args=parser.parse_args()
    install(args.config.resolve(),args.artifacts.resolve())
