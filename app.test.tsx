// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { loadPluginApp, renderSlot } from '@get-bb/plugin-sdk/testing/app';
it('shows a scoped heading count with details and no management panel', async () => {
  const app = await loadPluginApp(() => import('./app'));
  expect(app.threadPanelActions).toHaveLength(0);
  const slot = renderSlot(app.threadHeaderActions[0], { threadId: 't1', projectId: 'p1', isCompactViewport: false }, {
    rpc: { list: input => {
      expect(input).toEqual({ threadId: 't1' });
      return { subscriptions: [{ platform: 'linear', id: 'ENG-1', snapshot: null, error: null, checkedAt: null }], intervalSeconds: 60 };
    } },
  });
  await slot.findByText('1 following');
  expect(slot.getByRole('status').getAttribute('title')).toContain('ENG-1: pending');
  slot.lifecycle.unmount();
});
