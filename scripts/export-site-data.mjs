// Exports Showcase, Project, and jam data from Discord/Firestore into the Astro site.
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
import { findOwnerReplyImage } from '../src/lib/threadImages.js';
import { checkGameApproval } from '../src/lib/gameApproval.js';
import { readProjectPublishing } from './project-publishing-export.mjs';
import {
  parsePublishTagId,
  preserveGeneratedAtIfUnchanged,
  readJson,
  removeStaleAssets,
} from './site-export-safety.mjs';
import {
  buildPublicGame,
  finalizeProjectExport,
  normalizeOptionalText,
  normalizeProjectActivity,
  prepareProjectExports,
} from './site-export-contract.mjs';
import {
  DISCORD_SNOWFLAKE_RE,
  extractText,
  getChannel,
  getForumTagMap,
  getStarterMessage,
  isDirectRun,
  isMissingResource,
  truncate,
} from './site-export-shared.mjs';

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif'];
const CONTENT_TYPE_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};
const PUBLIC_DISCORD_THREAD_TYPES = new Set([10, 11]);
const PROJECT_GENERATED_DIR = '_discord-export';

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
  if (!DISCORD_SNOWFLAKE_RE.test(config.guildId)) {
    throw new Error('export-site-data: GUILD_ID must be a Discord snowflake');
  }
  return parsePublishTagId(process.env.SITE_PUBLISH_TAG_ID);
}

