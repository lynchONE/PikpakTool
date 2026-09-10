import test from 'node:test';
import assert from 'node:assert/strict';
import { scan, plan, execute, bytes, yearOf } from '../core.mjs';
import { progressStats, formatDuration } from '../progress.mjs';
import { FakeApi, file, folder, movingFiles, delay } from './fake.mjs';
const options = { pollDelay: 0, pollCount: 2 };
async function prepare(api) { return plan(await scan(api)); }

test('parallel moves reach four workers and share one destination listing', async () => {
  const api = new FakeApi(movingFiles(), 2), prepared = await prepare(api), progress = [];
  api.calls = [];
  const result = await execute(api, prepared, { ...options, onProgress: p => progress.push(p) });
  assert.equal(result.moved, 12); assert.equal(api.peakWrites, 4);
  assert.equal(api.calls.filter(c => c[0] === 'list' && c[1] === 'year').length, 1);
  assert.equal(api.items.filter(i => !i.folder && i.parentId === 'year').length, 12);
  assert.ok(progress.every(p => p.completed <= p.total && p.active <= 4));
  assert.equal(progress.at(-1).completed, progress.at(-1).total);
  assert.equal(progress.at(-1).active, 0);
});
test('small files delete concurrently after all retained files finish; parents wait for children', async () => {
  const api = new FakeApi([folder('parent'), ...Array.from({ length: 4 }, (_, n) => folder(`child${n}`, 'parent')), ...Array.from({ length: 8 }, (_, n) => file(`small${n}`, `child${n % 4}`, { size: '1' }))], 2);
  const result = await execute(api, await prepare(api), options);
  assert.equal(result.trashed, 8); assert.equal(result.folders, 5); assert.equal(api.peakWrites, 4);
  const ids = api.writes.map(w => w[1]);
  assert.ok(ids.indexOf('parent') > Math.max(...Array.from({ length: 4 }, (_, n) => ids.indexOf(`child${n}`))));
  assert.ok(ids.findIndex(id => id.startsWith('child')) > Math.max(...Array.from({ length: 8 }, (_, n) => ids.indexOf(`small${n}`))));
});
test('duplicate deletion waits for the keeper and never deletes the keeper', async () => {
  const api = new FakeApi([folder('source'), folder('year', '', '2025'), ...Array.from({ length: 8 }, (_, n) => file(`copy${n}`, 'source', { name: 'same.zip', size: String(200000000 + n) }))], 2);
  const prepared = await prepare(api), winner = prepared.entries.find(i => i.action === 'move');
  const result = await execute(api, prepared, options);
  assert.equal(result.moved, 1); assert.equal(result.duplicates, 7);
  assert.deepEqual(api.writes[0], ['move', winner.id]);
  assert.equal((await api.get(winner.id)).trashed, false);
});
test('failed keeper protects duplicate group while unrelated cleanup continues', async () => {
  const api = new FakeApi([folder('source'), folder('year', '', '2025'), file('a', 'source', { name: 'same.zip' }), file('b', 'source', { name: 'same.zip' }), file('small', 'source', { size: '1' })]);
  api.move = async () => { throw new Error('move failed'); };
  const result = await execute(api, await prepare(api), options);
  assert.equal(result.failed, 1); assert.equal(result.duplicates, 0); assert.equal(result.trashed, 1);
  assert.ok(api.items.filter(i => i.name === 'same.zip').every(i => !i.trashed));
});
test('stop drains started writes and verification and never dispatches the remaining queue', async () => {
  const api = new FakeApi(movingFiles(16), 4), prepared = await prepare(api), controller = new AbortController(), records = [];
  const move = api.move.bind(api); let count = 0;
  api.move = async (...args) => { count++; if (count === 2) controller.abort(); await move(...args); };
  await assert.rejects(execute(api, prepared, { ...options, signal: controller.signal, onRecord: async r => records.push(r) }), /停止/);
  assert.equal(api.activeWrites, 0); assert.ok(count >= 2 && count <= 4);
  assert.equal(records.filter(r => r.action === 'moved').length, count);
  const finalCount = api.writes.length; await delay(20); assert.equal(api.writes.length, finalCount);
  assert.ok(api.writes.every(w => w[0] === 'move'));
});
test('journal failure prevents all not-yet-started writes', async () => {
  const api = new FakeApi(movingFiles(12)), prepared = await prepare(api);
  await assert.rejects(execute(api, prepared, { ...options, onRecord: async r => { if (r.action === 'pending') throw new Error('journal unavailable'); } }), /journal unavailable/);
  assert.equal(api.writes.length, 0);
});
test('fatal account error drains started workers and stops later stages', async () => {
  const api = new FakeApi(movingFiles(), 1), prepared = await prepare(api), get = api.get.bind(api);
  api.get = async id => { if (id === 'f1') throw Object.assign(new Error('token expired'), { status: 401 }); return get(id); };
  await assert.rejects(execute(api, prepared, options), /token expired/);
  assert.equal(api.activeWrites, 0); assert.ok(api.writes.length <= 4); assert.ok(api.writes.every(w => w[0] === 'move'));
});
test('data errors do not stop other parallel items; new files stay outside deletion plan', async () => {
  const api = new FakeApi([folder('source'), file('bad', 'source', { size: null }), file('small', 'source', { size: '1' })]);
  const prepared = await prepare(api); api.items.push(file('new', 'source', { size: '1' }));
  const result = await execute(api, prepared, options);
  assert.equal(result.trashed, 1); assert.ok(result.skipped >= 1);
  assert.equal((await api.get('new')).trashed, false); assert.equal((await api.get('bad')).trashed, false);
});
test('scan progress covers full recursive pagination and ends at the discovered total', async () => {
  const api = new FakeApi([folder('parent'), ...Array.from({ length: 13 }, (_, n) => folder(`d${n}`, 'parent'))]);
  const events = [], snapshot = await scan(api, { onProgress: p => events.push(p) });
  assert.equal(snapshot.items.length, 14);
  assert.ok(events.some(p => p.estimated && p.completed < p.total));
  assert.equal(events.at(-1).completed, 15); assert.equal(events.at(-1).total, 15); assert.equal(events.at(-1).estimated, false);
});
test('dynamic scan ETA waits for evidence and never promises completion at a growing total', () => {
  assert.equal(progressStats({ startedAt: 0, completed: 0, total: 1, estimated: true }, 5000).remaining, null);
  assert.equal(progressStats({ startedAt: 0, completed: 5, total: 5, estimated: true }, 10000).remaining, null);
  const execution = progressStats({ startedAt: 0, completed: 20, total: 100, active: 4 }, 10000);
  assert.equal(execution.rate, 2); assert.equal(execution.remaining, 40); assert.equal(execution.percent, 20);
  assert.equal(progressStats({ startedAt: 0, completed: 100, total: 100, active: 0 }, 15000).remaining, 0);
  assert.equal(formatDuration(61), '1 分 1 秒'); assert.equal(formatDuration(3600), '1 小时 0 分');
});
test('existing exact threshold, year boundary and archived duplicate priority remain unchanged', async () => {
  assert.equal(bytes('9007199254740993'), 9007199254740993n); assert.equal(bytes('100 MB'), null);
  assert.equal(yearOf('2025-12-31T16:00:00Z'), '2026'); assert.equal(yearOf('2025-02-30T00:00:00Z'), null);
  const api = new FakeApi([folder('year', '', '2025'), file('archived', 'year', { name: 'same.zip' }), file('larger', '', { name: 'same.zip', size: '300000000' }), file('exact', '', { size: '100000000' })]);
  const prepared = await prepare(api);
  assert.equal(prepared.entries.find(i => i.id === 'larger').keepId, 'archived');
  assert.equal(prepared.entries.find(i => i.id === 'exact').action, 'trash');
});
