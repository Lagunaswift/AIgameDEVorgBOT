#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { getDb, initFirebase } from '../src/firebase.js';
import { buildHostedPlatformExport } from './hosted-platform-export-lib.mjs';

function parseArgs(argv) {
  const args = { out: null };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--out') args.out = argv[++index];
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!args.out) throw new Error('Usage: node scripts/export-hosted-platform.mjs --out <site-directory>');
  return args;
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

function docs(snapshot, idField = null) {
  return snapshot.docs.map((doc) => {
    const value = doc.data();
    return idField && !value[idField] ? { ...value, [idField]: doc.id } : value;
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const siteRoot = path.resolve(args.out);
  const dataDir = path.join(siteRoot, 'src', 'data');
  const [projectPayload, jamPayload] = await Promise.all([
    readJson(path.join(dataDir, 'projects.json')),
    readJson(path.join(dataDir, 'jams.json')),
  ]);

  initFirebase();
  const db = getDb();
  const [buildsSnap, statesSnap, submissionsSnap, eligibilitiesSnap] = await Promise.all([
    db.collection('projectBuilds').get(),
    db.collection('projectBuildState').get(),
    db.collection('jamSubmissions').get(),
    db.collection('jamEligibility').get(),
  ]);

  const payload = buildHostedPlatformExport({
    generatedAt: new Date().toISOString(),
    projectPayload,
    jamPayload,
    builds: docs(buildsSnap, 'buildId'),
    buildStates: docs(statesSnap, 'projectId'),
    submissions: docs(submissionsSnap),
    eligibilities: docs(eligibilitiesSnap),
  });

  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, 'builds.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`[hosted-export] ${payload.builds.length} public builds; ${payload.jamSubmissions.length} public jam submissions`);
}

main().catch((error) => {
  console.error(`[hosted-export] ${error.message}`);
  process.exitCode = 1;
});
