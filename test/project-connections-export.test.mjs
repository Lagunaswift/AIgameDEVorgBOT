import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readProjectConnections, readConnectionCatalog } from '../scripts/project-connections-export.mjs';
const project={id:'game-123',slug:'sample-game'},catalog=[{kind:'tool',id:'godot-mcp'},{kind:'guide',id:'giving-feedback'}];
const record={version:1,projectId:project.id,revision:3,genres:['puzzle'],aiUse:['code'],labelsVisibility:'draft',links:[{kind:'tool',targetId:'godot-mcp',visibility:'public'},{kind:'guide',targetId:'private-guide',visibility:'draft'},{kind:'guide',targetId:'removed-guide',visibility:'public'}],updatedAt:null};
function database(value){const reads=[];return{reads,db:{collection:(name)=>({doc:(id)=>({get:async()=>{reads.push([name,id]);return{id,exists:value!==undefined,data:()=>value};}})})}};}
const run=(d,projects=[project])=>readProjectConnections({db:d.db,projects,catalog,generatedAt:'2026-09-14T00:00:00.000Z'});
test('connection exporter reads only approved Projects and omits all draft labels and unavailable resources',async()=>{
 const d=database(record),output=await run(d);assert.deepEqual(d.reads,[['projectConnections',project.id]]);
 assert.deepEqual(output.projects[0].tools,['godot-mcp']);assert.deepEqual(output.projects[0].guides,[]);
 assert.doesNotMatch(JSON.stringify(output),/private-guide|removed-guide|draft|revision|ownerId|puzzle|code/);
 const hidden=database(record);assert.deepEqual((await run(hidden,[])).projects,[]);assert.deepEqual(hidden.reads,[]);
});
test('unselected or cleared records produce no public connection entry; malformed state and failures abort',async()=>{
 assert.deepEqual((await run(database(undefined))).projects,[]);
 assert.deepEqual((await run(database({...record,links:[]}))).projects,[]);
 for(const value of [null,{...record,projectId:'wrong'},{...record,ownerId:'private'}])await assert.rejects(run(database(value)),/Invalid/);
 await assert.rejects(run({db:{collection:()=>{throw Error('offline');}}}),/offline/);
});
test('explicit resource IDs come from the current Site files, not names or private contents',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'connection-catalog-'));
 try{
  await mkdir(join(dir,'src/data'),{recursive:true});await mkdir(join(dir,'src/content/wiki'),{recursive:true});
  await writeFile(join(dir,'src/data/tools.json'),JSON.stringify({tools:[{id:'godot-mcp',name:'Renamed display name'}]}));
  await writeFile(join(dir,'src/content/wiki/giving-feedback.md'),'not parsed as a relationship');
  assert.deepEqual(await readConnectionCatalog(dir),catalog);
  await writeFile(join(dir,'src/data/tools.json'),JSON.stringify({tools:[{name:'Do not derive ID'}]}));await assert.rejects(readConnectionCatalog(dir),/Invalid resource/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('connections reads finish before public writes and promotion follows staged validation/build',()=>{
 const source=readFileSync(new URL('../scripts/export-site-data.mjs',import.meta.url),'utf8');
 assert.ok(source.indexOf('const connections = await readProjectConnections')<source.indexOf('const filesWritten = []'));
 assert.match(source,/writeJson\(args.out, 'project-connections.json', connections\)/);
 const flow=readFileSync(new URL('../.github/workflows/export-site.yml',import.meta.url),'utf8');
 assert.ok(flow.indexOf('Build staged site')<flow.indexOf('cp site-staging/src/data/project-connections.json'));
 assert.match(flow,/git add [^\n]*src\/data\/project-connections\.json/);
});
