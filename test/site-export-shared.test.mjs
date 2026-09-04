import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkShowcaseEligibility,
  extractText,
  getForumTagMap,
  isMissingResource,
  stripMarkdown,
  truncate,
} from '../scripts/site-export-shared.mjs';

const FORUM = '1051088980176805920';
const PUBLISH_TAG = '1537600958245249154';
const THREAD = '1544780450570960947';

function channel(overrides = {}) {
  return {
    id: THREAD,
    parent_id: FORUM,
    applied_tags: [PUBLISH_TAG, '9999'],
    ...overrides,
  };
}

function threadData(overrides = {}) {
  return { threadId: THREAD, forumId: FORUM, mode: 'showcase', ...overrides };
}

test('extracted text normalisation keeps exporter behaviour', () => {
  // Single underscores survive (the exporter strips only __), matching the verbatim
  // extracted behaviour.
  assert.equal(stripMarkdown('**bold** and _under_ and ~~gone~~'), 'bold and _under_ and gone');
  assert.equal(stripMarkdown('__bold__ and __under__'), 'bold and under');
  assert.equal(stripMarkdown('[label](https://example.com)'), 'label');
  assert.equal(stripMarkdown('<:byte:123456789012345678> face'), ':byte: face');
  assert.equal(stripMarkdown('```\ncode\n```'), 'code');
  assert.equal(stripMarkdown('  spaced   out  '), 'spaced out');
  assert.equal(stripMarkdown(null), '');

  assert.equal(truncate('short', 280), 'short');
  assert.equal(truncate('x'.repeat(300), 280).length, 280);
  assert.equal(truncate(null, 280), null);

  assert.equal(extractText({ content: '**A** game' }, 280), 'A game');
  assert.equal(extractText(null, 280), null);
  assert.equal(extractText({ content: '   ' }, 280), null);
  assert.equal(extractText({ content: `x`.repeat(300) }, 280).length, 280);
});

test('isMissingResource recognises Discord missing-resource failures', () => {
  assert.equal(isMissingResource({ status: 404 }), true);
  assert.equal(isMissingResource({ status: 403 }), true);
  assert.equal(isMissingResource({ code: 10003 }), true);
  assert.equal(isMissingResource({ code: 10004 }), true);
  assert.equal(isMissingResource({ status: 500 }), false);
  assert.equal(isMissingResource(null), false);
});

test('eligibility decision reproduces the exporter publication boundary', () => {
  const sourceForumIds = new Set([FORUM]);

  assert.deepEqual(
    checkShowcaseEligibility({ channel: null, firestoreData: threadData(), sourceForumIds, publishTagId: PUBLISH_TAG }),
    { status: 'missing-channel' },
  );

  assert.equal(
    checkShowcaseEligibility({ channel: channel({ parent_id: '555' }), firestoreData: threadData(), sourceForumIds, publishTagId: PUBLISH_TAG }).status,
    'uncertain-forum',
  );
  assert.equal(
    checkShowcaseEligibility({ channel: channel({ parent_id: null }), firestoreData: threadData(), sourceForumIds, publishTagId: PUBLISH_TAG }).status,
    'uncertain-forum',
  );
  // Parent forum matches the channel but not the registered thread doc.
  assert.equal(
    checkShowcaseEligibility({ channel: channel(), firestoreData: threadData({ forumId: '555' }), sourceForumIds, publishTagId: PUBLISH_TAG }).status,
    'uncertain-forum',
  );

  assert.equal(
    checkShowcaseEligibility({ channel: channel({ applied_tags: undefined }), firestoreData: threadData(), sourceForumIds, publishTagId: PUBLISH_TAG }).status,
    'no-applied-tags',
  );

  // The publication boundary: no consent tag, no public data.
  assert.equal(
    checkShowcaseEligibility({ channel: channel({ applied_tags: ['9999'] }), firestoreData: threadData(), sourceForumIds, publishTagId: PUBLISH_TAG }).status,
    'not-published',
  );

  assert.deepEqual(
    checkShowcaseEligibility({ channel: channel(), firestoreData: threadData(), sourceForumIds, publishTagId: PUBLISH_TAG }),
    { status: 'ok', forumId: FORUM },
  );
});

test('getForumTagMap resolves tag ids and rejects malformed forums', async () => {
  let fetchCount = 0;
  const rest = {
    async get(url) {
      fetchCount += 1;
      if (url === `/channels/${FORUM}`) {
        return {
          available_tags: [
            { id: PUBLISH_TAG, name: 'Publish to site' },
            { id: '9999', name: 'web', emoji_id: null, emoji_name: null },
          ],
        };
      }
      throw new Error('unexpected url');
    },
  };
  const cache = new Map();
  const map = await getForumTagMap(rest, FORUM, cache);
  assert.equal(map.get(PUBLISH_TAG).name, 'Publish to site');
  assert.equal(map.get('9999').name, 'web');
  await getForumTagMap(rest, FORUM, cache);
  assert.equal(fetchCount, 1, 'forum tag map is cached per forum');

  await assert.rejects(
    getForumTagMap({ get: async () => ({}) }, '111', new Map()),
    /did not return available_tags/,
  );
  await assert.rejects(
    getForumTagMap({ get: async () => ({ available_tags: [{ id: 'x' }] }) }, '111', new Map()),
    /malformed tag/,
  );
});
