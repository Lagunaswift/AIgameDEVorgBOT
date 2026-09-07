import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { config } from '../src/config.js';
import { prepareProjectExports } from '../scripts/site-export-contract.mjs';
import { cleanProjectAssets, runProjectsFlow } from '../scripts/export-site-data.mjs';

const GUILD = '1051088980176805919';
const FORUM = '1051088980176805920';
const OWNER = '123456789012345678';
const PROFILE = '345678901234567890';
const MEDIA = '456789012345678901';
const ACTIVITY = '567890123456789012';
const PUBLISH_TAG = '1537600958245249154';

function projectData(overrides = {}) {
  return {
    projectId: 'project-1',
    ownerId: OWNER,
    title: 'Test Game',
    slug: 'test-game',
    summary: 'A compact test game.',
    status: 'playable',
    projectUrl: 'https://example.com/game',
    platforms: ['web'],
    publishToSite: true,
    profileThreadId: PROFILE,
    mediaThreadIds: [PROFILE],
    creatorName: 'Maker',
    description: 'A longer public description.',
    links: [{ type: 'play', label: 'Play now', url: 'https://example.com/play', priority: 1, ownerId: 'must-not-leak' }],
    activities: [{
      type: 'build', title: 'Website build', date: '2026-09-01T00:00:00.000Z',
      summary: null, url: 'https://example.com/build', firestorePath: 'must-not-leak',
    }],
    wiki: {
      url: 'https://example.com/wiki',
      entries: [{ title: 'Controls', summary: null, url: 'https://example.com/wiki/controls', ownerId: 'must-not-leak' }],
    },
    createdAt: { toDate: () => new Date('2026-08-01T00:00:00.000Z') },
    updatedAt: { toDate: () => new Date('2026-09-01T00:00:00.000Z') },
    internalNotes: 'must-not-leak',
    ...overrides,
  };
}

const projectDoc = (id, data) => ({ id, data: () => data });
const threadDoc = (id, data) => ({ id, data: () => ({
  threadId: id,
  forumId: FORUM,
  ownerId: OWNER,
  projectId: 'project-1',
  mode: 'showcase',
  createdAt: { toDate: () => new Date('2026-09-03T00:00:00.000Z') },
  ...data,
}) });

function approvalForum() {
  return {
    id: FORUM,
    guild_id: GUILD,
    type: 15,
    available_tags: [{ id: PUBLISH_TAG, name: 'Publish to site', moderated: true }],
  };
}

test('Project preparation exports only literal consent and strips every internal field', () => {
  const prepared = prepareProjectExports([
    projectDoc('project-1', projectData()),
    projectDoc('project-2', projectData({ projectId: 'project-2', slug: 'private-game', publishToSite: 'true' })),
  ]);

  assert.equal(prepared.published.length, 1);
  const publicProject = prepared.published[0].project;
  assert.equal(publicProject.id, 'project-1');
  assert.equal(publicProject.createdAt, '2026-08-01T00:00:00.000Z');
  assert.equal(publicProject.links[0].ownerId, undefined);
  assert.equal(publicProject.activities[0].firestorePath, undefined);
  assert.equal(publicProject.wiki.entries[0].ownerId, undefined);
  assert.equal(publicProject.ownerId, undefined);
  assert.equal(publicProject.profileThreadId, undefined);
  assert.equal(publicProject.publishToSite, undefined);
  assert.equal(publicProject.internalNotes, undefined);
});

test('Project preparation validates physical identity and rich-field limits', () => {
  assert.throws(
    () => prepareProjectExports([projectDoc('physical-id', projectData())]),
    /does not match document id/,
  );
  assert.throws(
    () => prepareProjectExports([projectDoc('project-1', projectData({ projectId: null }))]),
    /project ID is required/,
  );
  assert.throws(
    () => prepareProjectExports([projectDoc('project-1', projectData({ mediaThreadIds: [MEDIA, MEDIA] }))]),
    /duplicates/,
  );
  assert.throws(
    () => prepareProjectExports([projectDoc('project-1', projectData({ wiki: { url: 'https://example.com', entries: Array(7).fill({ title: 'Entry', url: 'https://example.com/entry' }) } }))]),
    /at most 6 entries/,
  );
  assert.throws(
    () => prepareProjectExports([projectDoc('project-1', projectData({ links: [{ type: 'play', label: 'Play', url: 'file:///private', priority: 1 }] }))]),
    /public http\(s\) URL/,
  );
});

