import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { prepareProjectExports } from '../scripts/site-export-contract.mjs';
import { runProjectsFlow } from '../scripts/export-site-data.mjs';
import { updateExcerpt, verifiedUpdate } from '../scripts/selected-project-updates.mjs';
const G='1051088980176805919',F='1051088980176805920',T='345678901234567890',O='123456789012345678',TAG='1537600958245249154',M='456789012345678901',OTHER='656789012345678901';
const item=(v={})=>({id:'update_123',messageId:M,title:'New level',visibility:'public',...v});
const msg=(v={})=>({id:M,channel_id:T,guild_id:G,author:{id:O},type:0,flags:0,timestamp:'2026-09-13T16:00:00.000000+00:00',content:'The bridge level is ready for testing.',...v});
function fixture(){
 const project={projectId:'updates-project',ownerId:O,title:'Updates game',slug:'updates-game',summary:'A test game',status:'playable',platforms:['web'],publishToSite:true,profileThreadId:T,activities:[]};
 const source={threadId:T,forumId:F,ownerId:O,projectId:'updates-project',mode:'showcase'};
 const state={version:1,projectId:'updates-project',threadId:T,revision:1,items:[item()],updatedAt:null};
 const f={project,source,state,message:msg(),approved:true,error:null,reads:[],calls:[]};
 const db={collection:name=>{
  if(name==='threads')return{get:async()=>({docs:[{id:T,data:()=>source}]})};
  if(name==='projectMedia')return{doc:id=>({get:async()=>({id,exists:false})})};
  assert.equal(name,'projectUpdates');return{doc:id=>({get:async()=>{f.reads.push(id);return{id,exists:f.state!==undefined,data:()=>f.state};}})};
 }};
 const rest={get:async url=>{f.calls.push(url);
  if(url===`/channels/${T}`)return{id:T,guild_id:G,parent_id:F,owner_id:O,type:11,name:'Game',applied_tags:f.approved?[TAG]:[]};
  if(url===`/channels/${F}`)return{id:F,guild_id:G,type:15,available_tags:[{id:TAG,name:'Publish to site',moderated:true}]};
  if(url===`/channels/${T}/messages/${T}`)return{author:{id:O},attachments:[{filename:'hero.png',url:'https://cdn.discordapp.com/legacy.png'}]};
  if(url===`/channels/${T}/messages/${M}`){if(f.error)throw f.error;return f.message;}
  throw Error('Unexpected REST path');
 }};
 f.run=()=>runProjectsFlow(rest,db,prepareProjectExports([{id:'updates-project',data:()=>project}]).published,{out:'.',dryRun:false,publishTagId:TAG},{downloadAttachment:async()=>({ext:'webp',width:4,height:3})});
 return f;
}
test('update excerpts exclude quotes, spoilers, code, mentions and raw URLs before bounded plain-text export',()=>{
 const text='**Bridge is ready.**\n> A player secret\n```js\nAPI_KEY=SECRET\n```\n||hidden spoiler||\n<@123456789012345678> <@&123456789012345679> <#123456789012345670> @everyone @here\n[Notes](https://example.org/?secret=abc) https://cdn.discordapp.com/image?hm=SECRET';
 assert.equal(updateExcerpt(text),'Bridge is ready. Notes');
 assert.equal(updateExcerpt('Good\n>>> multiple\nquoted lines'),'Good');
 assert.equal(updateExcerpt('||unfinished spoiler'),null);assert.equal(updateExcerpt('```unfinished code'),null);
 assert.equal(updateExcerpt('> quoted only'),null);assert.equal(updateExcerpt(''),null);assert.equal(updateExcerpt('x'.repeat(10001)),null);
 assert.equal(updateExcerpt('x'.repeat(499)+'😀').length,499);assert.equal(updateExcerpt('x'.repeat(900)).length,500);
});
test('only exact owned ordinary messages and replies qualify; forwards, webhooks and ephemeral data are rejected',()=>{
 assert.equal(verifiedUpdate(msg(),item(),T,O,G).date,'2026-09-13T16:00:00.000Z');
 const reply=msg({type:19});Object.defineProperty(reply,'referenced_message',{get(){assert.fail('Never inspect another member reply');}});Object.defineProperty(reply,'attachments',{get(){assert.fail('Never copy attached data');}});Object.defineProperty(reply,'embeds',{get(){assert.fail('Never copy embed data');}});
 assert.ok(verifiedUpdate(reply,item(),T,O,G));
 for(const change of [{id:OTHER},{channel_id:OTHER},{guild_id:OTHER},{author:{id:OTHER}},{author:{id:O,bot:true}},{webhook_id:OTHER},{type:21},{flags:64},{flags:2},{flags:8},{flags:128},{flags:16384},{flags:-1},{flags:null},{message_snapshots:[{}]},{message_reference:{type:1}},{timestamp:'2026-02-30T00:00:00Z'},{timestamp:'bad'},{content:''}])assert.equal(verifiedUpdate(msg(change),item(),T,O,G),null);
});
test('real Project export appends only public selected own messages and preserves manual activities',async t=>{
 const before=config.guildId;config.guildId=G;t.after(()=>{config.guildId=before;});
 const f=fixture();f.state.items.push(item({id:'update_456',messageId:OTHER,title:'PRIVATE_TITLE',visibility:'draft'}));
 f.project.activities.push({type:'milestone',title:'Manual milestone',date:'2026-09-12T10:00:00Z',summary:'Manual note',url:'https://example.org/log'});
 const result=await f.run();const activities=result.projects[0].activities;
 assert.equal(activities.length,2);assert.equal(activities[0].title,'New level');assert.equal(activities[1].title,'Manual milestone');
 assert.deepEqual(Object.keys(activities[0]).sort(),['date','summary','title','type','url']);
 assert.equal(activities[0].url,`https://discord.com/channels/${G}/${T}/${M}`);assert.doesNotMatch(JSON.stringify(result.projects),/PRIVATE_TITLE|messageId|ownerId|revision/);
 assert.equal(f.calls.some(url=>url.endsWith(`/messages/${OTHER}`)),false);assert.deepEqual(f.reads,['updates-project']);
});
test('owner intent and moderator approval are both mandatory before any selected update preference/message reads',async t=>{
 const before=config.guildId;config.guildId=G;t.after(()=>{config.guildId=before;});
 const f=fixture();f.approved=false;assert.equal((await f.run()).projects.length,0);assert.deepEqual(f.reads,[]);assert.equal(f.calls.some(u=>u.includes('/messages/')),false);
 f.approved=true;f.project.publishToSite=false;assert.equal((await f.run()).projects.length,0);assert.deepEqual(f.reads,[]);
 f.project.publishToSite=true;assert.equal((await f.run()).projects[0].activities.length,1);
});
test('changed or removed source messages refresh or withdraw the excerpt with no fallback to other messages',async t=>{
 const before=config.guildId;config.guildId=G;t.after(()=>{config.guildId=before;});const f=fixture();
 assert.equal((await f.run()).projects[0].activities.length,1);
 f.message=msg({content:'New text on the same selected message'});assert.equal((await f.run()).projects[0].activities[0].summary,'New text on the same selected message');
 f.message=msg({author:{id:OTHER}});assert.deepEqual((await f.run()).projects[0].activities,[]);
 for(const error of [{status:404},{status:403},{code:10008}]){f.error=error;assert.deepEqual((await f.run()).projects[0].activities,[]);}
 f.error=null;f.message=msg();f.state.items=[];assert.deepEqual((await f.run()).projects[0].activities,[]);
 f.state=undefined;assert.deepEqual((await f.run()).projects[0].activities,[]);
});
test('source/record errors and operational Discord failures abort without leaking private response details',async t=>{
 const before=config.guildId;config.guildId=G;t.after(()=>{config.guildId=before;});const f=fixture();
 f.error={status:500,message:'SECRET'};await assert.rejects(f.run(),e=>e.message.includes('could not be checked')&&!e.message.includes('SECRET'));
 f.error=null;f.state.threadId=OTHER;await assert.rejects(f.run(),/malformed or belong/);
 f.state.threadId=T;f.state.items=[item(),item()];await assert.rejects(f.run(),/malformed/);
});
test('an exact manual URL wins over a selected duplicate; chronological timeline stays bounded',async t=>{
 const before=config.guildId;config.guildId=G;t.after(()=>{config.guildId=before;});const f=fixture();
 f.project.activities=[{type:'milestone',title:'Manual choice',date:'2026-09-10T10:00:00Z',summary:'Manual summary',url:`https://discord.com/channels/${G}/${T}/${M}`}];
 const a=(await f.run()).projects[0].activities;assert.equal(a.length,1);assert.equal(a[0].title,'Manual choice');
 f.project.activities=Array.from({length:50},(_,i)=>({type:'milestone',title:`Old milestone ${i}`,date:'2026-09-10T10:00:00Z',summary:null,url:`https://example.org/${i}`}));
 const bounded=(await f.run()).projects[0].activities;assert.equal(bounded.length,50);assert.equal(bounded[0].title,'New level');
});
