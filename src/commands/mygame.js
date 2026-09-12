import { SlashCommandBuilder } from 'discord.js';
import { config } from '../config.js';
import { checkGameApproval } from '../lib/gameApproval.js';
import { PROJECT_STATUSES } from '../lib/projectValidation.js';
import { platformsFromTagNames } from '../services/migration.js';
import { createAndPublishProjectForThread, setProjectPublication } from '../services/projects.js';
import { getThread } from '../services/threads.js';
import { extractText } from '../../scripts/site-export-shared.mjs';

const DEFAULT_SITE_ORIGIN = 'https://www.aigamedevs.org';

const data = new SlashCommandBuilder()
  .setName('mygame')
  .setDescription('Publish or manage the Project linked to this game thread.')
  .addSubcommand((subcommand) => subcommand
    .setName('publish')
    .setDescription('Publish the Project for this approved game thread.')
    .addStringOption((option) => option
      .setName('status')
      .setDescription('Required only when creating a new Project from this thread')
      .setRequired(false)
      .addChoices(...PROJECT_STATUSES.map((value) => ({ name: value, value })))),
  )
  .addSubcommand((subcommand) => subcommand
    .setName('manage')
    .setDescription('Open the website tools for this thread\'s existing Project.'));

function errorMessage(error) {
  if (/Registered thread not found|Only the thread owner/.test(error.message)) return 'Use this command inside a registered thread that you own.';
  if (/Project not found|Only the project owner/.test(error.message)) return 'That Project is no longer available to you.';
  if (/source thread|backlink|already linked/.test(error.message)) return 'This Project is not correctly associated with this game thread.';
  if (/slug collision/.test(error.message)) return 'That title is already in use and no unique URL could be reserved. Rename the thread and try again.';
  return null;
}

async function getOwnedThread(interaction, services) {
  const thread = await services.getThread(interaction.channelId);
  if (!thread || thread.threadId !== interaction.channelId || thread.ownerId !== interaction.user.id) {
    await interaction.editReply('Use this command inside a registered thread that you own.');
    return null;
  }
  return thread;
}

function platformsFromAppliedTags(channel) {
  const tags = channel.parent?.availableTags;
  if (!tags || !Array.isArray(channel.appliedTags)) return [];
  return platformsFromTagNames(channel.appliedTags
    .map((tagId) => tags.find((tag) => tag.id === tagId)?.name)
    .filter((name) => typeof name === 'string')).platforms;
}

function managementUrl(projectId, siteOrigin) {
  const origin = new URL(siteOrigin || DEFAULT_SITE_ORIGIN);
  if (origin.protocol !== 'https:') throw new Error('SITE_ORIGIN must use HTTPS');
  return new URL(`/manage/projects/${encodeURIComponent(projectId)}/`, origin).href;
}

async function createPublishInput(interaction, thread, status) {
  if (!status) throw new Error('status is required');
  let starter;
  try { starter = await interaction.channel.fetchStarterMessage(); } catch { throw new Error('starter message unavailable'); }
  const summary = extractText(starter, 280);
  if (!summary) throw new Error('starter message has no usable text');
  return {
    ownerId: interaction.user.id,
    title: interaction.channel.name,
    summary,
    status,
    projectUrl: thread.projectUrl ?? null,
    platforms: platformsFromAppliedTags(interaction.channel),
    creatorName: interaction.member?.displayName || interaction.user.globalName || interaction.user.username,
  };
}

async function isApprovedShowcaseThread(interaction, thread, services) {
  if (thread.mode !== 'showcase') return false;
  const approval = await services.checkGameApproval(interaction.client?.rest, {
    threadId: interaction.channelId,
    ownerId: interaction.user.id,
    forumId: thread.forumId,
    guildId: services.config.guildId,
    publishTagId: services.config.sitePublishTagId,
  });
  return approval.approved;
}

export function createMyGameCommand(services = {
  getThread, setProjectPublication, createAndPublishProjectForThread, checkGameApproval, config,
  siteOrigin: process.env.SITE_ORIGIN || DEFAULT_SITE_ORIGIN,
}) {
  return {
    data,
    async execute(interaction) {
      await interaction.deferReply({ ephemeral: true });
      const subcommand = interaction.options.getSubcommand();
      if (!['publish', 'manage'].includes(subcommand)) {
        await interaction.editReply('That command is no longer supported. Keep updates in the game\'s existing thread and use /mygame publish or /mygame manage there.');
        return;
      }

      const thread = await getOwnedThread(interaction, services);
      if (!thread) return;

      if (subcommand === 'manage') {
        if (!thread.projectId) {
          await interaction.editReply('This thread does not have a Project yet. Use `/mygame publish` after moderator approval to create it.');
          return;
        }
        try {
          await interaction.editReply(`Manage your Project on AIGAMEDEV:\n${managementUrl(thread.projectId, services.siteOrigin || DEFAULT_SITE_ORIGIN)}`);
        } catch {
          await interaction.editReply('The AIGAMEDEV management link is temporarily unavailable.');
        }
        return;
      }

      if (!await isApprovedShowcaseThread(interaction, thread, services)) {
        await interaction.editReply('This registered Showcase thread needs the moderator-only Publish to site tag before it can be published.');
        return;
      }

      if (thread.projectId != null) {
        try {
          await services.setProjectPublication({ projectId: thread.projectId, threadId: interaction.channelId, actorId: interaction.user.id, publishToSite: true });
          await interaction.editReply('Your linked Project is queued for publication. Exports run every six hours; delayed or failed runs take longer.');
        } catch (error) {
          const message = errorMessage(error);
          if (!message) throw error;
          await interaction.editReply(message);
        }
        return;
      }

      const status = interaction.options.getString('status');
      if (!status) {
        await interaction.editReply('Choose a status to create and publish a new Project from this thread.');
        return;
      }
      try {
        const input = await createPublishInput(interaction, thread, status);
        const { project } = await services.createAndPublishProjectForThread({ threadId: interaction.channelId, actorId: interaction.user.id, input });
        await interaction.editReply(`Created **${project.title}** and queued it for publication. Exports run every six hours; delayed or failed runs take longer.`);
      } catch (error) {
        if (/starter message has no usable text|starter message unavailable/.test(error.message)) {
          await interaction.editReply('This thread needs a starter message with text before it can become a Project.');
          return;
        }
        const message = errorMessage(error);
        if (!message) throw error;
        await interaction.editReply(message);
      }
    },
  };
}

export const commands = [createMyGameCommand()];