// Real Firestore transaction coverage for /mygame Project creation. This suite only
// starts when an explicitly loopback emulator and a demo project are configured.
import assert from 'node:assert/strict';
import test from 'node:test';

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT || 'demo-aigdbot-r2';
const loopbackHost = /^(?:localhost|127\.0\.0\.1|\[?::1\]?)(?::\d+)?$/i;
const isConfigured = Boolean(emulatorHost);
const required = process.env.REQUIRE_FIRESTORE_EMULATOR === '1';

function safeEmulatorConfig() {
  assert.ok(emulatorHost, 'FIRESTORE_EMULATOR_HOST is required for this integration run');
  if (!loopbackHost.test(emulatorHost)) {
    throw new Error(`FIRESTORE_EMULATOR_HOST must be loopback, received ${emulatorHost}`);
  }
  if (!projectId.startsWith('demo-')) {
    throw new Error(`GCLOUD_PROJECT must be a demo project, received ${projectId}`);
  }
}

test('createAndPublishProjectForThread against the Firestore emulator', {
  skip: isConfigured || required ? false : 'FIRESTORE_EMULATOR_HOST not set; emulator integration skipped',
}, async (t) => {
  safeEmulatorConfig();

  const admin = (await import('firebase-admin')).default;
  const { createAndPublishProjectForThread, setProjectPublication } = await import('../src/services/projects.js');
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const app = admin.initializeApp({ projectId }, `mygame-emulator-demo-${runId}`);
  const db = app.firestore();
  db.settings({ ignoreUndefinedProperties: true });
  const refs = [];

  const thread = async (suffix, ownerId = '123456789012345678', project = null) => {
    const threadId = `9${runId.replace(/\D/g, '').slice(-15).padStart(15, '0')}${suffix}`;
    const ref = db.collection('threads').doc(threadId);
    refs.push(ref);
    await ref.set({ threadId, ownerId, projectId: project, mode: 'showcase', purpose: null, createdAt: 'test' });
    return { ref, threadId, ownerId };
  };
  const input = (ownerId, title = 'Demo Transaction Game') => ({
    ownerId,
    title,
    summary: 'A Firestore emulator transaction test project.',
    status: 'development',
    projectUrl: null,
    platforms: ['web'],
    creatorName: 'Demo creator',
  });
  const trackResult = (result) => {
    refs.push(db.collection('projects').doc(result.project.projectId));
    refs.push(db.collection('projectSlugs').doc(result.project.slug));
    return result;
  };
  const linkedProjects = (threadId) => db.collection('projects').where('profileThreadId', '==', threadId).get();

  t.after(async () => {
    try {
      await Promise.all(refs.map((ref) => ref.delete()));
    } finally {
      await app.delete();
    }
  });

  await t.test('same-thread concurrent requests create exactly one Project, reservation, and backlink', async () => {
    const record = await thread('01');
    const attempts = await Promise.allSettled([
      createAndPublishProjectForThread({ threadId: record.threadId, actorId: record.ownerId, input: input(record.ownerId), db }),
      createAndPublishProjectForThread({ threadId: record.threadId, actorId: record.ownerId, input: input(record.ownerId), db }),
    ]);
    const successes = attempts.filter(({ status }) => status === 'fulfilled');
    const failures = attempts.filter(({ status }) => status === 'rejected');
    assert.equal(successes.length, 1);
    assert.equal(failures.length, 1);
    assert.match(failures[0].reason.message, /already linked/);

    const result = trackResult(successes[0].value);
    assert.equal((await linkedProjects(record.threadId)).size, 1);
    assert.equal((await db.collection('projectSlugs').doc(result.project.slug).get()).data().projectId, result.project.projectId);
    assert.equal((await record.ref.get()).data().projectId, result.project.projectId);
  });

  await t.test('republishing requires the exact owner-owned source backlink', async () => {
    const record = await thread('08');
    const created = trackResult(await createAndPublishProjectForThread({
      threadId: record.threadId, actorId: record.ownerId, input: input(record.ownerId), db,
    }));
    await db.collection('projects').doc(created.project.projectId).update({ publishToSite: false });
    await setProjectPublication({ projectId: created.project.projectId, threadId: record.threadId, actorId: record.ownerId, publishToSite: true, db });
    assert.equal((await db.collection('projects').doc(created.project.projectId).get()).data().publishToSite, true);

    await db.collection('threads').doc(record.threadId).update({ projectId: 'wrong-project' });
    await assert.rejects(
      setProjectPublication({ projectId: created.project.projectId, threadId: record.threadId, actorId: record.ownerId, publishToSite: true, db }),
      /backlink is invalid/,
    );
  });

  await t.test('an orphaned source association cannot create a duplicate Project', async () => {
    const record = await thread('09');
    const created = trackResult(await createAndPublishProjectForThread({
      threadId: record.threadId, actorId: record.ownerId, input: input(record.ownerId), db,
    }));
    await record.ref.update({ projectId: null });
    await assert.rejects(createAndPublishProjectForThread({
      threadId: record.threadId, actorId: record.ownerId, input: input(record.ownerId), db,
    }), /already linked to a Project source/);
    assert.equal((await linkedProjects(record.threadId)).size, 1);
    assert.equal((await db.collection('projects').doc(created.project.projectId).get()).exists, true);
    assert.equal((await record.ref.get()).data().projectId, null, 'repair must be explicit, not guessed');
  });

  await t.test('same title on distinct threads reserves unique slugs', async () => {
    const [first, second] = await Promise.all([thread('02'), thread('03')]);
    const title = `Shared Emulator Title ${runId}`;
    const results = await Promise.all([
      createAndPublishProjectForThread({ threadId: first.threadId, actorId: first.ownerId, input: input(first.ownerId, title), db }),
      createAndPublishProjectForThread({ threadId: second.threadId, actorId: second.ownerId, input: input(second.ownerId, title), db }),
    ]);
    const [firstProject, secondProject] = results.map(trackResult);
    assert.notEqual(firstProject.project.slug, secondProject.project.slug);
    assert.equal((await db.collection('projectSlugs').doc(firstProject.project.slug).get()).exists, true);
    assert.equal((await db.collection('projectSlugs').doc(secondProject.project.slug).get()).exists, true);
  });

  await t.test('occupied base reservation falls back to a unique slug', async () => {
    const record = await thread('04');
    const title = `Occupied Emulator Title ${runId}`;
    const slug = `occupied-emulator-title-${runId}`;
    const occupied = db.collection('projectSlugs').doc(slug);
    refs.push(occupied);
    await occupied.set({ projectId: `other-${runId}`, createdAt: 'test' });
    const result = trackResult(await createAndPublishProjectForThread({
      threadId: record.threadId, actorId: record.ownerId, input: input(record.ownerId, title), db,
    }));
    assert.notEqual(result.project.slug, slug);
    assert.match(result.project.slug, /^occupied-emulator-title-/);
  });

  await t.test('wrong owner and existing links reject without Project or reservation writes', async () => {
    const owner = '123456789012345678';
    const wrongOwner = '234567890123456789';
    const unauthorized = await thread('05', owner);
    await assert.rejects(
      createAndPublishProjectForThread({
        threadId: unauthorized.threadId, actorId: wrongOwner,
        input: input(wrongOwner, 'Unauthorized No Write'), db,
      }),
      /Only the thread owner/,
    );
    assert.equal((await linkedProjects(unauthorized.threadId)).size, 0);
    assert.equal((await db.collection('projectSlugs').doc('unauthorized-no-write').get()).exists, false);

    const relink = await thread('06', owner, `existing-${runId}`);
    await assert.rejects(
      createAndPublishProjectForThread({
        threadId: relink.threadId, actorId: owner, input: input(owner, 'Relink No Write'), db,
      }),
      /already linked/,
    );
    assert.equal((await linkedProjects(relink.threadId)).size, 0);
    assert.equal((await relink.ref.get()).data().projectId, `existing-${runId}`);
    assert.equal((await db.collection('projectSlugs').doc('relink-no-write').get()).exists, false);
  });

  await t.test('forced transaction failure leaves no Project or slug reservation', async () => {
    const record = await thread('07');
    const occupied = db.collection('projectSlugs').doc(`commit-precondition-${runId}`);
    refs.push(occupied);
    await occupied.set({ projectId: 'existing' });
    const failingDb = {
      collection: (...args) => db.collection(...args),
      runTransaction: (callback) => db.runTransaction(async (transaction) => {
        const result = await callback(transaction);
        // A server-side create precondition must abort every queued write, not just
        // a JavaScript exception before the SDK sends the commit.
        transaction.create(occupied, { projectId: 'must-not-overwrite' });
        return result;
      }),
    };
    await assert.rejects(
      createAndPublishProjectForThread({
        threadId: record.threadId, actorId: record.ownerId,
        input: input(record.ownerId, 'Forced Failure No Orphan'), db: failingDb,
      }),
      /ALREADY_EXISTS|already exists/i,
    );
    assert.equal((await linkedProjects(record.threadId)).size, 0);
    assert.equal((await record.ref.get()).data().projectId, null);
    assert.equal((await db.collection('projectSlugs').doc('forced-failure-no-orphan').get()).exists, false);
    assert.equal((await occupied.get()).data().projectId, 'existing');
  });
});
