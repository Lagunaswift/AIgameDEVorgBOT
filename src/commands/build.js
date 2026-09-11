import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { hostedPlatformFlags } from '../lib/hostedFeatureFlags.js';
import { isMod } from '../lib/permissions.js';
import { disableHostedBuild, inspectHostedBuild, restoreHostedBuild } from '../services/hostedBuildModeration.js';

export const data = new SlashCommandBuilder()
  .setName('build')
  .setDescription('(Mod) Inspect or moderate an AIGAMEDEV hosted browser Build.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((command) => command
    .setName('inspect')
    .setDescription('Show Build state, Project linkage and Jam references.')
    .addStringOption((option) => option.setName('build_id').setDescription('Opaque Build ID').setRequired(true)))
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
  ];
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
  const buildId = interaction.options.getString('build_id', true).trim();

  if (subcommand === 'inspect') {
    const result = await inspectHostedBuild(buildId);
    await interaction.editReply(result ? stateLines(result).join('\n') : 'Build not found.');
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
