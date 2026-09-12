import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { disableHostedBuild, restoreHostedBuild } from '../services/hostedBuilds.js';

const data = new SlashCommandBuilder()
  .setName('build')
  .setDescription('Moderate an AIGAMEDEV hosted browser Build.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageThreads)
  .addSubcommand((sub) => sub
    .setName('disable')
    .setDescription('Immediately disable a hosted Build.')
    .addStringOption((option) => option.setName('build_id').setDescription('Opaque Build ID').setRequired(true))
    .addStringOption((option) => option.setName('reason').setDescription('Private moderation reason').setRequired(true)))
  .addSubcommand((sub) => sub
    .setName('restore')
    .setDescription('Restore a moderator-disabled Build to private ready state.')
    .addStringOption((option) => option.setName('build_id').setDescription('Opaque Build ID').setRequired(true)));

export function createBuildCommand(services = { disableHostedBuild, restoreHostedBuild }) {
  return {
    data,
    async execute(interaction) {
      await interaction.deferReply({ ephemeral: true });
      const subcommand = interaction.options.getSubcommand();
      const buildId = interaction.options.getString('build_id', true);
      try {
        if (subcommand === 'disable') {
          const reason = interaction.options.getString('reason', true);
          const result = await services.disableHostedBuild({ buildId, reason, moderatorId: interaction.user.id });
          await interaction.editReply(`Disabled Build \`${result.buildId}\`. Public runtime access is revoked; the Project record is preserved.`);
          return;
        }
        const result = await services.restoreHostedBuild({ buildId, moderatorId: interaction.user.id });
        await interaction.editReply(`Restored Build \`${result.buildId}\` to **READY / PRIVATE**. It is not automatically republished.`);
      } catch (error) {
        await interaction.editReply(`Build action failed: ${error.message}`);
      }
    },
  };
}

export const commands = [createBuildCommand()];
