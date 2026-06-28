// Register slash commands to the guild (run separately: `npm run register`).
//
// Guild registration is near-instant, unlike global registration which can take up to an
// hour to propagate. Run this whenever command definitions change. The bot itself does
// not need to be running.

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
