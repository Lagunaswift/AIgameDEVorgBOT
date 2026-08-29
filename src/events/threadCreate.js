import { Events, EmbedBuilder } from 'discord.js';
import { config } from '../config.js';
import { modeForForum, getEffectiveConfig } from '../services/config.js';
import { registerThread } from '../services/threads.js';
import { scheduleNudgeCheck } from '../services/screenshotNudge.js';
import { scheduleGuidelinesCheck } from '../services/guidelinesNudge.js';
import { maybeSendHelpfulHintForThread } from '../services/helpfulHint.js';

export const name = Events.ThreadCreate;
export const once = false;

export async function execute(thread, newlyCreated) {
  try {
    const forumId = thread.parentId;
    if (!forumId) return;

    const mode = await modeForForum(forumId);
    if (!mode) return;

    const data = await registerThread(thread, mode);
    console.log(
      `[threadCreate] registered thread ${thread.id} "${data.title}" mode=${mode} owner=${data.ownerId} (newlyCreated=${newlyCreated})`,
    );

    if (newlyCreated) {
      if (mode === 'showcase') {
        await maybeSendHelpfulHintForThread(thread);
      }
      await notifyModFeed(thread, data, mode);

      if (mode === 'showcase' && config.screenshotNudgeEnabled) {
        scheduleNudgeCheck(thread, config.screenshotNudgeDelayMinutes * 60000);
      }
      if (mode === 'showcase' && config.guidelinesNudgeEnabled) {
        scheduleGuidelinesCheck(thread, config.guidelinesNudgeDelayMinutes * 60000);
      }
    }
  } catch (err) {
    console.error('[threadCreate] failed to register thread:', err.message);
  }
}

async function notifyModFeed(thread, data, mode) {
  try {
    const cfg = await getEffectiveConfig();
    if (!cfg.modFeedChannelId) return;

    const feedChannel = await thread.client.channels.fetch(cfg.modFeedChannelId);
    if (!feedChannel || !feedChannel.isTextBased()) return;

    const label = mode === 'showcase' ? 'Showcase' : 'Competition';
    const embed = new EmbedBuilder()
      .setColor(mode === 'showcase' ? 0x39FF14 : 0xFF6B35)
      .setDescription(
        `<:ShowcaseBotReact:1521124760220729445> **New ${label} Post**\n\n` +
        `**${data.title}**\n` +
        `by <@${data.ownerId}> in <#${thread.parentId}>\n\n` +
        `<#${thread.id}>`,
      )


      .setTimestamp();

    await feedChannel.send({ embeds: [embed] });
  } catch (err) {
    console.error('[threadCreate] mod feed notification failed:', err.message);
  }
}
