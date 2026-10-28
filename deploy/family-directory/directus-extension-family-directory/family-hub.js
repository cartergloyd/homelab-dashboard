import { sessionUser } from './hub-session.js';
const ORIGIN='https://fam.xgold.tech';
const active=['pending','confirmed','blocked'];
export const roles = u => ({id:u.id,name:u.name,condo_manager:!!u.condo_manager,maintenance_manager:!!u.maintenance_manager,instant_booking:!!u.instant_booking});
export function validDates(start,end){try{return /^\d{4}-\d{2}-\d{2}$/.test(start||'')&&/^\d{4}-\d{2}-\d{2}$/.test(end||'')&&new Date(start).toISOString().slice(0,10)===start&&new Date(end).toISOString().slice(0,10)===end&&end>start&&(Date.parse(end)-Date.parse(start))/86400000<=365;}catch{return false;}}
const text=(value,max)=>typeof value==='string'&&value.trim().length<=max?value.trim():null;
const dateString=d=>typeof d==='string'?d.slice(0,10):d.toISOString().slice(0,10);
function failure(code,message){const e=Error(message);e.status=code;throw e;}
export default function familyHub(router,{database},options={}) {
 const secret=options.secret||process.env.SECRET;
 const run=fn=>async(req,res)=>{
  res.set('Cache-Control','no-store');
  try {
   if(req.method!=='GET'&&req.get('Origin')!==ORIGIN)failure(403,'Please use the family website.');
   const u=await sessionUser(database,req.get('X-Family-Session')||'',secret);
   if(!u)failure(401,'Sign in with your email and PIN to continue.');
   await fn(req,res,u);
  }catch(e){res.status(e.code==='23P01'?409:e.status||503).json({error:e.code==='23P01'?'Those dates are already held. Choose another stay.':e.status?e.message:'Could not save or load this information. Please try again.'});}
 };
 const manager=u=>{if(!u.condo_manager)failure(403,'Carter or Chester can manage the property.');};
 const taskManager=(u,kind)=>kind==='build'||u.maintenance_manager||u.condo_manager;
 async function validateStay(trx,body,blocked=false){
  const p=await trx('family_properties').where({id:'6108'}).forUpdate().first();
  if(!validDates(body.start_date,body.end_date))failure(400,'Choose valid check-in and check-out dates, up to 365 nights apart.');
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:p.timezone}).format(new Date());
  const earliest=new Date(today+'T00:00:00Z');earliest.setUTCDate(earliest.getUTCDate()+(blocked?0:p.advance_days));
  const nights=(Date.parse(body.end_date)-Date.parse(body.start_date))/86400000;
  if(body.start_date<earliest.toISOString().slice(0,10))failure(400,'Choose dates after the required advance notice.');
  if(!Number.isInteger(body.guests)||body.guests<1||body.guests>100||(!blocked&&p.max_guests&&body.guests>p.max_guests))failure(400,'Check the guest limit for this property.');
  if(!blocked&&p.max_nights&&nights>p.max_nights)failure(400,'This stay exceeds the maximum nights.');
  if(text(body.note??'',2000)===null)failure(400,'Keep notes under 2,000 characters.');
 }
 router.get('/hub/me',run(async(_req,res,u)=>res.json({user:roles(u)})));
 router.get('/hub/condo',run(async(_req,res,u)=>{
  const [property,reservations,tasks]=await Promise.all([
   database('family_properties').where({id:'6108'}).first(),
   database('family_reservations as r').join('family_users as u','r.user_id','u.id').select('r.*','u.name').orderBy('r.start_date'),
   database('family_tasks as t').join('family_users as u','t.user_id','u.id').select('t.*','u.name').where('t.kind','maintenance').orderBy('t.date_created','desc')]);
  res.json({user:roles(u),property,reservations:reservations.map(r=>({...r,start_date:dateString(r.start_date),end_date:dateString(r.end_date)})),tasks});
 }));
 router.post('/hub/reservations',run(async(req,res,u)=>{
  const b=req.body||{}, blocked=b.status==='blocked';if(blocked)manager(u);
  const row=await database.transaction(async trx=>{
   await validateStay(trx,b,blocked);
   const [r]=await trx('family_reservations').insert({property_id:'6108',user_id:u.id,start_date:b.start_date,end_date:b.end_date,guests:b.guests,note:text(b.note??'',2000),status:blocked?'blocked':u.instant_booking||u.condo_manager?'confirmed':'pending'}).returning('*');return r;
  });res.status(201).json({reservation:row});
 }));
 router.patch('/hub/reservations/:id',run(async(req,res,u)=>{
  const b=req.body||{};
  const result=await database.transaction(async trx=>{
   // All writes lock the property first so date edits and creates share one lock order.
   await trx('family_properties').where({id:'6108'}).forUpdate().first();
   const r=await trx('family_reservations').where({id:req.params.id}).forUpdate().first();if(!r)failure(404,'Reservation not found.');
   if(r.revision!==b.revision)failure(409,'This reservation changed. Refresh and try again.');
   if(!u.condo_manager&&(r.user_id!==u.id||b.status!=='cancelled'))failure(403,'You can cancel your own reservations.');
   if(!active.includes(r.status))failure(409,'This reservation is already closed.');
   if(!['confirmed','cancelled','declined'].includes(b.status))failure(400,'Choose a valid reservation status.');
   if(b.status==='confirmed'&&r.status!=='pending')failure(400,'Only pending requests can be approved.');
   const [saved]=await trx('family_reservations').where({id:r.id}).update({status:b.status,revision:r.revision+1}).returning('*');return saved;
  });res.json({reservation:result});
 }));
 router.patch('/hub/property',run(async(req,res,u)=>{
  manager(u);const b=req.body||{};
  const title=text(b.title,100),description=text(b.description,4000),house_rules=text(b.house_rules,8000);
  if(!title||description===null||house_rules===null||!/^([01]\d|2[0-3]):[0-5]\d$/.test(b.check_in||'')||!/^([01]\d|2[0-3]):[0-5]\d$/.test(b.check_out||''))failure(400,'Check the property details and times.');
  for(const [k,max]of [['max_guests',100],['max_nights',365]])if(b[k]!==null&&(!Number.isInteger(b[k])||b[k]<1||b[k]>max))failure(400,'Enter valid guest and stay limits, or leave them blank.');
  if(!Number.isInteger(b.advance_days)||b.advance_days<0||b.advance_days>365)failure(400,'Advance notice must be 0–365 days.');
  try{new Intl.DateTimeFormat('en',{timeZone:b.timezone}).format();}catch{failure(400,'Enter a valid property timezone.');}
  const rows=await database('family_properties').where({id:'6108',revision:b.revision}).update({title,description,house_rules,check_in:b.check_in,check_out:b.check_out,max_guests:b.max_guests,max_nights:b.max_nights,advance_days:b.advance_days,timezone:b.timezone,revision:b.revision+1}).returning('*');
  if(!rows.length)failure(409,'Property details changed. Refresh and try again.');res.json({property:rows[0]});
 }));
 router.get('/hub/booking-access',run(async(_req,res,u)=>{manager(u);res.json({users:await database('family_users').whereNot('status','disabled').select('id','name','instant_booking','condo_manager').orderBy('name')});}));
 router.patch('/hub/booking-access/:id',run(async(req,res,u)=>{
  manager(u);if(typeof req.body?.instant_booking!=='boolean')failure(400,'Choose instant booking access.');
  const rows=await database('family_users').where({id:req.params.id,condo_manager:false}).update({instant_booking:req.body.instant_booking}).returning('id');
  if(!rows.length)failure(404,'Family member not found, or already a property manager.');res.json({saved:true});
 }));
 router.get('/hub/builds',run(async(_req,res,u)=>res.json({user:roles(u),tasks:await database('family_tasks as t').join('family_users as u','t.user_id','u.id').select('t.*','u.name').where('t.kind','build').orderBy('t.date_created','desc')})));
 function taskValues(b){
  const title=text(b.title,160),description=text(b.description??'',4000);if(!title||description===null)failure(400,'Add a title and keep details under 4,000 characters.');
  if(!['todo','doing','done'].includes(b.status))failure(400,'Choose a board column.');
  const coords=['x','y','z'].map(k=>b[k]??null);
  if(coords.some(v=>v!==null)&&!coords.every((v,i)=>Number.isInteger(v)&&v>=(i===1?-64:-30000000)&&v<=(i===1?320:30000000)))failure(400,'Enter all three valid coordinates, or leave all blank.');
  if(!['world','world_nether','world_the_end'].includes(b.world||'world'))failure(400,'Choose a world.');
  return {title,description,status:b.status,world:b.world||'world',x:coords[0],y:coords[1],z:coords[2]};
 }
 router.post('/hub/tasks',run(async(req,res,u)=>{
  const b=req.body||{};if(!['maintenance','build'].includes(b.kind))failure(400,'Choose a task type.');
  const v=taskValues(b);const jaime=b.kind==='maintenance'?await database('family_users').where({maintenance_manager:true}).first('id'):null;
  const [task]=await database('family_tasks').insert({...v,kind:b.kind,user_id:u.id,assigned_to:jaime?.id||null}).returning('*');res.status(201).json({task});
 }));
 router.patch('/hub/tasks/:id',run(async(req,res,u)=>{
  const b=req.body||{},task=await database('family_tasks').where({id:req.params.id}).first();if(!task)failure(404,'Task not found.');
  if(!taskManager(u,task.kind))failure(403,'Jaime manages maintenance tasks.');
  const v=taskValues(b);
  const rows=await database('family_tasks').where({id:task.id,revision:b.revision}).update({...v,revision:task.revision+1}).returning('*');
  if(!rows.length)failure(409,'This card changed. Refresh and try again.');res.json({task:rows[0]});
 }));
 router.delete('/hub/tasks/:id',run(async(req,res,u)=>{
  const t=await database('family_tasks').where({id:req.params.id}).first();if(!t)failure(404,'Task not found.');if(!taskManager(u,t.kind))failure(403,'Jaime manages maintenance tasks.');
  if(!Number.isInteger(req.body?.revision))failure(400,'Refresh before deleting this card.');
  const n=await database('family_tasks').where({id:t.id,revision:req.body.revision}).delete();if(!n)failure(409,'This card changed. Refresh and try again.');res.json({deleted:true});
 }));
}
