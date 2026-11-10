import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import express from 'express';
import { cfg } from './dist/config.js';
import { feedRoutes } from './dist/services/feed.js';
import { validateDoc, localPath } from './dist/services/feedLib.js';

// pure checks
assert.deepEqual(validateDoc({ section: 'research', slug: 'a-b', title: 't', summary: 's', date: '2026-11-09' }), []);
assert.equal(validateDoc({ section: 'x', slug: 'Bad Slug', date: 'nope' }).length, 5);
assert.equal(localPath('../x.png'), null);
assert.equal(localPath('images/a.png'), 'images/a.png');

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'feed-test-'));
cfg.dataDir = temp;
await fs.writeFile(path.join(temp, 'database-uploads.json'), JSON.stringify({ ai: 'tok' }));
const ai = cfg.apps.find(a => a.name === 'ai') ?? (cfg.apps.push({ name: 'ai', kind: 'directus', url: 'http://directus.test' }), cfg.apps.at(-1));

// build a zip: wrapper/one (with image + video), wrapper/bad (references a missing image)
const src = path.join(temp, 'src/wrapper');
await fs.mkdir(path.join(src, 'one/img'), { recursive: true });
await fs.mkdir(path.join(src, 'bad'), { recursive: true });
await fs.writeFile(path.join(src, 'one/img/a.png'), 'png');
await fs.writeFile(path.join(src, 'one/clip.mp4'), 'mp4');
await fs.writeFile(path.join(src, 'one/article.json'), JSON.stringify({ section: 'research', slug: 'one', title: 'One.', summary: 'First.', date: '2026-11-09', body: [{ image: 'img/a.png', alt: 'x' }, { video: 'clip.mp4' }, { image: 'https://example.com/ext.png' }] }));
await fs.writeFile(path.join(src, 'bad/article.json'), JSON.stringify({ section: 'solutions', slug: 'bad', title: 'Bad.', summary: 'No file.', date: '2026-11-09', cover: 'missing.png' }));
execFileSync('zip', ['-qr', path.join(temp, 'in.zip'), 'wrapper'], { cwd: path.join(temp, 'src') });

const originalFetch = globalThis.fetch;
const files = [], items = [];
globalThis.fetch = async (url, init = {}) => {
  assert.equal(init.headers.Authorization, 'Bearer tok');
  if (url.endsWith('/files?fields=id')) { files.push(init.body.get('file').name); assert.equal(init.body.get('folder'), 'bafa863f-798e-4f4c-a8f6-616768988dcf'); return Response.json({ data: { id: `00000000-0000-4000-8000-00000000000${files.length}` } }); }
  if (init.method === 'POST' || init.method === 'PATCH') { items.push(JSON.parse(init.body)); return Response.json({ data: {} }); }
  return Response.json({ data: [] });
};
const app = express();
app.use('/api/feed', feedRoutes(() => {}));
app.use((e, _q, r, _n) => r.status(e.status || 500).json({ error: e.message }));
const server = app.listen(0, '127.0.0.1');
await new Promise(r => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}/api/feed/publish`;
try {
  const post = async (parts) => { const f = new FormData(); for (const [name, data] of parts) f.append('files', new Blob([data]), name); return originalFetch(base, { method: 'POST', body: f }); };
  let r = await post([['in.zip', await fs.readFile(path.join(temp, 'in.zip'))]]);
  assert.equal(r.status, 200);
  const { results } = await r.json();
  const one = results.find(x => x.slug === 'one'), bad = results.find(x => x.slug === 'bad');
  assert.equal(one.status, 'published'); assert.equal(one.media, 2);
  assert.equal(bad.status, 'failed'); assert.match(bad.errors[0], /missing\.png/);
  assert.equal(items.length, 1);
  assert.deepEqual(files.sort(), ['a.png', 'clip.mp4']);
  assert.equal(items[0].doc.body[0].image, 'media:00000000-0000-4000-8000-000000000001');
  assert.equal(items[0].doc.body[2].image, 'https://example.com/ext.png');
  assert.equal(items[0].card.cover, 'media:00000000-0000-4000-8000-000000000001');
  // folder upload (relative paths as filenames), no zip
  r = await post([['one/article.json', JSON.stringify({ section: 'solutions', slug: 'two', title: 'Two.', summary: 'S.', date: '2026-11-09', draft: true })]]);
  assert.deepEqual((await r.json()).results.map(x => x.status), ['skipped (draft)']);
  r = await post([['notes.txt', 'x']]);
  assert.equal(r.status, 400);
  console.log('feed ok');
} finally { server.close(); globalThis.fetch = originalFetch; await fs.rm(temp, { recursive: true, force: true }); }
