import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCombinedNudge, combinedNudgeDelayMinutes, sendCombinedNudge } from '../src/services/postNudge.js';
import { threadHasExcludedTag } from '../src/lib/tags.js';
import { buildScreenshotNudgeMessage } from '../src/services/screenshotNudge.js';
const OWNER='123456789012345678';
const cfg={screenshotNudgeEnabled:true,guidelinesNudgeEnabled:true,screenshotNudgeDelayMinutes:10,guidelinesNudgeDelayMinutes:15};
function fixture(){
 const claimed=new Set(),sent=[];let fresh;
 const ref=(name)=>({create:async()=>{if(claimed.has(name))throw Error('exists');claimed.add(name);},delete:async()=>claimed.delete(name)});
 const thread={id:'234567890123456789',ownerId:OWNER,archived:false,fetch:async()=>fresh??thread,send:async(msg)=>sent.push(msg.content)};
 const services={isGuidelinesExempt:async()=>false,threadFollowsGuidelines:async()=>false,threadHasScreenshot:async()=>false,guidelinesDedupRef:()=>ref('guidelines'),screenshotDedupRef:()=>ref('photo')};
 return{claimed,sent,thread,services,setFresh:v=>{fresh=v;},run:()=>sendCombinedNudge(thread,OWNER,{cfg,services})};
}
test('combined copy keeps current owner-reply image advice and never threatens deletion',()=>{
 const both=buildCombinedNudge(OWNER,{needsGuidelines:true,needsPhoto:true});
 assert.equal(both.split(`<@${OWNER}>`).length,2);assert.match(both,/specific feedback questions/);assert.match(both,/new reply/);assert.doesNotMatch(both,/deleted|original post|first message/i);
 assert.doesNotMatch(buildCombinedNudge(OWNER,{needsPhoto:true}),/12 hours|feedback questions/);
 assert.equal(buildCombinedNudge(OWNER,{}),null);assert.match(buildScreenshotNudgeMessage(OWNER),/new reply/);
 assert.equal(combinedNudgeDelayMinutes(cfg),10);assert.equal(combinedNudgeDelayMinutes({...cfg,screenshotNudgeEnabled:false}),15);assert.equal(combinedNudgeDelayMinutes({}),null);
});
test('tag exclusions recognise exact IDs without a cached parent and case-insensitive names',()=>{
 assert.equal(threadHasExcludedTag({appliedTags:['tag'],parent:null},{ids:['tag']}),true);
 assert.equal(threadHasExcludedTag({appliedTags:['tag'],parent:{availableTags:[{id:'tag',name:'Just-Sharing'}]}},{names:['just-sharing']}),true);
 assert.equal(threadHasExcludedTag({appliedTags:['other']},{ids:['tag']}),false);
});
test('one combined send claims both halves and subsequent concurrent sends do not repeat them',async()=>{
 const f=fixture();await Promise.all([f.run(),f.run()]);assert.equal(f.sent.length,1);assert.equal(f.claimed.size,2);
 await f.run();assert.equal(f.sent.length,1);
});
test('already nudged or excluded half is not repeated, modern image detection remains authoritative',async()=>{
 const f=fixture();f.claimed.add('photo');await f.run();assert.equal(f.sent.length,1);assert.doesNotMatch(f.sent[0],/screenshot/);
 const g=fixture();g.services.isGuidelinesExempt=async()=>true;await g.run();assert.equal(g.claimed.has('guidelines'),false);assert.match(g.sent[0],/screenshot/);
 const h=fixture();h.services.threadHasScreenshot=async()=>true;h.services.threadFollowsGuidelines=async()=>true;await h.run();assert.equal(h.sent.length,0);
});
test('late archive/owner change and failed source checks cannot produce a public prompt',async()=>{
 for(const value of [{archived:true,ownerId:OWNER},{archived:false,ownerId:'other'}]){const f=fixture();f.setFresh(value);await f.run();assert.equal(f.sent.length,0);assert.equal(f.claimed.size,0);}
 const f=fixture();f.services.threadHasScreenshot=async()=>{throw Error('source not readable');};await assert.rejects(f.run());assert.equal(f.sent.length,0);assert.equal(f.claimed.size,0);
});
test('failed send releases only newly claimed halves for retry',async()=>{
 const f=fixture();f.claimed.add('photo');f.thread.send=async()=>{throw Error('send failed');};await assert.rejects(f.run());assert.deepEqual([...f.claimed],['photo']);
});
