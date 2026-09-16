import { CONNECTIONS_COLLECTION, parseConnectionsPayload, publicConnections, resolveConnections, validConnectionId } from '../src/lib/project-connections/contracts.mjs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
export async function readConnectionCatalog(siteRoot) {
  const data = JSON.parse(await readFile(join(siteRoot,'src/data/tools.json'),'utf8'));
  if (!Array.isArray(data.tools)) throw new Error('Missing tools catalogue.');
  const toolIds = data.tools.map((t) => t.id);
  const files = await readdir(join(siteRoot,'src/content/wiki'), { withFileTypes: true });
  if (files.some((f) => f.isDirectory())) throw new Error('Nested guide IDs need an explicit catalogue contract.');
  const guideIds = files.filter((f) => f.isFile() && f.name.endsWith('.md')).map((f) => f.name.slice(0,-3));
  if ([...toolIds,...guideIds].some((id) => !validConnectionId(id)) || new Set(toolIds).size !== toolIds.length) throw new Error('Invalid resource IDs.');
  return [...toolIds.map((id) => ({ kind: 'tool', id })), ...guideIds.map((id) => ({ kind: 'guide', id }))];
}
// Only the freshly approved, owner-published Project set from the core exporter.
export async function readProjectConnections({ db, projects, generatedAt, catalog }) {
  if (parseConnectionsPayload({ version: 1, generatedAt, projects: [] }, projects) === null) throw new Error('Invalid public Project set for connections export.');
  if (!Array.isArray(catalog) || catalog.some((r) => !['tool','guide'].includes(r.kind) || !validConnectionId(r.id))) throw new Error('Invalid public resource catalogue.');
  const entries = [];
  for (const project of [...projects].sort((a,b) => a.id.localeCompare(b.id))) {
    const snap = await db.collection(CONNECTIONS_COLLECTION).doc(project.id).get();
    if (!snap.exists) continue;
    if (snap.id !== project.id) throw new Error('Connection snapshot identity mismatch.');
    const entry = resolveConnections(publicConnections(snap.data(), project),catalog);
    if (entry.genres.length || entry.aiUse.length || entry.tools.length || entry.guides.length) entries.push(entry);
  }
  const payload = { version: 1, generatedAt, projects: entries };
  if (parseConnectionsPayload(payload, projects) === null) throw new Error('Invalid public connections export.');
  return payload;
}
