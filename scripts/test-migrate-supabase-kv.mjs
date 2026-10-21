import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'fam-kv-migration-test-'));
const script = fileURLToPath(new URL('./migrate-supabase-kv.sh', import.meta.url));
try {
  const bin = path.join(tmp, 'bin'); await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'curl'), `#!/usr/bin/env node
const fs=require('fs'),args=process.argv.slice(2),out=args[args.indexOf('-o')+1],hdr=args[args.indexOf('-D')+1];
const range=args.find(a=>a.startsWith('Range: '));const n=Number(range.match(/Range: (\\d+)/)[1]);
fs.writeFileSync(hdr,'content-range: '+n+'-'+n+'/2\\r\\n');
fs.writeFileSync(out,JSON.stringify([{coll:'plans',id:'fixture-'+n,data:{nested:{text:'Line one\\nLine two'},ts:n}}],null,2));process.stdout.write('206');
`, { mode: 0o755 });
  await fs.writeFile(path.join(bin, 'docker'), `#!/usr/bin/env node
if(process.argv[2]==='inspect'){console.log('true');process.exit(0)}
if(process.argv.includes('-f')){let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{if(!s.includes('begin;')||!s.includes('on conflict (key)'))process.exit(1)});}
else console.log('2');
`, { mode: 0o755 });
  const result = spawnSync('bash', [script, 'fam', '--url', 'https://fixture.invalid', '--key', 'fixture-public-key', '--skip-directus'], {
    env: { ...process.env, PATH: bin + ':' + process.env.PATH, COMPOSE_ENV: path.join(tmp, 'absent.env'), MIGRATION_DIR: path.join(tmp, 'exports'), TMPDIR: tmp }, encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  const exports = await fs.readdir(path.join(tmp, 'exports')); assert.equal(exports.length, 1);
  const file = path.join(tmp, 'exports', exports[0]); const rows = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(rows.length, 2); assert.equal(rows[1].data.nested.text, 'Line one\nLine two');
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.deepEqual((await fs.readdir(tmp)).sort(), ['bin','exports'], 'temporary page files cleaned up');
  const generated = spawnSync('bash', [script,'fam','--from-file',file,'--print-sql'], { encoding:'utf8',env:{...process.env,COMPOSE_ENV:path.join(tmp,'absent.env')} });
  assert.equal(generated.status,0); assert.match(generated.stdout,/key text|key  text/); assert.match(generated.stdout,/coll_id_unique/);
  await fs.writeFile(file, JSON.stringify([rows[0],rows[0]]));
  const duplicate = spawnSync('bash', [script,'fam','--from-file',file,'--print-sql'], {encoding:'utf8',env:{...process.env,COMPOSE_ENV:path.join(tmp,'absent.env')}});
  assert.notEqual(duplicate.status,0); assert.match(duplicate.stderr,/duplicate document/);
  console.log('Migration tests passed: paginated formatted JSON, nested data, private export, temporary cleanup, generated SQL and duplicate rejection.');
} finally { await fs.rm(tmp,{recursive:true,force:true}); }
