import assert from 'node:assert/strict';
import test from 'node:test';
import { createMyGameCommand } from '../src/commands/mygame.js';

const OWNER = '123456789012345678';
const THREAD = '345678901234567890';
const FORUM = '456789012345678901';
const GUILD = '567890123456789012';
const TAG = '678901234567890123';

function interaction({ status = null } = {}) {
  const deferred = [];
  const edits = [];
  return {
    channelId: THREAD,
    channel: {
      name: 'Moon Base', parent: { availableTags: [{ id: 'web', name: 'Web' }] }, appliedTags: ['web'],
      async fetchStarterMessage() { return { content: 'A **small** moon game.' }; },
    },
    client: { rest: {} },
    user: { id: OWNER, username: 'Maker', globalName: 'Maker Display' },
    member: { displayName: 'Maker Display' },
    options: { getSubcommand: () => 'publish', getString: () => status },
    deferReply: async (value) => deferred.push(value),
    editReply: async (value) => edits.push(value),
    deferred,
    edits,
  };
}

function thread(overrides = {}) {
  return { threadId: THREAD, ownerId: OWNER, forumId: FORUM, mode: 'showcase', projectId: null, ...overrides };
}

function services(overrides = {}) {
  return {
    getThread: async () => thread(),
    checkGameApproval: async () => ({ approved: true }),
    config: { guildId: GUILD, sitePublishTagId: TAG },
    setProjectPublication: async () => {},
    createAndPublishProjectForThread: async ({ input }) => ({ project: { title: input.title } }),
    ...overrides,
  };
}

test('/mygame registry exposes only publish', () => {
  const json = createMyGameCommand().data.toJSON();
  assert.deepEqual(json.options.map((option) => option.name), ['publish']);
});

test('a stale link interaction cannot turn into a publish request', async () => {
  const request = interaction();
  request.options.getSubcommand = () => 'link';
  await createMyGameCommand(services({
    getThread: () => assert.fail('retired command must stop before thread lookup'),
    setProjectPublication: () => assert.fail('retired command cannot publish'),
  })).execute(request);
  assert.match(request.edits.at(-1), /no longer supported/);
});

test('/mygame denies missing approval metadata, tag states, wrong owner, and wrong guild without writes', async () => {
  for (const { storedThread, approval } of [
    { storedThread: thread({ forumId: undefined }), approval: { approved: false } },
    { storedThread: thread(), approval: { approved: false, reason: 'not-approved' } },
    { storedThread: thread(), approval: { approved: false, reason: 'moderated-approval-tag-missing' } },
    { storedThread: thread(), approval: { approved: false, reason: 'thread-identity-mismatch' } },
    { storedThread: thread({ ownerId: '234567890123456789' }), approval: { approved: true } },
  ]) {
    let writes = 0;
    const request = interaction({ status: 'playable' });
    await createMyGameCommand(services({
      getThread: async () => storedThread,
      checkGameApproval: async () => approval,
      createAndPublishProjectForThread: async () => { writes += 1; },
      setProjectPublication: async () => { writes += 1; },
    })).execute(request);
    assert.equal(writes, 0);
    assert.match(request.edits.at(-1), /registered thread|moderator-only/);
  }
});

test('/mygame passes the stored forum and configured live-approval identifiers before creating', async () => {
  let approvalInput;
  let creation;
  const request = interaction({ status: 'playable' });
  await createMyGameCommand(services({
    checkGameApproval: async (_rest, value) => { approvalInput = value; return { approved: true }; },
    createAndPublishProjectForThread: async (value) => {
      creation = value;
      return { project: { title: value.input.title } };
    },
  })).execute(request);
  assert.deepEqual(approvalInput, { threadId: THREAD, ownerId: OWNER, forumId: FORUM, guildId: GUILD, publishTagId: TAG });
  assert.deepEqual(creation.input, {
    ownerId: OWNER, title: 'Moon Base', summary: 'A small moon game.', status: 'playable',
    projectUrl: null, platforms: ['web'], creatorName: 'Maker Display',
  });
  assert.match(request.edits.at(-1), /Created/);
});

test('/mygame republish is gated before the publication write', async () => {
  let writes = 0;
  const denied = interaction();
  await createMyGameCommand(services({
    getThread: async () => thread({ projectId: 'project-1' }),
    checkGameApproval: async () => ({ approved: false }),
    setProjectPublication: async (value) => { assert.equal(value.threadId, THREAD); writes += 1; },
  })).execute(denied);
  assert.equal(writes, 0);

  const approved = interaction();
  await createMyGameCommand(services({
    getThread: async () => thread({ projectId: 'project-1' }),
    setProjectPublication: async () => { writes += 1; },
  })).execute(approved);
  assert.equal(writes, 1);
  assert.match(approved.edits.at(-1), /queued for publication/);
});
