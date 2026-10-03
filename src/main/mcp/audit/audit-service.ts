import { randomUUID } from 'node:crypto';
import type { AuditEntry } from '../../../shared/types';
import type { Store } from '../../application/services/store';
import { EventBus } from '../../application/events/event-bus';
import { redact } from '../../security/redact';
// Audit keeps a bounded trace, not payloads: history holds the full SQL, and one
// entry must not be able to grow the whole file without limit.
const limits = { summary: 8 * 1024, sql: 32 * 1024, result: 2 * 1024 } as const;
const clip = (value: string | undefined, max: number) =>
  value !== undefined && value.length > max
    ? `${value.slice(0, max)}… [truncated ${value.length - max} characters]`
    : value;
export class AuditService {
  private cache?: { at: number; values: string[] };
  constructor(
    private store: Store<AuditEntry[]>,
    private events: EventBus,
    private loadSecrets: () => string[] = () => [],
  ) {
    // Decrypting every stored credential on each audit write is slow; reload only
    // when credentials may have changed (and at least once a minute).
    events.subscribe((event) => {
      if (['ConnectionChanged', 'SettingsChanged', 'McpStopped'].includes(event.type))
        this.cache = undefined;
    });
  }
  private secrets() {
    if (!this.cache || Date.now() - this.cache.at > 60_000)
      this.cache = { at: Date.now(), values: this.loadSecrets() };
    return this.cache.values;
  }
  sanitize<T>(value: T): T {
    return redact(value, this.secrets()) as T;
  }
  record(entry: Omit<AuditEntry, 'id' | 'timestamp'>) {
    const safe = redact(
      {
        ...entry,
        summary: clip(entry.summary, limits.summary)!,
        sql: clip(entry.sql, limits.sql),
        result: clip(entry.result, limits.result),
        id: randomUUID(),
        timestamp: new Date().toISOString(),
      },
      this.secrets(),
    ) as AuditEntry;
    this.store.write([...this.store.read(), safe].slice(-10000));
    this.events.emit('AuditRecorded', safe);
    return safe;
  }
  list(search = '') {
    return this.store
      .read()
      .filter((entry) => JSON.stringify(entry).toLowerCase().includes(search.toLowerCase()))
      .reverse();
  }
}
