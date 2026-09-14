import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { config } from '../src/config.js';
import { buildEffectiveConfig } from '../src/services/config.js';

function environmentConfig(values = {}) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    "import {config} from './src/config.js'; console.log(JSON.stringify({names:config.excludedTagNames,ids:config.excludedTagIds}));"], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', env: { PATH: process.env.PATH, ...values },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('real environment config loads documented default and exact ID/name overrides', () => {
  assert.deepEqual(environmentConfig(), { names: ['just-sharing'], ids: [] });
  assert.deepEqual(environmentConfig({ EXCLUDED_TAG_NAMES: ' Just-Sharing, announcements ',
    EXCLUDED_TAG_IDS: '123456789012345678, 223456789012345678' }), {
      names: ['Just-Sharing', 'announcements'], ids: ['123456789012345678', '223456789012345678'],
    });
  assert.deepEqual(environmentConfig({ EXCLUDED_TAG_NAMES: '', EXCLUDED_TAG_IDS: '' }), { names: [], ids: [] });
});

test('effective config forwards env exclusions and respects independent runtime overrides', () => {
  const baseline = buildEffectiveConfig({});
  assert.deepEqual(baseline.excludedTagNames, config.excludedTagNames);
  assert.deepEqual(baseline.excludedTagIds, config.excludedTagIds);
  const byName = buildEffectiveConfig({ excludedTagNames: ['Sharing only'] });
  assert.deepEqual(byName.excludedTagNames, ['Sharing only']);
  assert.deepEqual(byName.excludedTagIds, config.excludedTagIds);
  const byId = buildEffectiveConfig({ excludedTagIds: ['123456789012345678'] });
  assert.deepEqual(byId.excludedTagNames, config.excludedTagNames);
  assert.deepEqual(byId.excludedTagIds, ['123456789012345678']);
  const cleared = buildEffectiveConfig({ excludedTagNames: [], excludedTagIds: [] });
  assert.deepEqual(cleared.excludedTagNames, []); assert.deepEqual(cleared.excludedTagIds, []);
  assert.equal(cleared.guildId, baseline.guildId);
  assert.equal(cleared.minCommentLength, baseline.minCommentLength);
});

test('malformed tag exclusion overrides fail without echoing private values', () => {
  for (const value of [{ excludedTagNames: 'private-value' }, { excludedTagIds: '123456789012345678' },
    { excludedTagNames: [null] }, { excludedTagIds: ['not-an-id'] }, { excludedTagNames: ['bad\nname'] }]) {
    assert.throws(() => buildEffectiveConfig(value), { message: 'Invalid feedback tag exclusion configuration.' });
  }
});
