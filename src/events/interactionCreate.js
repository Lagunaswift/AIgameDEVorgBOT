// Command router. Looks up the handler in the registry attached to the client and runs
// it, with a single try/catch so one failing command can't crash the process or leave the
// interaction hanging without a reply.

import { Events } from 'discord.js';

export const name = Events.InteractionCreate;
export const once = false;

export async function execute(interaction) {
  if (!interaction.isChatInputCommand()) return;

  const command = interaction.client.commands.get(interaction.commandName);
  if (!command) {
    console.warn(`[interaction] no handler for /${interaction.commandName}`);
    return;
  }

  try {
    await command.execute(interaction);
  } catch (err) {
    console.error(`[interaction] /${interaction.commandName} failed:`, err);
    const msg = 'Something went wrong running that command.';
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(msg);
      } else {
        await interaction.reply({ content: msg, ephemeral: true });
      }
    } catch {
      /* interaction may have expired; nothing more we can do */
    }
  }
}
