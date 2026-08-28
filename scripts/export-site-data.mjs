// Exports showcase + jam data from Discord/Firestore into the Astro site's data files.
//
// Reads Discord state over REST only (no gateway login) using the bot token, so this can
// run as a one-off script or a scheduled job without holding a live connection. Firestore
// is read via the same firebase-admin init the bot uses. Output conforms exactly to
// AIGAMEDEVSITE/src/data/CONTRACT.md.
//
// Usage:
//   node scripts/export-site-data.mjs --out ../AIGAMEDEVSITE --report ./export-report.json [--jams-forum <id[,id...]>] [--limit N] [--dry-run]

import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { REST } from 'discord.js';
import { config } from '../src/config.js';
import { initFirebase, getDb } from '../src/firebase.js';
import {
  parsePublishTagId,
  preserveGeneratedAtIfUnchanged,
  readJson,
  removeStaleAssets,
} from './site-export-safety.mjs';
import { buildPublicGame } from './site-export-contract.mjs';

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif'];
const CONTENT_TYPE_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

// ---------- CLI args ----------

function parseArgs(argv) {
  const args = { out: null, report: null, jamsForum: [], limit: null, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') {
      args.out = argv[i += 1];
    } else if (arg.startsWith('--out=')) {
      args.out = arg.slice('--out='.length);
    } else if (arg === '--report') {
      args.report = argv[i += 1];
    } else if (arg.startsWith('--report=')) {
      args.report = arg.slice('--report='.length);
    } else if (arg === '--jams-forum') {
      args.jamsForum = splitIds(argv[i += 1]);
    } else if (arg.startsWith('--jams-forum=')) {
      args.jamsForum = splitIds(arg.slice('--jams-forum='.length));
    } else if (arg === '--limit') {
      args.limit = parseLimit(argv[i += 1]);
    } else if (arg.startsWith('--limit=')) {
      args.limit = parseLimit(arg.slice('--limit='.length));
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    }
  }
  return args;
}

