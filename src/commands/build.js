import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { disableHostedBuild, restoreHostedBuild } from '../services/hostedBuilds.js';
import { listOpenBuildReports, resolveBuildReport } from '../services/buildReports.js';

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
    .addStringOption((option) => option.setName('build_id').setDescription('Opaque Build ID').setRequired(true)))
  .addSubcommand((sub) => sub
    .setName('reports')
    .setDescription('Show open hosted Build reports.'))
  .addSubcommand((sub) => sub
    .setName('resolve')
    .setDescription('Close a hosted Build report after review.')
    .addStringOption((option) => option.setName('report_id').setDescription('Build report ID').setRequired(true))
    .addStringOption((option) => option.setName('resolution').setDescription('Review result').setRequired(true).addChoices(
      { name: 'Resolved', value: 'resolved' },
      { name: 'Dismissed', value: 'dismissed' },
    ))
    .addStringOption((option) => option.setName('note').setDescription('Optional private resolution note').setRequired(false)));

function short(value, max = 44) {
  const text = String(value ?? '');
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function createBuildCommand(services = {
  disableHostedBuild,
  restoreHostedBuild,
  listOpenBuildReports,
  resolveBuildReport,
}) {
  return {
    data,
    async execute(interaction) {
      await interaction.deferReply({ ephemeral: true });
      const subcommand = interaction.options.getSubcommand();
      try {
        if (subcommand === 'disable') {
          const buildId = interaction.options.getString('build_id', true);
          const reason = interaction.options.getString('reason', true);
          const result = await services.disableHostedBuild({ buildId, reason, moderatorId: interaction.user.id });
          await interaction.editReply(`Disabled Build \`${result.buildId}\`. Public runtime access is revoked; the Project record is preserved.`);
          return;
        }
        if (subcommand === 'restore') {
          const buildId = interaction.options.getString('build_id', true);
          const result = await services.restoreHostedBuild({ buildId, moderatorId: interaction.user.id });
          await interaction.editReply(`Restored Build \`${result.buildId}\` to **READY / PRIVATE**. It is not automatically republished.`);
          return;
        }
        if (subcommand === 'reports') {
          const reports = await services.listOpenBuildReports();
          if (!reports.length) {
            await interaction.editReply('No open hosted Build reports.');
            return;
          }
          const lines = reports.slice(0, 10).map((report) =>
            `• \`${report.reportId}\` | **${short(report.category, 24)}** | build \`${short(report.buildId, 28)}\` | ${short(report.details || 'No details.', 90)}`,
          );
          await interaction.editReply(['**Open hosted Build reports**', ...lines, '', 'Use `/build resolve` after review, or `/build disable` first if public play must stop.'].join('\n'));
          return;
        }
        const reportId = interaction.options.getString('report_id', true);
        const resolution = interaction.options.getString('resolution', true);
        const note = interaction.options.getString('note');
        const result = await services.resolveBuildReport({ reportId, resolution, note, moderatorId: interaction.user.id });
        await interaction.editReply(`Report \`${result.reportId}\` marked **${result.status.toUpperCase()}** for Build \`${result.buildId}\`.`);
      } catch (error) {
        await interaction.editReply(`Build action failed: ${error.message}`);
      }
    },
  };
}

export const commands = [createBuildCommand()];
