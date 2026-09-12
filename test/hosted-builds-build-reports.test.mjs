import assert from 'node:assert/strict';
import test from 'node:test';
import { createBuildCommand } from '../src/commands/build.js';
import { buildReportAlertText } from '../src/services/buildReports.js';

const MOD = '123456789012345678';

test('Build report alerts are bounded and never intentionally ping the reporter', () => {
  const text = buildReportAlertText({
    reportId: 'report_abcdefghijklmnop',
    buildId: 'build_12345678',
    projectId: 'project_1',
    reporterDiscordId: '234567890123456789',
    category: 'malicious',
    details: ' suspicious   network behavior '.repeat(80),
  });
  assert.match(text, /Hosted Build report/);
  assert.match(text, /build_12345678/);
  assert.match(text, /\/build disable/);
  assert.ok(text.length < 1400);
});

test('/build exposes disable, restore, reports and resolve', () => {
  const json = createBuildCommand().data.toJSON();
  assert.deepEqual(json.options.map((option) => option.name), ['disable', 'restore', 'reports', 'resolve']);
});

test('/build reports renders an injected moderation queue', async () => {
  const replies = [];
  const command = createBuildCommand({
    disableHostedBuild: async () => assert.fail('not used'),
    restoreHostedBuild: async () => assert.fail('not used'),
    resolveBuildReport: async () => assert.fail('not used'),
    listOpenBuildReports: async () => [{
      reportId: 'report_abcdefghijklmnop',
      buildId: 'build_12345678',
      category: 'copyright',
      details: 'Possible copied art.',
    }],
  });
  await command.execute({
    user: { id: MOD },
    options: { getSubcommand: () => 'reports', getString: () => null },
    deferReply: async () => {},
    editReply: async (value) => replies.push(value),
  });
  assert.match(replies.at(-1), /copyright/);
  assert.match(replies.at(-1), /report_abcdefghijklmnop/);
});

test('/build resolve records the moderator decision through the service boundary', async () => {
  let input;
  const replies = [];
  const command = createBuildCommand({
    disableHostedBuild: async () => assert.fail('not used'),
    restoreHostedBuild: async () => assert.fail('not used'),
    listOpenBuildReports: async () => assert.fail('not used'),
    resolveBuildReport: async (value) => {
      input = value;
      return { reportId: value.reportId, buildId: 'build_12345678', status: value.resolution };
    },
  });
  const values = { report_id: 'report_abcdefghijklmnop', resolution: 'resolved', note: 'Reviewed and fixed.' };
  await command.execute({
    user: { id: MOD },
    options: { getSubcommand: () => 'resolve', getString: (name) => values[name] ?? null },
    deferReply: async () => {},
    editReply: async (value) => replies.push(value),
  });
  assert.deepEqual(input, {
    reportId: 'report_abcdefghijklmnop',
    resolution: 'resolved',
    note: 'Reviewed and fixed.',
    moderatorId: MOD,
  });
  assert.match(replies.at(-1), /RESOLVED/);
});