function splitIds(value) {
  return (value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseLimit(value) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function validateEnv(args) {
  const missing = [];
  if (!config.discordToken) missing.push('DISCORD_TOKEN');
  if (!config.firebaseServiceAccount) missing.push('FIREBASE_SERVICE_ACCOUNT');
  if (!config.guildId) missing.push('GUILD_ID');
  if (!args.out) missing.push('--out');
  if (!args.report) missing.push('--report');
  if (missing.length) {
    throw new Error(
      `export-site-data: missing required value(s): ${missing.join(', ')}`,
    );
  }
  return parsePublishTagId(process.env.SITE_PUBLISH_TAG_ID);
}

// ---------- text extraction ----------

// Strips the markdown constructs called out in the data contract: custom emoji tags,
// link syntax (kept as its label), bold/italic/underline/strikethrough/code markers.
// Longest markers are stripped first so triple/double sequences don't leave stray chars.
function stripMarkdown(input) {
  if (!input) return '';
  let text = String(input);
  text = text.replace(/<a?:([A-Za-z0-9_]+):\d+>/g, ':$1:');
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  text = text.replace(/~~/g, '');
  text = text.replace(/```/g, '');
  text = text.replace(/``/g, '');
  text = text.replace(/`/g, '');
  text = text.replace(/\*\*\*/g, '');
  text = text.replace(/\*\*/g, '');
  text = text.replace(/__/g, '');
  text = text.replace(/\*/g, '');
  text = text.replace(/\s+/g, ' ').trim();
  return text;
}

function truncate(text, max) {
  if (!text) return text;
  if (text.length <= max) return text;
  return text.slice(0, max).trim();
}

function extractText(message, max) {
  if (!message) return null;
  const cleaned = truncate(stripMarkdown(message.content || ''), max);
  return cleaned || null;
}

// ---------- image attachment handling ----------

function fileExt(filename) {
  const m = /\.([A-Za-z0-9]+)$/.exec(filename || '');
  return m ? m[1].toLowerCase() : '';
}

function isImageAttachment(att) {
  const contentType = (att.content_type || '').toLowerCase();
  if (contentType.startsWith('image/')) return true;
  return IMAGE_EXTS.includes(fileExt(att.filename));
}

// Returns a whitelisted extension for the attachment, or null when the format is not
// one we can label truthfully (e.g. svg/bmp/avif uploads). A null lets sharp determine
// whether it can safely re-encode the asset; undecodable attachments fail the export.
function resolveImageExt(att) {
  const ext = fileExt(att.filename);
  if (IMAGE_EXTS.includes(ext)) return ext;
  const contentType = (att.content_type || '').toLowerCase();
  return CONTENT_TYPE_EXT[contentType] || null;
}

function findImageAttachment(message) {
  if (!message || !Array.isArray(message.attachments)) return null;
  return message.attachments.find(isImageAttachment) || null;
}

// Card images are served in a ~320px grid slot; 800px covers retina with room to spare.
const OPTIMIZED_MAX_WIDTH = 800;
const OPTIMIZED_QUALITY = 78;

// Downloads an attachment and optimizes it for the site's showcase cards: resized to
// card width and re-encoded as webp (animation preserved for gifs). Falls back to the
// original bytes only when its declared extension is safe to preserve. Removes stale
// same-thread variants from earlier runs so extension changes never leave orphans.
async function downloadOptimizedAttachment(url, destDir, baseName, fallbackExt) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`image download failed (${res.status}) for ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.mkdir(destDir, { recursive: true });

  let ext = 'webp';
  let out;
  try {
    out = await sharp(buf, { animated: true })
      .resize({ width: OPTIMIZED_MAX_WIDTH, withoutEnlargement: true })
      .webp({ quality: OPTIMIZED_QUALITY })
      .toBuffer();
  } catch (err) {
    if (!fallbackExt) {
      throw new Error(`unsupported image format for ${baseName}: ${err.message}`);
    }
    console.warn(`[export] optimization failed for ${baseName} (${err.message}) - keeping original`);
    ext = fallbackExt;
    out = buf;
  }

  for (const stale of IMAGE_EXTS) {
    if (stale === ext) continue;
    try {
      await fs.unlink(path.join(destDir, `${baseName}.${stale}`));
    } catch {}
  }

  await fs.writeFile(path.join(destDir, `${baseName}.${ext}`), out);
  return ext;
}

// ---------- Discord REST helpers ----------

function isMissingResource(err) {
  return err && (err.status === 404 || err.status === 403);
}

async function getChannel(rest, id) {
  return rest.get(`/channels/${id}`);
}

async function getStarterMessage(rest, threadId) {
  // In a forum thread the starter message id equals the thread id.
  try {
    return await rest.get(`/channels/${threadId}/messages/${threadId}`);
  } catch (err) {
    if (isMissingResource(err)) return null;
    throw err;
  }
}

// Fallback for threads whose starter message has no image: scan up to the first 50
// messages after the starter (a single 100-message page, per the shared image-presence
// rule) for the earliest one from the thread owner that carries an image attachment.
async function findOwnerFallbackImage(rest, threadId, ownerId) {
  if (!ownerId) return null;
  let messages;
  try {
    messages = await rest.get(`/channels/${threadId}/messages`, {
      query: new URLSearchParams({ after: threadId, limit: '100' }),
    });
  } catch (err) {
    if (isMissingResource(err)) return null;
    throw err;
  }
  if (!Array.isArray(messages) || !messages.length) return null;

  // Discord returns newest-first; sort ascending by snowflake so we can walk forward
  // from the starter and stop at the earliest qualifying message.
  const sorted = [...messages].sort((a, b) => {
    const ai = BigInt(a.id);
    const bi = BigInt(b.id);
    if (ai < bi) return -1;
    if (ai > bi) return 1;
    return 0;
  });

  for (const message of sorted.slice(0, 50)) {
    if (message.author && message.author.id === ownerId) {
      const att = findImageAttachment(message);
      if (att) return att;
    }
  }
  return null;
}

async function getForumTagMap(rest, forumId, cache) {
  if (cache.has(forumId)) return cache.get(forumId);
  const map = new Map();
  const forum = await getChannel(rest, forumId);
  if (!Array.isArray(forum.available_tags)) {
    throw new Error(`forum ${forumId} did not return available_tags`);
  }
  for (const tag of forum.available_tags) {
    if (!tag || !tag.id || !tag.name) {
      throw new Error(`forum ${forumId} returned a malformed tag`);
    }
    map.set(tag.id, { name: tag.name, emojiId: tag.emoji_id || null, emojiName: tag.emoji_name || null });
  }
  cache.set(forumId, map);
  return map;
}

// ---------- placement awards ----------

// Mods apply a "1st place" / "2nd place" / "3rd place" tag to winning showcase posts.
// The tag's own emoji becomes the badge on the site card: custom emoji images are
// downloaded once from the Discord CDN, unicode emoji pass through as a character.
const AWARD_PATTERNS = [
  { place: 1, re: /(^|\W)(1st|first)(\W|$)/i },
  { place: 2, re: /(^|\W)(2nd|second)(\W|$)/i },
  { place: 3, re: /(^|\W)(3rd|third)(\W|$)/i },
];

async function resolveAward(appliedTags, ctx) {
  for (const { place, re } of AWARD_PATTERNS) {
    const tag = appliedTags.find((t) => re.test(t.name));
    if (!tag) continue;

    let emoji = null;
    if (tag.emojiId) {
      if (!ctx.awardEmojiCache.has(tag.emojiId)) {
        let ok = false;
        if (ctx.dryRun) {
          ok = true; // report the path without writing anything
        } else {
          try {
            const res = await fetch(`https://cdn.discordapp.com/emojis/${tag.emojiId}.webp?size=96`);
            if (res.ok) {
              const buf = Buffer.from(await res.arrayBuffer());
              const dir = path.join(ctx.outDir, 'public', 'assets', 'awards');
              await fs.mkdir(dir, { recursive: true });
              await fs.writeFile(path.join(dir, `${tag.emojiId}.webp`), buf);
              ok = true;
            } else {
              throw new Error(`Discord CDN returned ${res.status}`);
            }
          } catch (err) {
            throw new Error(`award emoji download failed (${tag.emojiId}): ${err.message}`);
          }
        }
        ctx.awardEmojiCache.set(tag.emojiId, ok);
      }
      emoji = ctx.awardEmojiCache.get(tag.emojiId) ? `/assets/awards/${tag.emojiId}.webp` : null;
    }

    return { place, emoji, emojiChar: tag.emojiId ? null : (tag.emojiName || null) };
  }
  return null;
}

