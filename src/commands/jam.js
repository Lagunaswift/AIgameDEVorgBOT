import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { jamStatus, lockQualifiedJamSubmissions, registerJam, setJamPhase } from '../services/jams.js';

const data = new SlashCommandBuilder()
  .setName('jam')
  .setDescription('Manage an AIGAMEDEV Jam.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageThreads)
  .addSubcommand((sub) => sub
    .setName('setup')
    .setDescription('Register this Discord thread as a Jam.')
    .addStringOption((option) => option.setName('submission_tag_id').setDescription('Discord tag ID used for Jam entries').setRequired(true))
    .addStringOption((option) => option.setName('submissions_forum_id').setDescription('Discord forum ID containing Jam submissions').setRequired(true))
    .addStringOption((option) => option.setName('title').setDescription('Public Jam title; defaults to this thread title').setRequired(false))
    .addStringOption((option) => option.setName('summary').setDescription('Short public Jam summary').setRequired(false)))
  .addSubcommand((sub) => sub
    .setName('phase')
    .setDescription('Move this registered Jam to its next phase.')
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
    .setDescription('Show this Jam mirror and submission counts.'));

function currentJamThread(interaction) {
  const channel = interaction.channel;
  if (!channel?.isThread?.() || !channel.parentId) return null;
  return channel;
}

export function createJamCommand(services = { registerJam, setJamPhase, lockQualifiedJamSubmissions, jamStatus }) {
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
            title: interaction.options.getString('title') || thread.name,
            summary: interaction.options.getString('summary'),
          });
          await interaction.editReply(`Registered **${jam.title}**. Phase: **UPCOMING**. No public Jam entries bypass the Publish to site moderation gate.`);
          return;
        }

        if (subcommand === 'phase') {
          const nextPhase = interaction.options.getString('phase', true);
          const jam = await services.setJamPhase(thread.id, nextPhase);
          if (nextPhase === 'voting') {
            const results = await services.lockQualifiedJamSubmissions(thread.id);
            const locked = results.filter((item) => item.status === 'locked').length;
            const blocked = results.filter((item) => item.status === 'blocked').length;
            await interaction.editReply(`Jam moved to **VOTING**. Locked ${locked} qualified submission${locked === 1 ? '' : 's'}; ${blocked} blocked submission${blocked === 1 ? '' : 's'} need moderator review.`);
            return;
          }
          await interaction.editReply(`Jam moved to **${jam.phase.toUpperCase()}**.`);
          return;
        }

        const status = await services.jamStatus(thread.id);
        if (!status) {
          await interaction.editReply('This thread is not registered as a Jam yet. Use `/jam setup`.');
          return;
        }
        const { jam, counts } = status;
        await interaction.editReply([
          `**${jam.title}**`,
          `Phase: **${String(jam.phase).toUpperCase()}**`,
          `Entries: ${counts.total}`,
          `Submitted: ${counts.submitted}`,
          `Locked for voting: ${counts.locked}`,
          `Withdrawn: ${counts.withdrawn}`,
          `Disqualified: ${counts.disqualified}`,
        ].join('\n'));
      } catch (error) {
        await interaction.editReply(`Jam action failed: ${error.message}`);
      }
    },
  };
}

export const commands = [createJamCommand()];
