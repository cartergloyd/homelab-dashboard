import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const digest = (secret, value) => createHmac('sha256', secret).update('family-streaming:' + value).digest('base64url');
export function signSelection(item, secret, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ ...item, expires: now + 3600000 })).toString('base64url');
  return payload + '.' + digest(secret, payload);
}
export function readSelection(token, secret, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 4000) throw Error('Invalid selection');
  const [payload, signature, extra] = token.split('.');
  const expected = digest(secret, payload || '');
  if (extra || !signature || signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw Error('Invalid selection');
  const item = JSON.parse(Buffer.from(payload, 'base64url'));
  if (!Number.isFinite(item.expires) || item.expires < now || !['movie','tv'].includes(item.type) || !/^\d{1,12}$/.test(item.id) || typeof item.title !== 'string' || !item.title || item.title.length > 300) throw Error('Invalid selection');
  return item;
}
export function normalizeResults(results, type) {
  const seen = new Set();
  return results.flatMap(row => {
    const id = row.ProviderIds?.Tmdb;
    if (!/^\d{1,12}$/.test(id || '') || seen.has(id) || !row.Name || row.Name.length > 300) return [];
    seen.add(id);
    const year = row.ProductionYear || Number(row.PremiereDate?.slice(0,4)) || null;
    const match = /^https:\/\/image\.tmdb\.org\/t\/p\/original\/(\w+\.jpg)$/.exec(row.ImageUrl || '');
    return [{ id, type, title:row.Name, year, poster:match ? 'https://image.tmdb.org/t/p/w154/' + match[1] : null }];
  });
}
export default function streamingRequests(router, { database }, options = {}) {
  const config = options.config || (() => readFile(new URL('../.family-streaming.json', import.meta.url), 'utf8').then(JSON.parse));
  const upstream = options.fetch || fetch;
  const cache = new Map(), pending = new Map(), limits = new Map();
  const limited = (req, res, category, maximum) => {
    const now=Date.now();
    for (const [key, value] of limits) if (value.until < now) limits.delete(key);
    const key=category + ':' + (req.ip || 'unknown');
    const value=limits.get(key) || {count:0,until:now+600000};
    limits.set(key,value);
    if (++value.count > maximum) { res.set('Retry-After', '600'); res.status(429).json({error:'Too many requests. Please try again in a few minutes.'}); return true; }
    return false;
  };
  const search = async (query, settings) => {
    const key=query.toLowerCase(), existing=cache.get(key);
    if (existing && existing.until > Date.now()) return existing.items;
    if (pending.has(key)) return pending.get(key);
    if (pending.size >= 6) throw Error('Search busy');
    const work=(async () => {
      const results=await Promise.all(['Movie','Series'].map(async kind => {
        const response=await upstream(settings.url + '/Items/RemoteSearch/' + kind, {
          method:'POST', headers:{'Content-Type':'application/json','X-Emby-Token':settings.api_key},
          body:JSON.stringify({SearchInfo:{Name:query},SearchProviderName:'TheMovieDb'}), signal:AbortSignal.timeout(12000),
        });
        if (!response.ok) throw Error('Search unavailable');
        return normalizeResults(await response.json(), kind === 'Movie' ? 'movie' : 'tv').slice(0,8);
      }));
      const score = item => item.title.toLowerCase() === key ? 0 : item.title.toLowerCase().startsWith(key) ? 1 : 2;
      const items=[];
      for (let i=0;i<8;i++) for (const group of results) if (group[i]) items.push(group[i]);
      items.sort((a,b) => score(a)-score(b));
      if (cache.size >= 100) cache.delete(cache.keys().next().value);
      cache.set(key,{until:Date.now()+600000,items:items.slice(0,12)});
      return items.slice(0,12);
    })();
    pending.set(key,work);
    try { return await work; } finally { pending.delete(key); }
  };
  router.get('/streaming-search', async(req,res) => {
    res.set('Cache-Control','no-store');
    if (limited(req,res,'search',90)) return;
    const q=typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (q.length < 2 || q.length > 100) return res.status(400).json({error:'Enter between 2 and 100 characters.'});
    try {
      const settings=await config();
      const items=await search(q, settings);
      res.json({results:items.map(item => ({...item,selection:signSelection(item,settings.api_key)}))});
    } catch { res.status(503).json({error:'Title search is temporarily unavailable. Please try again.'}); }
  });
  router.post('/streaming-requests', async(req,res) => {
    res.set('Cache-Control','no-store');
    if (req.get('Origin') !== 'https://fam.xgold.tech') return res.status(403).json({error:'Please submit your request from the family website.'});
    if (limited(req,res,'submit',20)) return;
    const client=req.body?.client_id;
    if (typeof client !== 'string' || !/^[0-9a-f-]{36}$/i.test(client)) return res.status(400).json({error:'Please reload the page and try again.'});
    try {
      const settings=await config();
      let item;
      try { item=readSelection(req.body?.selection,settings.api_key); }
      catch { return res.status(400).json({error:'Please search for the title again before requesting it.'}); }
      let name='Guest';
      if (typeof req.body.requested_by === 'string' && req.body.requested_by.length <= 80) {
        const user=await database('family_users').where({name:req.body.requested_by}).whereNot('status','disabled').first('name');
        if (user) name=user.name;
      }
      const key=digest(settings.api_key, 'requester:' + client.toLowerCase() + ':' + name);
      const rows=await database('family_streaming_requests').insert({media_type:item.type,tmdb_id:item.id,title:item.title,year:item.year,poster_url:item.poster,requested_by:name,requester_key:key})
        .onConflict(['media_type','tmdb_id','requester_key']).ignore().returning('id');
      res.status(rows.length ? 201 : 200).json({requested:true});
    } catch { res.status(503).json({error:'Your request could not be saved. Please try again.'}); }
  });
}
