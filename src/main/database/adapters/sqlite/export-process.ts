import { spawn } from 'node:child_process';
import type { SqlExportOptions } from '../../../../shared/sql-export';

// The child owns a read-only snapshot. Each chunk waits for the writer's ACK:
// neither a slow disk nor a large table can accumulate unbounded IPC messages.
const source = String.raw`
const { DatabaseSync } = require('node:sqlite');
let ack;
process.on('message', () => { if (ack) { const resolve=ack; ack=undefined; resolve(); } });
const send = message => new Promise(resolve => { ack=resolve; process.send(message); });
const quote = name => '"' + name.replaceAll('"','""') + '"';
const literal = value => "'" + value.replaceAll("'", "''") + "'";
(async () => {
  const db = new DatabaseSync(process.argv[1], {readOnly:true});
  let tables=0, rows=0;
  try {
    db.exec('PRAGMA busy_timeout=5000; BEGIN;');
    const objects=db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all();
    const tableList=db.prepare('PRAGMA table_list').all().filter(t=>t.schema==='main');
    if (tableList.some(t=>t.type==='virtual' || t.type==='shadow'))
      throw new Error('SQL export does not yet support SQLite virtual/shadow tables. No partial file was saved.');
    const write = async text => send({chunk:text});
    const ddl = async sql => write(sql.trim().replace(/;+\s*$/, '')+'\n;\n');
    const encoding=db.prepare('PRAGMA encoding').get().encoding;
    await write('-- Database Workspace / SQLite SQL export\n-- Restore into an empty database.\n');
    await write('PRAGMA encoding='+literal(encoding)+';\nPRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\n');
    await write('PRAGMA user_version='+db.prepare('PRAGMA user_version').get().user_version+';\n');
    await write('PRAGMA application_id='+db.prepare('PRAGMA application_id').get().application_id+';\n');
    for (const table of objects.filter(o=>o.type==='table')) await ddl(table.sql);
    if (process.argv[2]==='data') for(const table of objects.filter(o=>o.type==='table')) {
      const columns=db.prepare('PRAGMA table_xinfo('+quote(table.name)+')').all().filter(c=>c.hidden===0);
      const names=columns.map(c=>c.name);
      if (!tableList.find(t=>t.name===table.name).wr) {
        const aliases=['rowid','_rowid_','oid'];
        const rowid=aliases.find(alias=>!names.some(name=>name.toLowerCase()===alias));
        if (!rowid) throw new Error('Cannot preserve the hidden rowid of table '+table.name+'. All rowid aliases are shadowed.');
        names.unshift(rowid);
      }
      const expr = name => {
        const c=quote(name);
        return 'CASE typeof('+c+') WHEN \'null\' THEN \'NULL\' WHEN \'integer\' THEN CAST('+c+' AS TEXT) '+
          'WHEN \'real\' THEN CASE WHEN '+c+'>1.7976931348623157e308 THEN \'9e999\' WHEN '+c+'< -1.7976931348623157e308 THEN \'-9e999\' ELSE printf(\'%!.26g\','+c+') END '+
          'WHEN \'blob\' THEN \'X\'\'\'||hex('+c+')||\'\'\'\' '+
          'ELSE \'CAST(X\'\'\'||hex(CAST('+c+' AS BLOB))||\'\'\' AS TEXT)\' END';
      };
      const statement=db.prepare('SELECT '+names.map((n,i)=>expr(n)+' AS '+quote('c'+i)).join(',')+' FROM '+quote(table.name));
      const prefix='INSERT INTO '+quote(table.name)+' ('+names.map(quote).join(',')+') VALUES\n';
      let values=[], bytes=0;
      const flush=async()=>{if(values.length) {await write(prefix+values.join(',\n')+';\n'); values=[]; bytes=0;}};
      for (const row of statement.iterate()) {
        const value='('+names.map((_,i)=>row['c'+i]).join(',')+')';
        if(bytes+Buffer.byteLength(value)>65536) await flush();
        values.push(value); bytes+=Buffer.byteLength(value); rows++;
        if(values.length>=100) await flush();
      }
      await flush(); tables++;
      await send({progress:{tables,rows,currentTable:table.name}});
    }
    if (process.argv[2]==='data' && db.prepare("SELECT 1 FROM sqlite_schema WHERE name='sqlite_sequence'").get()) {
      await write('DELETE FROM sqlite_sequence;\n');
      const sequence=db.prepare('SELECT name, CAST(seq AS TEXT) AS seq FROM sqlite_sequence');
      for(const row of sequence.iterate()) {
        if (!/^-?\d+$/.test(row.seq)) throw new Error('Invalid sqlite_sequence value.');
        await write('INSERT INTO sqlite_sequence(name,seq) VALUES('+literal(row.name)+','+row.seq+');\n');
      }
    }
    for (const type of ['index','view','trigger']) for(const object of objects.filter(o=>o.type===type)) await ddl(object.sql);
    await write('COMMIT;\nPRAGMA foreign_keys=ON;\n');
    db.exec('COMMIT');
    db.close();
    await send({progress:{tables:objects.filter(o=>o.type==='table').length,rows}});
    process.send({done:true},()=>process.exit(0));
  } catch(error) {
    try {db.close();} catch {}
    process.send({error:error.message},()=>process.exit(1));
  }
})().catch(error=>{process.send({error:error.message},()=>process.exit(1));});
`;

export async function sqliteSqlExport(file: string, options: SqlExportOptions) {
  if (file === ':memory:') throw new Error('SQL export requires a saved SQLite database file.');
  if (options.signal.aborted) throw new Error('SQL export cancelled.');
  const child = spawn(
    process.execPath,
    ['-e', source, file, options.includeData ? 'data' : 'schema'],
    {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true,
    },
  );
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.once('error', () => resolve());
  });
  let abort = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (error) {
          child.kill();
          reject(error);
        } else resolve();
      };
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(
          () => finish(new Error('SQL export timed out waiting for database data.')),
          options.timeout,
        );
      };
      abort = () => finish(new Error('SQL export cancelled.'));
      options.signal.addEventListener('abort', abort, { once: true });
      child.once('error', finish);
      child.once('exit', () => finish(new Error('SQLite export process closed unexpectedly.')));
      child.on('message', (message: any) => {
        void (async () => {
          if (settled) return;
          clearTimeout(timer);
          if (message.error) return finish(new Error(message.error));
          if (message.done) return finish();
          if (message.chunk !== undefined) await options.write(message.chunk);
          if (message.progress) options.progress(message.progress);
          if (!settled) {
            arm();
            child.send({ ack: true }, (error) => {
              if (error) finish(error);
            });
          }
        })().catch((error) => finish(error));
      });
      arm();
      if (options.signal.aborted) abort();
    });
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener('abort', abort);
    child.kill();
    await exited;
  }
}
