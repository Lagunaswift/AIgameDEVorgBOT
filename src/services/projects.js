import { getDb, serverTimestamp } from '../firebase.js';
import {
  assertDiscordId,
  assertProjectId,
  normalizeProjectInput,
  normalizeProjectPlatforms,
  normalizeProjectStatus,
  normalizeProjectSummary,
  normalizeProjectTitle,
  normalizeProjectUrlValue,
  normalizePublishToSite,
  normalizeThreadPurpose,
} from '../lib/projectValidation.js';

const EDITABLE_FIELDS = new Set(['title', 'summary', 'status', 'projectUrl', 'platforms']);

function projectsRef() {
  return getDb().collection('projects');
}

function threadsRef() {
  return getDb().collection('threads');
}

function sameValue(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    ? left.length === right.length && left.every((value, index) => value === right[index])
    : left === right;
}

function assertOwner(record, actorId, resource) {
  if (record.ownerId !== actorId) throw new Error(`Only the ${resource} owner can make this change`);
}

export function buildProjectRecord({ projectId, input, timestamp }) {
  const normalizedInput = normalizeProjectInput(input);
  if (Object.hasOwn(input, 'publishToSite')) {
    if (normalizePublishToSite(input.publishToSite)) {
      throw new Error('publishToSite cannot be set when creating a project');
    }
  }
  return {
    projectId: assertProjectId(projectId),
    ...normalizedInput,
    publishToSite: false,
    profileThreadId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function normalizeProjectChanges(changes) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new Error('changes are required');
  const keys = Object.keys(changes);
  if (!keys.length) throw new Error('changes must include an editable field');
  for (const key of keys) {
    if (!EDITABLE_FIELDS.has(key)) throw new Error(`Project field is not editable: ${key}`);
  }

  const normalized = {};
  if (Object.hasOwn(changes, 'title')) normalized.title = normalizeProjectTitle(changes.title);
  if (Object.hasOwn(changes, 'summary')) normalized.summary = normalizeProjectSummary(changes.summary);
  if (Object.hasOwn(changes, 'status')) normalized.status = normalizeProjectStatus(changes.status);
  if (Object.hasOwn(changes, 'projectUrl')) normalized.projectUrl = normalizeProjectUrlValue(changes.projectUrl);
  if (Object.hasOwn(changes, 'platforms')) normalized.platforms = normalizeProjectPlatforms(changes.platforms);
  return normalized;
}

export async function updateOwnedProjectTransaction({ transaction, projectRef, actorId, changes, timestamp }) {
  const normalizedActorId = assertDiscordId(actorId, 'actor ID');
  const normalizedChanges = normalizeProjectChanges(changes);
  const projectSnap = await transaction.get(projectRef);
  if (!projectSnap.exists) throw new Error('Project not found');

  const project = projectSnap.data();
  assertOwner(project, normalizedActorId, 'project');
  const updates = Object.fromEntries(
    Object.entries(normalizedChanges).filter(([key, value]) => !sameValue(project[key], value)),
  );
  if (!Object.keys(updates).length) throw new Error('changes do not modify the project');
  transaction.update(projectRef, { ...updates, updatedAt: timestamp });
  return { ...project, ...updates };
}

export async function setProjectPublicationTransaction({ transaction, projectRef, actorId, publishToSite, timestamp }) {
  const normalizedActorId = assertDiscordId(actorId, 'actor ID');
  const published = normalizePublishToSite(publishToSite);
  const projectSnap = await transaction.get(projectRef);
  if (!projectSnap.exists) throw new Error('Project not found');
  const project = projectSnap.data();
  assertOwner(project, normalizedActorId, 'project');
  transaction.update(projectRef, { publishToSite: published, updatedAt: timestamp });
  return { ...project, publishToSite: published };
}

export async function linkThreadToProjectTransaction({
  transaction, threadRef, projectRef, actorId, projectId, purpose,
}) {
  const normalizedActorId = assertDiscordId(actorId, 'actor ID');
  const normalizedProjectId = assertProjectId(projectId);
  const normalizedPurpose = normalizeThreadPurpose(purpose);
  const [threadSnap, projectSnap] = await Promise.all([transaction.get(threadRef), transaction.get(projectRef)]);
  if (!threadSnap.exists) throw new Error('Registered thread not found');
  if (!projectSnap.exists) throw new Error('Project not found');

  const thread = threadSnap.data();
  const project = projectSnap.data();
  assertOwner(thread, normalizedActorId, 'thread');
  assertOwner(project, normalizedActorId, 'project');
  if (thread.projectId != null && thread.projectId !== normalizedProjectId) {
    throw new Error('Thread is already linked to a different project');
  }
  if (thread.projectId === normalizedProjectId && thread.purpose === normalizedPurpose) return thread;
  transaction.update(threadRef, { projectId: normalizedProjectId, purpose: normalizedPurpose });
  return { ...thread, projectId: normalizedProjectId, purpose: normalizedPurpose };
}

export async function createProject(input) {
  const ref = projectsRef().doc();
  const project = buildProjectRecord({ projectId: ref.id, input, timestamp: serverTimestamp() });
  await ref.create(project);
  return project;
}

export async function getProject(projectId) {
  const snap = await projectsRef().doc(assertProjectId(projectId)).get();
  return snap.exists ? snap.data() : null;
}

export async function updateOwnedProject({ projectId, actorId, changes }) {
  const ref = projectsRef().doc(assertProjectId(projectId));
  return getDb().runTransaction((transaction) => updateOwnedProjectTransaction({
    transaction, projectRef: ref, actorId, changes, timestamp: serverTimestamp(),
  }));
}

export async function setProjectPublication({ projectId, actorId, publishToSite }) {
  const ref = projectsRef().doc(assertProjectId(projectId));
  return getDb().runTransaction((transaction) => setProjectPublicationTransaction({
    transaction, projectRef: ref, actorId, publishToSite, timestamp: serverTimestamp(),
  }));
}

export async function linkThreadToProject({ threadId, projectId, purpose, actorId }) {
  const normalizedThreadId = assertDiscordId(threadId, 'thread ID');
  const normalizedProjectId = assertProjectId(projectId);
  return getDb().runTransaction((transaction) => linkThreadToProjectTransaction({
    transaction,
    threadRef: threadsRef().doc(normalizedThreadId),
    projectRef: projectsRef().doc(normalizedProjectId),
    actorId,
    projectId: normalizedProjectId,
    purpose,
  }));
}
