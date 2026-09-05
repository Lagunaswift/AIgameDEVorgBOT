// Transaction-behaviour integration against a real Firestore emulator.
//
// Skips (and reports why) unless FIRESTORE_EMULATOR_HOST is set, so CI or an operator
// can opt in:   FIRESTORE_EMULATOR_HOST=localhost:8080 GCLOUD_PROJECT=aigame-dev-test \
//               npx node --test test/migrate-projects.emulator.test.mjs
// Tests never touch production credentials: the emulator app initialises with a
// project id only, no service account.

import assert from 'node:assert/strict';
import test from 'node:test';

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;

test('transaction apply against the Firestore emulator', { skip: emulatorHost ? false : 'FIRESTORE_EMULATOR_HOST not set; emulator integration skipped' }, async (t) => {
  const admin = (await import('firebase-admin')).default;
  const {
    applyMigrationPlanTransaction,
    applyMigrationRecordTransaction,
  } = await import('../src/services/migration.js');

  const appName = 'migrate-emulator-test';
  const app = admin.apps.some((a) => a.name === appName)
    ? admin.app(appName)
    : admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'aigame-dev-test' }, appName);
  const db = app.firestore();
  db.settings({ ignoreUndefinedProperties: true });

  const OWNER = '123456789012345678';
  const THREAD = '900345678901234567';
  const PROJECT_ID = `mig-${Date.now()}`;

  const threadRef = db.collection('threads').doc(THREAD);
  const projectRef = db.collection('projects').doc(PROJECT_ID);
  await threadRef.set({
    threadId: THREAD, ownerId: OWNER, mode: 'showcase', forumId: '1051088980176805920',
    projectId: null, purpose: null, createdAt: 'then', registeredAt: 'then',
  });
  const planRecord = {
    threadId: THREAD,
    disposition: 'create',
    plannedProjectId: PROJECT_ID,
    slug: 'emulator-game',
    eligibility: { forumId: '1051088980176805920', consentTag: true },
    expectedThread: { mode: 'showcase', forumId: '1051088980176805920', projectUrl: null },
    metadata: {
      ownerId: OWNER, title: 'Emulator Game', slug: 'emulator-game',
      summary: 'An emulator-verified game.', status: 'development',
      projectUrl: null, platforms: ['web'], profileThreadId: THREAD,
    },
  };

  // Atomic commit: Project created + thread backlinked in one transaction.
  await db.runTransaction((transaction) => applyMigrationRecordTransaction({
    transaction, threadRef, projectRef, planRecord, timestamp: 'now',
  }));

  const projectSnap = await projectRef.get();
  assert.equal(projectSnap.exists, true);
  assert.equal(projectSnap.data().publishToSite, true);
  assert.equal(projectSnap.data().profileThreadId, THREAD);
  const threadSnap = await threadRef.get();
  assert.equal(threadSnap.data().projectId, PROJECT_ID);
  assert.equal(threadSnap.data().purpose, null, 'existing thread fields preserved');

  // Duplicate attempt (same planned id) fails closed; nothing new is written.
  await assert.rejects(
    db.runTransaction((transaction) => applyMigrationRecordTransaction({
      transaction, threadRef, projectRef, planRecord, timestamp: 'later',
    })),
    /already linked|already occupied|gained a Project link/,
  );

  // Production path: validate an already-linked resume record and commit one remaining
  // create in the same transaction.
  const RESUME_THREAD = '900345678901234568';
  const REMAINING_THREAD = '900345678901234569';
  const RESUME_PROJECT = `resume-${Date.now()}`;
  const REMAINING_PROJECT = `remaining-${Date.now()}`;
  const resumeThreadRef = db.collection('threads').doc(RESUME_THREAD);
  const remainingThreadRef = db.collection('threads').doc(REMAINING_THREAD);
  const resumeProjectRef = db.collection('projects').doc(RESUME_PROJECT);
  const remainingProjectRef = db.collection('projects').doc(REMAINING_PROJECT);
  const sourceThread = (threadId, projectId = null) => ({
    threadId, ownerId: OWNER, mode: 'showcase', forumId: '1051088980176805920',
    projectId, purpose: null, projectUrl: null, createdAt: 'then', registeredAt: 'then',
  });
  const metadata = (threadId, projectId, slug) => ({
    projectId,
    ownerId: OWNER,
    title: slug === 'resume-game' ? 'Resume Game' : 'Remaining Game',
    slug,
    summary: slug === 'resume-game' ? 'Already committed.' : 'Still to commit.',
    status: 'development',
    projectUrl: null,
    platforms: ['web'],
    publishToSite: true,
    profileThreadId: threadId,
    createdAt: 'earlier',
    updatedAt: 'earlier',
  });
  await resumeThreadRef.set(sourceThread(RESUME_THREAD, RESUME_PROJECT));
  await remainingThreadRef.set(sourceThread(REMAINING_THREAD));
  await resumeProjectRef.set(metadata(RESUME_THREAD, RESUME_PROJECT, 'resume-game'));
  t.after(async () => {
    await Promise.all([
      threadRef.delete(), projectRef.delete(),
      resumeThreadRef.delete(), remainingThreadRef.delete(),
      resumeProjectRef.delete(), remainingProjectRef.delete(),
    ]);
    await app.delete();
  });
  const planEntry = (threadId, projectId, slug, disposition) => ({
    planRecord: {
      threadId,
      disposition,
      plannedProjectId: projectId,
      slug,
      resumeMetadataValidated: disposition === 'already-linked',
      expectedThread: { mode: 'showcase', forumId: '1051088980176805920', projectUrl: null },
      metadata: {
        ownerId: OWNER,
        title: slug === 'resume-game' ? 'Resume Game' : 'Remaining Game',
        slug,
        summary: slug === 'resume-game' ? 'Already committed.' : 'Still to commit.',
        status: 'development', projectUrl: null, platforms: ['web'], profileThreadId: threadId,
      },
    },
    threadRef: threadId === RESUME_THREAD ? resumeThreadRef : remainingThreadRef,
    projectRef: projectId === RESUME_PROJECT ? resumeProjectRef : remainingProjectRef,
  });
  const entries = [
    planEntry(RESUME_THREAD, RESUME_PROJECT, 'resume-game', 'already-linked'),
    planEntry(REMAINING_THREAD, REMAINING_PROJECT, 'remaining-game', 'create'),
  ];
  await db.runTransaction((transaction) => applyMigrationPlanTransaction({
    transaction, entries, timestamp: 'now',
  }));
  assert.equal((await remainingProjectRef.get()).exists, true);
  assert.equal((await remainingThreadRef.get()).data().projectId, REMAINING_PROJECT);
});
