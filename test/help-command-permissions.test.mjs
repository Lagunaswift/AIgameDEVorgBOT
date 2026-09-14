import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { commands } from '../src/commands/help.js';

const help = commands.find((command) => command.data.name === 'help');
const posthelp = commands.find((command) => command.data.name === 'posthelp');

test('help is private and its current command reference fits Discord field limits', async () => {
  await help.execute({ reply: async (payload) => {
    assert.equal(payload.flags, MessageFlags.Ephemeral);
    const embed = payload.embeds[0].toJSON();
    assert.ok(embed.fields.every((field) => field.value.length <= 1024));
    assert.match(embed.fields[0].value, /\/mygame manage/);
    assert.match(embed.fields[0].value, /private reply/);
  } });
});

test('posthelp checks moderator permission before deferring or posting', async () => {
  for (const member of [null, { roles: { cache: { has: () => false } } }]) {
    let rejected = false;
    await posthelp.execute({ member, memberPermissions: { has: () => false },
      reply: async (payload) => { rejected = true; assert.equal(payload.flags, MessageFlags.Ephemeral); },
      deferReply: () => assert.fail('Unauthorised command must not defer'),
      channel: { send: () => assert.fail('Unauthorised command must not post') },
    });
    assert.equal(rejected, true);
  }
});

test('posthelp posts and pins only for an authorised invocation', async () => {
  const events = [];
  await posthelp.execute({ member: {}, memberPermissions: { has: () => true },
    deferReply: async (payload) => { assert.equal(payload.flags, MessageFlags.Ephemeral); events.push('defer'); },
    channel: { send: async (payload) => { assert.equal(payload.embeds.length, 1); events.push('send'); return { pin: async () => events.push('pin') }; } },
    editReply: async () => events.push('confirm'),
  });
  assert.deepEqual(events, ['defer', 'send', 'pin', 'confirm']);
});
