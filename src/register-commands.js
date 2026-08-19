import 'dotenv/config';

import { config, assertConfig } from './config.js';
import { loadCommands } from './loadCommands.js';
import { registerGuildCommands } from './lib/registerCommands.js';

async function main() {
  assertConfig();

  const commands = await loadCommands();

  console.log(`[register] registering ${commands.size} commands to guild ${config.guildId}...`);
  const data = await registerGuildCommands(commands);
  console.log(`[register] done. ${data.length} commands now live:`);
  for (const c of data) console.log(`  /${c.name}`);
}

main().catch((err) => {
  console.error('[register] failed:', err);
  process.exit(1);
});
