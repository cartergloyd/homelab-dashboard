import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DiscordJoinSupport, isSupportInput, downloadScreenshot, splitDiscordReply } from './dist/services/discordSupport.js';
const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'discord-join-support-'));
const base={id:'100',channelId:'10',guildId:'20',author:{id:'30',username:'player'},content:"<@40> I can't get on",mentions:['40'],attachments:[]};
const active={userId:'30',channelId:'10',replyIds:['50'],updatedAt:Date.now()};
try{
 assert.equal(isSupportInput(base,'40','20'),true);
 assert.equal(isSupportInput({...base,content:'hello',mentions:[]},'40','20'),false);
 assert.equal(isSupportInput({...base,content:'@40 do my homework'},'40','20'),false);
 for(const change of [{guildId:'21'},{author:{id:'30',bot:true}},{webhook:true},{author:{id:'40',bot:true}}])assert.equal(isSupportInput({...base,...change},'40','20'),false);
 assert.equal(isSupportInput({...base,content:'Xbox',mentions:[],replyTo:'50'},'40','20',active),true);
 assert.equal(isSupportInput({...base,author:{id:'31'},content:'Xbox',mentions:[],replyTo:'50'},'40','20',active),false,'another person cannot take over this support case');
 assert.equal(isSupportInput({...base,channelId:'11',content:'Xbox',mentions:[],replyTo:'50'},'40','20',active),false);
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=','base64');
 const attachment={id:'1234',url:'https://cdn.discordapp.com/attachments/10/1234/error.png',name:'error.png',size:png.length,contentType:'image/png'};
 const image=await downloadScreenshot(attachment,tmp,async(url,options)=>{assert.equal(options.redirect,'error');return new Response(png)});
 assert.deepEqual(await fs.readFile(image),png);
 assert.equal((await fs.stat(image)).mode&0o777,0o600);
 for(const url of ['http://cdn.discordapp.com/attachments/x','https://127.0.0.1/attachments/x','https://evil.example/error.png','https://cdn.discordapp.com/nope'])await assert.rejects(downloadScreenshot({...attachment,url},tmp),/Attach the screenshot/);
 await assert.rejects(downloadScreenshot({...attachment,size:9*1024*1024},tmp),/smaller than/);
 await assert.rejects(downloadScreenshot(attachment,tmp,async()=>new Response('<svg>bad</svg>')),/PNG, JPEG/);
 const sent=[];const reports=[];let fail=false;
 const deps={botId:'40',guildId:'20',stateFile:path.join(tmp,'state.json'),imageFolder:tmp,
   settings:()=>({enabled:true,autoTrigger:true}),
   report:(key,text)=>{reports.push({key,text});return{id:key}},
   download:async()=>image,
   send:async(channel,replyTo,text,nonce)=>{if(fail){fail=false;throw Error('network lost')}const id=String(500+sent.length);sent.push({channel,replyTo,text,nonce,id});return id}};
 const support=new DiscordJoinSupport(deps);await support.load();
 await support.handle(base);
 assert.equal(reports.length,1);assert.match(sent[0].text,/device/);assert.match(sent[0].text,/screenshot/);
 await support.handle(base);assert.equal(reports.length,1,'redelivered Discord event must be deduplicated');
 await support.handle({...base,id:'101',mentions:[],content:'Xbox Friends tab',replyTo:sent[0].id,attachments:[attachment]});
 assert.equal(reports.length,2);assert.equal(reports[0].key,reports[1].key,'the same reporter resumes their case');
 const a=support.delivery(reports[0].key);assert.deepEqual(a.imagePaths,[image]);assert.equal(a.sessionId,null);
 assert.match(a.context,/not an administrator/);
 await a.complete({id:'run-a',sessionId:'session-a',status:'exited',exitCode:0},'Add GoldServer2951 as a friend and check Minecraft Friends.');
 assert.equal(support.delivery(reports[0].key).sessionId,'session-a');
 assert.equal(sent.at(-1).replyTo,'101');
 await support.handle({...base,id:'102',author:{id:'31',username:'another-player'}});
 const b=support.delivery(reports.at(-1).key);assert.equal(b.sessionId,null,'different players must not share CLI session context');
 assert.notEqual(reports.at(-1).key,reports[0].key);
 fail=true;await assert.rejects(b.complete({id:'run-b',sessionId:'session-b',status:'exited',exitCode:0},'What exact error does Minecraft show?'),/network lost/);
 const restored=new DiscordJoinSupport(deps);await restored.load();await restored.flushReplies();
 assert.match(sent.at(-1).text,/exact error/);assert.equal(restored.delivery(reports.at(-1).key).sessionId,'session-b');
 const count=sent.length;await restored.flushReplies();assert.equal(sent.length,count,'completed replies are not reposted');
 assert.ok(splitDiscordReply('x'.repeat(7000)).every(s=>s.length<=1800));
 console.log('Discord support: mentions, bot/guild filtering, reporter isolation, screenshot validation, follow-ups, CLI session isolation, durable reply retry and deduplication passed');
}finally{await fs.rm(tmp,{recursive:true,force:true})}
