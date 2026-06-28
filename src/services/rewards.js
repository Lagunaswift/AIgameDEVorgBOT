// Optional reward roles. When a user's total points cross a configured threshold, the
// bot assigns the matching role. Requires Manage Roles and the bot's role dragged above
// any role it hands out. Safe to leave unconfigured (rewardThresholds defaults to []).

import { getDb } from '../firebase.js';

function pointsRef() {
  return getDb().collection('points');
}

// Re-check thresholds for a user after a point award and assign any roles they now
// qualify for. Best-effort: logs and continues on permission errors rather than throwing
// into the scoring hot path.
//
//   guild:   the discord.js Guild.
//   userId:  the user whose total to check.
//   cfg:     effective config (rewardThresholds: [{ points, roleId }]).
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
    // User may have left the server; nothing to do.
    return;
  }

  for (const { points, roleId } of thresholds) {
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
  }
}
