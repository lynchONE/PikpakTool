import test from 'node:test';
import assert from 'node:assert/strict';
import { scan, plan } from '../core.mjs';
import { createTask, runTask, taskSummary } from '../batch.mjs';
import { FakeApi, file, folder, movingFiles } from './fake.mjs';

class MemoryStore {
  async create(task) { this.task = structuredClone(task); }
  async saveMeta(meta) { this.task.meta = structuredClone(meta); }
  async saveBatches(batches) {
    for (const batch of batches) { const index = this.task.batches.findIndex(b => b.id === batch.id); if (index < 0) this.task.batches.push(structuredClone(batch)); else this.task.batches[index] = structuredClone(batch); }
  }
  load() { return structuredClone(this.task); }
}
const options = { pollDelay: 0, pollCount: 2 };
async function setup(api) { const task = createTask(plan(await scan(api)), await api.identity()), store = new MemoryStore(); await store.create(task); return { task, store }; }

test('normal execution batches 50 IDs and makes no per-file detail or trash-verification reads', async () => {
  const api = new FakeApi([...movingFiles(123), ...Array.from({ length: 112 }, (_, n) => file(`small${n}`, 'source', { size: '1' }))]);
  const { task, store } = await setup(api); api.calls = [];
  api.get = async () => { throw new Error('normal execution must not get individual files'); };
  api.isTrashed = async () => { throw new Error('normal execution must not verify individual files'); };
  const result = await runTask(api, task, store, options);
  assert.equal(result.moved, 123); assert.equal(result.trashed, 112); assert.equal(result.folders, 1);
  const moves = api.writes.filter(w => w[0] === 'moveBatch');
  assert.deepEqual(moves.map(w => w[1].length).sort((a, b) => a - b), [23, 50, 50]);
  assert.ok(api.writes.filter(w => w[0] === 'trashBatch').every(w => w[1].length <= 50));
  assert.equal(task.meta.status, 'completed'); assert.equal(result.completed, result.total);
});

test('pause after a submitted batch resumes remaining work without resubmitting completed IDs', async () => {
  const api = new FakeApi(movingFiles(123)), { task, store } = await setup(api), controller = new AbortController();
  const move = api.moveBatch.bind(api); let once = false;
  api.moveBatch = async (...args) => { const result = await move(...args); if (!once) { once = true; controller.abort(); } return result; };
  await assert.rejects(runTask(api, task, store, { ...options, concurrency: 1, signal: controller.signal }), /停止/);
  const saved = store.load(); assert.ok(saved.batches.some(b => b.kind === 'move' && b.status === 'done'));
  const result = await runTask(api, saved, store, options);
  assert.equal(result.moved, 123);
  const ids = api.writes.filter(w => w[0] === 'moveBatch').flatMap(w => w[1]);
  assert.equal(ids.length, 123); assert.equal(new Set(ids).size, 123);
});

test('async receipt is saved and recovery polls the same task without resubmission', async () => {
  const api = new FakeApi(movingFiles(2)), { task, store } = await setup(api), controller = new AbortController();
  const move = api.moveBatch.bind(api);
  api.moveBatch = async (...args) => { await move(...args); controller.abort(); return { state: 'waiting', taskId: 'remote-task-1' }; };
  await assert.rejects(runTask(api, task, store, { ...options, signal: controller.signal }), /停止/);
  const saved = store.load(); assert.equal(saved.batches.find(b => b.kind === 'move').remoteTaskId, 'remote-task-1');
  let polled = 0; api.taskStatus = async id => { assert.equal(id, 'remote-task-1'); polled++; return { state: 'done', taskId: id }; };
  await runTask(api, saved, store, options);
  assert.equal(polled, 1); assert.equal(api.writes.filter(w => w[0] === 'moveBatch').length, 1);
});

test('lost response after a move is reconciled only on resume and never replayed', async () => {
  const api = new FakeApi(movingFiles(3)), { task, store } = await setup(api), move = api.moveBatch.bind(api);
  api.moveBatch = async (...args) => { await move(...args); throw Object.assign(new Error('transport lost'), { code: 'LOCAL_CONNECTION' }); };
  await assert.rejects(runTask(api, task, store, options), /transport lost/);
  const saved = store.load(); assert.equal(saved.batches.find(b => b.kind === 'move').status, 'unknown');
  const result = await runTask(api, saved, store, options);
  assert.equal(result.moved, 3); assert.equal(api.writes.filter(w => w[0] === 'moveBatch').length, 1);
});

