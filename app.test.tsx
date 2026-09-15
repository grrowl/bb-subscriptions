// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { loadPluginApp, renderSlot } from '@get-bb/plugin-sdk/testing/app';
import type { Subscription } from './model';
afterEach(() => { cleanup(); vi.useRealTimers(); });
async function setup(initial: Subscription[], fail = false) {
  let items = initial;
  const unsubscribe = vi.fn((input: { threadId: string; platform: string; ids: string[] }) => {
    if (fail) throw new Error('Removal failed');
    items = items.filter(item => item.platform !== input.platform || !input.ids.includes(item.id));
    return { ids: input.ids };
  });
  const app = await loadPluginApp(() => import('./app'));
  const slot = renderSlot(app.threadHeaderActions[0], { threadId: 't1', projectId: 'p1', isCompactViewport: false }, {
    rpc: { list: input => {
      expect(input).toEqual({ threadId: 't1' });
      return { subscriptions: items, intervalSeconds: 60 };
    }, unsubscribe: input => unsubscribe(input as { threadId: string; platform: string; ids: string[] }) },
  });
  fireEvent.click(await slot.findByText(`${items.length} following`));
  return { slot, unsubscribe };
}
const item = (platform: string, id: string, checkedAt: number | null = null): Subscription => ({ platform, id, snapshot: null, error: null, checkedAt });
it('opens the list and updates the elapsed check time every second', async () => {
  const { slot } = await setup([item('linear', 'ENG-1', Date.now() - 5000)]);
  expect(screen.getByText('linear ENG-1')).toBeTruthy();
  expect(screen.getByText('checked: 5 seconds ago')).toBeTruthy();
  fireEvent.click(screen.getByText('1 following'));
  vi.useFakeTimers();
  fireEvent.click(screen.getByText('1 following'));
  act(() => { vi.advanceTimersByTime(2000); });
  expect(screen.getByText('checked: 7 seconds ago')).toBeTruthy();
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  expect(screen.queryByText('linear ENG-1')).toBeNull();
  slot.lifecycle.unmount();
});
it('removes one subscription and then unsubscribes all remaining platforms', async () => {
  const { slot, unsubscribe } = await setup([item('linear', 'ENG-1'), item('linear', 'ENG-2'), item('github', 'org/repo#1')]);
  expect(screen.getByText('checked: pending')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Unsubscribe linear ENG-1' }));
  await waitFor(() => expect(screen.queryByText('linear ENG-1')).toBeNull());
  expect(unsubscribe).toHaveBeenCalledWith({ threadId: 't1', platform: 'linear', ids: ['ENG-1'] });
  fireEvent.click(screen.getByText('unsubscribe all'));
  await waitFor(() => expect(screen.queryByText('2 following')).toBeNull());
  expect(unsubscribe).toHaveBeenCalledWith({ threadId: 't1', platform: 'linear', ids: ['ENG-2'] });
  expect(unsubscribe).toHaveBeenCalledWith({ threadId: 't1', platform: 'github', ids: ['org/repo#1'] });
  slot.lifecycle.unmount();
});
it('keeps subscriptions visible and displays removal failures', async () => {
  const { slot } = await setup([item('linear', 'ENG-1')], true);
  fireEvent.click(screen.getByText('unsubscribe all'));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Removal failed');
  expect(screen.getByText('linear ENG-1')).toBeTruthy();
  slot.lifecycle.unmount();
});
