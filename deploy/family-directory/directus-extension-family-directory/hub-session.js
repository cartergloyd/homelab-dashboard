import { createHmac, timingSafeEqual } from 'node:crypto';
const mac = (secret, payload) => createHmac('sha256',secret).update('family-session:'+payload).digest('base64url');
export function issueSession(user, secret, now=Date.now()) {
 if (!secret) throw Error('Session secret missing');
 const payload=Buffer.from(JSON.stringify({id:user.id,stamp:mac(secret,user.pin_hash),expires:now+7*86400000})).toString('base64url');
 return payload+'.'+mac(secret,payload);
}
export function readSession(token,secret,now=Date.now()) {
 if (!secret || typeof token!=='string' || token.length>1500) return null;
 const [payload,sig,extra]=token.split('.'), expected=mac(secret,payload||'');
 if(extra || !sig || Buffer.byteLength(sig)!==Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(sig),Buffer.from(expected)))return null;
 try { const data=JSON.parse(Buffer.from(payload,'base64url')); return /^[\da-f-]{36}$/i.test(data.id)&&data.expires>now ? data:null; } catch{return null;}
}
export async function sessionUser(database, token, secret) {
 const data=readSession(token,secret);if(!data)return null;
 const user=await database('family_users').where({id:data.id,status:'ready'}).first();
 return user && data.stamp===mac(secret,user.pin_hash) ? user:null;
}
