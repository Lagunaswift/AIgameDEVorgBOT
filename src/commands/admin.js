// Mod-only admin commands: /points adjust and /registerforum.
//
// This file exports a `commands` array (multiple command definitions), which the loader
// in index.js handles alongside single-command files. Both are gated by isMod() in the
// handler, not just by default_member_permissions, so the rule holds server-side.

import { SlashCommandBuilder, ChannelType, PermissionFlagsBits } from 'discord.js';
import { isMod } from '../lib/permissions.js';
import { adjustPoints } from '../services/scoring.js';
import { registerForum } from '../services/config.js';
import { getDb, serverTimestamp } from '../firebase.js';

// ---- /points adjust <user> <amount> <reason> -------------------------------------

const pointsCommand = {
  data: new SlashCommandBuilder()
    .setName('points')
    .setDescription('(Mod) Manually adjust feedback points.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub
        .setName('adjust')
        .setDescription('Manually add or remove points for a user (writes an audit record).')
        .addUserOption((o) =>
          o.setName('user').setDescription('User to adjust').setRequired(true),
        )
        .addIntegerOption((o) =>
          o
            .setName('amount')
            .setDescription('Points to add (positive) or remove (negative)')
            .setRequired(true),
        )
        .addStringOption((o) =>
          o.setName('reason').setDescription('Reason for the adjustment').setRequired(true),
        ),
    ),

  async execute(interaction) {
    if (!isMod(interaction)) {
      await interaction.reply({ content: 'This command is mods only.', ephemeral: true });
      return;
    }
    const sub = interaction.options.getSubcommand();
    if (sub !== 'adjust') {
      await interaction.reply({ content: 'Unknown subcommand.', ephemeral: true });
      return;
    }

    const user = interaction.options.getUser('user');
    const amount = interaction.options.getInteger('amount');
    const reason = interaction.options.getString('reason');

    if (amount === 0) {
      await interaction.reply({ content: 'Amount must be non-zero.', ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    const res = await adjustPoints({
      targetUserId: user.id,
      targetTag: user.tag,
      amount,
      reason,
      modId: interaction.user.id,
      modTag: interaction.user.tag,
    });

    const verb = amount > 0 ? 'added' : 'removed';
    await interaction.editReply(
      `✅ ${verb} ${Math.abs(res.applied)} point(s) for ${user.tag}.\nReason: ${reason}\nAudit id: \`${res.auditId}\``,
    );
  },
};

// ---- /registerforum <channel> <mode> ---------------------------------------------

const registerForumCommand = {
  data: new SlashCommandBuilder()
    .setName('registerforum')
    .setDescription('(Mod) Add a forum channel to the watched list with a mode.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption((o) =>
      o
        .setName('channel')
        .setDescription('The forum channel to watch')
        .addChannelTypes(ChannelType.GuildForum)
        .setRequired(true),
    )
    .addStringOption((o) =>
      o
        .setName('mode')
        .setDescription('How to treat threads in this forum')
        .setRequired(true)
        .addChoices(
          { name: 'Showcase (feedback scoring)', value: 'showcase' },
          { name: 'Competition (entries, vote via Poll)', value: 'competition' },
        ),
    ),

  async execute(interaction) {
    if (!isMod(interaction)) {
      await interaction.reply({ content: 'This command is mods only.', ephemeral: true });
      return;
    }

    const channel = interaction.options.getChannel('channel');
    const mode = interaction.options.getString('mode');

    await interaction.deferReply({ ephemeral: true });

    const { added } = await registerForum(channel.id, mode);
    if (added) {
      await interaction.editReply(
        `✅ Now watching <#${channel.id}> as a **${mode}** forum.`,
      );
    } else {
      await interaction.editReply(
        `<#${channel.id}> is already watched as **${mode}**.`,
      );
    }
  },
};

// ---- /seedusers -----------------------------------------------------------------

const seedUsersCommand = {
  data: new SlashCommandBuilder()
    .setName('seedusers')
    .setDescription('(Mod) Scan recent messages across the server to pre-populate known users.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    if (!isMod(interaction)) {
      await interaction.reply({ content: 'This command is mods only.', ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    const guild = interaction.guild;
    const db = getDb();
    const seenRef = db.collection('seenUsers');
    const seen = new Set();

    const channels = await guild.channels.fetch();
    let scanned = 0;

    for (const [, channel] of channels) {
      if (!channel) continue;
      if (!channel.isTextBased()) continue;
      if (channel.isThread()) continue;

      try {
        const messages = await channel.messages.fetch({ limit: 100 });
        for (const msg of messages.values()) {
          if (msg.author.bot) continue;
          if (seen.has(msg.author.id)) continue;
          seen.add(msg.author.id);
        }
        scanned += 1;
      } catch {
        // No access to this channel; skip.
      }
    }

    // Also scan threads in forum channels
    for (const [, channel] of channels) {
      if (!channel) continue;
      if (channel.type !== ChannelType.GuildForum) continue;

      try {
        const active = await channel.threads.fetchActive();
        for (const [, thread] of active.threads) {
          try {
            const messages = await thread.messages.fetch({ limit: 100 });
            for (const msg of messages.values()) {
              if (msg.author.bot) continue;
              if (seen.has(msg.author.id)) continue;
              seen.add(msg.author.id);
            }
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    }

    // Batch write to Firestore (max 500 per batch)
    const userIds = [...seen];
    let count = 0;
    for (let i = 0; i < userIds.length; i += 400) {
      const chunk = userIds.slice(i, i + 400);
      const batch = db.batch();
      for (const userId of chunk) {
        batch.set(
          seenRef.doc(userId),
          { userId, seenAt: serverTimestamp(), source: 'seed' },
          { merge: true },
        );
      }
      await batch.commit();
      count += chunk.length;
    }

    await interaction.editReply(
      `✅ Seeded **${count}** users from **${scanned}** channels. Only genuinely new posters will trigger notifications now.`,
    );
  },
};

export const commands = [pointsCommand, registerForumCommand, seedUsersCommand];
