import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCommunityNoteChecklist, buildPostTemplate } from '../src/lib/communityTemplates.js';
import { data as communityNoteData } from '../src/commands/communitynote.js';
import { data as postTemplateData } from '../src/commands/posttemplate.js';

test('post templates contain the required community workflow fields', () => {
  const buildHelp = buildPostTemplate('build_help');
  assert.match(buildHelp, /What I’m building/);
  assert.match(buildHelp, /Engine\/tool\/version/);
  assert.match(buildHelp, /Intended outcome/);
  assert.match(buildHelp, /Actual behavior/);
  assert.match(buildHelp, /What I’ve tried/);
  assert.match(buildHelp, /Relevant code, log, or screenshot/);
  assert.match(buildHelp, /Desired help/);
  assert.match(buildHelp, /remove secrets, API keys, personal data/);

  const playtest = buildPostTemplate('playtest');
  for (const field of [
    'Game/build', 'Playable link', 'Platform', 'Approximate play time', 'Feedback target',
    'Known issues', 'Feedback deadline', 'Code / Art / Audio / Voice / Narrative / Runtime / Other',
    'rights to distribute',
  ]) assert.match(playtest, new RegExp(field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  const update = buildPostTemplate('project_update');
  for (const field of [
    'What changed', 'What worked', 'What did not', 'What’s next', 'Feedback wanted', 'Yes / No',
    'Site publication opt-in', 'No (default)',
  ]) assert.match(update, new RegExp(field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('post template rejects unsupported types', () => {
  assert.throws(() => buildPostTemplate('unknown'), /unknown post template/);
});

test('community-note checklist is consent-first and private', () => {
  const checklist = buildCommunityNoteChecklist();
  for (const field of [
    'every material contributor’s explicit approval', 'title, problem, tried, worked, didn\'t, limitations, sources',
    'named / anonymous / no credit', 'exact final text', 'Discord IDs and forum IDs must never appear publicly',
    'manual curation only', 'does not collect, save, scrape, summarize, draft, or publish anything',
  ]) assert.match(checklist, new RegExp(field));
});

test('community workflow commands expose the required slash-command metadata', () => {
  const postTemplate = postTemplateData.toJSON();
  assert.equal(postTemplate.name, 'posttemplate');
  const type = postTemplate.options.find((option) => option.name === 'type');
  assert.equal(type.required, true);
  assert.deepEqual(type.choices.map((choice) => choice.value), [
    'build_help', 'playtest', 'project_update',
  ]);

  const communityNote = communityNoteData.toJSON();
  assert.equal(communityNote.name, 'communitynote');
  assert.equal(communityNote.options[0].name, 'nominate');
});
