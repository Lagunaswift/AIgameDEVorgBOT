// Keep the existing UTF-16 length budget without cutting an emoji/surrogate pair.
// Repair malformed input as well; strict JSON consumers reject lone surrogates.
export function truncateWellFormed(value, maxChars) {
  if (!Number.isSafeInteger(maxChars) || maxChars < 0) {
    throw new RangeError('maxChars must be a non-negative safe integer');
  }
  const text = String(value ?? '').toWellFormed();
  let end = Math.min(text.length, maxChars);
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return text.slice(0, end);
}
