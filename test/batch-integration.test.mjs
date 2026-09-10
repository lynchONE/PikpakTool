import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { startLocalServer } from '../scripts/local-server.mjs';
import { LocalApi } from '../local-api.mjs';
import { taskStore, closeStore } from '../journal.mjs';
import { scan, plan } from '../core.mjs';
import { createTask, runTask } from '../batch.mjs';
import { FakeApi, file, folder } from './fake.mjs';

test('HTTP plus IndexedDB: submit a batch, pause, reconnect and recover without a full rescan or duplicate write', async t => {
  const cloud = new FakeApi([folder('source'), ...Array.from({ length: 61 }, (_, n) => file(`large${n}`)), ...Array.from({ length: 61 }, (_, n) => file(`small${n}`, 'source', { size: '1' }))], 1);
  const controller = new AbortController(), move = cloud.moveBatch.bind(cloud); let interrupted = false;
  cloud.moveBatch = async (...args) => {
    const result = await move(...args);
    if (!interrupted) { interrupted = true; controller.abort(); return { state: 'waiting', taskId: 'async-batch' }; }
    return result;
  };
  const { server, url } = await startLocalServer({ port: 0, apiFactory: () => { const adapter = Object.create(cloud); adapter.session = crypto.randomUUID(); return adapter; } });
  t.after(async () => { await closeStore(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); });
  const origin = new URL(url).origin, page = await fetch(url), cookie = page.headers.get('set-cookie').split(';')[0];
  const transport = (path, init) => fetch(`${origin}${path}`, { ...init, headers: { ...init.headers, Origin: origin, Cookie: cookie } });
  const first = new LocalApi('synthetic-test-token', { fetchFn: transport }); await first.connect();
  const task = createTask(plan(await scan(first)), await first.identity()); await taskStore.create(task);
  await assert.rejects(runTask(first, task, taskStore, { signal: controller.signal, concurrency: 1, pollDelay: 0 }), /停止/);
  await first.disconnect(); await closeStore();
  const resumed = new LocalApi('synthetic-test-token', { fetchFn: transport }); await resumed.connect();
  const saved = await taskStore.latest(await resumed.identity());
  assert.equal(saved.meta.id, task.meta.id); assert.ok(saved.batches.some(b => b.remoteTaskId === 'async-batch'));
  cloud.get = async () => { throw new Error('normal resume must not read individual file details'); };
  const result = await runTask(resumed, saved, taskStore, { pollDelay: 0 });
  assert.equal(result.moved, 61); assert.equal(result.trashed, 61); assert.equal(result.folders, 1);
  const moved = cloud.writes.filter(w => w[0] === 'moveBatch').flatMap(w => w[1]);
  assert.equal(moved.length, 61); assert.equal(new Set(moved).size, 61);
  assert.equal(await taskStore.latest(await resumed.identity()), null);
});
