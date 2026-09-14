import type { PluginSettingDescriptor } from '@get-bb/plugin-sdk';
import type { Snapshot } from '../model';

/** A lookup failure. `retryMs` schedules the row; `pauseProvider` also pauses every row of the platform. */
export class ProviderError extends Error {
  constructor(message: string, public retryMs = 60_000, public pauseProvider = false) { super(message); }
}
export type ProviderConfig = Record<string, string | number | boolean | undefined>;
export interface ProviderContext { config: ProviderConfig; signal: AbortSignal }
export type BatchResult = Map<string, Snapshot | ProviderError>;
/** Per-item results plus an optional provider-wide pause to apply after recording them. */
export interface FetchResult { items: BatchResult; pause?: ProviderError }

export interface Provider {
  /** Platform identifier used in the DB, CLI, RPC and agent tool. */
  id: string;
  label: string;
  /** Example ID for help text. */
  example: string;
  /** Settings merged into the plugin's settings page. Prefix keys with the provider id. */
  settings: Record<string, PluginSettingDescriptor>;
  /** Normalise user input (ID, URL, bare number) or throw with a usable message. */
  canonical(raw: string, ctx: { config: ProviderConfig; repository?: string }): string;
  /** Read the current state of one or more items. Missing keys are treated as lookup failures. */
  fetch(ids: string[], ctx: ProviderContext): Promise<FetchResult>;
}

/** Run `fn` over `items` with at most `limit` in flight. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; results[i] = await fn(items[i]); }
  }));
  return results;
}
