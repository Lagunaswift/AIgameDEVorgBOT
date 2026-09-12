// Keep the production event registry importable without logging in to Discord.
import * as ready from './events/ready.js';
import * as threadCreate from './events/threadCreate.js';
import * as threadUpdate from './events/threadUpdate.js';
import * as messageReactionAdd from './events/messageReactionAdd.js';
import * as messageReactionRemove from './events/messageReactionRemove.js';
import * as interactionCreate from './events/interactionCreate.js';
import * as messageCreate from './events/messageCreate.js';

export const EVENT_MODULES = Object.freeze([
  ready, threadCreate, threadUpdate, messageReactionAdd,
  messageReactionRemove, interactionCreate, messageCreate,
]);
const registeredClients = new WeakSet();

export function registerEventHandlers(client) {
  if (registeredClients.has(client)) return;
  for (const mod of EVENT_MODULES) {
    if (mod.once) client.once(mod.name, (...args) => mod.execute(...args));
    else client.on(mod.name, (...args) => mod.execute(...args));
  }
  registeredClients.add(client);
}
