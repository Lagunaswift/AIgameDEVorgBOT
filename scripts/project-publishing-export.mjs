import { PUBLISHING_COLLECTION, publicPublishingRecord, parsePublishingPayload } from '../src/lib/project-publishing/contracts.mjs';
// Called only with the fresh public Project list returned by runProjectsFlow.
// Never enumerate private publishing records or infer identity from names/slugs.
export async function readProjectPublishing({ db, projects, generatedAt }) {
  const entries = [];
  for (const project of [...projects].sort((a, b) => a.id.localeCompare(b.id))) {
    const snap = await db.collection(PUBLISHING_COLLECTION).doc(project.id).get();
    if (!snap.exists) continue;
    if (snap.id !== project.id) throw new Error('Publishing snapshot identity mismatch.');
    const record = publicPublishingRecord(snap.data(), project);
    if (record.releases.length || record.roadmap.length) entries.push(record);
  }
  const payload = { version: 1, generatedAt, projects: entries };
  if (parsePublishingPayload(payload, projects) === null) throw new Error('Invalid Project publishing export.');
  return payload;
}
