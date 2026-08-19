// Push the loaded command definitions to the guild. Discord's PUT is a full replace and
// idempotent, so this is safe to run on every boot — which is exactly what index.js does,
// making a deploy alone enough for new slash commands to appear. The standalone
// `npm run register` script uses the same call for manual runs.

import { REST, Routes } from 'discord.js';
import { config } from '../config.js';

export async function registerGuildCommands(commands) {
  const body = [...commands.values()].map((c) => c.data.toJSON());
  const rest = new REST({ version: '10' }).setToken(config.discordToken);
  return rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), { body });
}
