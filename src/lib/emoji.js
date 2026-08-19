// Matching the configured helpful emoji against a reaction.
//
// A custom server emoji is identified by its snowflake id; a unicode emoji has no id
// and is identified by its name (the unicode char itself). The config value is the id
// for custom emoji, or the unicode char for standard ones. Matching on id rather than
// name for custom emoji means renaming the emoji in the server doesn't break scoring.

// Parse a configured display emoji (Byte's face) into a renderable message tag and the
// emoji's Discord-CDN image url (usable as a webhook avatar). Accepts:
//   - a bare custom-emoji id ("1234567890")
//   - a full tag ("<:byte:1234567890>", animated "<a:byte:1234567890>")
//   - a unicode emoji ("💾") — tag only; unicode has no CDN image (imageUrl null)
// For a bare id the tag's name part is cosmetic — Discord resolves custom emoji by id,
// so renaming the emoji in the server never breaks it (same trick as reaction matching).
// Use the full <a:name:id> form for an animated emoji so it animates.
export function parseDisplayEmoji(value, fallbackTag = '💾') {
  // Config docs can hold anything; only strings/numbers are meaningful here.
  const raw =
    typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  if (!raw) return { tag: fallbackTag, imageUrl: null };

  const full = /^<(a?):(\w+):(\d+)>$/.exec(raw);
  if (full) {
    const [, animated, name, id] = full;
    return { tag: `<${animated}:${name}:${id}>`, imageUrl: emojiCdnUrl(id, Boolean(animated)) };
  }
  if (/^\d+$/.test(raw)) {
    return { tag: `<:byte:${raw}>`, imageUrl: emojiCdnUrl(raw, false) };
  }
  return { tag: raw, imageUrl: null };
}

function emojiCdnUrl(id, animated) {
  return `https://cdn.discordapp.com/emojis/${id}.${animated ? 'gif' : 'png'}?size=256`;
}

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
