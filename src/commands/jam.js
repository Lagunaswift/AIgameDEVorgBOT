import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import {
  finishLockedJamSubmissions,
  jamReviewQueue,
  jamStatus,
  lockQualifiedJamSubmissions,
  registerJam,
  setJamArchiveDisposition,
  setJamPhaseFromDiscord,
} from '../services/jams.js';
import { reconcileAllActiveJamEligibility } from '../services/jamEligibility.js';

const data = new SlashCommandBuilder()
  .setName('jam')
  .setDescription('Manage an AIGAMEDEV Jam.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageThreads)
  .addSubcommand((sub) => sub
    .setName('setup')
    .setDescription('Register this Discord thread as a Jam.')
    .addStringOption((option) => option.setName('submission_tag_id').setDescription('Discord tag ID used on game threads for Jam entry').setRequired(true))
    .addStringOption((option) => option.setName('submissions_forum_id').setDescription('Discord forum ID containing Jam submissions').setRequired(true))
    .addStringOption((option) => option.setName('active_tag_id').setDescription('Lifecycle tag ID for Active').setRequired(true))
    .addStringOption((option) => option.setName('voting_tag_id').setDescription('Lifecycle tag ID for Voting').setRequired(true))
    .addStringOption((option) => option.setName('finished_tag_id').setDescription('Lifecycle tag ID for Finished').setRequired(true))
    .addStringOption((option) => option.setName('title').setDescription('Public Jam title; defaults to this thread title').setRequired(false))
    .addStringOption((option) => option.setName('summary').setDescription('Short public Jam summary').setRequired(false)))
  .addSubcommand((sub) => sub
    .setName('phase')
    .setDescription('Move this registered Jam to its next Discord lifecycle phase.')
    .addStringOption((option) => option
      .setName('phase')
      .setDescription('Next Jam phase')
      .setRequired(true)
      .addChoices(
        { name: 'Active', value: 'active' },
        { name: 'Voting', value: 'voting' },
        { name: 'Finished', value: 'finished' },
      )))
  .addSubcommand((sub) => sub
    .setName('status')
    .setDescription('Show this Jam mirror and submission counts.'))
  .addSubcommand((sub) => sub
    .setName('review')
    .setDescription('Show which Jam entries are ready or blocked and why.'))
  .addSubcommand((sub) => sub
    .setName('archive')
    .setDescription('Control one finished Jam entry after its hosted Build changes.')
    .addStringOption((option) => option.setName('project_id').setDescription('Exact Project ID from the Jam review/status tools').setRequired(true))
    .addStringOption((option) => option.setName('visibility').setDescription('Finished Jam archive behavior').setRequired(true).addChoices(
      { name: 'Playable if Build remains public', value: 'playable' },
      { name: 'Keep result but show Build removed', value: 'tombstone' },
      { name: 'Suppress from public Jam archive', value: 'suppress' },
    )));

function currentJamThread(interaction) {
  const channel = interaction.channel;
  if (!channel?.isThread?.() || !channel.parentId) return null;
  return channel;
}

function compact(value, max = 28) {
  const text = String(value ?? '');
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function createJamCommand(services = {
  registerJam,
  setJamPhaseFromDiscord,
  lockQualifiedJamSubmissions,
  finishLockedJamSubmissions,
  setJamArchiveDisposition,
  jamStatus,
  jamReviewQueue,
  reconcileAllActiveJamEligibility,
}) {
  return {
    data,
    async execute(interaction) {
      await interaction.deferReply({ ephemeral: true });
      const thread = currentJamThread(interaction);
      if (!thread) {
        await interaction.editReply('Run this command inside the Discord thread that represents the Jam.');
        return;
      }

      const subcommand = interaction.options.getSubcommand();
      try {
        if (subcommand === 'setup') {
          const jam = await services.registerJam({
            jamId: thread.id,
            discordThreadId: thread.id,
            submissionTagId: interaction.options.getString('submission_tag_id', true),
            eventsForumId: thread.parentId,
            submissionsForumId: interaction.options.getString('submissions_forum_id', true),
            activeTagId: interaction.options.getString('active_tag_id', true),
            votingTagId: interaction.options.getString('voting_tag_id', true),
            finishedTagId: interaction.options.getString('finished_tag_id', true),
            title: interaction.options.getString('title') || thread.name,
            summary: interaction.options.getString('summary'),
          });
          await interaction.editReply(`Registered **${jam.title}**. Phase: **UPCOMING**. Discord lifecycle tags are now the phase authority; public entries still require Publish to site approval.`);
          return;
        }

        if (subcommand === 'phase') {
          const nextPhase = interaction.options.getString('phase', true);
          if (nextPhase === 'voting') await services.reconcileAllActiveJamEligibility(interaction.client);
          const jam = await services.setJamPhaseFromDiscord(thread, nextPhase);
          if (nextPhase === 'voting') {
            const results = await services.lockQualifiedJamSubmissions(thread.id);
            const locked = results.filter((item) => item.status === 'locked').length;
            const blocked = results.filter((item) => item.status === 'blocked').length;
            await interaction.editReply(`Discord Jam phase is now **VOTING**. Locked ${locked} qualified submission${locked === 1 ? '' : 's'}; ${blocked} blocked submission${blocked === 1 ? '' : 's'} need moderator review.`);
            return;
          }
          if (nextPhase === 'finished') {
            const finalized = await services.finishLockedJamSubmissions(thread.id);
            await interaction.editReply(`Discord Jam phase is now **FINISHED**. Finalized ${finalized} locked submission${finalized === 1 ? '' : 's'} for the archive.`);
            return;
          }
          await interaction.editReply(`Discord Jam phase is now **${jam.phase.toUpperCase()}**.`);
          return;
        }

        if (subcommand === 'review') {
          const review = await services.jamReviewQueue(thread.id);
          const lines = [
            `**${review.jam.title} review**`,
            `Ready: ${review.counts.ready} | Blocked: ${review.counts.blocked} | Locked: ${review.counts.locked} | Excluded: ${review.counts.excluded}`,
          ];
          const actionable = review.entries.filter((entry) => entry.status === 'blocked' || entry.status === 'ready').slice(0, 12);
          for (const entry of actionable) {
            const reason = entry.reasons.length ? entry.reasons.join(', ') : 'ready';
            lines.push(`• **${entry.status.toUpperCase()}** Project \`${compact(entry.projectId)}\` | Build \`${compact(entry.buildId)}\` | ${reason}`);
          }
          if (!actionable.length) lines.push('No submitted entries currently need review.');
          if (review.entries.length > actionable.length) lines.push(`Showing ${actionable.length} of ${review.entries.length} entries. Use /jam status for totals.`);
          await interaction.editReply(lines.join('\n'));
          return;
        }

        if (subcommand === 'archive') {
          const result = await services.setJamArchiveDisposition({
            jamId: thread.id,
            projectId: interaction.options.getString('project_id', true),
            disposition: interaction.options.getString('visibility', true),
            moderatorId: interaction.user.id,
          });
          const copy = {
            playable: 'The archive will keep the entry playable only while its exact Build remains public.',
            tombstone: 'The archive may keep the historical result but will not serve the removed Build.',
            suppress: 'The entry is suppressed from the public Jam archive.',
          }[result.disposition];
          await interaction.editReply(`Updated Project \`${result.projectId}\` archive disposition to **${result.disposition.toUpperCase()}**. ${copy}`);
          return;
        }

        const status = await services.jamStatus(thread.id);
        if (!status) {
          await interaction.editReply('This thread is not registered as a Jam yet. Use `/jam setup`.');
          return;
        }
        const { jam, discordConfig, counts } = status;
        await interaction.editReply([
          `**${jam.title}**`,
          `Phase: **${String(jam.phase).toUpperCase()}**`,
          `Discord lifecycle: ${discordConfig ? 'Configured' : 'Needs setup repair'}`,
          `Entries: ${counts.total}`,
          `Submitted: ${counts.submitted}`,
          `Locked for voting: ${counts.locked}`,
          `Finished archive entries: ${counts.finished}`,
          `Withdrawn: ${counts.withdrawn}`,
          `Disqualified: ${counts.disqualified}`,
          'Use `/jam review` for entry-level readiness and blockers.',
        ].join('\n'));
      } catch (error) {
        await interaction.editReply(`Jam action failed: ${error.message}`);
      }
    },
  };
}

export const commands = [createJamCommand()];
