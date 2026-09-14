import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fetchBatch } from './providers';
const exec = promisify(execFile);
const signal = () => AbortSignal.timeout(20_000);
it.skipIf(!process.env.SUBSCRIPTIONS_LIVE)('reads a real GitHub PR through gh without modifying anything', async () => {
  const { stdout: prs } = await exec('gh', ['search', 'prs', '--author', '@me', '--limit', '1', '--json', 'number,repository']);
  const pr = JSON.parse(prs)[0];
  expect(pr).toBeTruthy();
  const id = `${pr.repository.nameWithOwner}#${pr.number}`.toLowerCase();
  const { items } = await fetchBatch('github', [id], { config: {}, signal: signal() });
  expect((items.get(id) as any).state).toBeTruthy();
}, 60_000);
it.skipIf(!process.env.SUBSCRIPTIONS_LIVE || !process.env.LINEAR_API_KEY)('reads a real Linear issue through the API with a read-only key', async () => {
  const key = process.env.LINEAR_API_KEY!;
  const res = await fetch('https://api.linear.app/graphql', { method: 'POST', headers: { 'content-type': 'application/json', authorization: key }, body: JSON.stringify({ query: '{ issues(first: 1) { nodes { identifier } } }' }) });
  const identifier = (await res.json()).data.issues.nodes[0].identifier as string;
  const { items } = await fetchBatch('linear', [identifier], { config: { linearApiKey: key }, signal: signal() });
  expect((items.get(identifier) as any).state).toBeTruthy();
}, 60_000);
