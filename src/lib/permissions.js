// Mod-gating for restricted slash commands.
//
// A user is a mod if they have Manage Server, or hold the configured MOD_ROLE_ID role.
// Checked in the handler (not just via Discord's default_member_permissions) so the rule
// is enforced server-side regardless of how the command was invoked.

import { PermissionFlagsBits } from 'discord.js';
import { config } from '../config.js';

export function isMod(interaction) {
  const member = interaction.member;
  if (!member) return false;

  // Manage Server always qualifies.
  const perms = interaction.memberPermissions;
  if (perms && perms.has(PermissionFlagsBits.ManageGuild)) {
    return true;
  }

  // Configured mod role, if any.
  if (config.modRoleId && member.roles?.cache?.has?.(config.modRoleId)) {
    return true;
  }

  return false;
}
