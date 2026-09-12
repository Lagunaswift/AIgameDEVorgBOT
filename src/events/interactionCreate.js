// Command router. Looks up the handler in the registry attached to the client and runs
// it, with a single try/catch so one failing command can't crash the process or leave the
// interaction hanging without a reply.

import { Events, PermissionFlagsBits } from 'discord.js';
import { config } from '../config.js';

export const name = Events.InteractionCreate;
export const once = false;

const HOSTED_MODERATOR_COMMANDS = new Set(['jam', 'build']);

export function mayRunHostedModeratorCommand(interaction, expectedGuildId = config.guildId) {
  try {
    return typeof expectedGuildId === 'string' && /^\d{17,20}$/.test(expectedGuildId)
      && interaction?.guildId === expectedGuildId
      && interaction?.memberPermissions?.has(PermissionFlagsBits.ManageThreads) === true;
  } catch { return false; }
}

export async function execute(interaction) {
  if (!interaction.isChatInputCommand()) return;

  // Slash-command visibility settings are not a substitute for server-side authority.
  if (HOSTED_MODERATOR_COMMANDS.has(interaction.commandName) && !mayRunHostedModeratorCommand(interaction)) {
    await interaction.reply({ content: 'This action requires an authorised AIGAMEDEV moderator.', ephemeral: true });
    return;
  }

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
