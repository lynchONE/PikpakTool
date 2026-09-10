import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { taskStore, closeStore, readRecords } from '../journal.mjs';
import { createTask } from '../batch.mjs';
import { plan, scan } from '../core.mjs';
import { FakeApi, movingFiles } from './fake.mjs';

test('IndexedDB migration preserves old logs and restores the plan and batch checkpoints after reopen', async () => {
  const old = await new Promise((resolve, reject) => {
    const request = indexedDB.open('pikpak-year-organizer', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('events', { keyPath: 'sequence', autoIncrement: true });
    request.onsuccess = () => resolve(request.result); request.onerror = reject;
  });
  await new Promise(resolve => { const tx = old.transaction('events', 'readwrite'); tx.objectStore('events').add({ action: 'old-log' }); tx.oncomplete = resolve; }); old.close();
  const api = new FakeApi(movingFiles(60)), task = createTask(plan(await scan(api)), await api.identity());
  await taskStore.create(task);
  const first = task.batches.find(b => b.kind === 'move'); first.status = 'waiting'; first.remoteTaskId = 'remote-id';
  await taskStore.saveBatches([first]); task.meta.status = 'paused'; await taskStore.saveMeta(task.meta); await closeStore();
  const restored = await taskStore.latest(await api.identity());
  assert.equal(restored.meta.id, task.meta.id); assert.equal(restored.plan.entries.length, 60);
  assert.equal(restored.batches.find(b => b.id === first.id).remoteTaskId, 'remote-id');
  assert.equal((await readRecords())[0].action, 'old-log');
  assert.equal(await taskStore.latest('b'.repeat(64)), null);
  // Splits of mixed duplicate batches are committed in one transaction.
  const child = { ...first, id: `${first.id}-deferred`, status: 'blocked', ids: ['one'] };
  await taskStore.saveBatches([{ ...first, ids: ['two'] }, child]); await closeStore();
  assert.ok((await taskStore.latest()).batches.some(b => b.id === child.id));
  const next = createTask(plan(await scan(api)), await api.identity());
  next.meta.createdAt = new Date(Date.now() + 1000).toISOString(); await taskStore.create(next);
  assert.equal((await taskStore.latest()).meta.id, next.meta.id);
  next.meta.status = 'completed'; await taskStore.saveMeta(next.meta);
  assert.equal(await taskStore.latest(), null); // Old superseded jobs must not reappear.
  await closeStore();
});
