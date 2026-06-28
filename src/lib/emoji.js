// Matching the configured helpful emoji against a reaction.
//
// A custom server emoji is identified by its snowflake id; a unicode emoji has no id
// and is identified by its name (the unicode char itself). The config value is the id
// for custom emoji, or the unicode char for standard ones. Matching on id rather than
// name for custom emoji means renaming the emoji in the server doesn't break scoring.

// configuredEmoji: the raw config value (e.g. "✅" or "1234567890").
// reactionEmoji: a discord.js ReactionEmoji / GuildEmoji (reaction.emoji).
export function emojiMatches(configuredEmoji, reactionEmoji) {
  if (!configuredEmoji || !reactionEmoji) return false;

  const isCustomConfig = /^\d+$/.test(configuredEmoji);

  if (isCustomConfig) {
    // Custom emoji: compare snowflake ids.
    return reactionEmoji.id === configuredEmoji;
  }

  // Unicode emoji: a custom emoji has an id, so it can never match a unicode config.
  if (reactionEmoji.id) return false;
  return reactionEmoji.name === configuredEmoji;
}
