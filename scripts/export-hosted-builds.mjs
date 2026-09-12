import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { initFirebase, getDb } from '../src/firebase.js';
import { buildHostedBuildsExport } from './hosted-builds-export.mjs';

function parseArgs(argv) {
  const args = { out: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') args.out = argv[++i];
    else if (argv[i].startsWith('--out=')) args.out = argv[i].slice('--out='.length);
  }
  if (!args.out) throw new Error('export-hosted-builds: --out is required');
  return args;
}

async function collectionDocs(db, name) {
  const snapshot = await db.collection(name).get();
  return snapshot.docs;
}

async function writeAtomic(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`);
    await fs.rename(temp, filePath);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
}

export async function exportHostedBuilds({ db, outDir, generatedAt = new Date().toISOString() }) {
  const [projectDocs, buildDocs, buildStateDocs, submissionDocs, eligibilityDocs, jamDocs] = await Promise.all([
    collectionDocs(db, 'projects'),
    collectionDocs(db, 'projectBuilds'),
    collectionDocs(db, 'projectBuildState'),
    collectionDocs(db, 'jamSubmissions'),
    collectionDocs(db, 'jamEligibility'),
    collectionDocs(db, 'jams'),
  ]);

  const payload = buildHostedBuildsExport({
    projectDocs,
    buildDocs,
    buildStateDocs,
    submissionDocs,
    eligibilityDocs,
    jamDocs,
    generatedAt,
  });
  const filePath = path.join(outDir, 'src', 'data', 'builds.json');
  await writeAtomic(filePath, payload);
  return { filePath, builds: payload.builds.length, jamSubmissions: payload.jamSubmissions.length };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) throw new Error('export-hosted-builds: FIREBASE_SERVICE_ACCOUNT is required');
  initFirebase();
  const result = await exportHostedBuilds({ db: getDb(), outDir: path.resolve(args.out) });
  console.log(`Hosted Builds exported: ${result.builds}`);
  console.log(`Hosted Jam submissions exported: ${result.jamSubmissions}`);
  console.log(`File written: ${result.filePath}`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  main().catch((error) => {
    console.error(`[hosted-builds-export] fatal: ${error.message}`);
    process.exitCode = 1;
  });
}
