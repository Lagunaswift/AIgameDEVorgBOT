// Mod-only admin commands: /points adjust and /registerforum.
//
// This file exports a `commands` array (multiple command definitions), which the loader
// in index.js handles alongside single-command files. Both are gated by isMod() in the
// handler, not just by default_member_permissions, so the rule holds server-side.

import { SlashCommandBuilder, ChannelType, PermissionFlagsBits } from 'discord.js';
import { isMod } from '../lib/permissions.js';
import { adjustPoints } from '../services/scoring.js';
import { registerForum } from '../services/config.js';

// ---- /points adjust <user> <amount> <reason> -------------------------------------

const pointsCommand = {
  data: new SlashCommandBuilder()
    .setName('points')
    .setDescription('(Mod) Manage feedback points.')
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

export const commands = [pointsCommand, registerForumCommand];
