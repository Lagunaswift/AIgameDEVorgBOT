// Exporter flow regression: processShowcaseThread end-to-end with faked REST.
//
// The shared-helper extraction once left `forumId` undefined on the eligible path
// (ReferenceError after consent passed) — unit tests of the shared helpers could not
// catch it because the wiring, not the decision, was broken. This file exercises the
// exporter's own thread-processing path so that class of regression fails here.

import assert from 'node:assert/strict';
import test from 'node:test';
import { processShowcaseThread } from '../scripts/export-site-data.mjs';

const OWNER = '123456789012345678';
const FORUM = '1051088980176805920';
const GUILD = '1051088980176805919';
const THREAD = '345678901234567890';
const PUBLISH_TAG = '1537600958245249154';
const WEB_TAG = '1111111111111111111';

function restFor({ consent = true, guildId = GUILD, archived = false } = {}) {
  return {
    async get(url) {
      if (url === `/channels/${FORUM}`) {
        return {
          id: FORUM, guild_id: GUILD, type: 15,
          available_tags: [
            { id: PUBLISH_TAG, name: 'Publish to site', moderated: true, emoji_id: null, emoji_name: null },
            { id: WEB_TAG, name: 'web', emoji_id: null, emoji_name: null },
          ],
        };
      }
      if (url === `/channels/${THREAD}`) {
        if (!consent) throw Object.assign(new Error('404'), { status: 404 });
        return {
          id: THREAD, parent_id: FORUM, guild_id: guildId, name: 'Guild Game', owner_id: OWNER,
          type: 11, applied_tags: [PUBLISH_TAG, WEB_TAG], thread_metadata: { archived },
        };
      }
      if (url === `/channels/${THREAD}/messages/${THREAD}`) {
        return { content: '**Bold** public description.', author: { id: OWNER }, attachments: [] };
      }
      // findOwnerFallbackImage scans the first page after the starter when the
      // starter itself carries no image; the starter here has none.
      if (url === `/channels/${THREAD}/messages`) {
        return [];
      }
      throw new Error(`unexpected url ${url}`);
    },
  };
}

function ctx(overrides = {}) {
  return {
    rest: restFor(),
    forumTagCache: new Map(),
    pointsMap: new Map([[THREAD, 3]]),
    dryRun: true,
    outDir: '.',
    publishTagId: PUBLISH_TAG,
    sourceForumIds: new Set([FORUM]),
    withheldIds: new Set(),
    awardEmojiCache: new Map(),
    ...overrides,
  };
}

function docSnap(data) {
  return { id: THREAD, data: () => ({ threadId: THREAD, ...data }) };
}

test('eligible public threads are exported through the shared eligibility decision', async () => {
  const result = await processShowcaseThread(docSnap({
    threadId: THREAD, forumId: FORUM, ownerId: OWNER, ownerTag: 'owner#1',
    mode: 'showcase', projectUrl: null, jamId: null,
  }), ctx());

  // The regression this guards: the eligible path must reach tag resolution without a
  // ReferenceError and with the verified forum id from the shared decision.
  assert.ok(result, 'eligible thread produces a game');
  assert.equal(result.game.id, THREAD);
  assert.equal(result.game.title, 'Guild Game');
  assert.equal(result.game.description, 'Bold public description.');
  assert.deepEqual(result.game.tags, ['Publish to site', 'web']);
  assert.equal(result.game.feedbackPoints, 3);
  assert.equal(result.game.publish, true);
  assert.equal(result.game.projectId, null);
  assert.equal(result.game.projectSlug, null);
  assert.equal(result.game.state, null);
  assert.equal(result.game.activityTitle, null);
});