test('missing optional Project values normalize to null and empty arrays', () => {
  const { project } = prepareProjectExports([projectDoc('project-1', projectData({
    profileThreadId: null,
    mediaThreadIds: undefined,
    creatorName: undefined,
    description: undefined,
    projectUrl: undefined,
    links: undefined,
    activities: undefined,
    wiki: undefined,
    createdAt: undefined,
    updatedAt: undefined,
  }))]).published[0];

  assert.equal(project.creatorName, null);
  assert.equal(project.description, null);
  assert.equal(project.projectUrl, null);
  assert.equal(project.hero, null);
  assert.equal(project.wiki, null);
  assert.equal(project.createdAt, null);
  assert.equal(project.updatedAt, null);
  assert.deepEqual(project.media, []);
  assert.deepEqual(project.links, []);
  assert.deepEqual(project.activities, []);
});

test('draft Wiki selections are omitted before public validation', () => {
  const { project } = prepareProjectExports([projectDoc('project-1', projectData({
    wiki: {
      url: 'https://example.com/wiki',
      entries: [
        { title: 'Public', url: 'https://example.com/wiki/public' },
        { title: 'Private draft', draft: true },
      ],
    },
  }))]).published[0];

  assert.deepEqual(project.wiki.entries, [{
    title: 'Public', summary: null, url: 'https://example.com/wiki/public',
  }]);

  const hidden = prepareProjectExports([projectDoc('project-1', projectData({
    wiki: { draft: true, entries: 'private draft data' },
  }))]).published[0].project;
  assert.equal(hidden.wiki, null);
});

test('Project flow builds media only from its approved fixed source thread', async (t) => {
  const previousGuild = config.guildId;
  config.guildId = GUILD;
  t.after(() => { config.guildId = previousGuild; });

  const docs = [threadDoc(PROFILE, { purpose: 'project-update', publishOnProject: false })];
  const db = { collection: () => ({ get: async () => ({ docs }) }) };
  const rest = {
    async get(url) {
      const channelMatch = /^\/channels\/(\d+)$/.exec(url);
      if (channelMatch) {
        if (channelMatch[1] === FORUM) return approvalForum();
        return {
          id: channelMatch[1], guild_id: GUILD, parent_id: FORUM, owner_id: OWNER,
          type: 11, name: 'Test Game art', applied_tags: [PUBLISH_TAG],
          thread_metadata: { archived: false },
        };
      }
      const starterMatch = /^\/channels\/(\d+)\/messages\/\1$/.exec(url);
      if (starterMatch) {
        return {
          author: { id: OWNER }, content: '',
          attachments: [{
            url: `https://cdn.discordapp.com/${starterMatch[1]}.png`,
            filename: 'image.png', content_type: 'image/png', description: 'Gameplay screenshot',
          }],
        };
      }
      if (/^\/channels\/\d+\/messages$/.test(url)) return [];
      throw new Error(`unexpected URL ${url}`);
    },
  };
  const downloadOptions = [];
  const downloadAttachment = async (...args) => {
    downloadOptions.push(args[4]);
    return { ext: 'webp', width: 1280, height: 720 };
  };
  const { projects, generatedAssets } = await runProjectsFlow(
    rest,
    db,
    prepareProjectExports([projectDoc('project-1', projectData())]).published,
    { out: '.', dryRun: false, publishTagId: PUBLISH_TAG },
    { downloadAttachment },
  );

  assert.equal(projects.length, 1);
  assert.equal(projects[0].hero.src, '/assets/projects/test-game/_discord-export/hero.webp');
  assert.equal(projects[0].media[0].src, '/assets/projects/test-game/_discord-export/media-01.webp');
  assert.doesNotMatch(projects[0].hero.src, new RegExp(PROFILE));
  assert.deepEqual(projects[0].activities.map(({ title }) => title), ['Website build']);
  assert.equal(projects[0].activities[0].url, 'https://example.com/build');
  assert.equal(projects[0].activities[0].ownerId, undefined);
  assert.deepEqual(generatedAssets, [projects[0].hero.src, projects[0].media[0].src]);
  assert.deepEqual(downloadOptions, [
    { maxWidth: 1600, quality: 82, allowOriginalFallback: false },
    { maxWidth: 1600, quality: 82, allowOriginalFallback: false },
  ]);

  docs[0] = threadDoc(PROFILE, { purpose: 'feedback', publishOnProject: true, activityTitle: 'Current playtest', activitySummary: 'Test the new build.' });
  const selected = await runProjectsFlow(rest, db,
    prepareProjectExports([projectDoc('project-1', projectData())]).published,
    { out: '.', dryRun: true, publishTagId: PUBLISH_TAG });
  assert.ok(selected.projects[0].activities.some((activity) => activity.title === 'Current playtest'
    && activity.url === `https://discord.com/channels/${GUILD}/${PROFILE}`));
  assert.ok(selected.projects[0].activities.some((activity) => activity.title === 'Website build'));
});

