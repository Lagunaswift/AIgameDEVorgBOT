import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { Events } from 'discord.js';
import { EVENT_MODULES, registerEventHandlers } from '../src/eventRegistry.js';

test('production startup uses the importable event registry', () => {
  const source = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(source, /import \{ registerEventHandlers \} from '\.\/eventRegistry\.js'/);
  assert.match(source, /registerEventHandlers\(client\)/);
});

test('Discord thread tag updates are wired exactly once on the real production registry', () => {
  const client = new EventEmitter();
  registerEventHandlers(client);
  assert.equal(EVENT_MODULES.filter((mod) => mod.name === Events.ThreadUpdate).length, 1);
  assert.equal(client.listenerCount(Events.ThreadUpdate), 1);
  for (const mod of EVENT_MODULES) assert.equal(client.listenerCount(mod.name), 1);
  registerEventHandlers(client);
  assert.equal(client.listenerCount(Events.ThreadUpdate), 1, 're-registration must not duplicate moderation effects');
  const secondClient = new EventEmitter();
  registerEventHandlers(secondClient);
  assert.equal(secondClient.listenerCount(Events.ThreadUpdate), 1);
});
