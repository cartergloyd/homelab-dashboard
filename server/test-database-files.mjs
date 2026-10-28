import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { cfg } from './dist/config.js';
import { databaseFileRoutes, MAX_DATABASE_FILE } from './dist/services/databaseFiles.js';
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'database-files-test-'));
const previous = cfg.dataDir;
cfg.dataDir = temp;
await fs.writeFile(path.join(temp,'database-uploads.json'), JSON.stringify({personal:'private-test-token'}));
const originalFetch=globalThis.fetch;
let calls=[], mode='normal';
globalThis.fetch=async (url, init) => {
  calls.push({url,init});
  assert.equal(init.headers.Authorization,'Bearer private-test-token');
  if(mode==='failure') return new Response('private upstream error',{status:403});
  if(init.method==='POST') {
    const file=init.body.get('file');
    assert.equal(file.name,'test.png');
    assert.equal(file.size,3);
    return Response.json({data:{id:'d3f3447c-a150-4915-94f5-71d5e7ebf007',filename_download:file.name}});
  }
  if(url.includes('/assets/')) return new Response('<script>bad()</script>');
  if(/\/files\//.test(url)) return Response.json({data:{type:'image/svg+xml',filename_download:'unsafe.svg'}});
  return Response.json({data:[]});
};
const app=express();
app.use((req,res,next)=>req.headers.authorization==='Bearer owner'?next():res.sendStatus(401));
app.use('/api/database/files',databaseFileRoutes(()=>{}));
app.use((error,_req,res,_next)=>res.status(error.status || 500).json({error:error.message}));
const server=app.listen(0,'127.0.0.1');
await new Promise(resolve=>server.once('listening',resolve));
const base=`http://127.0.0.1:${server.address().port}/api/database/files`;
const get=(url,init={})=>originalFetch(base+url,{...init,headers:{Authorization:'Bearer owner',...init.headers}});
try {
  let r=await originalFetch(base+'/targets'); assert.equal(r.status,401);
  r=await get('/targets'); assert.equal(r.status,200);assert.ok(!(await r.text()).includes('private-test-token'));
  r=await get('/personal');assert.equal(r.status,200);assert.deepEqual(await r.json(),[]);
  const n=calls.length;r=await get('/unknown');assert.equal(r.status,404);assert.equal(calls.length,n);
  const form=new FormData();form.append('files',new Blob(['png'],{type:'image/png'}),'test.png');
  r=await get('/personal',{method:'POST',body:form});assert.equal(r.status,201,await r.text());
  r=await get('/personal',{method:'POST',body:new FormData()});assert.equal(r.status,400);
  const big=new FormData();big.append('files',new Blob([new Uint8Array(MAX_DATABASE_FILE+1)]),'big.bin');
  r=await get('/personal',{method:'POST',body:big});assert.equal(r.status,400);assert.match(await r.text(),/25 MB/);
  r=await get('/personal/d3f3447c-a150-4915-94f5-71d5e7ebf007?preview=1');
  assert.equal(r.headers.get('content-type'),'application/octet-stream');
  assert.match(r.headers.get('content-disposition'),/^attachment/);
  assert.equal(r.headers.get('x-content-type-options'),'nosniff');
  assert.equal(await r.text(),'<script>bad()</script>');
  mode='failure';r=await get('/personal');assert.equal(r.status,502);assert.ok(!(await r.text()).includes('private upstream error'));
  console.log('Database uploads: auth, target allowlist, private tokens, multipart upload, size limit, safe downloads and upstream failure handling passed');
} finally {
  globalThis.fetch=originalFetch;cfg.dataDir=previous;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(temp,{recursive:true,force:true});
}
