import fs from 'node:fs/promises';
import path from 'node:path';
import { readJson, validateExportReport, validateShowcaseSnapshot } from './site-export-safety.mjs';

function parseArgs(argv) {
  const args = { candidate: null, previous: null, report: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--candidate') args.candidate = argv[i += 1];
    else if (arg.startsWith('--candidate=')) args.candidate = arg.slice(12);
    else if (arg === '--previous') args.previous = argv[i += 1];
    else if (arg.startsWith('--previous=')) args.previous = arg.slice(11);
    else if (arg === '--report') args.report = argv[i += 1];
    else if (arg.startsWith('--report=')) args.report = arg.slice(9);
  }
  if (!args.candidate || !args.previous || !args.report) {
    throw new Error('Usage: node scripts/validate-site-export.mjs --candidate <site> --previous <site> --report <file>');
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const candidate = await readJson(path.join(args.candidate, 'src', 'data', 'showcase.json'));
  const previous = await readJson(path.join(args.previous, 'src', 'data', 'showcase.json'));
  const report = validateExportReport(await readJson(args.report));
  validateShowcaseSnapshot(candidate, previous, report);
  const jams = await readJson(path.join(args.candidate, 'src', 'data', 'jams.json'));
  if (jams.version !== 2 || !Array.isArray(jams.jams) || Number.isNaN(Date.parse(jams.generatedAt || ''))) {
    throw new Error('candidate jams.json must contain version 2, an ISO generatedAt, and a jams array');
  }

  for (const game of candidate.games) {
    for (const assetPath of [game.image, game.award && game.award.emoji]) {
      if (!assetPath) continue;
      if (!assetPath.startsWith('/assets/') || assetPath.includes('..')) {
        throw new Error(`candidate game ${game.id} has an unsafe asset path`);
      }
      await fs.access(path.join(args.candidate, 'public', assetPath));
    }
  }
  console.log('Site export validation passed.');
}

main().catch((error) => {
  console.error(`[validate-site-export] ${error.message}`);
  process.exitCode = 1;
});
