import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
export interface Store<T> {
  read(): T;
  write(value: T): void;
}
export class JsonStore<T> implements Store<T> {
  constructor(
    private path: string,
    private initial: T,
  ) {}
  read(): T {
    if (!existsSync(this.path)) return structuredClone(this.initial);
    return JSON.parse(readFileSync(this.path, 'utf8')) as T;
  }
  write(value: T) {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(`${this.path}.tmp`, JSON.stringify(value, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameSync(`${this.path}.tmp`, this.path);
  }
}
export class MemoryStore<T> implements Store<T> {
  constructor(private value: T) {}
  read() {
    return structuredClone(this.value);
  }
  write(value: T) {
    this.value = structuredClone(value);
  }
}