// ---------- dates ----------

function snowflakeToIso(id) {
  const ms = (BigInt(id) >> 22n) + 1420070400000n;
  return new Date(Number(ms)).toISOString();
}

function resolveCreatedAt(channel, firestoreData, threadId) {
  const createTimestamp = channel && channel.thread_metadata && channel.thread_metadata.create_timestamp;
  if (createTimestamp) return new Date(createTimestamp).toISOString();
  if (firestoreData && firestoreData.createdAt && typeof firestoreData.createdAt.toDate === 'function') {
    return firestoreData.createdAt.toDate().toISOString();
  }
  return snowflakeToIso(threadId);
}

// ---------- feedback points ----------

// Fetches the whole points collection exactly once and indexes it client-side by
// threadId, instead of one where() query per thread.
async function buildFeedbackPointsMap(db) {
  const map = new Map();
  const snap = await db.collection('points').get();
  for (const doc of snap.docs) {
    const data = doc.data();
    let threadId = data.threadId;
    if (!threadId) {
      const idx = doc.id.indexOf('_');
      threadId = idx > -1 ? doc.id.slice(0, idx) : doc.id;
    }
    if (!threadId || threadId === '__adjustment__') continue;
    map.set(threadId, (map.get(threadId) || 0) + 1);
  }
  return map;
}

// ---------- showcase flow ----------

