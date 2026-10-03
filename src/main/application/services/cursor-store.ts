import { randomBytes } from 'node:crypto';
export interface CursorScope {
  actorId: string;
  connectionId: string;
  operation: string;
}
export class CursorStore<T> {
  private entries = new Map<string, { scope: CursorScope; value: T; expiresAt: number }>();
  constructor(
    private ttl = 5 * 60 * 1000,
    private maximum = 200,
  ) {}
  put(scope: CursorScope, value: T) {
    this.expire();
    if (this.entries.size >= this.maximum)
      throw new Error('Too many open cursors. Finish existing pages or wait for cursor expiry.');
    const cursor = randomBytes(24).toString('base64url');
    this.entries.set(cursor, {
      scope: structuredClone(scope),
      value,
      expiresAt: Date.now() + this.ttl,
    });
    return cursor;
  }
  take(cursor: string, scope: CursorScope, desktopOwner = false) {
    this.expire();
    const entry = this.entries.get(cursor);
    if (
      !entry ||
      (!desktopOwner && entry.scope.actorId !== scope.actorId) ||
      entry.scope.connectionId !== scope.connectionId ||
      entry.scope.operation !== scope.operation
    )
      throw new Error('Cursor is invalid, expired, or belongs to a different caller.');
    this.entries.delete(cursor);
    return entry.value;
  }
  private expire() {
    for (const [key, value] of this.entries)
      if (value.expiresAt <= Date.now()) this.entries.delete(key);
  }
}
