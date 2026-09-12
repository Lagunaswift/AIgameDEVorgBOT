import assert from 'node:assert/strict';
import test from 'node:test';
import { PermissionFlagsBits } from 'discord.js';
process.env.GUILD_ID = '1051088980176805919';
const { execute, mayRunHostedModeratorCommand } = await import('../src/events/interactionCreate.js');
const guildId = process.env.GUILD_ID;
const permissions = { has: (permission) => permission === PermissionFlagsBits.ManageThreads };

test('hosted moderation requires the configured guild and actual ManageThreads permission', () => {
  assert.equal(mayRunHostedModeratorCommand({ guildId, memberPermissions: permissions }, guildId), true);
  for (const interaction of [null, {}, { guildId }, { guildId: '123456789012345678', memberPermissions: permissions }, { guildId, memberPermissions: { has: () => false } }, { guildId, memberPermissions: { has: () => { throw new Error('unknown permissions'); } } }]) {
    assert.equal(mayRunHostedModeratorCommand(interaction, guildId), false);
  }
  assert.equal(mayRunHostedModeratorCommand({ guildId, memberPermissions: permissions }, ''), false);
});

test('production router rejects both hosted moderator commands before calling their handlers', async () => {
  for (const commandName of ['jam', 'build']) {
    let called = false;
    const replies = [];
    await execute({ commandName, guildId, isChatInputCommand: () => true,
      client: { commands: new Map([[commandName, { execute: async () => { called = true; } }]]) },
      reply: async (value) => replies.push(value),
    });
    assert.equal(called, false);
    assert.equal(replies[0].ephemeral, true);
  }
});

test('production router permits an authorised moderator and preserves normal member commands', async () => {
  for (const commandName of ['jam', 'build', 'help']) {
    let called = false;
    await execute({ commandName, guildId, memberPermissions: commandName === 'help' ? undefined : permissions,
      isChatInputCommand: () => true,
      client: { commands: new Map([[commandName, { execute: async () => { called = true; } }]]) },
      reply: async () => assert.fail('should not deny'),
    });
    assert.equal(called, true);
  }
});
