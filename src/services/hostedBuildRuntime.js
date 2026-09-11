import { config } from '../config.js';
import { FieldValue, Timestamp, getDb } from '../firebase.js';
import { checkGameApproval } from '../lib/gameApproval.js';
import { runtimeReconciliationPlan } from '../lib/hostedPlatform.js';

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
  const [buildsSnap, submissionsSnap, jamsSnap, eligibilitySnap] = await Promise.all([
    db.collection('projectBuilds').where('projectId', '==', projectId).get(),
    db.collection('jamSubmissions').where('projectId', '==', projectId).get(),
    db.collection('jams').get(),
    db.collection('jamEligibility').where('projectId', '==', projectId).get(),
  ]);
  const builds = buildsSnap.docs.map((doc) => ({ buildId: doc.id, ...doc.data() }));
  const submissions = submissionsSnap.docs.map((doc) => doc.data());
  const jams = jamsSnap.docs.map((doc) => ({ jamId: doc.id, ...doc.data() }));
  const eligibilities = eligibilitySnap.docs.map((doc) => doc.data());
  const plan = runtimeReconciliationPlan({
    project,
    buildState: state,
    builds,
    submissions,
    jams,
    eligibilities,
    approved: approval.approved === true,
  });

  if (plan.enable.length === 0 && plan.disable.length === 0) {
    const stateUpdate = {
      runtimeReconcileNeeded: false,
      runtimeReconcileReason: approval.approved === true ? 'in-sync' : approval.reason,
      runtimeReconcileAttemptedAt: Timestamp.now(),
      publishedBuildId: plan.primaryPublishedBuildId ?? FieldValue.delete(),
    };
    await stateRef.set(stateUpdate, { merge: true });
    return { status: 'ok', action: 'none', plan, approved: approval.approved === true };
  }

  if (!controllerReady(controller)) {
    await markReconcileNeeded(stateRef, 'provider-unavailable');
    return { status: 'blocked', action: 'reconcile', reason: 'provider-unavailable', plan };
  }

  // Provider operations must be idempotent. Enable desired Builds before disabling stale
  // ones so changing the primary Project Build does not create an avoidable outage.
  for (const buildId of plan.enable) await controller.enableBuild({ buildId, projectId });
  for (const buildId of plan.disable) await controller.disableBuild({ buildId, projectId });

  const now = Timestamp.now();
  const batch = db.batch();
  for (const buildId of plan.enable) {
    batch.update(db.collection('projectBuilds').doc(buildId), { runtimeState: 'public', updatedAt: now });
  }
  for (const buildId of plan.disable) {
    batch.update(db.collection('projectBuilds').doc(buildId), { runtimeState: 'revoked', updatedAt: now });
  }
  batch.set(stateRef, {
    publishedBuildId: plan.primaryPublishedBuildId ?? FieldValue.delete(),
    runtimeReconcileNeeded: false,
    runtimeReconcileReason: 'in-sync',
    runtimeReconcileAttemptedAt: now,
  }, { merge: true });
  await batch.commit();
  return { status: 'ok', action: 'reconcile', plan };
}

export async function reconcileThreadHostedBuild({ threadId, rest, controller = getHostedRuntimeController() }) {
  const threadSnap = await getDb().collection('threads').doc(threadId).get();
  if (!threadSnap.exists) return { status: 'ignored', reason: 'unregistered-thread' };
  const projectId = threadSnap.data()?.projectId;
  if (!projectId) return { status: 'ignored', reason: 'unlinked-thread' };
  return reconcileProjectHostedBuild({ projectId, rest, controller });
}
