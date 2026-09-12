// Consume only an already-approved/public Project. Never infer activity build URLs.
export function projectDestination(project) {
  if (!project) return null;
  const links = Array.isArray(project.links) ? [...project.links].sort((a, b) => a.priority - b.priority) : [];
  const preferred = ['playable', 'released'].includes(project.status)
    ? ['play', 'download', 'itch', 'steam', 'website']
    : ['website', 'play', 'download', 'itch', 'steam'];
  const link = preferred.map((type) => links.find((item) => item.type === type)).find(Boolean);
  return link?.url ?? project.projectUrl ?? null;
}
