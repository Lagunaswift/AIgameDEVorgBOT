import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BYTE_CHARACTER,
  BUILD_REACTIONS,
  OPENERS,
  QUIET_DAYS,
  SIGNOFFS,
} from '../src/lib/byte.js';

test('Byte v0.3 encodes behaviour, not only retro-computing lore', () => {
  assert.match(BYTE_CHARACTER, /competent old hardware with standards/i);
  assert.match(BYTE_CHARACTER, /reluctant mentor/i);
  assert.match(BYTE_CHARACTER, /soft spot for unfinished work/i);
  assert.match(BYTE_CHARACTER, /protect the community atmosphere/i);
  assert.match(BYTE_CHARACTER, /Sometimes say the useful thing with no joke at all/i);
});

test('Byte has explicit reaction instincts for design and shipping', () => {
  assert.match(BYTE_CHARACTER, /That is irritatingly solid/);
  assert.match(BYTE_CHARACTER, /Yes\. That is the bit\. Keep that/);
  assert.match(BYTE_CHARACTER, /built three systems to avoid building one mechanic/);
  assert.match(BYTE_CHARACTER, /I would not write-protect this yet/);
  assert.match(BYTE_CHARACTER, /It exists now\. That already puts it ahead of most ideas/);
});

test('Byte template pools include unfinished-work and restrained maker energy', () => {
  const all = [...BUILD_REACTIONS, ...OPENERS, ...QUIET_DAYS, ...SIGNOFFS].join('\n');
  assert.match(all, /Unfinished is allowed/);
  assert.match(all, /Things were made/);
  assert.match(all, /unfinished is allowed; unsaved is not/);
  assert.doesNotMatch(all, /!!!/);
});
