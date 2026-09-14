import { WIKI_COLLECTION, publicWikiRecord, parseWikiPayload } from '../src/lib/project-wiki/contracts.mjs';
// The core exporter supplies only its freshly approved public Project set.
// Do not enumerate private records or resolve Projects by name.
export async function readProjectWikis({ db, projects, generatedAt }) {
  if (parseWikiPayload({ version: 1, generatedAt, projects: [] }, projects) === null) throw new Error('Invalid public Project set for Wiki export.');
  const entries = [];
  for (const project of [...projects].sort((a, b) => a.id.localeCompare(b.id))) {
    const snapshot = await db.collection(WIKI_COLLECTION).doc(project.id).get();
    if (!snapshot.exists) continue;
    if (snapshot.id !== project.id) throw new Error('Wiki snapshot identity mismatch.');
    const entry = publicWikiRecord(snapshot.data(), project);
    if (entry.articles.length) entries.push(entry);
  }
  const payload = { version: 1, generatedAt, projects: entries };
  if (parseWikiPayload(payload, projects) === null) throw new Error('Invalid Project Wiki export.');
  return payload;
}