test('linked showcase threads export only their exact same-owner published Project', async () => {
  const projectsById = new Map([['project-1', {
    id: 'project-1',
    data: { projectId: 'project-1', ownerId: OWNER, publishToSite: true },
    prepared: { id: 'project-1', ownerId: OWNER, profileThreadId: THREAD, project: { slug: 'guild-game' } },
  }]]);
  const result = await processShowcaseThread(docSnap({
    threadId: THREAD,
    forumId: FORUM,
    ownerId: OWNER,
    ownerTag: 'owner#1',
    mode: 'showcase',
    projectId: 'project-1',
    purpose: 'feedback',
    activityTitle: 'Enemy timing pass',
    projectUrl: null,
    jamId: null,
  }), ctx({ projectsById, exportedProjectIds: new Set(['project-1']) }));

  assert.equal(result.game.projectId, 'project-1');
  assert.equal(result.game.projectSlug, 'guild-game');
  assert.equal(result.game.state, 'open');
  assert.equal(result.game.activityTitle, 'Enemy timing pass');

  const archived = await processShowcaseThread(docSnap({
    threadId: THREAD, forumId: FORUM, ownerId: OWNER, mode: 'showcase',
    projectId: 'project-1', activityTitle: null,
  }), ctx({ rest: restFor({ archived: true }), projectsById, exportedProjectIds: new Set(['project-1']) }));
  assert.equal(archived.game.state, 'archived');

  const wrongOwner = await processShowcaseThread(docSnap({
    threadId: THREAD, forumId: FORUM, ownerId: '234567890123456789', mode: 'showcase',
    projectId: 'project-1', activityTitle: null,
  }), ctx({ projectsById, exportedProjectIds: new Set(['project-1']) }));
  assert.equal(wrongOwner, null, 'a live owner mismatch is withheld before private content is read');
  await assert.rejects(
    processShowcaseThread(docSnap({
      threadId: THREAD, forumId: FORUM, ownerId: OWNER, mode: 'showcase',
      projectId: 'missing-project', activityTitle: null,
    }), ctx({ projectsById, exportedProjectIds: new Set(['project-1']) })),
    /missing Project/i,
  );
});

test('non-published and missing threads are withheld exactly as before', async () => {
  const withheld = new Set();
  const noTagRest = {
    async get(url) {
      if (url === `/channels/${FORUM}`) {
        return { id: FORUM, guild_id: GUILD, type: 15, available_tags: [{ id: PUBLISH_TAG, name: 'Publish to site', moderated: true }, { id: WEB_TAG, name: 'web' }] };
      }
      if (url === `/channels/${THREAD}`) {
        return { id: THREAD, parent_id: FORUM, guild_id: GUILD, owner_id: OWNER, type: 11, applied_tags: [WEB_TAG], thread_metadata: { archived: false } };
      }
      throw new Error(`unexpected url ${url}`);
    },
  };
  const skipped = await processShowcaseThread(docSnap({
    threadId: THREAD, forumId: FORUM, ownerId: OWNER, mode: 'showcase',
  }), ctx({ rest: noTagRest, withheldIds: withheld }));
  assert.equal(skipped, null);
  assert.ok(withheld.has(THREAD), 'untagged thread is withheld');

  const missing = new Set();
  const gone = await processShowcaseThread(docSnap({
    threadId: THREAD, forumId: FORUM, ownerId: OWNER, mode: 'showcase',
  }), ctx({ rest: restFor({ consent: false }), withheldIds: missing }));
  assert.equal(gone, null);
  assert.ok(missing.has(THREAD), 'missing channel is withheld');
});

test('an owner-unpublished Project leaves its approved Showcase card unlinked', async () => {
  const projectsById = new Map([['project-1', {
    id: 'project-1',
    data: { projectId: 'project-1', ownerId: OWNER, publishToSite: false },
    prepared: null,
  }]]);
  const result = await processShowcaseThread(docSnap({
    threadId: THREAD, forumId: FORUM, ownerId: OWNER, mode: 'showcase', projectId: 'project-1',
  }), ctx({ projectsById, exportedProjectIds: new Set() }));
  assert.equal(result.game.projectId, null);
  assert.equal(result.game.projectSlug, null);
  assert.equal(result.game.state, null);
});

