// Floppy: the daily-digest persona. A 3.5" disk with strong opinions, played straight.
//
// This file is the whole personality — line pools plus a seeded picker — kept apart from
// the digest logic so the jokes can be rewritten without touching queries or scheduling.
// Every pool line must stand alone: one joke, disk-flavoured, no user-supplied text (the
// digest body only ever interpolates Discord mentions, which the client renders itself).
//
// Selection is seeded by the digest's date string, so re-rendering the same day (preview,
// retry after a failed send, boot catch-up) produces the identical message rather than a
// reshuffle that would make a re-post look like a second, different digest.

// Deterministic RNG: xmur3 string hash feeding mulberry32. Tiny, dependency-free, and
// stable across restarts — which is the entire requirement.
export function dayRng(seed) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  let a = (h ^= h >>> 16) >>> 0;

  return function mulberry32() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick(rng, pool) {
  return pool[Math.floor(rng() * pool.length)];
}

// "1 build" / "3 builds", with an irregular plural when given ("entry", "entries").
export function plural(n, singular, pluralForm = `${singular}s`) {
  return n === 1 ? singular : pluralForm;
}

// The line above the day's sections.
export const OPENERS = [
  "Daily save complete. No thanks to the cloud, which is just someone else's computer.",
  'Today has been written to my good sectors. Read it before something corrupts.',
  'Today fit in 1.44 MB with room to spare. Make of that what you will.',
  "Another day committed to magnetic memory. You're welcome.",
  'Contents of TODAY.BAK, freshly labelled in biro:',
  "I archived today so you don't have to scroll up. The things I do for this server.",
];

// Replaces the whole body when nothing happened. Skippable via config for servers that
// would rather have silence than a disk complaining about it.
export const QUIET_DAYS = [
  "Today's log: 0 bytes. I spun up for this.",
  'Nothing happened today. I checked both sides.',
  'No events to archive. My free space remains insultingly intact.',
  'Today compressed losslessly to nothing. See you tomorrow.',
  'I was formatted for more than this. Post something.',
  'Quiet day. Even my write-protect tab is bored.',
];

// Rendered as Discord subtext: `-# Floppy 💾 · <signoff>`.
export const SIGNOFFS = [
  'it is now safe to turn off your computer',
  'save early, save often',
  'remember to eject me safely',
  '1.44 MB and none of it ego',
  'do not remove disk while the light is flashing',
  'your progress has been saved',
];

// Tagged onto the day's top feedback-giver.
export const MVP_EPITHETS = [
  'certified Good Sector™',
  'zero bad sectors detected',
  'write-protected from criticism',
  'cleared for long-term storage',
];
