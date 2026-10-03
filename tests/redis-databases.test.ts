import { expect, it, vi } from 'vitest';
import { RedisAdapter } from '../src/main/database/adapters/redis/redis-adapter';
import type { Connection } from '../src/shared/types';

const adapter = () => new RedisAdapter({ database: '0' } as Connection);
it('does not reconnect a closed Redis client for a heartbeat', async () => {
  const redis = adapter();
  const connect = vi.spyOn(redis, 'connect');
  await expect(redis.heartbeat(1000)).rejects.toThrow('closed');
  expect(connect).not.toHaveBeenCalled();
});
it('lists configured Redis databases including empty ones and key counts', async () => {
  const redis = adapter();
  vi.spyOn(redis, 'command').mockImplementation(async (name, args) =>
    name === 'CONFIG'
      ? ['databases', '32']
      : args[0] === 'cluster'
        ? 'cluster_enabled:0\r\n'
        : '# Keyspace\r\ndb12:keys=7,expires=1,avg_ttl=0\r\n',
  );
  const result = await redis.databaseSummary();
  expect(result.inferred).toBe(false);
  expect(result.databases).toHaveLength(32);
  expect(result.databases[12]).toEqual({ database: '12', keys: 7 });
  expect(result.databases[31]).toEqual({ database: '31', keys: 0 });
});
it('shows unknown counts and an inferred list when metadata is denied', async () => {
  const redis = adapter();
  vi.spyOn(redis, 'command').mockRejectedValue(new Error('NOPERM this user has no permissions'));
  const result = await redis.databaseSummary();
  expect(result.inferred).toBe(true);
  expect(result.databases).toHaveLength(16);
  expect(result.databases.every((db) => db.keys === null)).toBe(true);
});
it('lists only DB0 for cluster metadata and surfaces network failures', async () => {
  const redis = adapter();
  const command = vi
    .spyOn(redis, 'command')
    .mockImplementation(async (name, args) =>
      name === 'CONFIG'
        ? ['databases', '16']
        : args[0] === 'cluster'
          ? 'cluster_enabled:1\r\n'
          : '',
    );
  expect((await redis.databaseSummary()).databases).toEqual([{ database: '0', keys: 0 }]);
  command.mockRejectedValue(new Error('Redis command timed out.'));
  await expect(redis.databaseSummary()).rejects.toThrow('timed out');
});
