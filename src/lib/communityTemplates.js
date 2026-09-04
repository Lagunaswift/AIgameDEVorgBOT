const templates = {
  build_help: `## Build help

**What I’m building:**
**Engine/tool/version:**
**Intended outcome:**
**Actual behavior:**
**What I’ve tried:**
**Relevant code, log, or screenshot:**
**Desired help:**

> Before posting, remove secrets, API keys, personal data, and any material you do not have permission to share.`,

  playtest: `## Playtest request

**Game/build:**
**Playable link:**
**Platform:**
**Approximate play time:**
**Feedback target:**
**Known issues:**
**Feedback deadline:**
**AI-use disclosure (if applicable):** Code / Art / Audio / Voice / Narrative / Runtime / Other

> Only share a build and assets you have the rights to distribute.`,

  project_update: `## Project update

**What changed:**
**What worked:**
**What did not:**
**What’s next:**
**Feedback wanted:** Yes / No
`,
};

export function buildPostTemplate(type) {
  const template = templates[type];
  if (!template) throw new Error(`unknown post template: ${type}`);
  return `\`\`\`md\n${template}\`\`\``;
}

export function buildCommunityNoteChecklist() {
  return `## Community note nomination — manual curation only

Nothing publishes without every material contributor’s explicit approval.

Before any draft is considered, confirm:
- **Proposed fields:** title, problem, tried, worked, didn't, limitations, sources
- **Credit preferences:** named / anonymous / no credit
- **Final exact-draft approval:** every material contributor approves the exact final text
- **Internal ID and privacy boundary:** Discord IDs and forum IDs must never appear publicly

This command only provides this consent-first checklist. It does not collect, save, scrape, summarize, draft, or publish anything.`;
}
