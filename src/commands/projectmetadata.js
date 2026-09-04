import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { isMod } from '../lib/permissions.js';
import { normalizeJamId, normalizeProjectUrl } from '../lib/publicMetadata.js';
import { assignThreadJam, getThread, setThreadProjectUrl } from '../services/threads.js';

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
      .setName('projecturl')
      .setDescription('Owner: save playable URL metadata for this registered thread.')
      .addStringOption((option) =>
        option.setName('url').setDescription('An http(s) playable project URL').setRequired(true),
      ),

    async execute(interaction) {
      const projectUrl = normalizeProjectUrl(interaction.options.getString('url'));
      if (!projectUrl) {
        await interaction.reply({
          content: 'Please provide a valid http:// or https:// URL.',
          ephemeral: true,
        });
        return;
      }

      const thread = await getCurrentThread(interaction);
      if (!thread) return;
      if (thread.ownerId !== interaction.user.id) {
        await interaction.reply({
          content: 'Only this registered thread’s owner can set its playable URL.',
          ephemeral: true,
        });
        return;
      }

      await setThreadProjectUrl(thread.threadId, projectUrl);
      await interaction.reply({
        content: 'Playable URL metadata saved for this registered thread. This does not publish or create a Project/page; only the **Publish to site** tag controls site publication.',
        ephemeral: true,
      });
    },
  },
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
