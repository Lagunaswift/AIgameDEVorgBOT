import test from 'node:test';
import assert from 'node:assert/strict';
import { projectDestination } from '../src/lib/projectDestination.js';
import { commands } from '../src/commands/projectmetadata.js';
import { execute } from '../src/events/interactionCreate.js';
import { loadCommands } from '../src/loadCommands.js';

test('Project destinations use structured link policy before primary legacy-compatible Project URL', () => {
  const links=[{type:'website',url:'https://example.com',priority:1},{type:'play',url:'https://example.com/play',priority:3},{type:'play',url:'https://example.com/first',priority:2}];
  const p={status:'playable',links,projectUrl:'https://example.com/old'};
  assert.equal(projectDestination(p),'https://example.com/first');
  assert.equal(projectDestination({...p,status:'development'}),'https://example.com');
  assert.equal(projectDestination({...p,links:[]}),p.projectUrl);
  assert.equal(projectDestination({...p,links:[],projectUrl:null}),null);
  assert.equal(projectDestination({...p,links:[{type:'devlog',url:'https://example.com/log',priority:0}],projectUrl:null}),null);
});

test('retired URL command is absent from the metadata group and actual registration registry', async () => {
  assert.deepEqual(commands.map((command)=>command.data.name),['assignjam']);
  const registry=await loadCommands();
  assert.equal(registry.has('projecturl'),false);
  assert.equal(registry.has('assignjam'),true);
  assert.equal(registry.has('mygame'),true);
});

test('a cached retired command gets private guidance and never reaches a stale write handler', async () => {
  const replies=[];
  await execute({isChatInputCommand:()=>true,commandName:'projecturl',client:{commands:{get:()=>assert.fail('retired handler must not be looked up')}},reply:async (reply)=>replies.push(reply)});
  assert.equal(replies.length,1);
  assert.equal(replies[0].ephemeral,true);
  assert.match(replies[0].content,/mygame manage/);
});
