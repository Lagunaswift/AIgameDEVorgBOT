// Build the command registry from src/commands/*.js.
//
// A command file may export either a single command (`data` + `execute`) or a `commands`
// array of such objects (admin.js does this). Both shapes are flattened into one Map
// keyed by command name, used by the interaction router and the registration script.

import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const commandsDir = join(here, 'commands');

export async function loadCommands() {
  const files = (await readdir(commandsDir)).filter((f) => f.endsWith('.js'));
  const map = new Map();

  for (const file of files) {
    const mod = await import(pathToFileURL(join(commandsDir, file)).href);
    const defs = Array.isArray(mod.commands)
      ? mod.commands
      : mod.data && mod.execute
        ? [{ data: mod.data, execute: mod.execute }]
        : [];

    if (defs.length === 0) {
      console.warn(`[commands] ${file} exports no usable command; skipping`);
      continue;
    }

    for (const def of defs) {
      if (!def.data || typeof def.execute !== 'function') {
        console.warn(`[commands] a command in ${file} is missing data/execute; skipping`);
        continue;
      }
      map.set(def.data.name, def);
    }
  }

  return map;
}
