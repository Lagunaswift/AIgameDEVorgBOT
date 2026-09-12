import { FieldValue, getDb, serverTimestamp } from '../firebase.js';
import { runtimeDecision } from '../lib/hostedBuilds.js';

function refs(db, projectId) {
  return {
    project: db.collection('projects').doc(projectId),
    state: db.collection('projectBuildState').doc(projectId),
  };
}

async function loadBuildForState(db, state) {
  const ids = [...new Set([state?.requestedBuildId, state?.publishedBuildId].filter(Boolean))];
  if (!ids.length) return [];
  const snapshots = await Promise.all(ids.map((id) => db.collection('projectBuilds').doc(id).get()));
  return snapshots.filter((snap) => snap.exists).map((snap) => ({ id: snap.id, ...snap.data() }));
}

export function createFailClosedRuntimeControl() {
  return {
    async publish() { throw new Error('Hosted runtime control is not configured'); },
    async revoke() { return { ok: true, provider: 'not-configured' }; },
  };
}

export async function reconcileHostedBuildsForProject({
  projectId,
  moderatorApproved,
  db = getDb(),
  runtimeControl = createFailClosedRuntimeControl(),
  timestamp = serverTimestamp(),
}) {
  const { project: projectRef, state: stateRef } = refs(db, projectId);
  const [projectSnap, stateSnap] = await Promise.all([projectRef.get(), stateRef.get()]);
  if (!projectSnap.exists) return { status: 'missing-project', decisions: [] };

  const project = { id: projectSnap.id, ...projectSnap.data() };
  const state = stateSnap.exists ? stateSnap.data() : {};
  const builds = await loadBuildForState(db, state);
  const decisions = [];

  for (const build of builds) {
    const decision = runtimeDecision({ project, build, moderatorApproved });
    decisions.push({ buildId: build.id, ...decision });
    if (decision.action === 'none') continue;

    const buildRef = db.collection('projectBuilds').doc(build.id);
    if (decision.action === 'revoke') {
      try {
        await runtimeControl.revoke({ projectId, buildId: build.id });
      } finally {
        await Promise.all([
          buildRef.set({ runtimeState: 'revoked', reconcileNeeded: false, moderationApproved: Boolean(moderatorApproved), updatedAt: timestamp }, { merge: true }),
          stateRef.set({ publishedBuildId: FieldValue.delete(), moderationApproved: Boolean(moderatorApproved), updatedAt: timestamp }, { merge: true }),
        ]);
      }
      continue;
    }

    try {
      await runtimeControl.publish({ projectId, buildId: build.id });
      await Promise.all([
        buildRef.set({ runtimeState: 'public', reconcileNeeded: false, moderationApproved: true, updatedAt: timestamp }, { merge: true }),
        stateRef.set({ publishedBuildId: build.id, requestedBuildId: FieldValue.delete(), moderationApproved: true, updatedAt: timestamp }, { merge: true }),
      ]);
    } catch (error) {
      await Promise.all([
        buildRef.set({ runtimeState: 'requested', reconcileNeeded: true, moderationApproved: true, updatedAt: timestamp }, { merge: true }),
        stateRef.set({ requestedBuildId: build.id, moderationApproved: true, updatedAt: timestamp }, { merge: true }),
      ]);
      decisions[decisions.length - 1].runtimeError = error.message;
    }
  }

  if (!builds.length) {
    await stateRef.set({ moderationApproved: Boolean(moderatorApproved), updatedAt: timestamp }, { merge: true });
  }
  return { status: 'ok', decisions };
}

export async function reconcileHostedBuildsForThread({ threadId, moderatorApproved, db = getDb(), runtimeControl }) {
  const threadSnap = await db.collection('threads').doc(threadId).get();
  if (!threadSnap.exists) return { status: 'unregistered-thread', decisions: [] };
  const thread = threadSnap.data();
  if (thread.mode !== 'showcase' || !thread.projectId) return { status: 'not-project-source', decisions: [] };
  return reconcileHostedBuildsForProject({ projectId: thread.projectId, moderatorApproved, db, runtimeControl });
}
