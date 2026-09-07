import assert from 'node:assert/strict';
import test from 'node:test';
import { MessageFlags } from 'discord.js';
import { commands } from '../src/commands/help.js';

test('/help lists the one-thread /mygame publish workflow', async () => {
  const help = commands.find((command) => command.data.name === 'help');
  let payload;
  await help.execute({ reply: async (value) => { payload = value; } });

  assert.equal(payload.flags, MessageFlags.Ephemeral);
  const text = payload.embeds[0].toJSON().fields[0].value;
  assert.match(text, /`\/mygame publish`/);
  assert.doesNotMatch(text, /`\/mygame link`/);
});
