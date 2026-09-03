// Shared forum-tag exclusion check.
//
// Tags can be excluded by name (matched case-insensitively against the parent forum's
// availableTags) or by raw tag id. Id matching is the sturdier of the two: it needs no
// parent lookup, so it still works when the thread's parent forum isn't cached, and it
// survives the tag being renamed in Discord.

export function threadHasExcludedTag(thread, { names = [], ids = [] } = {}) {
  const applied = thread?.appliedTags;
  if (!applied?.length) return false;

  if (ids.length && applied.some((id) => ids.includes(id))) return true;

  if (!names.length) return false;
  const available = thread.parent?.availableTags;
  if (!available?.length) return false;

  const lowered = names.map((n) => String(n).toLowerCase());
  const excludedIds = available
    .filter((t) => lowered.includes(t.name.toLowerCase()))
    .map((t) => t.id);

  return applied.some((id) => excludedIds.includes(id));
}
