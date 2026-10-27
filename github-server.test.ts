import { afterEach, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import plugin from './server';
vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
const issue = {
  __typename: 'Issue', title: 'Example issue', url: 'https://github.com/o/r/issues/2',
  state: 'OPEN', stateReason: null, updatedAt: '2026-01-01',
  assignees: { nodes: [] }, labels: { nodes: [] }, comments: { totalCount: 0, nodes: [] },
};
const pr = {
  ...issue, __typename: 'PullRequest', title: 'Example PR', url: 'https://github.com/o/r/pull/1',
  isDraft: false, headRefOid: '0123456789abcdef', reviewDecision: null,
  reviews: { totalCount: 0, nodes: [] }, commits: { nodes: [] },
};
const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.harness.lifecycle.dispose();
  vi.mocked(execFile).mockReset();
});
it('follows issues through CLI/RPC/tool, preserving persisted PR baselines and delivering issue changes', async () => {
  let currentIssue: typeof issue | Record<string, unknown> = issue;
  vi.mocked(execFile).mockImplementation((...args: any[]) => {
    const number = args[1].find((arg: string) => arg.startsWith('number='));
    const item = number === 'number=1' ? pr : currentIssue;
    args.at(-1)(null, { stdout: JSON.stringify({ data: { repository: { issueOrPullRequest: item } } }) });
    return {} as any;
  });
  let h = createFakePluginHost({ pluginId: 'subscriptions', sdk: { threads: {
    get: async ({ threadId }) => makeThreadResponse({ id: threadId }),
    send: async () => ({ delivery: 'sent', ok: true } as never),
  } } });
  hosts.push(h); plugin(h.bb);
  const list = async () => await h.harness.behavior.callRpc('list', { threadId: 't1' }) as any;
  const cycle = async (check: () => void) => {
    const service = h.harness.behavior.runService('watch');
    try { await vi.waitFor(check, { timeout: 3000, interval: 10 }); }
    finally { service.controller.abort(); await service.done; }
  };
  await h.harness.behavior.callRpc('subscribe', { threadId: 't1', platform: 'github', ids: ['o/r#1'] });
  await cycle(async () => expect((await list()).subscriptions[0].snapshot?.state).toBe('open'));
  const oldPr = (await list()).subscriptions[0];
  expect(oldPr.snapshot.fields).not.toHaveProperty('state reason');
  const replacement = await h.harness.lifecycle.reload(plugin);
  hosts.splice(hosts.indexOf(h), 1, replacement); h = replacement;
  await h.harness.behavior.setSettings({ githubRepository: 'O/R', debounceSeconds: 0 });
  expect((await h.harness.behavior.runCli(['sub', 'github', '#2', 'https://github.com/O/R/issues/2', '--thread', 't1'])).exitCode).toBe(0);
  await h.harness.behavior.callAgentTool('thread_subscriptions', { action: 'subscribe', platform: 'github', ids: ['https://github.com/o/r/issues/2'] }, { threadId: 't1' });
  expect((await list()).subscriptions).toHaveLength(2);
  await cycle(async () => expect((await list()).subscriptions[1].snapshot?.state).toBe('open'));
  expect(h.harness.inspection.sdk.callsTo('threads.send')).toHaveLength(0);
  expect((await list()).subscriptions[0].snapshot).toEqual(oldPr.snapshot);
  expect((await list()).subscriptions[1].snapshot.url).toBe('https://github.com/o/r/issues/2');
  currentIssue = { ...issue, state: 'CLOSED', stateReason: 'COMPLETED',
    comments: { totalCount: 1, nodes: [{ updatedAt: '2026-01-02', author: { login: 'alice' } }] },
  };
  await h.harness.behavior.setSettings({ intervalSeconds: 61 });
  await cycle(() => expect(h.harness.inspection.sdk.callsTo('threads.send')).toHaveLength(1));
  const sent = h.harness.inspection.sdk.callsTo('threads.send')[0][0] as any;
  expect(sent.input[0].text).toBe('[Subscription update] [o/r#2](https://github.com/o/r/issues/2): open → closed; state reason: none → completed; comments: 0 → 1 latest by alice at 2026-01-02.');
  await h.harness.behavior.callRpc('unsubscribe', { threadId: 't1', platform: 'github', ids: ['https://github.com/o/r/issues/2'] });
  expect((await list()).subscriptions).toEqual([expect.objectContaining({ id: 'o/r#1', snapshot: oldPr.snapshot })]);
});
