import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { buildCommunityNoteChecklist } from '../lib/communityTemplates.js';
import { isMod } from '../lib/permissions.js';
import { getThread } from '../services/threads.js';

export const data = new SlashCommandBuilder()
  .setName('communitynote')
  .setDescription('(Mod) Community-note curation tools.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((subcommand) =>
    subcommand
      .setName('nominate')
      .setDescription('Show the manual consent-first community-note checklist.'),
  );

export async function execute(interaction) {
  if (!isMod(interaction)) {
    await interaction.reply({ content: 'This command is mods only.', ephemeral: true });
    return;
  }

  if (interaction.options.getSubcommand() !== 'nominate') {
    await interaction.reply({ content: 'Unknown subcommand.', ephemeral: true });
    return;
  }

  if (!interaction.channel?.isThread?.() || !(await getThread(interaction.channelId))) {
    await interaction.reply({
      content: 'Use this command inside a registered forum thread.',
      ephemeral: true,
    });
    return;
  }

  await interaction.reply({ content: buildCommunityNoteChecklist(), ephemeral: true });
}