async function processShowcaseThread(docSnap, ctx) {
  const { rest, forumTagCache, pointsMap, dryRun, outDir, publishTagId, sourceForumIds, withheldIds } = ctx;
  const threadId = docSnap.id;
  const data = docSnap.data();

  const channel = await getChannel(rest, threadId);
  const forumId = channel.parent_id || null;
  if (!forumId || forumId !== data.forumId || !sourceForumIds.has(forumId)) {
    throw new Error(`showcase thread ${threadId} has an uncertain source forum`);
  }
  if (!Array.isArray(channel.applied_tags)) {
    throw new Error(`showcase thread ${threadId} did not return applied_tags`);
  }

  // This is the publication boundary: untagged threads never have their text or assets read.
  if (!channel.applied_tags.includes(publishTagId)) {
    withheldIds.add(threadId);
    return null;
  }

  const tagMap = await getForumTagMap(rest, forumId, forumTagCache);
  const appliedTags = channel.applied_tags.map((id) => {
    const tag = tagMap.get(id);
    if (!tag) throw new Error(`showcase thread ${threadId} has an unknown tag ${id}`);
    return tag;
  });

  const starterMessage = await getStarterMessage(rest, threadId);
  if (!starterMessage) {
    throw new Error(`showcase thread ${threadId} has no accessible starter message`);
  }
  const description = extractText(starterMessage, 280);

  const ownerId = data.ownerId || channel.owner_id || null;

  let image = null;
  let hasImage = false;
  let recovered = false;
  let att = findImageAttachment(starterMessage);
  if (!att) {
    att = await findOwnerFallbackImage(rest, threadId, ownerId);
    if (att) recovered = true;
  }
  if (att) {
    let ext = 'webp';
    if (!dryRun) {
      const destDir = path.join(outDir, 'public', 'assets', 'showcase');
      ext = await downloadOptimizedAttachment(att.url, destDir, threadId, resolveImageExt(att));
    }
    if (ext) {
      hasImage = true;
      image = `/assets/showcase/${threadId}.${ext}`;
    } else {
      recovered = false;
    }
  }

  const tags = appliedTags.map((tag) => tag.name);
  const award = await resolveAward(appliedTags, ctx);

  const title = truncate((channel.name || data.title || '').trim(), 120);

  return {
    game: buildPublicGame({
      id: threadId,
      title,
      author: data.ownerTag || null,
      description,
      image,
      threadUrl: `https://discord.com/channels/${config.guildId}/${threadId}`,
      createdAt: resolveCreatedAt(channel, data, threadId),
      feedbackPoints: pointsMap.get(threadId) || 0,
      tags,
      award,
      projectUrl: data.projectUrl ?? null,
      jamId: data.jamId ?? null,
    }),
    hasImage,
    recovered,
  };
}

async function runShowcaseFlow(rest, db, args) {
  const pointsMap = await buildFeedbackPointsMap(db);
  const threadsSnap = await db.collection('threads').where('mode', '==', 'showcase').get();
  let threadDocs = threadsSnap.docs;
  if (args.limit) threadDocs = threadDocs.slice(0, args.limit);

  const sourceForumIds = new Set();
  for (const docSnap of threadDocs) {
    const forumId = docSnap.data().forumId;
    if (!forumId || !/^\d{17,20}$/.test(forumId)) {
      throw new Error(`showcase thread ${docSnap.id} has no valid source forum id`);
    }
    sourceForumIds.add(forumId);
  }

  const forumTagCache = new Map();
  const awardEmojiCache = new Map();
  for (const forumId of sourceForumIds) {
    const tags = await getForumTagMap(rest, forumId, forumTagCache);
    if (!tags.has(args.publishTagId)) {
      throw new Error(`SITE_PUBLISH_TAG_ID is not available in showcase forum ${forumId}`);
    }
  }

  const games = [];
  const missingScreenshots = [];
  const withheldIds = new Set();
  let recoveredCount = 0;

  for (const docSnap of threadDocs) {
    const result = await processShowcaseThread(docSnap, {
      rest,
      forumTagCache,
      awardEmojiCache,
      pointsMap,
      dryRun: args.dryRun,
      outDir: args.out,
      publishTagId: args.publishTagId,
      sourceForumIds,
      withheldIds,
    });
    if (!result) continue;
    games.push(result.game);
    if (!result.hasImage) missingScreenshots.push(result.game.title);
    if (result.recovered) recoveredCount += 1;
  }

  games.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  let totalFeedbackPoints = 0;
  for (const count of pointsMap.values()) totalFeedbackPoints += count;

  return { games, missingScreenshots, recoveredCount, totalFeedbackPoints, withheldIds: [...withheldIds].sort() };
}

