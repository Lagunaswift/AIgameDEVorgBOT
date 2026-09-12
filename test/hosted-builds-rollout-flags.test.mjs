import assert from 'node:assert/strict';
import test from 'node:test';
import { hostedPlatformEnabled } from '../src/lib/hostedFeatureFlags.js';
import { loadCommands } from '../src/loadCommands.js';
import { execute as threadUpdate } from '../src/events/threadUpdate.js';

test('hosted Bot controls default off and require explicit enablement', () => {
  for (const value of [undefined, null, false, true, 'false', '1', '']) assert.equal(hostedPlatformEnabled({ HOSTED_BUILDS_ENABLED: value }), false);
  assert.equal(hostedPlatformEnabled({ HOSTED_BUILDS_ENABLED: ' true ' }), true);
});
test('disabled hosting excludes new moderator commands but preserves existing community commands', async () => {
  const disabled = await loadCommands({});
  assert.equal(disabled.has('jam'), false);
  assert.equal(disabled.has('build'), false);
  for (const name of ['help', 'mygame', 'jamvotes']) assert.equal(disabled.has(name), true);
  const enabled = await loadCommands({ HOSTED_BUILDS_ENABLED: 'true' });
  assert.equal(enabled.has('jam'), true);
  assert.equal(enabled.has('build'), true);
});
test('disabled hosting returns from tag reconciliation before reading Discord or Firestore', async () => {
  const previous = process.env.HOSTED_BUILDS_ENABLED;
  process.env.HOSTED_BUILDS_ENABLED = 'false';
  try {
    const inaccessible = new Proxy({}, { get() { assert.fail('disabled handler must not inspect or mutate sources'); } });
    await threadUpdate(inaccessible, inaccessible);
  } finally {
    if (previous === undefined) delete process.env.HOSTED_BUILDS_ENABLED;
    else process.env.HOSTED_BUILDS_ENABLED = previous;
  }
});
