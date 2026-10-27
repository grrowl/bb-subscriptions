import { useCallback, useEffect, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { definePluginApp, useRealtime, useRealtimeConnectionState, useRpc } from '@get-bb/plugin-sdk/app';
import type { rpcContract } from './server';
import type { Subscription } from './model';
function subscriptionUrl(item: Subscription): string | undefined {
  const url = item.snapshot?.url ?? (item.platform === 'github'
    ? `https://github.com/${item.id.replace('#', '/pull/')}` : undefined);
  return url && /^https?:\/\//i.test(url) ? url : undefined;
}
function SubscriptionCount({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [items, setItems] = useState<Subscription[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const requestId = useRef(0);
  const connection = useRealtimeConnectionState();
  const refresh = useCallback(async () => {
    const request = ++requestId.current;
    try {
      const result = await rpc.call('list', { threadId });
      if (request === requestId.current) setItems(result.subscriptions);
    } catch { /* Keep the last known count during disconnects. */ }
  }, [rpc, threadId]);
  useEffect(() => { setItems([]); setOpen(false); setError(null); void refresh(); return () => { requestId.current++; }; }, [refresh]);
  useEffect(() => { if (connection === 'connected') void refresh(); }, [connection, refresh]);
  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [open]);
  useRealtime('subscriptions-changed', () => { void refresh(); });
  async function unsubscribe(targets: Subscription[]) {
    setBusy(true);
    setError(null);
    try {
      for (const platform of new Set(targets.map(item => item.platform))) {
        const ids = targets.filter(item => item.platform === platform).map(item => item.id);
        for (let offset = 0; offset < ids.length; offset += 50) {
          await rpc.call('unsubscribe', { threadId, platform, ids: ids.slice(offset, offset + 50) });
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not unsubscribe. Please try again.');
    } finally {
      await refresh();
      setBusy(false);
    }
  }
  if (!items.length) return null;
  const checkedAt = Math.max(...items.map(item => item.checkedAt ?? 0));
  return <Popover.Root open={open} onOpenChange={setOpen}>
    <Popover.Trigger asChild>
      <button type="button" className="inline-flex h-7 items-center rounded px-2 text-xs text-muted-foreground hover:bg-muted" aria-label={`${items.length} following${items.some(item => item.error) ? ', some checks failed' : ''}`}>
        {items.length} following{items.some(item => item.error) ? ' · !' : ''}
      </button>
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Content align="end" sideOffset={6} aria-label="Subscriptions" className="z-50 w-80 max-w-[calc(100vw-1rem)] rounded-md border bg-popover text-popover-foreground shadow-md">
        <ul className="max-h-72 overflow-y-auto p-1">
          {items.map(item => <li key={`${item.platform}:${item.id}`} className="flex items-center gap-2 rounded px-2 py-2 text-xs">
            <div className="min-w-0 flex-1">
              {subscriptionUrl(item)
                ? <a href={subscriptionUrl(item)} target="_blank" rel="noopener noreferrer" aria-label={`${item.platform} ${item.id}`} className="flex min-w-0 items-baseline hover:underline focus-visible:underline" title={item.snapshot?.title ?? item.id}>
                    <span className="shrink-0">{item.platform}&nbsp;</span>
                    <span dir="rtl" className="min-w-0 truncate text-left"><bdi dir="ltr">{item.id}</bdi></span>
                  </a>
                : <div className="flex min-w-0 items-baseline" title={item.snapshot?.title ?? item.id}>
                    <span className="shrink-0">{item.platform}&nbsp;</span>
                    <span dir="rtl" className="min-w-0 truncate text-left"><bdi dir="ltr">{item.id}</bdi></span>
                  </div>}
              <div className="truncate text-muted-foreground" title={item.error ?? item.snapshot?.state ?? 'pending'}>{item.error ?? item.snapshot?.state ?? 'pending'}</div>
            </div>
            <button type="button" disabled={busy} aria-label={`Unsubscribe ${item.platform} ${item.id}`} onClick={() => void unsubscribe([item])} className="shrink-0 rounded px-1.5 py-1 text-muted-foreground hover:bg-muted disabled:opacity-50">×</button>
          </li>)}
        </ul>
        {error && <p role="alert" className="px-3 pb-2 text-xs text-destructive">{error}</p>}
        <div className="flex items-center justify-between gap-3 border-t px-3 py-2 text-xs text-muted-foreground">
          <span title="Most recent subscription check">checked: {checkedAt ? `${Math.max(0, Math.floor((now - checkedAt) / 1000))} seconds ago` : 'pending'}</span>
          <button type="button" disabled={busy} onClick={() => void unsubscribe(items)} className="shrink-0 hover:underline disabled:opacity-50">unsubscribe all</button>
        </div>
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}
export default definePluginApp(app => {
  app.slots.experimental_threadHeaderAction({ id: 'subscriptions', title: 'Subscriptions', component: SubscriptionCount });
});