// ---------- text extraction ----------
// stripMarkdown / truncate / extractText live in site-export-shared.mjs, shared with
// the Phase 3 project migration so both tools normalise public text identically.

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
async function downloadOptimizedAttachment(
  url,
  destDir,
  baseName,
  fallbackExt,
  {
    maxWidth = OPTIMIZED_MAX_WIDTH,
    quality = OPTIMIZED_QUALITY,
    allowOriginalFallback = true,
  } = {},
) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`image download failed (${res.status}) for ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.mkdir(destDir, { recursive: true });

  let ext = 'webp';
  let out;
  let width = null;
  let height = null;
  try {
    const optimized = await sharp(buf, { animated: true })
      .resize({ width: maxWidth, withoutEnlargement: true })
      .webp({ quality })
      .toBuffer({ resolveWithObject: true });
    out = optimized.data;
    width = optimized.info.width;
    height = optimized.info.height;
  } catch (err) {
    if (!fallbackExt || !allowOriginalFallback) {
      throw new Error(`unsupported image format for ${baseName}: ${err.message}`);
    }
    console.warn(`[export] optimization failed for ${baseName} (${err.message}) - keeping original`);
    ext = fallbackExt;
    out = buf;
    try {
      const metadata = await sharp(buf, { animated: true }).metadata();
      width = metadata.width ?? null;
      height = metadata.height ?? null;
    } catch {
      // Showcase cards do not need intrinsic dimensions. Project media validation below
      // fails closed if an original cannot supply them.
    }
  }

  for (const stale of IMAGE_EXTS) {
    if (stale === ext) continue;
    try {
      await fs.unlink(path.join(destDir, `${baseName}.${stale}`));
    } catch {}
  }

  await fs.writeFile(path.join(destDir, `${baseName}.${ext}`), out);
  return { ext, width, height };
}

// ---------- Discord REST helpers ----------
// getChannel / getStarterMessage / isMissingResource live in site-export-shared.mjs.

// Use the same bounded owner-reply search as the nudge. Failed history reads abort
// the candidate export rather than silently replacing a valid image with a placeholder.
function findOwnerFallbackImage(rest, threadId, ownerId) {
  return findOwnerReplyImage({
    threadId,
    ownerId,
    fetchPage: (options) => rest.get(`/channels/${threadId}/messages`, { query: new URLSearchParams(options) }),
    findImage: findImageAttachment,
  });
}

// getForumTagMap lives in site-export-shared.mjs (also used by the Phase 3 migration
// to resolve applied tag ids into the tag names platform extraction runs against).

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

// ---------- Projects flow ----------

function threadDataFromDoc(doc, label) {
  const data = doc && typeof doc.data === 'function' ? doc.data() : null;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`${label} has malformed Firestore data`);
  }
  return data;
}

function assertProjectSourceThread(doc, prepared, role) {
  if (!doc) throw new Error(`Project ${prepared.id} ${role} is not a registered thread`);
  const threadId = doc.id;
  if (!DISCORD_SNOWFLAKE_RE.test(String(threadId || ''))) {
    throw new Error(`Project ${prepared.id} ${role} has an invalid Discord thread ID`);
  }
  const data = threadDataFromDoc(doc, `Project ${prepared.id} ${role}`);
  if (Object.hasOwn(data, 'threadId') && data.threadId !== threadId) {
    throw new Error(`Project ${prepared.id} ${role} embedded threadId does not match document id ${threadId}`);
  }
  if (data.ownerId !== prepared.ownerId) {
    throw new Error(`Project ${prepared.id} ${role} owner does not match the Project owner`);
  }
  if (data.projectId !== prepared.id) {
    throw new Error(`Project ${prepared.id} ${role} is not exactly linked to this Project`);
  }
  if (!DISCORD_SNOWFLAKE_RE.test(String(data.forumId || ''))) {
    throw new Error(`Project ${prepared.id} ${role} has no valid source forum ID`);
  }
  return { threadId, data };
}

async function getPublicProjectThread(rest, source, prepared, role, channelCache) {
  if (channelCache.has(source.threadId)) return channelCache.get(source.threadId);
  let channel;
  try {
    channel = await getChannel(rest, source.threadId);
  } catch (err) {
    if (isMissingResource(err)) {
      throw new Error(`Project ${prepared.id} ${role} Discord thread is unavailable`);
    }
    throw err;
  }
  if (!channel || channel.id !== source.threadId) {
    throw new Error(`Project ${prepared.id} ${role} returned the wrong Discord thread`);
  }
  if (channel.guild_id !== config.guildId) {
    throw new Error(`Project ${prepared.id} ${role} is outside the configured guild`);
  }
  if (!PUBLIC_DISCORD_THREAD_TYPES.has(channel.type)) {
    throw new Error(`Project ${prepared.id} ${role} is not a public Discord thread`);
  }
  if (channel.parent_id !== source.data.forumId) {
    throw new Error(`Project ${prepared.id} ${role} source forum does not match registration`);
  }
  if (channel.owner_id !== prepared.ownerId) {
    throw new Error(`Project ${prepared.id} ${role} live Discord owner does not match the Project owner`);
  }
  channelCache.set(source.threadId, channel);
  return channel;
}

function attachmentAltText(attachment, prepared, channel) {
  const supplied = typeof attachment.description === 'string' ? attachment.description.trim() : '';
  if (supplied && supplied.length <= 240) return supplied;
  const channelName = typeof channel.name === 'string' && channel.name.trim()
    ? channel.name.trim()
    : 'project image';
  return truncate(`${prepared.project.title}: ${channelName}`, 240);
}

async function buildProjectImage({
  rest,
  threadDocsById,
  prepared,
  threadId,
  role,
  baseName,
  optional,
  args,
  channelCache,
  downloadAttachment,
}) {
  const source = assertProjectSourceThread(threadDocsById.get(threadId), prepared, role);
  const channel = await getPublicProjectThread(rest, source, prepared, role, channelCache);
  const starterMessage = await getStarterMessage(rest, threadId);
  if (starterMessage?.author?.id && starterMessage.author.id !== prepared.ownerId) {
    throw new Error(`Project ${prepared.id} ${role} starter message owner does not match the Project owner`);
  }

  let attachment = starterMessage?.author?.id === prepared.ownerId
    ? findImageAttachment(starterMessage)
    : null;
  if (!attachment) attachment = await findOwnerFallbackImage(rest, threadId, prepared.ownerId);
  if (!attachment) {
    if (optional) return { media: null, asset: null };
    throw new Error(`Project ${prepared.id} ${role} has no owner-authored image`);
  }
  if (args.dryRun) return { media: null, asset: null };

  const destDir = path.join(
    args.out,
    'public',
    'assets',
    'projects',
    prepared.project.slug,
    PROJECT_GENERATED_DIR,
  );
  const result = await downloadAttachment(
    attachment.url,
    destDir,
    baseName,
    resolveImageExt(attachment),
    { maxWidth: 1600, quality: 82, allowOriginalFallback: false },
  );
  const src = `/assets/projects/${prepared.project.slug}/${PROJECT_GENERATED_DIR}/${baseName}.${result.ext}`;
  return {
    asset: src,
    media: {
      kind: 'image',
      src,
      alt: attachmentAltText(attachment, prepared, channel),
      width: result.width,
      height: result.height,
      caption: null,
    },
  };
}

function assertSingleProjectSource(threadDocs, prepared) {
  if (!prepared.profileThreadId) {
    throw new Error(`Project ${prepared.id} has no fixed profileThreadId source association`);
  }
  if (prepared.mediaThreadIds.some((threadId) => threadId !== prepared.profileThreadId)) {
    throw new Error(`Project ${prepared.id} mediaThreadIds must reference only its fixed source thread`);
  }
  const linked = threadDocs.filter((doc) => {
    const data = doc && typeof doc.data === 'function' ? doc.data() : null;
    return data && typeof data === 'object' && !Array.isArray(data) && data.projectId === prepared.id;
  });
  if (linked.length !== 1) {
    throw new Error(`Project ${prepared.id} must have exactly one registered source thread backlink`);
  }
  const source = assertProjectSourceThread(linked[0], prepared, 'fixed source thread');
  if (source.threadId !== prepared.profileThreadId) {
    throw new Error(`Project ${prepared.id} registered source thread does not match profileThreadId`);
  }
  if (source.data.mode !== 'showcase') {
    throw new Error(`Project ${prepared.id} fixed source thread must use showcase mode`);
  }
  return source;
}

export async function runProjectsFlow(
  rest,
  db,
  preparedProjects,
  args,
  { downloadAttachment = downloadOptimizedAttachment } = {},
) {
  const threadsSnap = await db.collection('threads').get();
  const threadDocs = threadsSnap.docs || [];
  const threadDocsById = new Map(threadDocs.map((doc) => [doc.id, doc]));
  const channelCache = new Map();
  const projects = [];
  const generatedAssets = [];
  const withheldProjectIds = new Set();
  const exportedProjectIds = new Set();

  for (const prepared of preparedProjects) {
    const source = assertSingleProjectSource(threadDocs, prepared);
    const approval = await checkGameApproval(rest, {
      threadId: source.threadId,
      ownerId: prepared.ownerId,
      forumId: source.data.forumId,
      guildId: config.guildId,
      publishTagId: args.publishTagId,
    });
    if (!approval.approved) {
      withheldProjectIds.add(prepared.id);
      continue;
    }
    channelCache.set(source.threadId, approval.channel);

    let hero = null;
    const result = await buildProjectImage({
      rest,
      threadDocsById,
      prepared,
      threadId: prepared.profileThreadId,
      role: 'profile thread',
      baseName: 'hero',
      optional: true,
      args,
      channelCache,
      downloadAttachment,
    });
    hero = result.media;
    if (result.asset) generatedAssets.push(result.asset);

    const media = [];
    for (const [index, threadId] of prepared.mediaThreadIds.entries()) {
      const result = await buildProjectImage({
        rest,
        threadDocsById,
        prepared,
        threadId,
        role: `media thread ${index + 1}`,
        baseName: `media-${String(index + 1).padStart(2, '0')}`,
        optional: false,
        args,
        channelCache,
        downloadAttachment,
      });
      if (result.media) media.push(result.media);
      if (result.asset) generatedAssets.push(result.asset);
    }

    const derivedActivities = [];
    if (source.data.publishOnProject === true) {
      if (!['feedback', 'project-update', 'jam-entry'].includes(source.data.purpose)) {
        throw new Error(`Project ${prepared.id} fixed source activity has an invalid purpose`);
      }
      derivedActivities.push(normalizeProjectActivity({
        type: source.data.purpose,
        title: normalizeOptionalText(source.data.activityTitle, 'fixed source activity title', 160)
          ?? truncate((approval.channel.name || prepared.project.title).trim(), 160),
        date: resolveCreatedAt(approval.channel, source.data, source.threadId),
        summary: normalizeOptionalText(source.data.activitySummary, 'fixed source activity summary', 500),
        url: `https://discord.com/channels/${config.guildId}/${source.threadId}`,
      }, `Project ${prepared.id} fixed source activity`));
    }
    projects.push(finalizeProjectExport(prepared, { hero, media, derivedActivities }));
    exportedProjectIds.add(prepared.id);
  }

  return {
    projects,
    generatedAssets,
    withheldProjectIds: [...withheldProjectIds].sort(),
    exportedProjectIds,
  };
}

