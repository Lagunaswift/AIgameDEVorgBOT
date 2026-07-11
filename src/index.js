import 'dotenv/config';

import { Client, GatewayIntentBits, Partials, Collection, Events } from 'discord.js';
import { config, assertConfig } from './config.js';
import { initFirebase } from './firebase.js';
import { loadCommands } from './loadCommands.js';
import { scheduleWeeklyPost, catchUpWeeklyPost } from './services/weeklyPost.js';

// Event modules, imported once and bound at startup.
import * as ready from './events/ready.js';
import * as threadCreate from './events/threadCreate.js';
import * as messageReactionAdd from './events/messageReactionAdd.js';
import * as messageReactionRemove from './events/messageReactionRemove.js';
import * as interactionCreate from './events/interactionCreate.js';
import * as messageCreate from './events/messageCreate.js';

const EVENT_MODULES = [
  ready,
  threadCreate,
  messageReactionAdd,
  messageReactionRemove,
  interactionCreate,
  messageCreate,
];

async function main() {
  assertConfig();
  initFirebase();

  const client = new Client({
    // Gateway intents. MessageContent is privileged and needed to read comment length
    // for the anti-farm floor — enable it in the Developer Portal too.
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.MessageContent,
    ],
    // Partials. Without these, reactions on uncached messages (anything before the bot
    // started, or after a restart) arrive incomplete and score nothing.
    partials: [Partials.Message, Partials.Channel, Partials.Reaction],
  });

  // Command registry, available to the interaction router via client.commands.
  client.commands = new Collection();
  const commands = await loadCommands();
  for (const [name, def] of commands) client.commands.set(name, def);
  console.log(`[startup] loaded ${client.commands.size} commands`);

  // Bind event handlers exactly once. discord.js auto-reconnects on the same client, so
  // we must not re-register on reconnect.
  for (const mod of EVENT_MODULES) {
    if (mod.once) {
      client.once(mod.name, (...args) => mod.execute(...args));
    } else {
      client.on(mod.name, (...args) => mod.execute(...args));
    }
  }

  // Schedule the weekly leaderboard post once we're ready (needs a live client).
  client.once(Events.ClientReady, () => {
    if (config.weeklyPostEnabled) {
      scheduleWeeklyPost(client);
      // Catch up on boot: if the previous week's post never went out (a restart across the
      // Monday boundary, or a permission error that's since been fixed), post it now. The
      // per-week marker keeps this to at most one post per week.
      catchUpWeeklyPost(client).catch((err) =>
        console.error('[weeklyPost] catch-up failed:', err.message),
      );
    } else {
      console.log('[startup] weekly post disabled via WEEKLY_POST_ENABLED=false');
    }
  });

  // Surface gateway errors rather than dying silently.
  client.on(Events.Error, (err) => console.error('[client] error:', err));
  client.on(Events.Warn, (msg) => console.warn('[client] warn:', msg));

  await client.login(config.discordToken);
}

// Don't let an unhandled rejection take the always-on process down silently.
process.on('unhandledRejection', (reason) => {
  console.error('[process] unhandled rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[process] uncaught exception:', err);
});

main().catch((err) => {
  console.error('[startup] fatal:', err);
  process.exit(1);
});