// ---------- jams flow ----------

async function collectJamThreads(rest, guildId, forumIds) {
  const threadsById = new Map();

  const activeResp = await rest.get(`/guilds/${guildId}/threads/active`);
  const activeThreads = activeResp.threads || [];
  for (const thread of activeThreads) {
    if (forumIds.includes(thread.parent_id)) threadsById.set(thread.id, thread);
  }

  for (const forumId of forumIds) {
    let before;
    let hasMore = true;
    while (hasMore) {
      const query = new URLSearchParams();
      query.set('limit', '100');
      if (before) query.set('before', before);

      const page = await rest.get(`/channels/${forumId}/threads/archived/public`, { query });

      const threads = page.threads || [];
      for (const thread of threads) {
        if (!threadsById.has(thread.id)) threadsById.set(thread.id, thread);
      }

      hasMore = Boolean(page.has_more) && threads.length > 0;
      if (hasMore) {
        const last = threads[threads.length - 1];
        // The API requires an ISO8601 timestamp here, never a raw snowflake; fall back to
        // one derived from the id on the rare thread missing archive_timestamp.
        before = (last.thread_metadata && last.thread_metadata.archive_timestamp)
          || snowflakeToIso(last.id);
      }
    }
  }

  return [...threadsById.values()];
}

// Lifecycle phases a jam thread moves through, read from the forum tags the organiser
// applies. Falls back to a sensible phase when no lifecycle tag is present.
const JAM_PHASES = ['upcoming', 'active', 'voting', 'finished'];

function resolveJamPhase(tagNames, archived) {
  const lowered = tagNames.map((n) => n.toLowerCase().trim());
  for (const phase of JAM_PHASES) {
    if (lowered.includes(phase)) return phase;
  }
  return archived ? 'finished' : 'active';
}

async function processJamThread(rest, thread, guildId, forumTagCache) {
  const starterMessage = await getStarterMessage(rest, thread.id);
  const summary = extractText(starterMessage, 200);
  const archived = Boolean(thread.thread_metadata && thread.thread_metadata.archived);

  let tagNames = [];
  if (thread.parent_id && Array.isArray(thread.applied_tags) && thread.applied_tags.length) {
    const tagMap = await getForumTagMap(rest, thread.parent_id, forumTagCache);
    tagNames = thread.applied_tags
      .map((id) => tagMap.get(id))
      .filter(Boolean)
      .map((t) => t.name);
  }

  return {
    id: thread.id,
    title: truncate((thread.name || '').trim(), 120),
    summary,
    date: resolveCreatedAt(thread, null, thread.id),
    status: archived ? 'past' : 'active',
    phase: resolveJamPhase(tagNames, archived),
    tags: tagNames,
    threadUrl: `https://discord.com/channels/${guildId}/${thread.id}`,
  };
}

async function runJamsFlow(rest, forumIds) {
  const threads = await collectJamThreads(rest, config.guildId, forumIds);
  const forumTagCache = new Map();
  const jams = [];

  for (const thread of threads) {
    jams.push(await processJamThread(rest, thread, config.guildId, forumTagCache));
  }

  jams.sort((a, b) => new Date(b.date) - new Date(a.date));
  return jams;
}

// ---------- output ----------