function resolveShowcaseProjectFields(data, channel, threadId, projectsById, exportedProjectIds) {
  const activityTitle = normalizeOptionalText(data.activityTitle, `thread ${threadId} activityTitle`, 160);
  if (data.projectId == null) {
    return { activityTitle, projectId: null, projectSlug: null, state: null };
  }

  const record = projectsById?.get(data.projectId);
  if (!record) throw new Error(`showcase thread ${threadId} links to a missing Project ${data.projectId}`);
  // Owner intent alone never creates a public Project link. A Project that was
  // withheld by the live moderation gate must not leave a dangling id or slug.
  if (!record.prepared || record.data.publishToSite !== true || !exportedProjectIds.has(record.id)) {
    return { activityTitle, projectId: null, projectSlug: null, state: null };
  }
  if (record.prepared.profileThreadId !== threadId) {
    throw new Error(`showcase thread ${threadId} is not Project ${data.projectId}'s fixed source thread`);
  }
  if (data.ownerId !== record.prepared.ownerId) {
    throw new Error(`showcase thread ${threadId} owner does not match Project ${data.projectId}`);
  }
  if (channel.owner_id !== record.prepared.ownerId) {
    throw new Error(`showcase thread ${threadId} live owner does not match Project ${data.projectId}`);
  }
  const archived = channel.thread_metadata?.archived;
  if (typeof archived !== 'boolean') {
    throw new Error(`showcase thread ${threadId} did not return an explicit archived state`);
  }
  return {
    activityTitle,
    projectId: record.id,
    projectSlug: record.prepared.project.slug,
    state: archived ? 'archived' : 'open',
  };
}

