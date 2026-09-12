import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fetchSnapshot } from './providers';
const exec = promisify(execFile);
it.skipIf(!process.env.SUBSCRIPTIONS_LIVE)('reads real GitHub and Linear snapshots through authenticated CLIs without modifying either', async () => {
  const { stdout: prs } = await exec('gh', ['search', 'prs', '--author', '@me', '--limit', '1', '--json', 'number,repository']);
  const pr = JSON.parse(prs)[0];
  expect(pr).toBeTruthy();
  const github = await fetchSnapshot('github', `${pr.repository.nameWithOwner}#${pr.number}`, {}, AbortSignal.timeout(20_000));
  expect(github.state).toBeTruthy();
  const { stdout: issues } = await exec('linear', ['api', 'query { issues(first: 1) { nodes { identifier } } }']);
  const issue = JSON.parse(issues).data.issues.nodes[0];
  expect(issue).toBeTruthy();
  const linear = await fetchSnapshot('linear', issue.identifier, {}, AbortSignal.timeout(20_000));
  expect(linear.state).toBeTruthy();
}, 60_000);
