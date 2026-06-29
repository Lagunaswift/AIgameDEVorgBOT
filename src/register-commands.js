import 'dotenv/config';

import { REST, Routes } from 'discord.js';
import { config, assertConfig } from './config.js';
import { loadCommands } from './loadCommands.js';

async function main() {
  assertConfig();

  const commands = await loadCommands();
  const body = [...commands.values()].map((c) => c.data.toJSON());

  const rest = new REST({ version: '10' }).setToken(config.discordToken);

  console.log(`[register] registering ${body.length} commands to guild ${config.guildId}...`);
  const data = await rest.put(
    Routes.applicationGuildCommands(config.clientId, config.guildId),
    { body },
  );
  console.log(`[register] done. ${data.length} commands now live:`);
  for (const c of data) console.log(`  /${c.name}`);
}

main().catch((err) => {
  console.error('[register] failed:', err);
  process.exit(1);
});
