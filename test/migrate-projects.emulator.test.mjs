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
  const { applyMigrationRecordTransaction } = await import('../src/services/migration.js');

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
    threadId: THREAD, ownerId: OWNER, mode: 'showcase',
    projectId: null, purpose: null, createdAt: 'then', registeredAt: 'then',
  });
  t.after(async () => {
    await threadRef.delete();
    await projectRef.delete();
    await app.delete();
  });

  const planRecord = {
    threadId: THREAD,
    disposition: 'create',
    plannedProjectId: PROJECT_ID,
    slug: 'emulator-game',
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
    /already linked|already occupied/,
  );
});
