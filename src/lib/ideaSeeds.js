// Ingredient pools for /gameidea. The generator rolls a random collision of these and
// (when an API key is configured) hands it to Claude to develop into a coherent pitch.
// The random seed is what keeps output diverse: a model asked "funny game idea" with no
// constraints converges on the same five jokes; a model asked to reconcile "a souls-like"
// with "a grandmother with a leaf blower" in "the lost-property office of a train
// network" has to actually invent something.
//
// House rules for pool entries: specific beats wacky, no real brands or people (ideas
// should be buildable without a lawsuit), and every entry must collide well with the
// other pools — if it only works in one combination it's a punchline, not an ingredient.

export const GENRES = [
  'a roguelike deck-builder',
  'a dating sim',
  'a farming sim',
  'a souls-like',
  'a city builder',
  'an idle clicker',
  'a rhythm game',
  'a tower defence game',
  'a visual novel',
  'a battle royale',
  'a metroidvania',
  'a physics sandbox',
  'a racing sim',
  'a fishing game',
  'a courtroom drama',
  'a stealth game',
  'a typing game',
  'a golf game',
  'a survival crafting game',
  'a puzzle platformer',
  'a boomer shooter',
  'a cosy management sim',
  'a grand strategy game',
  'an escape room game',
  'a walking simulator',
  'a horror game',
  'an immersive sim',
  'a sports management sim',
];

export const PROTAGONISTS = [
  'a tax auditor',
  'a sentient vending machine',
  'the last IT technician on Earth',
  'a pigeon with a grudge',
  'a medieval health-and-safety inspector',
  'an unpaid intern at a necromancy startup',
  'a grandmother with a leaf blower',
  'a final boss working their notice period',
  'a ghost who can only possess office equipment',
  'an extremely tired dad',
  'an insurance adjuster specialising in dragon damage',
  'a mimic trying to go straight',
  'the fourth musketeer nobody remembers',
  'a lighthouse keeper who is afraid of the sea',
  'an NPC who has become self-aware, but only slightly',
  'a substitute teacher at a wizard school',
  'a raccoon with a business plan',
  'the janitor of a superhero headquarters',
  'a retired horse',
  'a smart fridge with abandonment issues',
  'a bureaucrat in the afterlife',
  'a slime promoted to middle management',
  'a time traveller who can only go back four seconds',
  'a knight sponsored by a mattress company',
  'the understudy for the chosen one',
  'a druid who can only turn into invertebrates',
  'a delivery driver during the apocalypse',
  'a very small god of a very specific thing',
];

export const SETTINGS = [
  'a haunted flat-pack furniture warehouse',
  "the inside of someone's CV",
  'a procedurally generated retail park',
  'a space station governed by homeowners-association rules',
  'the last video rental shop on Earth',
  'a Bronze Age professional-networking event',
  'the staff room of a dungeon',
  'a garden centre after closing time',
  'a submarine crewed entirely by cats',
  'the lost-property office of a train network',
  'a music festival for the undead',
  'the server room of a failing MMO',
  'a medieval theme park cutting corners',
  "the world's least secure bank",
  'a lighthouse at the edge of the map',
  'an all-you-can-eat buffet during a heist',
  'the moon, but zoned for light industry',
  'a village where everyone is a suspect',
  'the inside of a corrupted save file',
  'a national park for retired kaiju',
  'an airport where time works differently',
  'the break room between boss fights',
  'a cursed allotment',
  'a call centre for wizards',
];

export const TWISTS = [
  'the entire UI is physics-simulated and can be knocked over',
  'you can only move while the music is playing',
  'the game permanently deletes one mechanic every level',
  "the NPCs have permadeath, but only for their feelings",
  'the tutorial narrator is actively trying to get you killed',
  'your inventory is a literal game of Tetris-style block packing',
  'the difficulty is controlled by real-world weather',
  'every item is load-bearing',
  'saving the game is a boss fight',
  'the map is honest but the compass lies',
  'you level down with experience',
  'the pause menu exists inside the game world and can be stolen',
  'each death adds your corpse to the level geometry',
  'the entire economy is run by one extremely emotional shopkeeper',
  'you are the escort mission',
  'the credits have been playing quietly the whole time',
  'your health bar is shared with your worst enemy',
  'the loading screens are canon',
  'the game is turn-based, but each turn lasts 0.8 seconds',
  'it is multiplayer, but everyone controls the same character',
  'the final boss can hear your microphone',
  'quicksaving ages the protagonist by one year',
  'the skill tree is a real tree and needs watering',
  'every NPC remembers exactly one thing you did, forever',
];

function pickFrom(pool) {
  return pool[Math.floor(Math.random() * pool.length)];
}

// Roll a collision: always a genre and a protagonist, then a setting and/or a twist —
// at least one of the two, sometimes both. Three ingredients is a premise; four is a
// premise with a complication.
export function rollIngredients() {
  const withSetting = Math.random() < 0.8;
  const withTwist = Math.random() < 0.7 || !withSetting;
  return {
    genre: pickFrom(GENRES),
    protagonist: pickFrom(PROTAGONISTS),
    setting: withSetting ? pickFrom(SETTINGS) : null,
    twist: withTwist ? pickFrom(TWISTS) : null,
  };
}

// Compact "genre × protagonist × setting" label for the footer of the posted idea.
export function describeSeed(seed) {
  return [seed.genre, seed.protagonist, seed.setting, seed.twist]
    .filter(Boolean)
    .join(' × ');
}

// No-API-key fallback: serve the raw collision as a mad-lib. Less polished than the
// developed pitch, still a perfectly usable jam prompt.
export function madlibsIdea(seed, number) {
  const lines = [
    `**Untitled Masterpiece #${number}**`,
    `${capitalise(seed.genre)} where you play as ${seed.protagonist}` +
      `${seed.setting ? `, set in ${seed.setting}` : ''}.`,
  ];
  if (seed.twist) lines.push(`**The hook:** ${seed.twist}.`);
  return lines.join('\n');
}

function capitalise(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
