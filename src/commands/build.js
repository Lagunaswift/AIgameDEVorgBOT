import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { hostedPlatformFlags } from '../lib/hostedFeatureFlags.js';
import { isMod } from '../lib/permissions.js';
import {
  disableHostedBuild,
  inspectHostedBuild,
  listOpenHostedBuildReports,
  resolveHostedBuildReport,
  restoreHostedBuild,
} from '../services/hostedBuildModeration.js';

export const data = new SlashCommandBuilder()
  .setName('build')
  .setDescription('(Mod) Inspect or moderate an AIGAMEDEV hosted browser Build.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((command) => command
    .setName('inspect')
    .setDescription('Show Build state, Project linkage, reports and Jam references.')
    .addStringOption((option) => option.setName('build_id').setDescription('Opaque Build ID').setRequired(true)))
  .addSubcommand((command) => command
    .setName('reports')
    .setDescription('Show open moderation reports for one Build.')
    .addStringOption((option) => option.setName('build_id').setDescription('Opaque Build ID').setRequired(true)))
  .addSubcommand((command) => command
    .setName('resolve-report')
    .setDescription('Resolve one private Hosted Build moderation report.')
    .addStringOption((option) => option.setName('report_id').setDescription('Report ID from the mod feed').setRequired(true))
    .addStringOption((option) => option.setName('resolution').setDescription('Private resolution note').setMaxLength(1000).setRequired(true)))
  .addSubcommand((command) => command
    .setName('disable')
    .setDescription('Disable a Build and revoke public runtime access.')
    .addStringOption((option) => option.setName('build_id').setDescription('Opaque Build ID').setRequired(true))
    .addStringOption((option) => option.setName('reason').setDescription('Private moderator reason').setMaxLength(500).setRequired(true)))
  .addSubcommand((command) => command
    .setName('restore')
    .setDescription('Restore a disabled Build to ready and run normal approval reconciliation.')
    .addStringOption((option) => option.setName('build_id').setDescription('Opaque Build ID').setRequired(true)));

function stateLines(result) {
  const build = result.build;
  const project = result.project;
  const openReports = result.reports.filter((report) => report.status === 'open').length;
  return [
    `Build: \`${build.buildId}\``,
    `Project: ${project ? `**${project.title ?? project.id}** (\`${project.id}\`)` : 'missing'}`,
    `Status: **${build.status}**`,
    `Runtime: **${build.runtimeState}**`,
    `Version: ${build.versionLabel ?? 'unknown'}`,
    `Owner: \`${build.ownerId ?? 'unknown'}\``,
    `Primary requested: ${result.buildState?.requestedBuildId === build.buildId ? 'yes' : 'no'}`,
    `Primary public: ${result.buildState?.publishedBuildId === build.buildId ? 'yes' : 'no'}`,
    `Jam references: **${result.jamSubmissions.length}**`,
    `Open reports: **${openReports}**`,
  ];
}

function reportLines(reports) {
  if (!reports.length) return ['No open reports for this Build.'];
  return reports.slice(0, 10).map((report, index) => {
    const details = String(report.details || '').replace(/\s+/g, ' ').slice(0, 240);
    return `${index + 1}. \`${report.id}\` · **${report.category ?? 'other'}** · reporter \`${report.reporterDiscordId ?? 'unknown'}\`\n${details}`;
  });
}

export async function execute(interaction) {
  if (!isMod(interaction)) {
    await interaction.reply({ content: 'This command is mods only.', ephemeral: true });
    return;
  }
  if (!hostedPlatformFlags().hostedBuildsEnabled) {
    await interaction.reply({ content: 'Hosted Build moderation is installed but not enabled yet.', ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === 'resolve-report') {
    const reportId = interaction.options.getString('report_id', true).trim();
    const resolution = interaction.options.getString('resolution', true);
    const result = await resolveHostedBuildReport({ reportId, moderatorId: interaction.user.id, resolution });
    if (result.status === 'missing') {
      await interaction.editReply('Report not found.');
      return;
    }
    if (result.status === 'state') {
      await interaction.editReply(`Report is already \`${result.reportStatus}\`.`);
      return;
    }
    if (result.status === 'resolution') {
      await interaction.editReply('Resolution note must be 1 to 1000 characters.');
      return;
    }
    await interaction.editReply(`Report \`${reportId}\` resolved for Build \`${result.buildId}\`.`);
    return;
  }

  const buildId = interaction.options.getString('build_id', true).trim();

  if (subcommand === 'inspect') {
    const result = await inspectHostedBuild(buildId);
    await interaction.editReply(result ? stateLines(result).join('\n') : 'Build not found.');
    return;
  }

  if (subcommand === 'reports') {
    const reports = await listOpenHostedBuildReports(buildId);
    if (reports === null) {
      await interaction.editReply('Build not found.');
      return;
    }
    await interaction.editReply(reportLines(reports).join('\n\n'));
    return;
  }

  if (subcommand === 'disable') {
    const reason = interaction.options.getString('reason', true);
    const result = await disableHostedBuild({ buildId, moderatorId: interaction.user.id, reason });
    if (result.status === 'blocked') {
      await interaction.editReply('Build is currently public, but the runtime provider is unavailable. No state was changed because public revocation could not be guaranteed.');
      return;
    }
    if (result.status === 'missing') {
      await interaction.editReply('Build not found.');
      return;
    }
    if (result.status === 'state') {
      await interaction.editReply(`Build cannot be disabled from status \`${result.buildStatus}\`.`);
      return;
    }
    await interaction.editReply(result.unchanged
      ? 'Build is already disabled.'
      : `Build \`${buildId}\` disabled${result.runtimeWasPublic ? ' and runtime access revoked' : ''}.`);
    return;
  }

  const result = await restoreHostedBuild({ buildId, moderatorId: interaction.user.id, rest: interaction.client.rest });
  if (result.status === 'missing') {
    await interaction.editReply('Build not found.');
    return;
  }
  if (result.status === 'state') {
    await interaction.editReply(`Build cannot be restored from status \`${result.buildStatus}\`.`);
    return;
  }
  const reconciliation = result.reconciliation;
  await interaction.editReply(
    `Build \`${buildId}\` restored to ready. Runtime reconciliation: **${reconciliation.status}**${reconciliation.reason ? ` (${reconciliation.reason})` : ''}.`,
  );
}