test('Project media uses the real optimizer and records output dimensions', async (t) => {
  const previousGuild = config.guildId;
  config.guildId = GUILD;
  t.after(() => { config.guildId = previousGuild; });
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'project-media-'));
  t.after(() => fs.rm(out, { recursive: true, force: true }));

  const png = await sharp({
    create: { width: 4, height: 3, channels: 3, background: '#ff6600' },
  }).png().toBuffer();
  const docs = [threadDoc(PROFILE, { publishOnProject: false })];
  const db = { collection: () => ({ get: async () => ({ docs }) }) };
  const rest = {
    async get(url) {
      if (url === `/channels/${PROFILE}`) {
        return {
          id: PROFILE, guild_id: GUILD, parent_id: FORUM, owner_id: OWNER,
          type: 11, name: 'Hero art', applied_tags: [PUBLISH_TAG], thread_metadata: { archived: false },
        };
      }
      if (url === `/channels/${FORUM}`) return approvalForum();
      if (url === `/channels/${PROFILE}/messages/${PROFILE}`) {
        return {
          author: { id: OWNER }, content: '',
          attachments: [{
            url: `data:image/png;base64,${png.toString('base64')}`,
            filename: 'hero.png', content_type: 'image/png', description: 'Orange test image',
          }],
        };
      }
      throw new Error(`unexpected URL ${url}`);
    },
  };

  const { projects } = await runProjectsFlow(
    rest,
    db,
    prepareProjectExports([projectDoc('project-1', projectData({ mediaThreadIds: [] }))]).published,
    { out, dryRun: false, publishTagId: PUBLISH_TAG },
  );

  assert.equal(projects[0].hero.width, 4);
  assert.equal(projects[0].hero.height, 3);
  assert.equal(projects[0].hero.alt, 'Orange test image');
  await fs.access(path.join(out, 'public', projects[0].hero.src));
});

test('Project flow withholds a non-public source and rejects a conflicting owner backlink', async (t) => {
  const previousGuild = config.guildId;
  config.guildId = GUILD;
  t.after(() => { config.guildId = previousGuild; });

  const privateDocs = [threadDoc(PROFILE, { publishOnProject: false })];
  const privateDb = { collection: () => ({ get: async () => ({ docs: privateDocs }) }) };
  const privateRest = {
    get: async (url) => {
      if (url === `/channels/${PROFILE}`) {
        return { id: PROFILE, guild_id: GUILD, parent_id: FORUM, owner_id: OWNER, type: 12, name: 'Private' };
      }
      if (url === `/channels/${FORUM}`) return approvalForum();
      throw new Error(`unexpected URL ${url}`);
    },
  };
  const withheld = await runProjectsFlow(privateRest, privateDb, prepareProjectExports([
    projectDoc('project-1', projectData({ mediaThreadIds: [] })),
  ]).published, { out: '.', dryRun: false, publishTagId: PUBLISH_TAG }, { downloadAttachment: async () => ({ ext: 'webp', width: 1, height: 1 }) });
  assert.deepEqual(withheld.projects, []);
  assert.deepEqual(withheld.withheldProjectIds, ['project-1']);

  const wrongOwnerDocs = [threadDoc(PROFILE, { ownerId: '234567890123456789' })];
  const wrongOwnerDb = { collection: () => ({ get: async () => ({ docs: wrongOwnerDocs }) }) };
  await assert.rejects(
    runProjectsFlow(privateRest, wrongOwnerDb, prepareProjectExports([
      projectDoc('project-1', projectData({ mediaThreadIds: [] })),
    ]).published, { out: '.', dryRun: false, publishTagId: PUBLISH_TAG }),
    /owner/i,
  );
});

test('Project asset cleanup only touches the reserved generated namespace', async () => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'project-assets-'));
  const projectDir = path.join(out, 'public', 'assets', 'projects', 'test-game');
  const generatedDir = path.join(projectDir, '_discord-export');
  try {
    await fs.mkdir(generatedDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, 'manual.webp'), 'manual');
    await fs.writeFile(path.join(generatedDir, 'keep.webp'), 'keep');
    await fs.writeFile(path.join(generatedDir, 'stale.webp'), 'stale');

    await cleanProjectAssets(out, ['/assets/projects/test-game/_discord-export/keep.webp']);

    assert.equal(await fs.readFile(path.join(projectDir, 'manual.webp'), 'utf8'), 'manual');
    assert.deepEqual(await fs.readdir(generatedDir), ['keep.webp']);
  } finally {
    await fs.rm(out, { recursive: true, force: true });
  }
});