test('Showcase recovers the owners reply image beyond the former fifty-message cutoff', async () => {
  const base = restFor();
  const rest = {
    async get(url, options) {
      if (url === `/channels/${THREAD}/messages`) {
        return Array.from({ length: 80 }, (_, index) => ({
          id: String(BigInt(THREAD) + BigInt(index + 1)),
          author: { id: index === 1 ? '234567890123456789' : OWNER },
          attachments: index === 1 || index === 79 ? [{ url: 'https://cdn.discordapp.com/game.png', filename: 'game.png' }] : [],
        })).reverse();
      }
      return base.get(url, options);
    },
  };
  const result = await processShowcaseThread(docSnap({
    threadId: THREAD, forumId: FORUM, ownerId: OWNER, mode: 'showcase',
  }), ctx({ rest }));
  assert.equal(result.hasImage, true);
  assert.equal(result.recovered, true);
  assert.equal(result.game.image, `/assets/showcase/${THREAD}.webp`);
});

test('Showcase REST image search can recover a fresh upload in a long thread', async () => {
  const base = restFor();
  let pages = 0;
  const rest = { async get(url, options) {
    if (url !== `/channels/${THREAD}/messages`) return base.get(url, options);
    pages++;
    assert.equal(options.query.get('limit'), '100');
    const after = options.query.get('after');
    if (!after) return [{
      id: String(BigInt(THREAD) + 10000n), author: { id: OWNER },
      attachments: [{ filename: 'fresh.png', url: 'https://cdn.discordapp.com/fresh.png' }],
    }];
    return Array.from({ length: 100 }, (_, index) => ({
      id: String(BigInt(after) + BigInt(index + 1)), author: { id: OWNER }, attachments: [],
    })).reverse();
  } };
  const result = await processShowcaseThread(docSnap({
    threadId: THREAD, forumId: FORUM, ownerId: OWNER, mode: 'showcase',
  }), ctx({ rest }));
  assert.equal(result.hasImage, true);
  assert.equal(pages, 6);
});

test('Showcase does not silently clear an image when reply history is unavailable', async () => {
  const base = restFor();
  const rest = { async get(url, options) {
    if (url === `/channels/${THREAD}/messages`) throw Object.assign(new Error('history forbidden'), { status: 403 });
    return base.get(url, options);
  } };
  await assert.rejects(processShowcaseThread(docSnap({
    threadId: THREAD, forumId: FORUM, ownerId: OWNER, mode: 'showcase',
  }), ctx({ rest })), /history forbidden/);
});

test('linked Showcase destination comes from approved Project data, not stale Thread metadata', async () => {
  const makeProject=(project)=>new Map([['project-1',{id:'project-1',data:{projectId:'project-1',ownerId:OWNER,publishToSite:true},prepared:{id:'project-1',ownerId:OWNER,profileThreadId:THREAD,project:{slug:'guild-game',status:'playable',links:[],...project}}}]]);
  const thread=docSnap({threadId:THREAD,forumId:FORUM,ownerId:OWNER,mode:'showcase',projectId:'project-1',projectUrl:'https://example.com/old'});
  const current=await processShowcaseThread(thread,ctx({projectsById:makeProject({projectUrl:'https://example.com/current'}),exportedProjectIds:new Set(['project-1'])}));
  assert.equal(current.game.projectUrl,'https://example.com/current');
  const removed=await processShowcaseThread(thread,ctx({projectsById:makeProject({projectUrl:null}),exportedProjectIds:new Set(['project-1'])}));
  assert.equal(removed.game.projectUrl,null);
  const structured=await processShowcaseThread(thread,ctx({projectsById:makeProject({projectUrl:'https://example.com/site',links:[{type:'play',url:'https://example.com/play',priority:1}]}),exportedProjectIds:new Set(['project-1'])}));
  assert.equal(structured.game.projectUrl,'https://example.com/play');
});

test('owner-unpublished Project does not leak its destination or resurrect old Thread URL', async () => {
  const projectsById=new Map([['project-1',{id:'project-1',data:{projectId:'project-1',ownerId:OWNER,publishToSite:false,projectUrl:'https://private.example'},prepared:null}]]);
  const result=await processShowcaseThread(docSnap({threadId:THREAD,forumId:FORUM,ownerId:OWNER,mode:'showcase',projectId:'project-1',projectUrl:'https://old.example'}),ctx({projectsById,exportedProjectIds:new Set()}));
  assert.equal(result.game.projectUrl,null);
  assert.equal(result.game.projectId,null);
});
