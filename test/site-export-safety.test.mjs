import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { normalizeProjectUrl } from '../src/lib/publicMetadata.js';
import { buildPublicGame } from '../scripts/site-export-contract.mjs';
import {
  parsePublishTagId,
  preserveGeneratedAtIfUnchanged,
  removeStaleAssets,
  validateExportReport,
  validateShowcaseSnapshot,
} from '../scripts/site-export-safety.mjs';

const game = (id, overrides = {}) => ({
  id,
  title: 'Game',
  publish: true,
  feedbackPoints: 0,
  needsFeedback: true,
  kind: 'project',
  jamId: null,
  projectUrl: null,
  ...overrides,
});
const snapshot = (games, generatedAt = '2026-08-28T12:00:00.000Z') => ({
  version: 2,
  generatedAt,
  games,
});

test('publication tag must be a Discord snowflake', () => {
  assert.equal(parsePublishTagId(' 12345678901234567 '), '12345678901234567');
  assert.throws(() => parsePublishTagId('showcase'), /SITE_PUBLISH_TAG_ID/);
  assert.throws(() => parsePublishTagId(''), /SITE_PUBLISH_TAG_ID/);
});

test('project URLs accept only explicit http(s) URLs', () => {
  assert.equal(normalizeProjectUrl('https://example.com/build'), 'https://example.com/build');
  assert.equal(normalizeProjectUrl('http://example.com'), 'http://example.com/');
  assert.equal(normalizeProjectUrl('ftp://example.com'), null);
  assert.equal(normalizeProjectUrl('not a url'), null);
});

test('candidate snapshots require the v2 public contract and exclude private metadata', () => {
  assert.doesNotThrow(() => validateShowcaseSnapshot(snapshot([game('12345678901234567')]), null));
  assert.throws(
    () => validateShowcaseSnapshot({ ...snapshot([]), version: 1 }, null),
    /version 2/,
  );
  assert.throws(
    () => validateShowcaseSnapshot(snapshot([game('12345678901234567', { authorId: 'private' })]), null),
    /private metadata/,
  );
  assert.throws(
    () => validateShowcaseSnapshot(snapshot([game('12345678901234567', { forumId: 'private' })]), null),
    /private metadata/,
  );
});

test('v1 snapshots are accepted only as prior migration input', () => {
  const v1Previous = { version: 1, generatedAt: '2026-08-28T12:00:00.000Z', games: [] };
  assert.doesNotThrow(() => validateShowcaseSnapshot(snapshot([]), v1Previous));
  assert.throws(() => validateShowcaseSnapshot(v1Previous, null), /version 2/);
});

test('a populated v1 snapshot cannot lose a project without a withheld record', () => {
  const v1Previous = { version: 1, generatedAt: '2026-08-28T12:00:00.000Z', games: [{ id: '12345678901234567', title: 'Legacy game' }] };
  assert.throws(() => validateShowcaseSnapshot(snapshot([]), v1Previous), /would remove non-opted-out project/);
  assert.doesNotThrow(() => validateShowcaseSnapshot(snapshot([]), v1Previous, {
    version: 1,
    withheldIds: ['12345678901234567'],
  }));
});

test('public game contract derives kind and feedback state from structured metadata', () => {
  const jamEntry = buildPublicGame({
    ...game('12345678901234567', { feedbackPoints: 2, needsFeedback: false }),
    author: 'Maker',
    description: null,
    image: null,
    threadUrl: 'https://discord.com/channels/1/12345678901234567',
    createdAt: '2026-08-28T12:00:00.000Z',
    tags: [],
    award: null,
    jamId: 'spring-2026',
    projectUrl: 'https://example.com/game',
  });
  assert.equal(jamEntry.kind, 'jam-entry');
  assert.equal(jamEntry.jamId, 'spring-2026');
  assert.equal(jamEntry.needsFeedback, false);
  assert.equal(Object.hasOwn(jamEntry, 'authorId'), false);
  assert.equal(Object.hasOwn(jamEntry, 'forumId'), false);

  const project = buildPublicGame({ ...jamEntry, jamId: null, feedbackPoints: 0, projectUrl: null });
  assert.equal(project.kind, 'project');
  assert.equal(project.needsFeedback, true);
});

test('snapshot rejects inconsistent jam and feedback semantics', () => {
  assert.throws(
    () => validateShowcaseSnapshot(snapshot([game('12345678901234567', { kind: 'jam-entry' })]), null),
    /inconsistent kind and jamId/,
  );
  assert.throws(
    () => validateShowcaseSnapshot(snapshot([game('12345678901234567', { feedbackPoints: 1 })]), null),
    /inconsistent needsFeedback/,
  );
});

test('only explicitly opted-out or withheld prior projects may disappear', () => {
  const previous = snapshot([
    game('12345678901234567'),
    game('12345678901234568', { publish: false }),
  ]);
  assert.doesNotThrow(() => validateShowcaseSnapshot(snapshot([game('12345678901234567')]), previous));
  assert.doesNotThrow(() => validateShowcaseSnapshot(snapshot([]), snapshot([game('12345678901234567')]), {
    version: 1,
    withheldIds: ['12345678901234567'],
  }));
  assert.throws(
    () => validateShowcaseSnapshot(snapshot([]), previous),
    /would remove non-opted-out project/,
  );
});

test('malformed export reports are rejected', () => {
  assert.throws(() => validateExportReport({ version: 1, withheldIds: ['not-a-snowflake'] }), /invalid withheld id/);
  assert.throws(() => validateExportReport({ version: 1, withheldIds: ['12345678901234567', '12345678901234567'] }), /duplicate withheld id/);
});

test('unchanged semantic snapshots retain generatedAt', () => {
  const previous = snapshot([game('12345678901234567')], '2026-08-28T12:00:00.000Z');
  const candidate = snapshot([game('12345678901234567')], '2026-08-28T13:00:00.000Z');
  assert.equal(
    preserveGeneratedAtIfUnchanged(previous, candidate).generatedAt,
    previous.generatedAt,
  );
});

test('staging cleanup removes stale generated assets only', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'site-export-assets-'));
  try {
    await fs.writeFile(path.join(directory, 'keep.webp'), 'keep');
    await fs.writeFile(path.join(directory, 'stale.webp'), 'stale');
    await removeStaleAssets(directory, ['/assets/showcase/keep.webp']);
    assert.deepEqual(await fs.readdir(directory), ['keep.webp']);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