// ---------- showcase flow ----------

async function processShowcaseThread(docSnap, ctx) {
  const {
    rest, forumTagCache, pointsMap, dryRun, outDir, publishTagId,
    withheldIds, projectsById, exportedProjectIds,
  } = ctx;
  const threadId = docSnap.id;
  const data = docSnap.data();

  if (data.mode !== 'showcase' || data.threadId !== threadId
    || !DISCORD_SNOWFLAKE_RE.test(String(data.ownerId || ''))
    || !DISCORD_SNOWFLAKE_RE.test(String(data.forumId || ''))) {
    throw new Error(`showcase thread ${threadId} has an invalid registered source association`);
  }
  const approval = await checkGameApproval(rest, {
    threadId,
    ownerId: data.ownerId,
    forumId: data.forumId,
    guildId: config.guildId,
    publishTagId,
  });
  if (!approval.approved) {
    withheldIds.add(threadId);
    return null;
  }
  const channel = approval.channel;
  const projectFields = resolveShowcaseProjectFields(
    data, channel, threadId, projectsById, exportedProjectIds,
  );

  const tagMap = await getForumTagMap(rest, data.forumId, forumTagCache);
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
      ({ ext } = await downloadOptimizedAttachment(att.url, destDir, threadId, resolveImageExt(att)));
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
      ...projectFields,
    }),
    hasImage,
    recovered,
  };
}