test('unresolved write is kept unknown and never guessed safe to repeat', async () => {
  const api = new FakeApi(movingFiles(2)), { task, store } = await setup(api); let attempts = 0;
  api.moveBatch = async () => { attempts++; throw new Error('lost response'); };
  await runTask(api, task, store, options);
  const saved = store.load(); await runTask(api, saved, store, options);
  assert.equal(attempts, 1); assert.equal(saved.batches.find(b => b.kind === 'move').status, 'unknown');
  assert.equal(saved.meta.status, 'attention');
});

test('a failed keeper blocks only its duplicates, not a mixed batch of healthy groups', async () => {
  const api = new FakeApi([folder('source'), folder('year', '', '2025'), file('good', 'year', { name: 'good.zip' }), file('good-copy', 'source', { name: 'good.zip' }), file('bad', 'source', { name: 'bad.zip', size: '300000000' }), file('bad-copy', 'source', { name: 'bad.zip' })]);
  const { task, store } = await setup(api);
  api.moveBatch = async () => { throw Object.assign(new Error('bad move'), { status: 400 }); };
  const result = await runTask(api, task, store, options);
  assert.equal(result.duplicates, 1);
  assert.equal(api.items.find(i => i.id === 'good-copy').trashed, true);
  assert.equal(api.items.find(i => i.id === 'bad-copy').trashed, false);
  assert.ok(store.load().batches.some(b => b.status === 'blocked' && b.ids.includes('bad-copy')));
});

test('empty-folder cleanup retains nonempty folders and batches each depth separately', async () => {
  const api = new FakeApi([folder('parent'), folder('empty', 'parent'), file('bad', 'parent', { size: null })]);
  const { task, store } = await setup(api), result = await runTask(api, task, store, options);
  assert.equal(result.folders, 1); assert.equal(api.items.find(i => i.id === 'parent').trashed, false);
  assert.equal(result.completed, result.total);
});

test('task cannot resume with a different token fingerprint and never stores the connection token', async () => {
  const api = new FakeApi(movingFiles(1)), { task, store } = await setup(api);
  assert.ok(!JSON.stringify(task).includes('fake-account'));
  api.identity = async () => 'b'.repeat(64);
  await assert.rejects(runTask(api, task, store, options), /令牌/); assert.equal(api.writes.length, 0);
});

test('checkpoint failure before submission prevents a cloud write', async () => {
  const api = new FakeApi(movingFiles(1)), { task, store } = await setup(api);
  store.saveBatches = async () => { throw new Error('storage unavailable'); };
  await assert.rejects(runTask(api, task, store, options), /storage unavailable/); assert.equal(api.writes.length, 0);
});

test('a resumed unsent empty-folder batch checks emptiness again', async () => {
  const api = new FakeApi([folder('empty')]), { task, store } = await setup(api), controller = new AbortController();
  await assert.rejects(runTask(api, task, store, { ...options, signal: controller.signal, onRecord: async r => { if (r.action === 'batch-submitting') controller.abort(); } }), /停止/);
  assert.equal(api.writes.length, 0);
  api.items.push(file('new', 'empty', { size: '1' }));
  const saved = store.load(); await runTask(api, saved, store, options);
  assert.equal(api.items.find(i => i.id === 'empty').trashed, false);
  assert.equal(api.items.find(i => i.id === 'new').trashed, false);
});

test('folder cleanup remains resumable when a remote move is still pending', async () => {
  const api = new FakeApi(movingFiles(2)), { task, store } = await setup(api), move = api.moveBatch.bind(api);
  let submitted = 0, deferred;
  api.moveBatch = async (...args) => { submitted++; deferred = args; return { state: 'waiting', taskId: 'slow-move' }; };
  api.taskStatus = async taskId => ({ state: 'waiting', taskId });
  await runTask(api, task, store, { ...options, pollCount: 1 });
  assert.equal(task.batches.find(b => b.kind === 'folders').status, 'blocked');
  api.taskStatus = async taskId => { await move(...deferred); return { state: 'done', taskId }; };
  const saved = store.load(), result = await runTask(api, saved, store, options);
  assert.equal(submitted, 1); assert.equal(result.folders, 1); assert.equal(saved.meta.status, 'completed');
});
