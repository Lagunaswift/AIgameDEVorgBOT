import { SlashCommandBuilder } from 'discord.js';
import { buildPostTemplate } from '../lib/communityTemplates.js';

export const data = new SlashCommandBuilder()
  .setName('posttemplate')
  .setDescription('Get a copyable Markdown template for a community post.')
  .addStringOption((option) =>
    option
      .setName('type')
      .setDescription('The kind of post you are preparing')
      .setRequired(true)
      .addChoices(
        { name: 'Build help', value: 'build_help' },
        { name: 'Playtest', value: 'playtest' },
        { name: 'Project update', value: 'project_update' },
      ),
  );

export async function execute(interaction) {
  const type = interaction.options.getString('type', true);
  await interaction.reply({ content: buildPostTemplate(type), ephemeral: true });
}
