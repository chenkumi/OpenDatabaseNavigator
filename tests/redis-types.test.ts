import { expect, it, vi } from 'vitest';
import { RedisService } from '../src/main/application/services/redis-service';
import { RedisAdapter } from '../src/main/database/adapters/redis/redis-adapter';
import { ConnectionService } from '../src/main/application/services/connection-service';
import { EventBus } from '../src/main/application/events/event-bus';
import { DEFAULT_SETTINGS, type Connection } from '../src/shared/types';

function fixture() {
  const connection = { id: 'redis', engine: 'redis', database: '0' } as Connection;
  const adapter = new RedisAdapter(connection);
  const call = vi.spyOn(adapter, 'command');
  const service = new RedisService(
    {
      get: () => connection,
      connect: async () => adapter,
    } as unknown as ConnectionService,
    () => DEFAULT_SETTINGS,
    new EventBus(),
  );
  return { service, call };
}
it('unknown module values expose metadata without pretending to be editable collections', async () => {
  const { service, call } = fixture();
  call.mockImplementation(async (name) => (name === 'TYPE' ? 'custom-module' : 45));
  expect(
    await service.read(
      'get',
      { connectionId: 'redis', key: 'module' },
      { kind: 'human', id: 'human', name: 'Human' },
    ),
  ).toMatchObject({ type: 'custom-module', readOnly: true, ttl: 45, items: [], hasMore: false });
  expect(call.mock.calls.map(([name]) => name)).toEqual(['TYPE', 'TTL']);
});
it('malformed JSON and oversized UTF-8 stream entries never issue a write', async () => {
  const { service, call } = fixture();
  await expect(
    service.write('json_set', { connectionId: 'redis', key: 'json', value: '{broken' }),
  ).rejects.toThrow('valid JSON');
  await expect(
    service.write('xadd', {
      connectionId: 'redis',
      key: 'stream',
      fields: [['text', '中'.repeat(400000)]],
    }),
  ).rejects.toThrow('1 MiB');
  expect(call).not.toHaveBeenCalled();
});
