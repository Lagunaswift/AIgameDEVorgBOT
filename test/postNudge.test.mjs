import assert from 'node:assert/strict';
import test from 'node:test';
import { threadHasExcludedTag } from '../src/lib/tags.js';
import { buildCombinedNudge, combinedNudgeDelayMinutes } from '../src/services/postNudge.js';
import { buildScreenshotMessage } from '../src/services/screenshotNudge.js';

const OWNER = '123';
const EXCLUDED_TAG_ID = '1545025922355298374';

test('the excluded tag id suppresses the guidelines nudge without a parent lookup', () => {
  // No parent cached: id matching must still hold, which is the point of matching on id.
  const tagged = { appliedTags: [EXCLUDED_TAG_ID], parent: null };
  assert.equal(threadHasExcludedTag(tagged, { ids: [EXCLUDED_TAG_ID] }), true);

  const untagged = { appliedTags: ['999'], parent: null };
  assert.equal(threadHasExcludedTag(untagged, { ids: [EXCLUDED_TAG_ID] }), false);

  const noTags = { appliedTags: [], parent: null };
  assert.equal(threadHasExcludedTag(noTags, { ids: [EXCLUDED_TAG_ID] }), false);
});

test('name-based exclusion still works and is case-insensitive', () => {
  const thread = {
    appliedTags: ['t1'],
    parent: { availableTags: [{ id: 't1', name: 'Just-Sharing' }] },
  };
  assert.equal(threadHasExcludedTag(thread, { names: ['just-sharing'] }), true);
  assert.equal(threadHasExcludedTag(thread, { names: ['showcase'] }), false);
});

test('both asks arrive in one message, photo ask last before the warning', () => {
  const msg = buildCombinedNudge(OWNER, { needsGuidelines: true, needsPhoto: true });

  assert.match(msg, /^Hey <@123>! /);
  assert.match(msg, /1-2 specific questions/);
  assert.match(msg, /add a photo to the original post/);
  assert.match(msg, /deleted in 12 hours if you don't!$/);

  // One greeting, one message: the poster never gets the photo ask as a second post.
  assert.equal(msg.match(/Hey <@123>/g).length, 1);
  assert.ok(msg.indexOf('specific questions') < msg.indexOf('add a photo'));
  assert.ok(msg.indexOf('add a photo') < msg.indexOf('deleted in 12 hours'));
});

test('the photo ask is omitted when the post already has one', () => {
  const msg = buildCombinedNudge(OWNER, { needsGuidelines: true, needsPhoto: false });
  assert.doesNotMatch(msg, /photo/);
  assert.match(msg, /1-2 specific questions/);
  assert.match(msg, /deleted in 12 hours/);
});

test('a photo-only nudge stands alone and carries no deletion warning', () => {
  const msg = buildCombinedNudge(OWNER, { needsGuidelines: false, needsPhoto: true });
  assert.match(msg, /Please add a photo to the original post/);
  assert.doesNotMatch(msg, /^.*And please add/);
  assert.doesNotMatch(msg, /specific questions/);
  assert.doesNotMatch(msg, /deleted in 12 hours/);
});

test('nothing is sent when the post passes both checks', () => {
  assert.equal(buildCombinedNudge(OWNER, { needsGuidelines: false, needsPhoto: false }), null);
});

test('the standalone screenshot nudge asks for the original post too', () => {
  const msg = buildScreenshotMessage(OWNER);
  assert.match(msg, /Please add a photo to the original post/);
  assert.doesNotMatch(msg, /first message/);
});

test('the shared timer uses the shorter of the enabled delays', () => {
  const both = {
    guidelinesNudgeEnabled: true,
    guidelinesNudgeDelayMinutes: 15,
    screenshotNudgeEnabled: true,
    screenshotNudgeDelayMinutes: 10,
  };
  assert.equal(combinedNudgeDelayMinutes(both), 10);

  assert.equal(combinedNudgeDelayMinutes({ ...both, screenshotNudgeEnabled: false }), 15);
  assert.equal(combinedNudgeDelayMinutes({ ...both, guidelinesNudgeEnabled: false }), 10);
  assert.equal(
    combinedNudgeDelayMinutes({
      ...both,
      guidelinesNudgeEnabled: false,
      screenshotNudgeEnabled: false,
    }),
    null,
  );
});
