// Aggregation queries over the `points` collection.
//
// Points are event-sourced: a user's score is the count of their docs, weekly score is
// the same count filtered by isoWeek. There is no running total to reset, so a new week
// starts empty automatically just by querying the new week string.

import { getDb } from '../firebase.js';
import { isoWeek } from '../lib/week.js';

function pointsRef() {
  return getDb().collection('points');
}

// Group an array of point docs by commenterId into a sorted leaderboard.
export function tally(docs) {
  const counts = new Map();
  const tags = new Map();
  for (const d of docs) {
    counts.set(d.commenterId, (counts.get(d.commenterId) || 0) + 1);
    if (d.commenterTag) tags.set(d.commenterId, d.commenterTag);
  }
  return [...counts.entries()]
    .map(([commenterId, points]) => ({
      commenterId,
      commenterTag: tags.get(commenterId) || null,
      points,
    }))
    .sort((a, b) => b.points - a.points);
}

// Attach competition ranking to a sorted board: equal scores share a rank, and the next
// distinct score skips ahead by the size of the tie group (1,2,2,4 — not 1,2,2,3).
//
// Sorting alone leaves tied users in arbitrary Firestore order, so numbering rows by
// array index invents a winner. Mods read this board to decide who to thank personally,
// so a fabricated ordering has real consequences.
export function rankBoard(board) {
  let lastPoints = null;
  let lastRank = 0;
  return board.map((entry, i) => {
    if (entry.points !== lastPoints) {
      lastRank = i + 1;
      lastPoints = entry.points;
    }
    return { ...entry, rank: lastRank };
  });
}

// True when `rank` is shared with at least one other entry.
export function isTiedRank(ranked, rank) {
  return ranked.filter((e) => e.rank === rank).length > 1;
}

// Display name for a board entry: the stored tag, else a live mention.
export function displayName(entry) {
  return entry.commenterTag || `<@${entry.commenterId}>`;
}

// Names only, alphabetised case-insensitively — the public thank-you roll.
//
// Sorted by name rather than score on purpose: the weekly post is recognition, not a
// ranking, and a score-ordered list still reads as a ladder even with the numbers gone.
export function rollNames(board) {
  return board
    .map(displayName)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

// Top N for a scope: "week" (current ISO week) or "all".
export async function getLeaderboard({ scope = 'week', limit = 10 } = {}) {
  let query = pointsRef();
  if (scope === 'week') {
    query = query.where('isoWeek', '==', isoWeek());
  }
  const snap = await query.get();
  const board = tally(snap.docs.map((d) => d.data()));
  return sliceKeepingTies(board, limit);
}

// Cut to `limit`, then keep going while the next entry has the same score as the last one
// kept. A plain slice can hide someone who scored exactly as much as the last person
// shown, which is indefensible on a board used to decide who gets thanked.
export function sliceKeepingTies(board, limit) {
  if (limit == null || board.length <= limit) return board;
  let end = limit;
  const boundary = board[limit - 1].points;
  while (end < board.length && board[end].points === boundary) end++;
  return board.slice(0, end);
}

// Stats for a single user: total points, weekly points, and weekly rank (1-based) or
// null if they have no points this week.
export async function getUserStats(userId) {
  const week = isoWeek();

  const [allSnap, weekSnap] = await Promise.all([
    pointsRef().where('commenterId', '==', userId).get(),
    pointsRef().where('commenterId', '==', userId).where('isoWeek', '==', week).get(),
  ]);

  const total = allSnap.size;
  const weekly = weekSnap.size;

  // Weekly rank: build the full weekly board and find the user's position. Ranks are
  // shared on equal scores, so a three-way tie reports #1 for all three rather than
  // handing out 1/2/3 by Firestore order.
  const weekBoardSnap = await pointsRef().where('isoWeek', '==', week).get();
  const ranked = rankBoard(tally(weekBoardSnap.docs.map((d) => d.data())));
  const me = ranked.find((e) => e.commenterId === userId);
  const rank = me ? me.rank : null;
  const tied = me ? isTiedRank(ranked, me.rank) : false;

  return { total, weekly, rank, tied, totalRanked: ranked.length };
}
