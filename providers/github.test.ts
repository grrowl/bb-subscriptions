import { afterEach, describe, expect, it, vi } from 'vitest';
import { github } from './github';
const exec = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util');
  return { execFile: Object.assign(vi.fn(), { [promisify.custom]: exec }) };
});
const pr = (mergeable: string, state = 'OPEN', isDraft = false) => ({
  title: 'Example', state, isDraft, updatedAt: '2026-01-01', headRefOid: 'abcdef123456', reviewDecision: null as string | null, mergeable,
  assignees: { nodes: [] }, labels: { nodes: [] }, comments: { totalCount: 0, nodes: [] },
  reviews: { totalCount: 0, nodes: [] }, commits: { nodes: [] },
});
async function read(value: ReturnType<typeof pr>) {
  exec.mockResolvedValue({ stdout: JSON.stringify({ data: { repository: { pullRequest: value } } }) });
  const { items } = await github.fetch(['o/r#1'], { config: {}, signal: new AbortController().signal });
  return items.get('o/r#1');
}
afterEach(() => exec.mockReset());
describe('GitHub mergeability', () => {
  it.each(['MERGEABLE', 'CONFLICTING', 'UNKNOWN'])('queries and maps %s independently of checks and review requirements', async mergeable => {
    const value = pr(mergeable);
    value.reviewDecision = 'CHANGES_REQUESTED';
    expect(await read(value)).toMatchObject({ state: 'open', mergeability: mergeable });
    const [command, args] = exec.mock.calls[0];
    expect(command).toBe('gh');
    expect(args.find((arg: string) => arg.startsWith('query='))).toMatch(/\bmergeable\b/);
  });
  it('tracks draft conflicts, but omits mergeability for closed and merged PRs', async () => {
    expect(await read(pr('CONFLICTING', 'OPEN', true))).toMatchObject({ state: 'draft', mergeability: 'CONFLICTING' });
    for (const state of ['CLOSED', 'MERGED']) {
      expect(await read(pr('CONFLICTING', state))).toMatchObject({ state: state.toLowerCase(), mergeability: undefined });
    }
  });
  it('rejects an invalid mergeability response instead of recording a false resolution', async () => {
    await expect(read(pr('BLOCKED'))).rejects.toThrow('Invalid option');
  });
});
