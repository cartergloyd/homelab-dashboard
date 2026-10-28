const BASE='http://192.168.1.148:8123';
export function chooseFocus(players,hotspot,spawn={world:'world',x:0,y:64,z:0}){
 const online=players.filter(p=>!p.ishidden&&typeof p.account==='string'&&Number.isFinite(p.x)&&Number.isFinite(p.z)).sort((a,b)=>a.account.localeCompare(b.account));
 return online.length?{mode:'player',...online[0]}:hotspot?{mode:hotspot.source==='players'?'activity':'chunks',...hotspot,y:64}:{mode:'spawn',...spawn};
}
export default function minecraft(router,{database},options={}){
 const upstream=options.fetch||fetch;
 let cached,until=0,pending;
 const state=async()=>{
  if(cached&&Date.now()<until)return cached;
  if(pending)return pending;
  pending=(async()=>{
   const [r,c]=await Promise.all([upstream(BASE+'/up/world/world/0',{signal:AbortSignal.timeout(6000)}),upstream(BASE+'/up/configuration',{signal:AbortSignal.timeout(6000)})]);
   if(!r.ok||!c.ok)throw Error('Map unavailable');
   const [data,config]=await Promise.all([r.json(),c.json()]);
   const recent=await database('family_mc_activity').where('day','>=',new Date(Date.now()-21*86400000).toISOString().slice(0,10)).select('world','x','z','source').sum({samples:'samples'}).groupBy('world','x','z','source').orderByRaw("CASE WHEN source = 'players' THEN 0 ELSE 1 END").orderBy('samples','desc').orderBy('world').orderBy('x').orderBy('z').first();
   const world=config.worlds?.find(w=>w.name==='world')||config.worlds?.[0];
   cached={online:true,players:(data.players||[]).filter(p=>!p.ishidden).map(p=>({account:p.account,name:p.name,world:p.world,x:p.x,y:p.y,z:p.z})),focus:chooseFocus(data.players||[],recent,world?{world:world.name,...world.center}:undefined),updated_at:new Date().toISOString()};until=Date.now()+10000;return cached;
  })();try{return await pending;}finally{pending=null;}
 };
 router.get('/mc-status',async(_req,res)=>{res.set('Cache-Control','no-store');try{res.json(await state());}catch{res.status(503).json({online:false,error:'The live map is temporarily unavailable. Join instructions and builds are still here.'});}});
 router.use('/mc-map',async(req,res)=>{
  if(req.method!=='GET')return res.sendStatus(405);
  const raw=req.url.split('?')[0];
  // Fixed upstream, read-only resources; no Dynmap chat, login, or admin actions.
  if(raw.includes('..')||raw.includes('%')||!/^\/(?:$|index\.html$|(?:js|css|images|tiles)\/[\w./@+-]+$|standalone\/(?:config\.js|dynmap_[\w.-]+\.json)$|version\.js$|up\/configuration$|up\/world\/[\w-]+\/\d+$)/.test(raw))return res.sendStatus(404);
  try{
   const r=await upstream(BASE+req.url,{signal:AbortSignal.timeout(12000),redirect:'error'});
   res.status(r.status);res.set('Content-Type',r.headers.get('Content-Type')||'application/octet-stream');
   res.set('Cache-Control',/\.(png|jpg|webp|css|js)(\?|$)/.test(req.url)?'public, max-age=60':'no-store');
   res.removeHeader('X-Frame-Options');res.set('Content-Security-Policy',"frame-ancestors https://fam.xgold.tech http://127.0.0.1:* http://localhost:*");
   res.send(Buffer.from(await r.arrayBuffer()));
  }catch{res.status(503).send('Live map temporarily unavailable.');}
 });
}
