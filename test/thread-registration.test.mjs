import assert from 'node:assert/strict';
import test from 'node:test';
import { registerThreadTransaction } from '../src/services/threads.js';

function snapshot(data) {
  return data == null
    ? { exists: false, data: () => undefined }
    : { exists: true, data: () => data };
}

function registrationData() {
  return {
    threadId: '345678901234567890', forumId: '456789012345678901', ownerId: '123456789012345678',
    ownerTag: 'Maker', title: 'Build', mode: 'showcase', createdAt: 'created', registeredAt: 'registered',
  };
}

test('new thread registration initializes nullable Project relationship fields', async () => {
  let written;
  const transaction = {
    async get() { return snapshot(null); },
    set(ref, data, options) { written = { ref, data, options }; },
  };
  const result = await registerThreadTransaction({ transaction, ref: 'thread', data: registrationData() });
  assert.equal(result.projectId, null);
  assert.equal(result.purpose, null);
  assert.equal(written.data.projectId, null);
  assert.equal(written.data.purpose, null);
  assert.deepEqual(written.options, { merge: true });
});

test('re-registration preserves an existing Project relationship', async () => {
  const existing = { ...registrationData(), projectId: 'project-1', purpose: 'feedback' };
  let written;
  const transaction = {
    async get() { return snapshot(existing); },
    set(ref, data, options) { written = { ref, data, options }; },
  };
  const result = await registerThreadTransaction({
    transaction, ref: 'thread', data: { ...registrationData(), title: 'Renamed' },
  });
  assert.equal(Object.hasOwn(result, 'projectId'), false);
  assert.equal(Object.hasOwn(result, 'purpose'), false);
  assert.equal(Object.hasOwn(written.data, 'projectId'), false);
  assert.equal(Object.hasOwn(written.data, 'purpose'), false);
  assert.deepEqual(existing, { ...registrationData(), projectId: 'project-1', purpose: 'feedback' });
});

test('re-registration initializes missing relationship fields on a legacy thread', async () => {
  const existing = registrationData();
  let written;
  const transaction = {
    async get() { return snapshot(existing); },
    set(ref, data, options) { written = { ref, data, options }; },
  };
  const result = await registerThreadTransaction({ transaction, ref: 'thread', data: registrationData() });
  assert.equal(result.projectId, null);
  assert.equal(result.purpose, null);
  assert.equal(written.data.projectId, null);
  assert.equal(written.data.purpose, null);
});
