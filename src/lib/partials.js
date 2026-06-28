// Partial resolution for reaction events.
//
// The bot receives reactions on messages it hasn't cached — anything posted before the
// bot started, or after a restart. Those arrive as partial objects that score nothing
// unless fetched. Every reaction handler must resolve partials before doing anything,
// and bail safely (not throw) if the fetch fails.

// Resolve a reaction and its message. Returns true on success, false if anything failed
// (e.g. the message was deleted). Callers should bail on false.
export async function resolveReactionPartials(reaction) {
  try {
    if (reaction.partial) {
      await reaction.fetch();
    }
    if (reaction.message.partial) {
      await reaction.message.fetch();
    }
    return true;
  } catch (err) {
    console.error('[partials] failed to resolve reaction/message partial:', err.message);
    return false;
  }
}
