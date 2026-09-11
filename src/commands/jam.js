import { ChannelType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { hostedPlatformFlags } from '../lib/hostedFeatureFlags.js';
import { isMod } from '../lib/permissions.js';
import { getJam, jamStatus, registerJam, setJamPhase } from '../services/jams.js';

const LIFECYCLE_PHASES = ['upcoming', 'active', 'voting', 'finished'];

export const data = new SlashCommandBuilder()
  .setName('jam')
  .setDescription('(Mod) Set up and manage the AIGAMEDEV Jam lifecycle.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((command) => command
    .setName('setup')
    .setDescription('Register a Jam thread and its exact submissions tag.')
    .addChannelOption((option) => option
      .setName('event_thread')
      .setDescription('The existing Jam thread in the Jam events forum.')
      .addChannelTypes(ChannelType.PublicThread)
      .setRequired(true))
    .addChannelOption((option) => option
      .setName('submissions_forum')
      .setDescription('The forum where the Jam-tagged game threads live.')
      .addChannelTypes(ChannelType.GuildForum, ChannelType.GuildMedia)
      .setRequired(true))
    .addStringOption((option) => option
      .setName('submission_tag')
      .setDescription('Exact Jam tag name or tag ID from the submissions forum.')
      .setRequired(true))
    .addStringOption((option) => option
      .setName('summary')
      .setDescription('Optional short Jam summary for the website operational record.')
      .setMaxLength(500)))
  .addSubcommand((command) => command
    .setName('phase')
    .setDescription('Move a registered Jam forward to its next lifecycle phase.')
    .addChannelOption((option) => option
      .setName('event_thread')
      .setDescription('The registered Jam thread.')
      .addChannelTypes(ChannelType.PublicThread)
      .setRequired(true))
    .addStringOption((option) => option
      .setName('phase')
      .setDescription('New phase.')
      .setRequired(true)
      .addChoices(
        { name: 'Active', value: 'active' },
        { name: 'Voting', value: 'voting' },
        { name: 'Finished', value: 'finished' },
      )))
  .addSubcommand((command) => command
    .setName('status')
    .setDescription('Show the registered Jam state and submission counts.')
    .addChannelOption((option) => option
      .setName('event_thread')
      .setDescription('The registered Jam thread.')
      .addChannelTypes(ChannelType.PublicThread)
      .setRequired(true)));

function exactTag(forum, input) {
  const tags = Array.isArray(forum?.availableTags) ? forum.availableTags : [];
  const text = String(input || '').trim();
  if (/^\d{17,20}$/.test(text)) return tags.find((tag) => tag.id === text) ?? null;
  const matches = tags.filter((tag) => String(tag.name || '').trim().toLowerCase() === text.toLowerCase());
  return matches.length === 1 ? matches[0] : null;
}

function lifecycleMap(forum) {
  const result = new Map();
  for (const tag of forum?.availableTags ?? []) {
    const name = String(tag.name || '').trim().toLowerCase();
    if (LIFECYCLE_PHASES.includes(name) && !result.has(name)) result.set(name, tag.id);
  }
  return result;
}

async function freshChannel(client, id) {
  try { return await client.channels.fetch(id, { force: true }); } catch { return null; }
}

async function applyLifecycleTag(thread, forum, phase) {
  const lifecycle = lifecycleMap(forum);
  const target = lifecycle.get(phase);
  if (!target) throw new Error(`The events forum needs an exact \`${phase}\` lifecycle tag first.`);
  const lifecycleIds = new Set(lifecycle.values());
  const existing = Array.isArray(thread.appliedTags) ? thread.appliedTags : [];
  const next = [...existing.filter((tagId) => !lifecycleIds.has(tagId)), target];
  await thread.setAppliedTags([...new Set(next)], `AIGAMEDEV Jam phase -> ${phase}`);
}

export async function execute(interaction) {
  if (!isMod(interaction)) {
    await interaction.reply({ content: 'This command is mods only.', ephemeral: true });
    return;
  }
  if (!hostedPlatformFlags().jamHostingEnabled) {
    await interaction.reply({ content: 'Hosted Jam management is installed but not enabled yet.', ephemeral: true });
    return;
  }

  const subcommand = interaction.options.getSubcommand();
  await interaction.deferReply({ ephemeral: true });

  if (subcommand === 'setup') {
    const eventThreadOption = interaction.options.getChannel('event_thread', true);
    const submissionsForumOption = interaction.options.getChannel('submissions_forum', true);
    const tagInput = interaction.options.getString('submission_tag', true);
    const summary = interaction.options.getString('summary');

    const eventThread = await freshChannel(interaction.client, eventThreadOption.id);
    const submissionsForum = await freshChannel(interaction.client, submissionsForumOption.id);
    if (!eventThread?.isThread?.() || !eventThread.parentId) {
      await interaction.editReply('The event thread could not be read as a Discord forum post.');
      return;
    }
    const eventsForum = await freshChannel(interaction.client, eventThread.parentId);
    if (![ChannelType.GuildForum, ChannelType.GuildMedia].includes(eventsForum?.type)) {
      await interaction.editReply('The event thread must belong to a forum or media channel.');
      return;
    }
    if (![ChannelType.GuildForum, ChannelType.GuildMedia].includes(submissionsForum?.type)) {
      await interaction.editReply('The submissions channel must be a forum or media channel.');
      return;
    }
    const submissionTag = exactTag(submissionsForum, tagInput);
    if (!submissionTag) {
      await interaction.editReply('I could not resolve exactly one submission tag. Paste its exact name or numeric tag ID.');
      return;
    }
    if (await getJam(eventThread.id)) {
      await interaction.editReply('This Jam thread is already registered. Use `/jam status` or `/jam phase`.');
      return;
    }

    try {
      await applyLifecycleTag(eventThread, eventsForum, 'upcoming');
      await registerJam({
        jamId: eventThread.id,
        discordThreadId: eventThread.id,
        submissionTagId: submissionTag.id,
        eventsForumId: eventsForum.id,
        submissionsForumId: submissionsForum.id,
        title: eventThread.name,
        summary,
        phase: 'upcoming',
      });
      await interaction.editReply(
        `Registered **${eventThread.name}**.\nPhase: **upcoming**\nSubmission tag: \`${submissionTag.name}\`\nSubmissions forum: <#${submissionsForum.id}>`,
      );
    } catch (error) {
      await interaction.editReply(`Jam setup failed: ${error.message}`);
    }
    return;
  }

  const eventThreadOption = interaction.options.getChannel('event_thread', true);
  const jam = await getJam(eventThreadOption.id);
  if (!jam) {
    await interaction.editReply('That thread is not a registered Hosted Builds V1 Jam.');
    return;
  }

  if (subcommand === 'phase') {
    const nextPhase = interaction.options.getString('phase', true);
    const eventThread = await freshChannel(interaction.client, jam.discordThreadId);
    const eventsForum = eventThread?.parentId ? await freshChannel(interaction.client, eventThread.parentId) : null;
    if (!eventThread?.isThread?.() || !eventsForum) {
      await interaction.editReply('The registered Jam thread or its events forum is unavailable.');
      return;
    }
    try {
      await applyLifecycleTag(eventThread, eventsForum, nextPhase);
      const result = await setJamPhase(jam.id, nextPhase);
      if (result.status === 'state') {
        await interaction.editReply(`Phase change rejected: **${result.from}** cannot move to **${result.to}**.`);
        return;
      }
      if (result.status !== 'ok') {
        await interaction.editReply(`Phase change failed: ${result.status}.`);
        return;
      }
      const extra = nextPhase === 'voting'
        ? `\nLocked ${result.locked} submitted entr${result.locked === 1 ? 'y' : 'ies'} to their exact Build.`
        : nextPhase === 'finished'
          ? `\nArchived ${result.finished} locked entr${result.finished === 1 ? 'y' : 'ies'} as finished submissions.`
          : '';
      await interaction.editReply(`**${jam.title}** is now **${nextPhase}**.${extra}`);
    } catch (error) {
      await interaction.editReply(`Phase change failed: ${error.message}`);
    }
    return;
  }

  const status = await jamStatus(jam.id);
  if (!status) {
    await interaction.editReply('Jam record not found.');
    return;
  }
  await interaction.editReply([
    `**${status.jam.title}**`,
    `Phase: **${status.jam.phase}**`,
    `Eligible Project threads: **${status.eligibleProjects}**`,
    `Submissions: **${status.submissions}**`,
    `Submitted: ${status.submitted} · Locked: ${status.locked} · Finished: ${status.finished}`,
    `Withdrawn: ${status.withdrawn} · Disqualified: ${status.disqualified}`,
  ].join('\n'));
}
