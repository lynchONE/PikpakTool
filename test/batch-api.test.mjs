import test from 'node:test';
import assert from 'node:assert/strict';
import { PikPakApi, batchReceipt } from '../api.mjs';
test('batch routes send up to 50 IDs and retain the remote task ID', async () => {
  const requests = [], api = new PikPakApi('fake', { spacing: 0, fetchFn: async (url, init) => {
    requests.push({ url: new URL(url), method: init.method, body: init.body && JSON.parse(init.body) });
    return new Response(JSON.stringify(init.method === 'GET' ? { id: 'task-1', phase: 'PHASE_TYPE_COMPLETE', progress: 100 } : { task_id: 'task-1' }), { status: 200 });
  } });
  const ids = Array.from({ length: 50 }, (_, n) => `f${n}`);
  assert.deepEqual(await api.moveBatch(ids, 'year'), { state: 'waiting', taskId: 'task-1' });
  assert.deepEqual(requests[0].body, { ids, to: { parent_id: 'year' } });
  await api.trashBatch(ids); assert.equal(requests[1].url.pathname, '/drive/v1/files:batchTrash');
  assert.equal((await api.taskStatus('task-1')).state, 'done');
  assert.ok(requests.every(r => !r.url.pathname.includes('batchDelete')));
  await assert.rejects(api.trashBatch([])); await assert.rejects(api.trashBatch(['x', 'x']));
  await assert.rejects(api.moveBatch([...ids, 'extra'], 'year'));
  assert.equal(requests.length, 3);
});
test('missing async receipts stay unknown, not falsely marked completed', () => {
  assert.deepEqual(batchReceipt({}), { state: 'unknown', taskId: '' });
  assert.deepEqual(batchReceipt({ task_id: 't' }), { state: 'waiting', taskId: 't' });
  assert.equal(batchReceipt({ task: { id: 't', phase: 'PHASE_TYPE_COMPLETE' } }).state, 'done');
});
test('resume identity is stable for the same normalized token and does not expose it', async () => {
  const a = new PikPakApi('fake-token'), b = new PikPakApi('Bearer fake-token'), c = new PikPakApi('different-token');
  assert.equal(await a.identity(), await b.identity()); assert.notEqual(await a.identity(), await c.identity());
  assert.match(await a.identity(), /^[a-f0-9]{64}$/); assert.ok(!JSON.stringify(a).includes('fake-token'));
});
