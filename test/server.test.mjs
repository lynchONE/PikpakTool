import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { startLocalServer } from '../scripts/local-server.mjs';
import { FakeApi, movingFiles, delay, file, folder } from './fake.mjs';
import { LocalApi } from '../local-api.mjs';
import { scan, plan, execute } from '../core.mjs';
async function setup(t, latency = 15) {
  const api = new FakeApi(movingFiles(), latency);
  const { server, url } = await startLocalServer({ port: 0, apiFactory: () => api });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = new URL(url).origin, page = await fetch(url), cookie = page.headers.get('set-cookie').split(';')[0];
  const rpc = (method, args = [], connection = 'fake-account', extraHeaders = {}) => fetch(`${origin}/local/rpc`, { method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', 'X-Organizer-Request': '1', ...extraHeaders }, body: JSON.stringify({ method, args, connection }) });
  assert.equal((await rpc('connect', ['fake-token'])).status, 200);
  return { api, rpc, origin, page };
}
test('independent writes and reads overlap; the same file and connection changes remain exclusive', async t => {
  const { api, rpc } = await setup(t, 80);
  const writes = Array.from({ length: 4 }, (_, n) => rpc('move', [`f${n}`, 'year']));
  while (api.activeWrites < 4) await delay(2);
  assert.equal((await rpc('get', ['f9'])).status, 200);
  assert.ok((await Promise.all(writes)).every(r => r.status === 200)); assert.equal(api.peakWrites, 4);
  const pending = rpc('move', ['f4', 'year']);
  while (!api.activeWrites) await delay(2);
  assert.equal((await rpc('trash', ['f4'])).status, 409);
  assert.equal((await rpc('connect', ['other-token'])).status, 409);
  assert.equal((await rpc('disconnect')).status, 409);
  assert.equal((await pending).status, 200);
});
test('local RPC still rejects cross-origin, missing sessions, arbitrary methods and forged hosts', async t => {
  const { rpc, origin, page } = await setup(t, 0);
  assert.match(await page.text(), /pikpak-server-protocol" content="3/);
  assert.equal((await rpc('trash', ['f1'], 'fake-account', { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await rpc('trash', ['f1'], 'fake-account', { Cookie: '' })).status, 401);
  assert.equal((await rpc('request', ['GET', 'https://evil.example'])).status, 400);
  const status = await new Promise((resolve, reject) => { const req = request(`${origin}/task.html`, { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); req.end(); });
  assert.equal(status, 403);
});

test('full local HTTP workflow completes scan, move, duplicate and small-file trash, and empty folders', async t => {
  const cloud = new FakeApi([
    folder('source'), folder('year', '', '2025'), folder('empty', 'source'),
    file('winner', 'year', { name: 'same.zip' }), file('duplicate', 'source', { name: 'same.zip' }),
    file('large'), file('small', 'source', { size: '1' }),
  ], 1);
  const { server, url } = await startLocalServer({ port: 0, apiFactory: () => cloud });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = new URL(url).origin, page = await fetch(url), cookie = page.headers.get('set-cookie').split(';')[0];
  const client = new LocalApi('synthetic-test-token', { fetchFn: (path, init) => fetch(`${origin}${path}`, {
    ...init, headers: { ...init.headers, Origin: origin, Cookie: cookie },
  }) });
  await client.connect();
  assert.equal(await client.isTrashed('small', 'source'), false);
  const prepared = plan(await scan(client)), records = [];
  const result = await execute(client, prepared, { pollDelay: 0, pollCount: 2, onRecord: async r => records.push(r) });
  assert.deepEqual(result, { moved: 1, kept: 1, trashed: 1, duplicates: 1, folders: 2, skipped: 0, failed: 0 });
  assert.equal(await client.isTrashed('small', 'source'), true);
  assert.equal((await client.get('winner')).trashed, false);
  assert.equal((await client.get('large')).parentId, 'year');
  assert.ok(records.some(r => r.action === 'duplicate-trashed'));
  assert.ok(records.some(r => r.action === 'folder-trashed'));
  const rerun = plan(await scan(client));
  assert.ok(rerun.entries.every(item => item.action === 'keep'));
});
