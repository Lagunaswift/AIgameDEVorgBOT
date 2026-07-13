import { EmbedBuilder } from 'discord.js';
import { getDb } from '../firebase.js';
import { getEffectiveConfig } from './config.js';

function pointsRef() {
  return getDb().collection('points');
}

export async function applyRewardRoles({ guild, userId, cfg }) {
  const thresholds = cfg.rewardThresholds || [];
  if (thresholds.length === 0) return;

  let total;
  try {
    const snap = await pointsRef().where('commenterId', '==', userId).get();
    total = snap.size;
  } catch (err) {
    console.error('[rewards] failed to count points:', err.message);
    return;
  }

  let member;
  try {
    member = await guild.members.fetch(userId);
  } catch {
    return;
  }

  for (const { points, roleId, label } of thresholds) {
    if (total < points) continue;
    if (!roleId) continue;
    if (member.roles.cache.has(roleId)) continue;

    try {
      await member.roles.add(roleId, `Reached ${points} feedback points`);
      console.log(`[rewards] gave role ${roleId} to ${userId} (total ${total})`);
    } catch (err) {
      console.error(
        `[rewards] could not add role ${roleId} to ${userId} (check Manage Roles + role order):`,
        err.message,
      );
    }

    await notifyMilestone({ guild, member, points, total, label });
  }
}

async function notifyMilestone({ guild, member, points, total, label }) {
  try {
    const cfg = await getEffectiveConfig();
    if (!cfg.modFeedChannelId) return;

    const channel = await guild.client.channels.fetch(cfg.modFeedChannelId);
    if (!channel || !channel.isTextBased()) return;

    const milestone = label || `${points} points`;

    const embed = new EmbedBuilder()
      .setColor(0xFFD700)
      .setDescription(
        `<:ShowcaseBotReact:1521124760220729445> **Milestone Reached**\n\n` +
        `<@${member.id}> (${member.user.tag}) hit **${milestone}**!\n` +
        `Total points: **${total}**\n\n` +
        `_Action needed — check if they qualify for a reward._`,
      )
      .setTimestamp();

    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.error('[rewards] milestone notification failed:', err.message);
  }
}
