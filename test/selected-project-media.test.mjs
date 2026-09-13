import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { config } from '../src/config.js';
import { prepareProjectExports } from '../scripts/site-export-contract.mjs';
import { runProjectsFlow, cleanProjectAssets } from '../scripts/export-site-data.mjs';
import { trustedAttachmentUrl, verifiedImage, downloadSelectedImage, MAX_IMAGE_BYTES } from '../scripts/selected-project-media.mjs';
const G='1051088980176805919',F='1051088980176805920',T='345678901234567890',O='123456789012345678',TAG='1537600958245249154';
const M='456789012345678901',A='567890123456789012';
const png=await sharp({create:{width:4,height:3,channels:3,background:'#445566'}}).png().toBuffer();
const image=(v={})=>({id:'gallery_123',messageId:M,attachmentId:A,alt:'Bridge',caption:'A crossing',visibility:'public',...v});
const att=(v={})=>({id:A,url:`https://cdn.discordapp.com/attachments/${T}/${A}/screen.png?ex=0001&hm=SECRET`,content_type:'image/png',filename:'screen.png',size:png.length,width:4,height:3,...v});
const msg=(v={})=>({id:M,channel_id:T,author:{id:O},type:0,flags:0,attachments:[att()],...v});
const response=()=>new Response(png,{headers:{'Content-Type':'image/png','Content-Length':String(png.length)}});
function fixture(selection={version:1,projectId:'gallery-project',threadId:T,revision:1,mode:'selected',items:[image()],updatedAt:null}){
 let approved=true;let message=msg();let error=null;const calls=[];const reads=[];
 const prepared=prepareProjectExports([{id:'gallery-project',data:()=>({projectId:'gallery-project',ownerId:O,title:'Gallery Game',slug:'gallery-game',summary:'Test game',status:'playable',platforms:['web'],publishToSite:true,profileThreadId:T,mediaThreadIds:[T]})}]).published;
 const source={id:T,data:()=>({threadId:T,forumId:F,ownerId:O,projectId:'gallery-project',mode:'showcase'})};
 const db={collection:name=>{
  if(name==='threads')return{get:async()=>({docs:[source]})};
  assert.equal(name,'projectMedia');return{doc:id=>({get:async()=>{reads.push(id);return{id,exists:selection!==undefined,data:()=>selection};}})};
 }};
 const rest={get:async url=>{calls.push(url);
  if(url===`/channels/${T}`)return{id:T,guild_id:G,parent_id:F,owner_id:O,type:11,name:'Game',applied_tags:approved?[TAG]:[]};
  if(url===`/channels/${F}`)return{id:F,guild_id:G,type:15,available_tags:[{id:TAG,name:'Publish to site',moderated:true}]};
  if(url===`/channels/${T}/messages/${T}`)return{author:{id:O},attachments:[{filename:'hero.png',url:'https://cdn.discordapp.com/legacy.png'}]};
  if(url===`/channels/${T}/messages/${M}`){if(error)throw error;return message;}
  throw Error('Unexpected REST path');
 }};
 const run=out=>runProjectsFlow(rest,db,prepared,{out,dryRun:false,publishTagId:TAG},{downloadAttachment:async()=>({ext:'webp',width:4,height:3}),selectedImageFetch:async(url,options)=>{assert.equal(url,att().url);assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');assert.equal(options.headers,undefined);return response();}});
 return{run,calls,reads,approve:v=>approved=v,message:v=>message=v,error:v=>error=v,selection};
}
test('only exact owner-authored attachments with bounded raster metadata and fresh trusted URLs qualify',()=>{
 assert.ok(verifiedImage(msg(),image(),T,O));
 for(const changed of [{id:T},{channel_id:M},{author:{id:A}},{author:{id:O,bot:true}},{webhook_id:A},{flags:64},{type:21},{message_snapshots:[{}]},{attachments:[att(),att()]}]) assert.equal(verifiedImage(msg(changed),image(),T,O),null);
 for(const changed of [{id:M},{ephemeral:true},{size:MAX_IMAGE_BYTES+1},{width:100000},{height:null},{content_type:'image/svg+xml'},{url:'https://evil.invalid/secret'}]) assert.equal(verifiedImage(msg({attachments:[att(changed)]}),image(),T,O),null);
 for(const url of ['https://evil.invalid/a',att().url.replace(T,M),att().url.replace(A,M),'http://cdn.discordapp.com/attachments/'+T+'/'+A+'/a.png',att().url.replace('cdn.discordapp.com','user@cdn.discordapp.com'),att().url.replace('/screen.png','/../../secret')])assert.equal(trustedAttachmentUrl(url,T,A),false);
});
test('real raster decoding produces only bounded WebP and does not preserve original executable bytes',async()=>{
 const result=await downloadSelectedImage(att(),{threadId:T,attachmentId:A,fetchImpl:async()=>response()});
 assert.deepEqual([result.width,result.height],[4,3]);assert.equal((await sharp(result.bytes).metadata()).format,'webp');
 for(const raw of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="3"></svg>'),Buffer.from('<script>alert(1)</script>')])await assert.rejects(downloadSelectedImage(att({size:raw.length}),{threadId:T,attachmentId:A,fetchImpl:async()=>new Response(raw,{headers:{'Content-Type':'image/png'}})}),/bounded raster/);
});
test('download limits are enforced on headers and streamed bytes, without exposing signed URLs',async()=>{
 await assert.rejects(downloadSelectedImage(att(),{threadId:T,attachmentId:A,fetchImpl:async()=>new Response(png,{headers:{'Content-Type':'image/png','Content-Length':String(MAX_IMAGE_BYTES+1)}})}),/bounded raster/);
 const body=new ReadableStream({start(c){c.enqueue(new Uint8Array(MAX_IMAGE_BYTES+1));c.close();}});
 await assert.rejects(downloadSelectedImage(att(),{threadId:T,attachmentId:A,fetchImpl:async()=>new Response(body,{headers:{'Content-Type':'image/png'}})}),/bounded raster/);
 await assert.rejects(downloadSelectedImage(att(),{threadId:T,attachmentId:A,fetchImpl:()=>{throw Error('SECRET '+att().url);}}),e=>!e.message.includes('SECRET')&&!e.message.includes('hm='));
});
test('real exporter wiring uses selected images in order, ignores drafts and cleans removed generated assets',async t=>{
 const before=config.guildId;config.guildId=G;t.after(()=>{config.guildId=before;});
 const out=await fs.mkdtemp(path.join(os.tmpdir(),'selected-media-'));t.after(()=>fs.rm(out,{recursive:true,force:true}));
 const f=fixture();f.selection.items.push(image({id:'gallery_456',attachmentId:'667890123456789012',visibility:'draft',caption:'PRIVATE DRAFT'}));
 const result=await f.run(out);assert.equal(result.projects.length,1);const gallery=result.projects[0].media;
 assert.equal(gallery.length,1);assert.equal(gallery[0].alt,'Bridge');assert.equal(gallery[0].caption,'A crossing');
 assert.match(gallery[0].src,/\/selected-[a-f0-9]{64}\.webp$/);assert.equal((await sharp(path.join(out,'public',gallery[0].src)).metadata()).format,'webp');
 for(const forbidden of [M,A,'SECRET','PRIVATE DRAFT','messageId','attachmentId','ownerId'])assert.equal(JSON.stringify(result.projects).includes(forbidden),false);
 assert.deepEqual(f.reads,['gallery-project']);
 f.selection.items=[];const empty=await f.run(out);assert.equal(empty.projects[0].media.length,0);
 await cleanProjectAssets(out,empty.generatedAssets);await assert.rejects(fs.access(path.join(out,'public',gallery[0].src)));
});
test('global moderator approval prevents gallery reads; reapproval restores choices without creating a second Project',async t=>{
 const before=config.guildId;config.guildId=G;t.after(()=>{config.guildId=before;});
 const out=await fs.mkdtemp(path.join(os.tmpdir(),'selected-gate-'));t.after(()=>fs.rm(out,{recursive:true,force:true}));
 const f=fixture();f.approve(false);let result=await f.run(out);assert.equal(result.projects.length,0);assert.deepEqual(f.reads,[]);assert.equal(f.calls.some(p=>p.includes('/messages/')),false);
 f.approve(true);result=await f.run(out);assert.equal(result.projects[0].id,'gallery-project');assert.equal(result.projects[0].media.length,1);
});
test('wrong authors and deleted messages never fall back to an unselected image; operational failures abort',async t=>{
 const before=config.guildId;config.guildId=G;t.after(()=>{config.guildId=before;});
 const out=await fs.mkdtemp(path.join(os.tmpdir(),'selected-reject-'));t.after(()=>fs.rm(out,{recursive:true,force:true}));
 const f=fixture();f.message(msg({author:{id:A}}));assert.equal((await f.run(out)).projects[0].media.length,0);
 f.error({status:404});assert.equal((await f.run(out)).projects[0].media.length,0);
 f.error({status:500,message:'SECRET'});await assert.rejects(f.run(out),/could not be checked/);
 f.error(null);f.selection.threadId=M;await assert.rejects(f.run(out),/malformed or belongs/);
});
test('automatic gallery stays backward compatible and does not read dormant selected messages',async t=>{
 const before=config.guildId;config.guildId=G;t.after(()=>{config.guildId=before;});
 const f=fixture();f.selection.mode='automatic';const result=await f.run('.');
 assert.match(result.projects[0].media[0].src,/media-01.webp$/);assert.equal(f.calls.includes(`/channels/${T}/messages/${M}`),false);
});
