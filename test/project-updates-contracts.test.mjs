import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUpdatesInput, updatesState, updatesMessageId, updatesProjectId, UPDATES_LIMIT } from '../src/lib/project-updates-contracts.mjs';
const G='1051088980176805919',T='345678901234567890',M='456789012345678901';
const item=(v={})=>({id:'update_123',messageId:M,title:'New level',visibility:'draft',...v});
const input=(v={})=>({revision:0,items:[item()],...v});
test('selected-update inputs allow only bounded explicit message references and draft/public choices',()=>{
 assert.equal(parseUpdatesInput(input()).items[0].visibility,'draft');
 for(const extra of [{ownerId:G},{threadId:T},{content:'private text'},{date:'2026-01-01'},{url:'https://evil.invalid'},{publishToSite:true}])assert.equal(parseUpdatesInput({...input(),...extra}),null);
 assert.equal(parseUpdatesInput(input({items:[item({content:'private'})]})),null);
 assert.deepEqual(parseUpdatesInput({revision:7},'clear'),{revision:7});
 assert.equal(parseUpdatesInput({...input()},'clear'),null);
});
test('update limits, duplicate messages, unknown state and bad titles fail closed',()=>{
 for(const value of [null,[],{},input({revision:-1}),input({revision:Number.MAX_SAFE_INTEGER}),input({items:[item(),item({id:'update_456'})]}),input({items:[item(),item({messageId:G})]}),input({items:[item({title:' '})]}),input({items:[item({title:'x'.repeat(161)})]}),input({items:[item({title:'bad\nline'})]}),input({items:[item({visibility:true})]}),input({items:[item({messageId:M+'?secret'})]}),input({items:Array(UPDATES_LIMIT+1).fill(item())})])assert.equal(parseUpdatesInput(value),null);
 assert.ok(parseUpdatesInput(input({items:[item({title:'x'.repeat(160)})]})));assert.ok(parseUpdatesInput(input({items:[]})));
 assert.equal(updatesProjectId('../other'),false);assert.equal(updatesProjectId('x'.repeat(1501)),false);
});
test('missing update preferences are empty and cleared revisions cannot revive old selections',()=>{
 const fresh=updatesState(undefined,'game-123',T);assert.equal(fresh.revision,0);assert.deepEqual(fresh.items,[]);
 const saved={...fresh,revision:2,updatedAt:null};assert.equal(updatesState(saved,'game-123',T).revision,2);
 for(const bad of [null,{...saved,projectId:'other'},{...saved,threadId:M},{...saved,items:null},{...saved,revision:0},{...saved,content:'private'}])assert.equal(updatesState(bad,'game-123',T),null);
});
test('message-link helper accepts only the exact guild/thread/message without query, fragments or redirects',()=>{
 const link=`https://discord.com/channels/${G}/${T}/${M}`;assert.equal(updatesMessageId(link,G,T),M);
 for(const bad of [link+'/',link+'?x=1',link+'#fragment',link.replace(T,M),link.replace('discord.com','evil.invalid'),link.replace('https:','http:'),link.replace('discord.com','user@discord.com'),'https://discord.com/channels/@me/'+M])assert.equal(updatesMessageId(bad,G,T),null);
});
