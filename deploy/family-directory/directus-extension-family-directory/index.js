import whitelistHub from './hub-whitelist.js';
import familyHub from './family-hub.js';
import minecraftHub from './hub-minecraft.js';
import { issueSession } from './hub-session.js';
import streamingRequests from './streaming-requests.js';
import streamingArtwork from './streaming-artwork.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
export const pinHash = (name, pin) => createHash('sha256').update(`destin|${name}|${pin}`).digest('hex');
const emailOf = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const emailOk = email => email.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
const pinOk = pin => typeof pin === 'string' && /^\d{4}$/.test(pin);
export const publicUser = row => ({ id: row.id, name: row.name, first_name: row.first_name || row.name.split(' ')[0], last_name: row.last_name || null, group_id: row.group_id,
 fantasy_team: row.fantasy_team, registered: !!row.email,
 photo_url: row.photo ? `https://fam-api.xgold.tech/family/photos/${row.id}?v=${encodeURIComponent(row.photo)}` : null });

export default { id: 'family', handler(router, { database }) {
 familyHub(router, { database });
 whitelistHub(router, { database });
 minecraftHub(router, { database });
 streamingArtwork(router);
 streamingRequests(router, { database });
 const attempts = new Map();
 const wrap = fn => async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try { await fn(req,res); } catch { res.status(503).json({error:'The family directory is temporarily unavailable. Please try again.'}); }
 };
 function limited(req,res) {
  const key=req.ip || 'unknown', now=Date.now();
  for (const [k,v] of attempts) if (v.until < now) attempts.delete(k);
  const record=attempts.get(key) || {count:0,until:now+15*60*1000};
  attempts.set(key,record);
  if (++record.count > 30) {res.status(429).json({error:'Too many attempts. Please try again in 15 minutes.'});return true;}
  return false;
 }
 router.get('/users',wrap(async (_req,res) => {
  const rows=await database('family_users').whereNot('status','disabled').orderBy('name');
  res.json({users:rows.map(publicUser)});
 }));
 router.post('/lookup',wrap(async(req,res) => {
  if(limited(req,res))return;
  const email=emailOf(req.body?.email);
  if(!emailOk(email))return res.status(400).json({error:'Enter a valid email address.'});
  const row=await database('family_users').where({email}).whereNot('status','disabled').first();
  res.json({user:row ? {id:row.id,name:row.name} : null});
 }));
 router.post('/login',wrap(async(req,res) => {
  if(limited(req,res))return;
  const email=emailOf(req.body?.email),pin=req.body?.pin;
  if(!emailOk(email)||!pinOk(pin))return res.status(400).json({error:'Enter your email and four-digit PIN.'});
  const row=await database('family_users').where({email,status:'ready'}).first();
  const expected=row?.pin_hash || '0'.repeat(64),actual=pinHash(row?.pin_salt_name || '',pin);
  if(!row || !timingSafeEqual(Buffer.from(expected,'hex'),Buffer.from(actual,'hex')))return res.status(401).json({error:'The email or PIN does not match.'});
  attempts.delete(req.ip || 'unknown');
  res.json({user:{id:row.id,name:row.name,email:row.email},session:issueSession(row,process.env.SECRET)});
 }));
 router.post('/register',wrap(async(req,res) => {
  if(limited(req,res))return;
  const email=emailOf(req.body?.email),pin=req.body?.pin,id=req.body?.id;
  if(!emailOk(email)||!pinOk(pin)||typeof id!=='string'||!/^[0-9a-f-]{36}$/i.test(id))return res.status(400).json({error:'Choose your name, a valid email and a four-digit PIN.'});
  try {
   const row=await database.transaction(async trx => {
    const user=await trx('family_users').where({id,status:'invited'}).whereNull('email').forUpdate().first();
    if(!user)return null;
    const [saved]=await trx('family_users').where({id}).update({email,pin,status:'ready'}).returning(['id','name','email']);
    return saved;
   });
   if(!row)return res.status(409).json({error:'That name is already registered. Sign in or choose another name.'});
   attempts.delete(req.ip || 'unknown');
   const authenticated=await database('family_users').where({id:row.id}).first();
   res.status(201).json({user:row,session:issueSession(authenticated,process.env.SECRET)});
  } catch(e) {
   if(e.code==='23505')return res.status(409).json({error:'That email is already registered. Sign in instead.'});
   throw e;
  }
 }));
 router.get('/photos/:id',wrap(async(req,res) => {
  if(!/^[0-9a-f-]{36}$/i.test(req.params.id))return res.sendStatus(404);
  const row=await database('family_users as u').join('directus_files as f','u.photo','f.id')
    .where('u.id',req.params.id).whereNot('u.status','disabled').select('f.filename_disk','f.type','f.storage').first();
  if(!row||row.storage!=='local'||!/^image\/(jpeg|png|webp|gif|avif)$/.test(row.type)||path.basename(row.filename_disk)!==row.filename_disk)return res.sendStatus(404);
  res.set('Content-Type',row.type);res.set('X-Content-Type-Options','nosniff');
  res.sendFile(path.join('/directus/uploads',row.filename_disk),err=>{if(err&&!res.headersSent)res.sendStatus(404);});
 }));
} };
