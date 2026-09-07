import assert from 'node:assert/strict';
import test from 'node:test';
import { ChannelType, PermissionsBitField, PermissionFlagsBits } from 'discord.js';
import { collectTranscript } from '../src/services/chatSummary.js';

const guildId = 'guild';
const window = {
  start: new Date('2026-09-05T00:00:00Z'),
  end: new Date('2026-09-06T00:00:00Z'),
  guildId,
};

function batch(messages) {
  return {
    size: messages.length,
    values: () => messages.values(),
    last: () => messages.at(-1),
  };
}

function message(id = 'message') {
  return {
    id,
    createdTimestamp: new Date('2026-09-05T12:00:00Z').getTime(),
    cleanContent: 'A public game update.',
    author: { bot: false, username: 'Maker' },
  };
}

function oldMessage() {
  return { ...message('old-message'), createdTimestamp: window.start.getTime() - 1 };
}

function makeClient({
  allow = true,
  channelId = 'source',
  channelGuildId = guildId,
  guildObjectId = guildId,
  nsfw = false,
  type = ChannelType.GuildText,
  omitGuild = false,
  fetchError,
  roleError,
  permissionsError,
  adminOnly = false,
  historyAllowed = true,
  states,
}) {
  let channelFetches = 0;
  let messageFetches = 0;
  const channelOptions = [];
  const roleOptions = [];
  const role = { id: guildId, guild: { id: guildId } };
  const channel = {
    id: channelId,
    guildId: channelGuildId,
    nsfw,
    type,
    name: 'general',
    guild: {
      id: guildObjectId,
      roles: {
        async fetch(id, options) {
          roleOptions.push({ id, options });
          if (roleError) throw roleError;
          return role;
        },
      },
    },
    permissionsFor(_role, checkAdmin = true) {
      if (permissionsError) throw permissionsError;
      if (adminOnly) return new PermissionsBitField(checkAdmin ? PermissionsBitField.All : PermissionFlagsBits.Administrator);
      const enabled = states ? states[Math.min(channelFetches - 1, states.length - 1)] : allow;
      return {
        has(permission, checkAdmin) {
          assert.equal(checkAdmin, false, 'Administrator must not satisfy public visibility');
          if (permission === PermissionFlagsBits.ReadMessageHistory && !historyAllowed) return false;
          return enabled;
        },
      };
    },
    messages: {
      async fetch() {
        messageFetches++;
        return batch([message(), oldMessage()]);
      },
    },
  };
  if (omitGuild) channel.guild = null;

  return {
    client: {
      channels: {
        async fetch(id, options) {
          channelFetches++;
          channelOptions.push({ id, options });
          if (fetchError) throw fetchError;
          return channel;
        },
      },
    },
    counts: () => ({ channelFetches, messageFetches, channelOptions, roleOptions }),
  };
}

test('collectTranscript makes no message calls for blocked sources', async () => {
  const mock = makeClient({ allow: false });
  const result = await collectTranscript(mock.client, ['source'], window);

  assert.equal(mock.counts().messageFetches, 0);
  assert.equal(result.messageCount, 0);
  assert.equal(result.channelsRead, 0);
});

test('collectTranscript rejects Administrator-only and missing history visibility', async () => {
  for (const options of [{ adminOnly: true }, { historyAllowed: false }]) {
    const mock = makeClient(options);
    const result = await collectTranscript(mock.client, ['source'], window);
    assert.equal(mock.counts().messageFetches, 0);
    assert.equal(result.transcript, '');
  }
});

test('collectTranscript preserves other public sources on permission calculation failure', async () => {
  const broken = makeClient({ channelId: 'broken', permissionsError: new Error('unavailable permission metadata') });
  const allowed = makeClient({ channelId: 'allowed' });
  const client = { channels: { fetch: (id, options) =>
    (id === 'broken' ? broken : allowed).client.channels.fetch(id, options) } };
  const result = await collectTranscript(client, ['broken', 'allowed'], window);
  assert.equal(broken.counts().messageFetches, 0);
  assert.equal(result.channelsRead, 1);
});

test('collectTranscript preserves public sources when another configured source is blocked', async () => {
  const blocked = makeClient({ channelId: 'blocked', allow: false });
  const allowed = makeClient({ channelId: 'allowed', allow: true });
  const client = {
    channels: {
      fetch(id, options) {
        return id === 'blocked'
          ? blocked.client.channels.fetch(id, options)
          : allowed.client.channels.fetch(id, options);
      },
    },
  };
  const result = await collectTranscript(client, ['blocked', 'allowed'], window);

  assert.equal(blocked.counts().messageFetches, 0);
  assert.equal(allowed.counts().messageFetches, 1);
  assert.equal(result.messageCount, 1);
  assert.equal(result.channelsRead, 1);
});

test('collectTranscript reads an explicitly public guild text channel', async () => {
  const mock = makeClient({ allow: true });
  const result = await collectTranscript(mock.client, ['source'], window);

  assert.equal(mock.counts().messageFetches, 1);
  assert.equal(result.messageCount, 1);
  assert.equal(result.channelsRead, 1);
  assert.match(result.transcript, /public game update/);
});

test('collectTranscript bypasses stale channel and role caches', async () => {
  const mock = makeClient({ allow: true });
  await collectTranscript(mock.client, ['source'], window);

  for (const call of mock.counts().channelOptions) assert.deepEqual(call.options, { force: true });
  for (const call of mock.counts().roleOptions) {
    assert.equal(call.id, guildId);
    assert.deepEqual(call.options, { force: true });
  }
});

test('collectTranscript discards a source that loses public visibility mid-collection', async () => {
  const mock = makeClient({ states: [true, true, false] });
  const result = await collectTranscript(mock.client, ['source'], window);

  assert.equal(mock.counts().messageFetches, 1);
  assert.equal(result.messageCount, 0);
  assert.equal(result.channelsRead, 0);
});

test('collectTranscript handles channel and role lookup failures before message reads', async () => {
  for (const options of [{ fetchError: new Error('missing') }, { roleError: new Error('forbidden') }]) {
    const mock = makeClient(options);
    const result = await collectTranscript(mock.client, ['source'], window);
    assert.equal(mock.counts().messageFetches, 0);
    assert.equal(result.messageCount, 0);
  }
});

test('collectTranscript rejects channel and guild identity mismatches before message reads', async () => {
  for (const options of [
    { channelId: 'other-channel' },
    { channelGuildId: 'other-guild' },
    { guildObjectId: 'other-guild' },
  ]) {
    const mock = makeClient(options);
    const result = await collectTranscript(mock.client, ['source'], window);
    assert.equal(mock.counts().messageFetches, 0);
    assert.equal(result.messageCount, 0);
  }
});

test('collectTranscript rejects missing, NSFW, DM, voice, forum, and thread metadata before message reads', async () => {
  for (const options of [
    { omitGuild: true },
    { nsfw: true },
    { type: ChannelType.DM },
    { type: ChannelType.GuildVoice },
    { type: ChannelType.GuildForum },
    { type: ChannelType.PublicThread },
  ]) {
    const mock = makeClient(options);
    const result = await collectTranscript(mock.client, ['source'], window);
    assert.equal(mock.counts().messageFetches, 0);
    assert.equal(result.messageCount, 0);
  }
});
