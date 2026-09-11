import { FieldValue, Timestamp, getDb } from '../firebase.js';
import { getHostedRuntimeController, reconcileProjectHostedBuild } from './hostedBuildRuntime.js';

function controllerReady(controller) {
  return controller?.configured === true
    && typeof controller.disableBuild === 'function'
    && typeof controller.enableBuild === 'function';
}

export async function inspectHostedBuild(buildId) {
  const db = getDb();
  const buildRef = db.collection('projectBuilds').doc(buildId);
  const buildSnap = await buildRef.get();
  if (!buildSnap.exists) return null;
  const build = { buildId: buildSnap.id, ...buildSnap.data() };
  const [projectSnap, stateSnap, submissionsSnap] = await Promise.all([
    db.collection('projects').doc(build.projectId).get(),
    db.collection('projectBuildState').doc(build.projectId).get(),
    db.collection('jamSubmissions').where('buildId', '==', buildId).get(),
  ]);
  return {
    build,
    project: projectSnap.exists ? { id: projectSnap.id, ...projectSnap.data() } : null,
    buildState: stateSnap.exists ? stateSnap.data() : null,
    jamSubmissions: submissionsSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
  };
}

export async function disableHostedBuild({ buildId, moderatorId, reason, controller = getHostedRuntimeController() }) {
  const current = await inspectHostedBuild(buildId);
  if (!current) return { status: 'missing' };
  if (current.build.status === 'disabled') return { status: 'ok', unchanged: true, projectId: current.build.projectId };
  if (!['ready', 'failed'].includes(current.build.status)) return { status: 'state', buildStatus: current.build.status };

  if (current.build.runtimeState === 'public') {
    if (!controllerReady(controller)) return { status: 'blocked', reason: 'provider-unavailable' };
    await controller.disableBuild({ buildId, projectId: current.build.projectId });
  }

  const db = getDb();
  const now = Timestamp.now();
  const batch = db.batch();
  batch.update(db.collection('projectBuilds').doc(buildId), {
    status: 'disabled',
    runtimeState: 'revoked',
    moderationDisabledAt: now,
    moderationDisabledBy: moderatorId,
    moderationDisableReason: String(reason || '').trim().slice(0, 500) || 'Moderator disabled Build',
    updatedAt: now,
  });
  const stateUpdate = {
    runtimeReconcileNeeded: false,
    runtimeReconcileReason: 'build-disabled',
    runtimeReconcileAttemptedAt: now,
  };
  if (current.buildState?.publishedBuildId === buildId) stateUpdate.publishedBuildId = FieldValue.delete();
  batch.set(db.collection('projectBuildState').doc(current.build.projectId), stateUpdate, { merge: true });
  await batch.commit();
  return { status: 'ok', projectId: current.build.projectId, runtimeWasPublic: current.build.runtimeState === 'public' };
}

export async function restoreHostedBuild({ buildId, moderatorId, rest, controller = getHostedRuntimeController() }) {
  const current = await inspectHostedBuild(buildId);
  if (!current) return { status: 'missing' };
  if (current.build.status !== 'disabled') return { status: 'state', buildStatus: current.build.status };

  const db = getDb();
  const now = Timestamp.now();
  await db.collection('projectBuilds').doc(buildId).update({
    status: 'ready',
    moderationRestoredAt: now,
    moderationRestoredBy: moderatorId,
    updatedAt: now,
  });
  await db.collection('projectBuildState').doc(current.build.projectId).set({
    runtimeReconcileNeeded: true,
    runtimeReconcileReason: 'build-restored',
    updatedAt: now,
  }, { merge: true });

  const reconciliation = await reconcileProjectHostedBuild({ projectId: current.build.projectId, rest, controller });
  return { status: 'ok', projectId: current.build.projectId, reconciliation };
}