test('Project moderation withdrawal avoids media reads, reapproval restores export, and conflicting backlinks abort', async (t) => {
  const previousGuild = config.guildId;
  config.guildId = GUILD;
  t.after(() => { config.guildId = previousGuild; });
  const docs = [threadDoc(PROFILE, { publishOnProject: false })];
  const db = { collection: () => ({ get: async () => ({ docs }) }) };
  let approved = false;
  const calls = [];
  const rest = { async get(url) {
    calls.push(url);
    if (url === `/channels/${PROFILE}`) return {
      id: PROFILE, guild_id: GUILD, parent_id: FORUM, owner_id: OWNER, type: 11,
      applied_tags: approved ? [PUBLISH_TAG] : [], name: 'Game thread',
    };
    if (url === `/channels/${FORUM}`) return approvalForum();
    if (url === `/channels/${PROFILE}/messages/${PROFILE}`) return {
      author: { id: OWNER }, attachments: [{ filename: 'hero.png', url: 'https://cdn.discordapp.com/hero.png' }],
    };
    throw new Error(`Unexpected URL ${url}`);
  } };
  const prepared = prepareProjectExports([projectDoc('project-1', projectData({ mediaThreadIds: [] }))]).published;
  const withdrawn = await runProjectsFlow(rest, db, prepared, { out: '.', dryRun: false, publishTagId: PUBLISH_TAG });
  assert.deepEqual(withdrawn.withheldProjectIds, ['project-1']);
  assert.equal(calls.includes(`/channels/${PROFILE}/messages/${PROFILE}`), false);
  approved = true;
  const restored = await runProjectsFlow(rest, db, prepared, { out: '.', dryRun: true, publishTagId: PUBLISH_TAG });
  assert.equal(restored.projects.length, 1);

  const conflicting = [...docs, threadDoc(MEDIA, { purpose: 'feedback' })];
  const conflictDb = { collection: () => ({ get: async () => ({ docs: conflicting }) }) };
  await assert.rejects(
    runProjectsFlow(rest, conflictDb, prepared, { out: '.', dryRun: true, publishTagId: PUBLISH_TAG }),
    /exactly one registered source thread backlink/,
  );
});

test('Project hero uses the owners reply attachment when the first post has no image', async (t) => {
  const previousGuild = config.guildId;
  config.guildId = GUILD;
  t.after(() => { config.guildId = previousGuild; });
  const docs = [threadDoc(PROFILE, { publishOnProject: false })];
  const db = { collection: () => ({ get: async () => ({ docs }) }) };
  const rest = { async get(url) {
    if (url === `/channels/${PROFILE}`) return {
      id: PROFILE, guild_id: GUILD, parent_id: FORUM, owner_id: OWNER, type: 11, name: 'Game thread', applied_tags: [PUBLISH_TAG],
    };
    if (url === `/channels/${FORUM}`) return approvalForum();
    if (url === `/channels/${PROFILE}/messages/${PROFILE}`) return { author: { id: OWNER }, attachments: [] };
    if (url === `/channels/${PROFILE}/messages`) return Array.from({ length: 80 }, (_, index) => ({
      id: String(BigInt(PROFILE) + BigInt(index + 1)), author: { id: index === 0 ? '234567890123456789' : OWNER },
      attachments: index === 0 || index === 79
        ? [{ filename: 'game.png', url: `https://cdn.discordapp.com/image-${index}.png` }] : [],
    })).reverse();
    throw new Error(`Unexpected URL ${url}`);
  } };
  const downloads = [];
  const result = await runProjectsFlow(rest, db,
    prepareProjectExports([projectDoc('project-1', projectData({ mediaThreadIds: [] }))]).published,
    { out: '.', dryRun: false, publishTagId: PUBLISH_TAG },
    { downloadAttachment: async (url) => { downloads.push(url); return { ext: 'webp', width: 100, height: 100 }; } },
  );
  assert.deepEqual(downloads, ['https://cdn.discordapp.com/image-79.png']);
  assert.equal(result.projects[0].hero.src, '/assets/projects/test-game/_discord-export/hero.webp');
});
