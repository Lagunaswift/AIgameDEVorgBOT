import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeJamId, normalizeProjectUrl } from '../src/lib/publicMetadata.js';

export const DISCORD_SNOWFLAKE_RE = /^\d{17,20}$/;

export function parsePublishTagId(value) {
  const tagId = String(value || '').trim();
  if (!DISCORD_SNOWFLAKE_RE.test(tagId)) {
    throw new Error('SITE_PUBLISH_TAG_ID must be a Discord snowflake');
  }
  return tagId;
}

export function isExplicitlyOptedOut(game) {
  return game && game.publish === false;
}

export function validateExportReport(report) {
  if (!report || report.version !== 1 || !Array.isArray(report.withheldIds)) {
    throw new Error('export report must contain version 1 and a withheldIds array');
  }
  const ids = new Set();
  for (const id of report.withheldIds) {
    if (!DISCORD_SNOWFLAKE_RE.test(String(id || ''))) {
      throw new Error('export report contains an invalid withheld id');
    }
    if (ids.has(id)) throw new Error(`export report contains duplicate withheld id ${id}`);
    ids.add(id);
  }
  return report;
}

export function semanticSnapshot(snapshot) {
  const { generatedAt, ...semantic } = snapshot;
  return semantic;
}

export function preserveGeneratedAtIfUnchanged(previous, candidate) {
  if (!previous || JSON.stringify(semanticSnapshot(previous)) !== JSON.stringify(semanticSnapshot(candidate))) {
    return candidate;
  }
  return { ...candidate, generatedAt: previous.generatedAt };
}

export function validateShowcaseSnapshot(candidate, previous, report = { version: 1, withheldIds: [] }) {
  validateExportReport(report);
  if (!candidate || candidate.version !== 2 || !Array.isArray(candidate.games)) {
    throw new Error('candidate showcase.json must contain version 2 and a games array');
  }
  if (!Number.isNaN(Date.parse(candidate.generatedAt || ''))) {
    // Valid ISO timestamps are required; Date.parse alone also accepts some non-ISO forms.
    if (!/^\d{4}-\d{2}-\d{2}T.*Z$/.test(candidate.generatedAt)) {
      throw new Error('candidate showcase.json generatedAt must be an ISO timestamp');
    }
  } else {
    throw new Error('candidate showcase.json generatedAt must be an ISO timestamp');
  }

  const candidateIds = new Set();
  for (const game of candidate.games) {
    if (!game || !DISCORD_SNOWFLAKE_RE.test(String(game.id || ''))) {
      throw new Error('candidate showcase.json contains a game with an invalid id');
    }
    if (candidateIds.has(game.id)) {
      throw new Error(`candidate showcase.json contains duplicate game id ${game.id}`);
    }
    if (game.publish !== true) {
      throw new Error(`candidate game ${game.id} must set publish: true`);
    }
    if (typeof game.title !== 'string' || !game.title.trim()) {
      throw new Error(`candidate game ${game.id} must have a title`);
    }
    if (Object.hasOwn(game, 'authorId') || Object.hasOwn(game, 'forumId')) {
      throw new Error(`candidate game ${game.id} contains private metadata`);
    }
    if (!['project', 'jam-entry'].includes(game.kind)) {
      throw new Error(`candidate game ${game.id} must have a valid kind`);
    }
    if (!Object.hasOwn(game, 'jamId') || (game.jamId !== null && !normalizeJamId(game.jamId))) {
      throw new Error(`candidate game ${game.id} has an invalid jamId`);
    }
    if ((game.kind === 'jam-entry') !== (game.jamId !== null)) {
      throw new Error(`candidate game ${game.id} has inconsistent kind and jamId`);
    }
    if (!Object.hasOwn(game, 'projectUrl') || (game.projectUrl !== null && !normalizeProjectUrl(game.projectUrl))) {
      throw new Error(`candidate game ${game.id} has an invalid projectUrl`);
    }
    if (!Number.isInteger(game.feedbackPoints) || game.feedbackPoints < 0) {
      throw new Error(`candidate game ${game.id} has an invalid feedbackPoints count`);
    }
    if (typeof game.needsFeedback !== 'boolean' || game.needsFeedback !== (game.feedbackPoints === 0)) {
      throw new Error(`candidate game ${game.id} has inconsistent needsFeedback`);
    }
    candidateIds.add(game.id);
  }

  // v1 is accepted only as the prior snapshot during the one-way v2 migration. It is
  // never a valid candidate contract, so a site loader cannot render it by accident.
  if (!previous || ![1, 2].includes(previous.version) || !Array.isArray(previous.games)) return;
  const withheldIds = new Set(report.withheldIds);
  const missing = previous.games
    // Every v1 record was previously public. During the one-way migration, a
    // record can disappear only when the exporter saw it and recorded it as
    // withheld (for example because the owner did not add the opt-in tag).
    .filter((game) => game && (previous.version === 1 || game.publish === true) && !candidateIds.has(game.id) && !withheldIds.has(game.id))
    .map((game) => game.id);
  if (missing.length) {
    throw new Error(`candidate showcase.json would remove non-opted-out project(s): ${missing.join(', ')}`);
  }
}

export async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

export async function removeStaleAssets(directory, referencedPaths) {
  await fs.mkdir(directory, { recursive: true });
  const expected = new Set(referencedPaths.map((assetPath) => path.basename(assetPath)));
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.isFile() && !expected.has(entry.name)) {
      await fs.unlink(path.join(directory, entry.name));
    }
  }
}
