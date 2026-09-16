import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConnectionsInput, connectionsState, publicConnections, parseConnectionsPayload, resolveConnections, validConnectionProjectId } from '../src/lib/project-connections/contracts.mjs';
const project = { id: 'sample-game', slug: 'sample-game' };
const input = (extra = {}) => ({ revision: 0, genres: ['puzzle'], aiUse: ['code'], labelsVisibility: 'draft', links: [{ kind: 'tool', targetId: 'godot-mcp', visibility: 'draft' }], ...extra });
const saved = (extra = {}) => ({ version: 1, projectId: project.id, ...input({ revision: 2 }), updatedAt: null, ...extra });
const payload = (entry) => ({ version: 1, generatedAt: '2026-09-14T00:00:00.000Z', projects: [entry] });
test('connection contract permits only bounded explicit metadata and relationships', () => {
  assert.ok(parseConnectionsInput(input()));
  for (const fields of [{ ownerId: 'private' }, { projectId: 'other' }, { publishToSite: true }, { score: 100 }, { url: 'https://evil.invalid' }]) assert.equal(parseConnectionsInput(input(fields)), null);
  for (const bad of [null, [], input({ revision: -1 }), input({ genres: ['puzzle','puzzle'] }), input({ genres: [['puzzle']] }), input({ aiUse: [['code']] }), input({ genres: ['puzzle','rpg','action','racing'] }), input({ aiUse: ['none'] }), input({ links: Array(25).fill(input().links[0]) }), input({ links: [{ ...input().links[0], href: 'private' }] }), input({ links: [{ kind: 'project', targetId: 'other', visibility: 'public' }] }), input({ links: [{ kind: 'tool', targetId: '../private', visibility: 'public' }] }), input({ links: [input().links[0], input().links[0]] })]) assert.equal(parseConnectionsInput(bad),null);
  assert.deepEqual(parseConnectionsInput({ revision: 8 },'clear'),{ revision: 8 });
  assert.equal(parseConnectionsInput(input(),'clear'),null);
  for (const bad of ['../x','__private__',' x','x\\y','é'.repeat(751)]) assert.equal(validConnectionProjectId(bad),false);
});
test('missing connections default private; malformed records never silently reset', () => {
  assert.equal(connectionsState(undefined,project.id).labelsVisibility,'draft');
  assert.deepEqual(connectionsState(undefined,project.id).links,[]);
  for (const broken of [null,saved({ revision: 0 }),saved({ projectId: 'other' }),saved({ secret: 'private' }),saved({ updatedAt: null, links: null })]) assert.equal(connectionsState(broken,project.id),null);
});
test('public projection excludes drafts and only includes creator-declared public choices', () => {
  const state = saved({ links: [...input().links, { kind: 'guide', targetId: 'giving-feedback', visibility: 'public' }] });
  const output = publicConnections(state,project);
  assert.deepEqual(output, { projectId: project.id, projectSlug: project.slug, genres: [], aiUse: [], tools: [], guides: ['giving-feedback'] });
  assert.doesNotMatch(JSON.stringify(output), /godot-mcp|draft|revision|updatedAt|ownerId|puzzle|code/);
  assert.deepEqual(publicConnections(saved({ labelsVisibility: 'public' }),project).genres,['puzzle']);
});
test('mixed snapshots, unknown fields and unavailable targets cannot produce public relationships', () => {
  const entry = publicConnections(saved({ labelsVisibility: 'public' }),project);
  assert.ok(parseConnectionsPayload(payload(entry),[project]));
  for (const bad of [{ ...entry, ownerId: 'private' }, { ...entry, projectSlug: 'another' }, { ...entry, genres: ['fake'] }, { ...entry, tools: ['godot-mcp','godot-mcp'] }]) assert.equal(parseConnectionsPayload(payload(bad),[project]),null);
  assert.equal(parseConnectionsPayload(payload(entry),[]),null);
  assert.equal(parseConnectionsPayload({ ...payload(entry), generatedAt: null },[project]),null);
  assert.equal(parseConnectionsPayload({ ...payload(entry), projects: [entry,entry] },[project]),null);
  assert.deepEqual(resolveConnections({ ...entry, tools: ['godot-mcp','removed'], guides: ['private-guide'] },[{ kind: 'tool', id: 'godot-mcp' }]).tools,['godot-mcp']);
  assert.deepEqual(resolveConnections({ ...entry, guides: ['private-guide'] },[]).guides,[]);
});
