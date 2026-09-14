import { afterEach, describe, expect, it, vi } from 'vitest';
import { batchQuery, linear, LINEAR_ENDPOINT, resetDelay } from './linear';
import { ProviderError } from './types';
import { fetchBatch } from './index';
const issue = (n: number) => ({ title: `Issue ${n}`, url: `https://linear.app/acme/issue/ENG-${n}/x`, updatedAt: '2026-01-01', state: { name: 'Todo' }, assignee: null, priority: 2, labels: { nodes: [] }, comments: { nodes: [] } });
const reply = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, ...init });
const ctx = (key = 'lin_api_test') => ({ config: { linearApiKey: key }, signal: new AbortController().signal });
afterEach(() => vi.unstubAllGlobals());
describe('linear provider', () => {
  it('fails fast and pauses when no key is configured, without calling the network', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    await expect(linear.fetch(['ENG-1'], ctx(''))).rejects.toMatchObject({ pauseProvider: true, message: expect.stringContaining('linearApiKey') });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('sends one aliased query for many issues with the raw key as the Authorization header', async () => {
    const fetchMock = vi.fn(async () => reply({ data: { i0: issue(1), i1: null } }, { headers: { 'x-ratelimit-requests-remaining': '2400' } }));
    vi.stubGlobal('fetch', fetchMock);
    const { items, pause } = await linear.fetch(['ENG-1', 'ENG-2'], ctx());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(LINEAR_ENDPOINT);
    expect((init.headers as Record<string, string>).authorization).toBe('lin_api_test');
    const body = JSON.parse(String(init.body));
    expect(body.variables).toEqual({ i0: 'ENG-1', i1: 'ENG-2' });
    expect(body.query).toContain('i1: issue(id: $i1)');
    expect(body.query).not.toMatch(/mutation/);
    expect((items.get('ENG-1') as any).state).toBe('Todo');
    expect(items.get('ENG-2')).toBeInstanceOf(ProviderError);
    expect((items.get('ENG-2') as ProviderError).message).toContain('not found');
    expect(pause).toBeUndefined();
  });
  it('pauses the provider until the window resets on RATELIMITED and on a low remaining budget', async () => {
    const reset = String(Date.now() + 20 * 60_000);
    vi.stubGlobal('fetch', vi.fn(async () => reply({ errors: [{ message: 'limited', extensions: { code: 'RATELIMITED' } }] }, { status: 400, headers: { 'x-ratelimit-requests-reset': reset } })));
    const limited = await fetchBatch('linear', ['ENG-1'], ctx());
    expect(limited.pause?.pauseProvider).toBe(true);
    expect(limited.pause?.retryMs).toBeGreaterThan(19 * 60_000);
    expect(limited.items.get('ENG-1')).toBeInstanceOf(ProviderError);
    vi.stubGlobal('fetch', vi.fn(async () => reply({ data: { i0: issue(1) } }, { headers: { 'x-ratelimit-requests-remaining': '5', 'x-ratelimit-requests-reset': reset } })));
    const low = await linear.fetch(['ENG-1'], ctx());
    expect((low.items.get('ENG-1') as any).title).toBe('Issue 1');
    expect(low.pause?.message).toContain('budget');
  });
  it('treats a rejected key as a long provider pause', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply({ errors: [{ message: 'no' }] }, { status: 401 })));
    const { pause } = await fetchBatch('linear', ['ENG-1'], ctx());
    expect(pause?.retryMs).toBe(3600_000); expect(pause?.message).toContain('read-only');
  });
  it('chunks fifty issues per request', () => {
    expect(batchQuery(['A-1', 'B-2']).aliases).toEqual(['i0', 'i1']);
    expect(resetDelay(new Headers(), 0)).toBeNull();
    expect(resetDelay(new Headers({ 'x-ratelimit-requests-reset': '100000' }), 50_000)).toBe(60_000);
  });
});
