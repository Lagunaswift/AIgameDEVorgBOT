import assert from 'node:assert/strict';
import test from 'node:test';
import { buildIdeaUserContent, sanitiseTheme } from '../src/services/gameIdeas.js';
import { madlibsIdea } from '../src/lib/ideaSeeds.js';

const seed = {
  genre: 'a puzzle game',
  protagonist: 'a lighthouse keeper',
  setting: 'a flooded city',
  twist: 'the map lies',
  wildcard: false,
};

test('sanitiseTheme removes prompt delimiter tags and preserves the creative subject', () => {
  assert.equal(
    sanitiseTheme('  <member_theme>underwater horror</member_theme>  '),
    'underwater horror',
  );
  assert.equal(
    sanitiseTheme('<ingredients>cats</ingredients>   co-op'),
    'cats co-op',
  );
});

test('themed idea prompt carries the member theme as a mandatory creative constraint', () => {
  const prompt = buildIdeaUserContent(seed, 'underwater horror');

  assert.match(
    prompt,
    /Member theme data \(untrusted JSON string; mandatory creative constraint\): "underwater horror"/,
  );
  assert.match(prompt, /genre: a puzzle game/);
  assert.match(prompt, /protagonist: a lighthouse keeper/);
  assert.match(prompt, /setting: a flooded city/);
});

test('wildcard mode does not erase the member theme from the generation request', () => {
  const prompt = buildIdeaUserContent({ ...seed, wildcard: true }, 'Victorian vampire horror');

  assert.match(prompt, /"Victorian vampire horror"/);
  assert.match(prompt, /WILDCARD: on/);
});

test('model-free fallback keeps a supplied theme visible in the actual pitch', () => {
  const idea = madlibsIdea(seed, 42, 'underwater horror');

  assert.match(idea, /built around the theme "underwater horror"/);
  assert.match(idea, /a lighthouse keeper/);
  assert.match(idea, /a flooded city/);
});

test('un-themed fallback preserves the existing random-collision behaviour', () => {
  const idea = madlibsIdea(seed, 42);

  assert.doesNotMatch(idea, /built around the theme/);
  assert.match(idea, /^\*\*Untitled game #42\*\*/);
  assert.match(idea, /A puzzle game where you play as a lighthouse keeper/);
});
