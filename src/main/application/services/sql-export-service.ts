import { connectionIdentity } from './connection-service';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, open, readFile, realpath, rename, rm, rmdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import type { Actor, Settings } from '../../../shared/types';
import type { SqlExportProgress } from '../../../shared/sql-export';
import { SQL_FILE_LIMIT } from '../../../shared/sql-script';
import { splitSqlScript } from '../../database/sql-script-parser';
import type { ConnectionService } from './connection-service';
import type { EventBus } from '../events/event-bus';
import type { PermissionService } from '../../mcp/permissions/permission-service';
import type { AuditService } from '../../mcp/audit/audit-service';

interface ExportJob {
  actor: Actor;
  config: string;
  controller: AbortController;
  progress: SqlExportProgress;
  directory?: string;
  file?: string;
  work: Promise<void>;
}
export class SqlExportService {
  private jobs = new Map<string, ExportJob>();
  private closing = false;
  constructor(
    private connections: ConnectionService,
    private events: EventBus,
    private permissions: PermissionService,
    private audit: AuditService,
    private settings: () => Settings,
  ) {
    events.subscribe((event) => {
      if (event.type === 'ConnectionChanged' && (event.payload as any)?.disconnecting)
        this.cancelConnection((event.payload as any).connectionId);
      if (event.type === 'McpStopped')
        for (const job of this.jobs.values())
          if (job.actor.kind === 'agent') job.controller.abort();
    });
  }
  async start(
    input: { id: string; connectionId: string; database: string; includeData: boolean },
    actor: Actor,
  ) {
    if (this.closing) throw new Error('SQL export service is shutting down.');
    this.connections.assertAvailable(input.connectionId);
    const connection = this.connections.get(input.connectionId);
    this.permissions.evaluate(actor, connection, 'read');
    const config = connectionIdentity(connection);
    if (this.jobs.has(input.id)) throw new Error('This export ID has already been used.');
    if ([...this.jobs.values()].filter((j) => j.progress.state === 'running').length >= 4)
      throw new Error('At most four SQL exports can run at once.');
    const adapter = await this.connections.connect(input.connectionId, input.database);
    if (this.closing) throw new Error('SQL export service is shutting down.');
    if (!adapter.exportSql)
      throw new Error('SQL export is not yet supported for this database engine.');
    // Recheck after connection establishment, before reserving a job ID.
    if (this.jobs.has(input.id)) throw new Error('This export ID has already been used.');
    if ([...this.jobs.values()].filter((j) => j.progress.state === 'running').length >= 4)
      throw new Error('At most four SQL exports can run at once.');
    if (this.jobs.size >= 12)
      throw new Error('Release an earlier SQL export before starting another.');
    const job: ExportJob = {
      actor: structuredClone(actor),
      config,
      controller: new AbortController(),
      progress: { ...input, state: 'running', bytes: 0, tables: 0, rows: 0 },
      work: Promise.resolve(),
    };
    this.jobs.set(input.id, job);
    let lastEvent = 0;
    const emit = (force = false) => {
      if (force || Date.now() - lastEvent >= 100) {
        lastEvent = Date.now();
        this.events.emit('SqlExportProgress', this.audit.sanitize(structuredClone(job.progress)));
      }
    };
    const check = () => {
      if (job.controller.signal.aborted) throw new Error('SQL export cancelled.');
      this.connections.assertAvailable(input.connectionId);
      const current = this.connections.get(input.connectionId);
      this.permissions.evaluate(actor, current, 'read');
      if (connectionIdentity(current) !== config)
        throw new Error('Connection configuration changed. Export stopped.');
    };
    job.work = (async () => {
      try {
        check();
        job.directory = await mkdtemp(join(tmpdir(), 'database-workspace-export-'));
        job.file = join(job.directory, 'export.sql');
        const file = await open(job.file, 'wx', 0o600);
        try {
          await adapter.exportSql!({
            includeData: input.includeData,
            signal: job.controller.signal,
            timeout: this.settings().queryTimeout,
            write: async (chunk) => {
              check();
              const buffer = Buffer.from(chunk, 'utf8');
              if (job.progress.bytes + buffer.length > SQL_FILE_LIMIT)
                throw new Error(
                  'SQL export exceeds the 16 MiB SQL-file limit. No partial file was saved.',
                );
              // FileHandle.write may be short; writeFile writes this complete buffer
              // at the descriptor's current position, serially under backpressure.
              await file.writeFile(buffer);
              job.progress.bytes += buffer.length;
              emit();
            },
            progress: (value) => {
              Object.assign(job.progress, value);
              emit();
            },
          });
          await file.sync();
        } finally {
          await file.close();
        }
        check();
        // Exports obey the same size/batch/lexical limits as our SQL-file importer.
        splitSqlScript(await readFile(job.file, 'utf8'), connection.engine);
        check();
        job.progress.state = 'completed';
      } catch (error) {
        job.progress.state = job.controller.signal.aborted ? 'cancelled' : 'failed';
        job.progress.error = (error as Error).message;
        await this.removeFiles(job).catch(() => {
          job.progress.error += ' Could not remove the temporary export file.';
        });
      } finally {
        // Auditing must never reject job.work: release() and shutdown() await it
        // before cleaning up temporary files.
        try {
          this.audit.record({
            actor,
            command: 'export.finished',
            connectionId: input.connectionId,
            database: input.database,
            summary: JSON.stringify(input),
            status: job.progress.state === 'completed' ? 'success' : 'error',
            duration: 0,
            result: JSON.stringify(job.progress),
          });
        } catch (error) {
          console.error('Could not audit export completion', error);
        }
        emit(true);
      }
    })();
    return structuredClone(job.progress);
  }
  private owned(id: string, actor: Actor, checkAccess = true) {
    const job = this.jobs.get(id);
    if (
      !job ||
      (actor.kind === 'agent' && (job.actor.kind !== actor.kind || job.actor.id !== actor.id))
    )
      throw new Error('SQL export not found.');
    if (checkAccess) {
      const connection = this.connections.get(job.progress.connectionId);
      this.permissions.evaluate(actor, connection, 'read');
      if (connectionIdentity(connection) !== job.config)
        throw new Error('Connection configuration changed. Create a new SQL export.');
    }
    return job;
  }
  status(id: string, actor: Actor) {
    return structuredClone(this.owned(id, actor).progress);
  }
  cancel(id: string, actor: Actor) {
    const job = this.owned(id, actor, false);
    if (job.progress.state !== 'running') return { cancelled: false };
    job.controller.abort();
    return { cancelled: true };
  }
  async read(id: string, offset: number, actor: Actor) {
    const job = this.owned(id, actor);
    if (job.progress.state !== 'completed' || !job.file)
      throw new Error('SQL export is not ready.');
    const file = await open(job.file, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(65536, Math.max(0, job.progress.bytes - offset)));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
      this.owned(id, actor);
      return {
        base64: buffer.subarray(0, bytesRead).toString('base64'),
        nextOffset: offset + bytesRead,
        done: offset + bytesRead >= job.progress.bytes,
      };
    } finally {
      await file.close();
    }
  }
  /** Only the main-process native picker may supply a filesystem destination. */
  async save(id: string, destination: string, actor: Actor) {
    if (actor.kind !== 'human') throw new Error('Only the desktop user can save a local SQL file.');
    const job = this.owned(id, actor);
    if (job.progress.state !== 'completed' || !job.file)
      throw new Error('SQL export is not ready.');
    if (extname(destination).toLowerCase() !== '.sql') throw new Error('Choose a .sql file.');
    const canonical = async (path: string) => {
      const value = await realpath(path).catch(() => resolve(path));
      return process.platform === 'win32' ? value.toLowerCase() : value;
    };
    const target = await canonical(destination);
    for (const connection of this.connections.list())
      if (connection.engine === 'sqlite' && (await canonical(connection.database)) === target)
        throw new Error('The export destination cannot overwrite a connected SQLite database.');
    const staging = join(
      dirname(destination),
      '.' + basename(destination) + '.' + randomUUID() + '.tmp',
    );
    try {
      await copyFile(job.file, staging, constants.COPYFILE_EXCL);
      this.owned(id, actor);
      await rename(staging, destination);
    } finally {
      await rm(staging, { force: true });
    }
    return { saved: true, fileName: basename(destination), bytes: job.progress.bytes };
  }
  async release(id: string, actor: Actor) {
    // Releasing an owned temporary artifact must remain possible after access
    // revocation or connection deletion; it never returns database contents.
    const job = this.owned(id, actor, false);
    job.controller.abort();
    await job.work.catch(() => undefined);
    this.jobs.delete(id);
    await this.removeFiles(job);
    return { released: true };
  }
  private async removeFiles(job: ExportJob) {
    if (job.file) await rm(job.file, { force: true });
    if (job.directory)
      await rmdir(job.directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    job.file = undefined;
    job.directory = undefined;
  }
  cancelConnection(id: string) {
    for (const job of this.jobs.values())
      if (job.progress.connectionId === id) job.controller.abort();
  }
  async shutdown() {
    this.closing = true;
    for (const job of this.jobs.values()) job.controller.abort();
    await Promise.all(
      [...this.jobs.values()].map(async (job) => {
        await job.work.catch(() => undefined);
        await this.removeFiles(job).catch(() => undefined);
      }),
    );
    this.jobs.clear();
  }
}
