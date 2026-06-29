import 'dotenv/config';

import { REST, Routes, InteractionContextType, ApplicationIntegrationType } from 'discord.js';
import { config, assertConfig } from './config.js';
import { loadCommands } from './loadCommands.js';

async function main() {
  assertConfig();

  const commands = await loadCommands();
  // Make the install/usage scope explicit: guild-installed, usable in every guild
  // channel (including threads). This only sets where a command *can* live — it does
  // NOT control per-channel visibility. If commands show in some channels but not
  // others, that's a Discord server setting (Integration command permissions or a
  // channel permission override), not this payload — see the README troubleshooting.
  const body = [...commands.values()].map((c) => {
    c.data
      .setContexts(InteractionContextType.Guild)
      .setIntegrationTypes(ApplicationIntegrationType.GuildInstall);
    return c.data.toJSON();
  });

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