async function writeJson(outDir, fileName, payload) {
  const dataDir = path.join(outDir, 'src', 'data');
  await fs.mkdir(dataDir, { recursive: true });
  const filePath = path.join(dataDir, fileName);
  let previous = null;
  try {
    previous = await readJson(filePath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const stablePayload = preserveGeneratedAtIfUnchanged(previous, payload);
  await fs.writeFile(filePath, `${JSON.stringify(stablePayload, null, 2)}\n`);
  return filePath;
}

async function writeReport(filePath, report) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(report, null, 2)}\n`);
}

async function cleanExportAssets(outDir, games) {
  const showcaseAssets = games.filter((game) => game.image).map((game) => game.image);
  const awardAssets = games
    .filter((game) => game.award && game.award.emoji)
    .map((game) => game.award.emoji);
  await removeStaleAssets(path.join(outDir, 'public', 'assets', 'showcase'), showcaseAssets);
  await removeStaleAssets(path.join(outDir, 'public', 'assets', 'awards'), awardAssets);
}

// ---------- org stats ----------

// Live counters for the site's org-status card. A count lookup failure fails the staged
// export rather than replacing a previously complete snapshot with partial stats.
async function fetchGuildMemberCount(rest, guildId) {
  const guild = await rest.get(`/guilds/${guildId}`, {
    query: new URLSearchParams({ with_counts: 'true' }),
  });
  if (typeof guild.approximate_member_count !== 'number') {
    throw new Error('guild lookup did not return approximate_member_count');
  }
  return guild.approximate_member_count;
}

// ---------- summary ----------

function printSummary({ games, missingScreenshots, recoveredCount, jams, jamsRequested, filesWritten, dryRun }) {
  console.log('');
  console.log('=== export-site-data summary ===');
  console.log(`Games exported: ${games.length}`);
  if (missingScreenshots.length) {
    console.log(`Games missing screenshots (${missingScreenshots.length}):`);
    for (const title of missingScreenshots) console.log(`  - ${title}`);
  } else {
    console.log('Games missing screenshots: none');
  }
  console.log(`Screenshots recovered from thread replies: ${recoveredCount}`);
  if (jamsRequested) {
    console.log(`Jams exported: ${jams.length}`);
  } else {
    console.log('Jams exported: skipped (no --jams-forum)');
  }
  if (dryRun) {
    console.log('Files written: none (dry run)');
  } else if (filesWritten.length) {
    console.log('Files written:');
    for (const f of filesWritten) console.log(`  - ${f}`);
  } else {
    console.log('Files written: none');
  }
}

// ---------- main ----------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  args.publishTagId = validateEnv(args);
  args.out = path.resolve(args.out);

  initFirebase();
  const db = getDb();
  const rest = new REST({ version: '10' }).setToken(config.discordToken);

  const { games, missingScreenshots, recoveredCount, totalFeedbackPoints, withheldIds } =
    await runShowcaseFlow(rest, db, args);

  const memberCount = await fetchGuildMemberCount(rest, config.guildId);
  const stats = {
    members: memberCount,
    projects: games.length,
    feedbackPoints: totalFeedbackPoints,
  };
  console.log(
    `Org stats: members=${memberCount ?? 'unavailable'}, projects=${games.length}, feedbackPoints=${totalFeedbackPoints}`,
  );

  const filesWritten = [];
  if (!args.dryRun) {
    await writeReport(args.report, { version: 1, withheldIds });
    filesWritten.push(args.report);
    const showcasePath = await writeJson(args.out, 'showcase.json', {
      version: 2,
      generatedAt: new Date().toISOString(),
      guildId: config.guildId,
      stats,
      games,
    });
    filesWritten.push(showcasePath);
    await cleanExportAssets(args.out, games);
  }

  const jamsRequested = args.jamsForum.length > 0;
  let jams = [];
  if (jamsRequested) {
    jams = await runJamsFlow(rest, args.jamsForum);
    if (!args.dryRun) {
      const jamsPath = await writeJson(args.out, 'jams.json', {
        version: 2,
        generatedAt: new Date().toISOString(),
        jams,
      });
      filesWritten.push(jamsPath);
    }
  }

  printSummary({
    games,
    missingScreenshots,
    recoveredCount,
    jams,
    jamsRequested,
    filesWritten,
    dryRun: args.dryRun,
  });

  const exportedNothing = games.length === 0 && (!jamsRequested || jams.length === 0);
  if (exportedNothing) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`[export] fatal: ${err.message}`);
  process.exitCode = 1;
});