async function runShowcaseFlow(rest, db, args, projectsById, exportedProjectIds) {
  const pointsMap = await buildFeedbackPointsMap(db);
  const threadsSnap = await db.collection('threads').where('mode', '==', 'showcase').get();
  let threadDocs = threadsSnap.docs;
  if (args.limit) threadDocs = threadDocs.slice(0, args.limit);

  const forumTagCache = new Map();
  const awardEmojiCache = new Map();

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
      withheldIds,
      projectsById,
      exportedProjectIds,
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
  const tempPath = `${filePath}.${process.pid}.tmp`;
  try {
    await fs.writeFile(tempPath, `${JSON.stringify(stablePayload, null, 2)}\n`);
    await fs.rename(tempPath, filePath);
  } catch (err) {
    await fs.rm(tempPath, { force: true });
    throw err;
  }
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

export async function cleanProjectAssets(outDir, referencedPaths) {
  const root = path.join(outDir, 'public', 'assets', 'projects');
  await fs.mkdir(root, { recursive: true });
  const bySlug = new Map();
  for (const assetPath of referencedPaths) {
    const match = /^\/assets\/projects\/([a-z0-9]+(?:-[a-z0-9]+)*)\/_discord-export\/([^/]+)$/.exec(assetPath);
    if (!match) throw new Error(`generated Project asset has an unsafe path: ${assetPath}`);
    const paths = bySlug.get(match[1]) || [];
    paths.push(assetPath);
    bySlug.set(match[1], paths);
  }

  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const generatedDir = path.join(root, entry.name, PROJECT_GENERATED_DIR);
    let generatedStat;
    try {
      generatedStat = await fs.lstat(generatedDir);
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    if (!generatedStat.isDirectory() || generatedStat.isSymbolicLink()) {
      throw new Error(`Project generated asset namespace is not a directory: ${generatedDir}`);
    }
    await removeStaleAssets(generatedDir, bySlug.get(entry.name) || []);
  }
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

function printSummary({ projects, games, missingScreenshots, recoveredCount, jams, jamsRequested, filesWritten, dryRun, withheldProjectIds }) {
  console.log('');
  console.log('=== export-site-data summary ===');
  console.log(`Projects exported: ${projects.length}`);
  console.log(`Games exported: ${games.length}`);
  console.log(`Projects withheld by moderation: ${withheldProjectIds.length}`);
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

  const projectsSnap = await db.collection('projects').get();
  const preparedProjects = prepareProjectExports(projectsSnap.docs);
  const { projects, generatedAssets, withheldProjectIds, exportedProjectIds } = await runProjectsFlow(
    rest,
    db,
    preparedProjects.published,
    args,
  );

  const { games, missingScreenshots, recoveredCount, totalFeedbackPoints, withheldIds } =
    await runShowcaseFlow(rest, db, args, preparedProjects.allById, exportedProjectIds);

  const memberCount = await fetchGuildMemberCount(rest, config.guildId);
  const stats = {
    members: memberCount,
    projects: games.length,
    feedbackPoints: totalFeedbackPoints,
  };
  console.log(
    `Org stats: members=${memberCount ?? 'unavailable'}, projects=${games.length}, feedbackPoints=${totalFeedbackPoints}`,
  );

  const jamsRequested = args.jamsForum.length > 0;
  let jams = [];
  if (jamsRequested) {
    jams = await runJamsFlow(rest, args.jamsForum);
  }

  const publishing = await readProjectPublishing({ db, projects, generatedAt: new Date().toISOString() });

  // Finish every external read and contract transformation before replacing any JSON
  // snapshot. Each file is then written via a same-directory temp file and atomic rename;
  // the workflow's staging clone is the all-files promotion boundary.
  const filesWritten = [];
  if (!args.dryRun) {
    const generatedAt = new Date().toISOString();
    await cleanExportAssets(args.out, games);
    await cleanProjectAssets(args.out, generatedAssets);
    const unpublishedProjectIds = [...preparedProjects.allById.values()]
      .filter(({ data }) => data.publishToSite !== true)
      .map(({ id }) => id)
      .sort();
    await writeReport(args.report, { version: 1, withheldIds, withheldProjectIds, unpublishedProjectIds });
    filesWritten.push(args.report);
    filesWritten.push(await writeJson(args.out, 'project-publishing.json', publishing));
    filesWritten.push(await writeJson(args.out, 'projects.json', {
      version: 1,
      generatedAt,
      projects,
    }));
    filesWritten.push(await writeJson(args.out, 'showcase.json', {
      version: 2,
      generatedAt,
      guildId: config.guildId,
      stats,
      games,
    }));
    if (jamsRequested) {
      filesWritten.push(await writeJson(args.out, 'jams.json', {
        version: 2,
        generatedAt,
        jams,
      }));
    }
  }

  printSummary({
    projects,
    games,
    missingScreenshots,
    recoveredCount,
    jams,
    jamsRequested,
    filesWritten,
    dryRun: args.dryRun,
    withheldProjectIds,
  });

  const exportedNothing = projects.length === 0 && games.length === 0 && (!jamsRequested || jams.length === 0);
  if (exportedNothing) {
    process.exitCode = 1;
  }
}

export { processShowcaseThread };

// Run only when executed directly (isDirectRun encodes reserved path characters
// like #, %, ? correctly — see site-export-shared.mjs).
if (isDirectRun(process.argv[1], import.meta.url)) {
  main().catch((err) => {
    console.error(`[export] fatal: ${err.message}`);
    process.exitCode = 1;
  });
}
