import { config } from '../config.js';
import { FieldValue, Timestamp, getDb } from '../firebase.js';
import { checkGameApproval } from '../lib/gameApproval.js';
import { runtimeReconciliationDecision } from '../lib/hostedPlatform.js';

let controllerOverride = null;

function unconfiguredController() {
  return Object.freeze({
    kind: 'unconfigured',
    configured: false,
    async enableBuild() { throw new Error('Hosted runtime provider is not configured.'); },
    async disableBuild() { throw new Error('Hosted runtime provider is not configured.'); },
  });
}

export function setHostedRuntimeControllerForTests(controller) {
  controllerOverride = controller ?? null;
}

export function getHostedRuntimeController() {
  return controllerOverride ?? unconfiguredController();
}

function controllerReady(controller) {
  return controller?.configured === true
    && typeof controller.enableBuild === 'function'
    && typeof controller.disableBuild === 'function';
}

async function markReconcileNeeded(stateRef, reason) {
  await stateRef.set({
    runtimeReconcileNeeded: true,
    runtimeReconcileReason: reason,
    runtimeReconcileAttemptedAt: Timestamp.now(),
  }, { merge: true });
}

async function approvalForProject(rest, project, thread) {
  if (!config.sitePublishTagId) return { approved: false, reason: 'publish-tag-not-configured' };
  return checkGameApproval(rest, {
    threadId: project.profileThreadId,
    ownerId: project.ownerId,
    forumId: thread.forumId,
    guildId: config.guildId,
    publishTagId: config.sitePublishTagId,
  });
}

export async function reconcileProjectHostedBuild({ projectId, rest, controller = getHostedRuntimeController() }) {
  const db = getDb();
  const projectRef = db.collection('projects').doc(projectId);
  const stateRef = db.collection('projectBuildState').doc(projectId);
  const [projectSnap, stateSnap] = await Promise.all([projectRef.get(), stateRef.get()]);
  if (!projectSnap.exists) return { status: 'missing-project' };

  const project = { id: projectSnap.id, ...projectSnap.data() };
  const state = stateSnap.exists ? stateSnap.data() : {};
  if (!project.profileThreadId) return { status: 'ignored', reason: 'missing-profile-thread' };
  const threadSnap = await db.collection('threads').doc(project.profileThreadId).get();
  if (!threadSnap.exists) return { status: 'ignored', reason: 'missing-thread' };
  const thread = threadSnap.data();
  if (thread?.projectId !== projectId || thread?.ownerId !== project.ownerId) return { status: 'ignored', reason: 'thread-project-mismatch' };

  const approval = await approvalForProject(rest, project, thread);
  let requestedBuild = null;
  if (typeof state.requestedBuildId === 'string') {
    const buildSnap = await db.collection('projectBuilds').doc(state.requestedBuildId).get();
    requestedBuild = buildSnap.exists ? buildSnap.data() : null;
  }

  const decision = runtimeReconciliationDecision({
    project,
    buildState: state,
    build: requestedBuild,
    approved: approval.approved === true,
  });

  if (decision.action === 'none') {
    await stateRef.set({
      runtimeReconcileNeeded: false,
      runtimeReconcileReason: decision.reason,
      runtimeReconcileAttemptedAt: Timestamp.now(),
    }, { merge: true });
    return { status: 'ok', action: 'none', reason: decision.reason, approved: approval.approved === true };
  }

  if (!controllerReady(controller)) {
    await markReconcileNeeded(stateRef, 'provider-unavailable');
    return { status: 'blocked', action: decision.action, reason: 'provider-unavailable' };
  }

  if (decision.action === 'publish') {
    await controller.enableBuild({ buildId: decision.buildId, projectId });
    if (decision.previousBuildId && decision.previousBuildId !== decision.buildId) {
      await controller.disableBuild({ buildId: decision.previousBuildId, projectId });
    }

    const now = Timestamp.now();
    const batch = db.batch();
    batch.update(db.collection('projectBuilds').doc(decision.buildId), { runtimeState: 'public', updatedAt: now });
    if (decision.previousBuildId && decision.previousBuildId !== decision.buildId) {
      batch.update(db.collection('projectBuilds').doc(decision.previousBuildId), { runtimeState: 'revoked', updatedAt: now });
    }
    batch.set(stateRef, {
      projectId,
      requestedBuildId: decision.buildId,
      publishedBuildId: decision.buildId,
      runtimeReconcileNeeded: false,
      runtimeReconcileReason: 'approved',
      runtimeReconcileAttemptedAt: now,
    }, { merge: true });
    await batch.commit();
    return { status: 'ok', action: 'publish', buildId: decision.buildId };
  }

  await controller.disableBuild({ buildId: decision.buildId, projectId });
  const now = Timestamp.now();
  const buildRef = db.collection('projectBuilds').doc(decision.buildId);
  const buildSnap = await buildRef.get();
  const batch = db.batch();
  if (buildSnap.exists) batch.update(buildRef, { runtimeState: 'revoked', updatedAt: now });
  batch.set(stateRef, {
    publishedBuildId: FieldValue.delete(),
    runtimeReconcileNeeded: false,
    runtimeReconcileReason: decision.reason,
    runtimeReconcileAttemptedAt: now,
  }, { merge: true });
  await batch.commit();
  return { status: 'ok', action: 'revoke', buildId: decision.buildId, reason: decision.reason };
}

export async function reconcileThreadHostedBuild({ threadId, rest, controller = getHostedRuntimeController() }) {
  const threadSnap = await getDb().collection('threads').doc(threadId).get();
  if (!threadSnap.exists) return { status: 'ignored', reason: 'unregistered-thread' };
  const projectId = threadSnap.data()?.projectId;
  if (!projectId) return { status: 'ignored', reason: 'unlinked-thread' };
  return reconcileProjectHostedBuild({ projectId, rest, controller });
}
