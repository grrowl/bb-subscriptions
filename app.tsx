import { useCallback, useEffect, useRef, useState } from 'react';
import { definePluginApp, useRealtime, useRealtimeConnectionState, useRpc } from '@get-bb/plugin-sdk/app';
import type { rpcContract } from './server';
import type { Subscription } from './model';
function SubscriptionCount({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [items, setItems] = useState<Subscription[]>([]);
  const requestId = useRef(0);
  const connection = useRealtimeConnectionState();
  const refresh = useCallback(async () => {
    const request = ++requestId.current;
    try {
      const result = await rpc.call('list', { threadId });
      if (request === requestId.current) setItems(result.subscriptions);
    } catch { /* Keep the last known count during disconnects. */ }
  }, [rpc, threadId]);
  useEffect(() => { setItems([]); void refresh(); return () => { requestId.current++; }; }, [refresh]);
  useEffect(() => { if (connection === 'connected') void refresh(); }, [connection, refresh]);
  useRealtime('subscriptions-changed', () => { void refresh(); });
  if (!items.length) return null;
  const title = items.map(item => `${item.platform} ${item.id}: ${item.error ?? item.snapshot?.state ?? 'pending'}`).join('\n');
  return <span className="inline-flex h-7 items-center px-2 text-xs text-muted-foreground" title={title} role="status" aria-label={`${items.length} subscriptions${items.some(item => item.error) ? ', some checks failed' : ''}`}>{items.length} following{items.some(item => item.error) ? ' · !' : ''}</span>;
}
export default definePluginApp(app => {
  app.slots.experimental_threadHeaderAction({ id: 'subscriptions', title: 'Subscriptions', component: SubscriptionCount });
});
