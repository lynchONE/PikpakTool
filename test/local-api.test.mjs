import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalApi } from '../local-api.mjs';
import { PikPakApi } from '../api.mjs';

test('both transports invoke fetch with the browser global receiver', async () => {
  // Node fetch accepts arbitrary receivers; emulate the browser Web IDL brand check.
  const receivers = [];
  function browserFetch(url) {
    receivers.push(this);
    if (this !== globalThis) throw new TypeError('Illegal invocation');
    return Promise.resolve(new Response(JSON.stringify(url === '/local/rpc' ? { connection: 'session' } : { files: [] }), { status: 200 }));
  }
  const local = new LocalApi('fake', { fetchFn: browserFetch });
  const direct = new PikPakApi('fake', { fetchFn: browserFetch, spacing: 0 });
  await local.connect(); await direct.connect();
  assert.equal(receivers.length, 2); assert.ok(receivers.every(receiver => receiver === globalThis));
});
test('local guards reuse connection identity and every actual RPC carries it', async () => {
  const calls = [];
  const api = new LocalApi('fake-token', { fetchFn: async (_url, init) => {
    const body = JSON.parse(init.body); calls.push(body);
    return new Response(JSON.stringify(body.method === 'connect' ? { connection: 'session' } : {}), { status: 200 });
  } });
  await api.connect();
  for (let n = 0; n < 20; n++) assert.equal(await api.account(), 'session');
  assert.equal(calls.length, 1);
  await api.move('file', 'folder'); assert.equal(calls[1].connection, 'session');
  assert.ok(!JSON.stringify(api).includes('fake-token'));
  await api.disconnect(); await assert.rejects(api.account(), error => error.code === 'CONNECTION_CHANGED');
});
test('local transport surfaces changed sessions and failed connections as fatal categories', async () => {
  const api = new LocalApi('fake', { fetchFn: async () => new Response(JSON.stringify({ message: 'changed', code: 'CONNECTION_CHANGED' }), { status: 409 }) });
  await assert.rejects(api.get('file'), error => error.code === 'CONNECTION_CHANGED');
  const offline = new LocalApi('fake', { fetchFn: async () => { throw new TypeError('failed'); } });
  await assert.rejects(offline.connect(), error => error.code === 'LOCAL_CONNECTION');
});

test('connection failures do not incorrectly assert the server is stopped or expose credentials', async () => {
  const api = new LocalApi('private-test-token', { fetchFn: async () => { throw new Error('private-test-token'); } });
  await assert.rejects(api.connect(), error => error.code === 'LOCAL_CONNECTION' && !error.outcomeUnknown && !error.message.includes('private-test-token') && error.message.includes('不能仅据此判断服务已停止'));
});

test('body transport failure is fatal and an uncertain write is never replayed', async () => {
  let requests = 0;
  const api = new LocalApi('fake', { fetchFn: async () => {
    requests++;
    return { ok: true, status: 200, text: async () => { throw new TypeError('body interrupted'); } };
  } });
  await assert.rejects(api.move('file', 'target'), error => error.code === 'LOCAL_CONNECTION' && error.outcomeUnknown === true);
  assert.equal(requests, 1);
});

test('non-JSON responses stop the queue without exposing the response body', async () => {
  const api = new LocalApi('fake', { fetchFn: async () => new Response('private-response-content', { status: 200 }) });
  await assert.rejects(api.trash('file'), error => error.code === 'LOCAL_CONNECTION' && error.outcomeUnknown && !error.message.includes('private-response-content'));
});

test('trash verification accepts both boolean values without treating false as an error', async () => {
  for (const value of [false, true]) {
    const api = new LocalApi('fake', { fetchFn: async () => new Response(JSON.stringify(value), { status: 200 }) });
    assert.equal(await api.isTrashed('file', 'parent'), value);
  }
});

test('trash verification never coerces malformed results into deletion success', async () => {
  for (const value of [null, 0, 1, 'false', 'true', {}, []]) {
    const api = new LocalApi('fake', { fetchFn: async () => new Response(JSON.stringify(value), { status: 200 }) });
    await assert.rejects(api.isTrashed('file', 'parent'), error => error.code === 'LOCAL_CONNECTION');
  }
});

test('success responses are validated against the requested method', async () => {
  for (const [method, value] of [['connect', {}], ['list', { items: [] }], ['get', {}], ['move', false]]) {
    const api = new LocalApi('fake', { fetchFn: async () => new Response(JSON.stringify(value), { status: 200 }) });
    await assert.rejects(api.call(method), error => error.code === 'LOCAL_CONNECTION');
  }
});
