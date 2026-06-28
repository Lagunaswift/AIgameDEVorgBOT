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
function tally(docs) {
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

// Top N for a scope: "week" (current ISO week) or "all".
export async function getLeaderboard({ scope = 'week', limit = 10 } = {}) {
  let query = pointsRef();
  if (scope === 'week') {
    query = query.where('isoWeek', '==', isoWeek());
  }
  const snap = await query.get();
  const board = tally(snap.docs.map((d) => d.data()));
  return board.slice(0, limit);
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

  // Weekly rank: build the full weekly board and find the user's position.
  const weekBoardSnap = await pointsRef().where('isoWeek', '==', week).get();
  const board = tally(weekBoardSnap.docs.map((d) => d.data()));
  const idx = board.findIndex((e) => e.commenterId === userId);
  const rank = idx === -1 ? null : idx + 1;

  return { total, weekly, rank, totalRanked: board.length };
}
