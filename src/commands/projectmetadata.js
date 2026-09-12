import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { isMod } from '../lib/permissions.js';
import { normalizeJamId } from '../lib/publicMetadata.js';
import { assignThreadJam, getThread } from '../services/threads.js';

async function getCurrentThread(interaction) {
  const thread = await getThread(interaction.channelId);
  if (!thread) {
    await interaction.reply({
      content: 'Use this command inside a registered forum thread.',
      ephemeral: true,
    });
    return null;
  }
  return thread;
}

export const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('assignjam')
      .setDescription('(Mod) Assign this thread to a stable jam ID.')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addStringOption((option) =>
        option.setName('jam_id').setDescription('Stable jam ID (letters, numbers, _ and -)').setRequired(true),
      ),

    async execute(interaction) {
      if (!isMod(interaction)) {
        await interaction.reply({ content: 'This command is mods only.', ephemeral: true });
        return;
      }

      const jamId = normalizeJamId(interaction.options.getString('jam_id'));
      if (!jamId) {
        await interaction.reply({
          content: 'Jam ID must be 1–64 letters, numbers, hyphens, or underscores.',
          ephemeral: true,
        });
        return;
      }

      const thread = await getCurrentThread(interaction);
      if (!thread) return;
      await assignThreadJam(thread.threadId, jamId);
      await interaction.reply({ content: `Assigned jam ID \`${jamId}\` to this thread.`, ephemeral: true });
    },
  },
];
