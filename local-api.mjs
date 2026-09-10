// Same-origin transport to the loopback server. The server alone talks to PikPak.
export class LocalApi {
  #token;
  #connection = '';
  #identity = '';
  #fetch;
  constructor(token, { fetchFn = fetch } = {}) {
    this.#token = token;
    // Window.fetch requires the browser global receiver, not this LocalApi instance.
    this.#fetch = fetchFn.bind(globalThis);
  }
  async call(method, args = []) {
    const outcomeUnknown = ['mkdir', 'move', 'trash', 'createFolder', 'moveBatch', 'trashBatch'].includes(method);
    const transportFailure = () => Object.assign(new Error(`LOCAL_CONNECTION：浏览器与本机服务之间的请求未完成，可能被客户端拦截或连接中断，不能仅据此判断服务已停止。${outcomeUnknown ? '此文件操作结果未知，请重新扫描核验，不要直接重试。' : '此请求没有发起文件移动或删除。'}`), {
      code: 'LOCAL_CONNECTION', path: '/local/rpc', dispatched: true, outcomeUnknown,
    });
    let response;
    try {
      response = await this.#fetch('/local/rpc', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-Organizer-Request': '1' },
        body: JSON.stringify({ method, args, connection: this.#connection }),
      });
    } catch { throw transportFailure(); }
    let text, data;
    try { text = await response.text(); } catch { throw transportFailure(); }
    try { data = JSON.parse(text); }
    catch { throw Object.assign(new Error('LOCAL_RESPONSE：本机请求返回了非 JSON 内容，已停止后续操作，请检查浏览器网络面板中的响应类型。'), { code: 'LOCAL_CONNECTION', outcomeUnknown }); }
    const object = data !== null && typeof data === 'object' && !Array.isArray(data);
    const invalidResponse = () => Object.assign(new Error('LOCAL_RESPONSE：本机响应结构异常，已停止后续操作。'), { code: 'LOCAL_CONNECTION', outcomeUnknown });
    if (!response.ok) {
      if (!object) throw invalidResponse();
      const error = new Error(data.message || '本机请求失败。'); error.status = data.status || response.status; error.code = data.code || ''; throw error;
    }
    // RPC results are method-specific: isTrashed returns a boolean, including false.
    // Do not coerce strings/objects into true: that could incorrectly confirm a deletion.
    const valid = ['moveBatch', 'trashBatch', 'taskStatus'].includes(method) ? object && ['done', 'waiting', 'unknown', 'failed'].includes(data.state) && typeof data.taskId === 'string'
      : method === 'createFolder' ? object && typeof data.id === 'string' && data.id.length > 0
      : method === 'isTrashed' ? typeof data === 'boolean'
      : method === 'account' ? typeof data === 'string' && data.length > 0
      : method === 'connect' ? object && typeof data.connection === 'string' && data.connection.length > 0
      : method === 'list' ? object && Array.isArray(data.items) && typeof data.next === 'string'
      : method === 'get' ? object && typeof data.id === 'string' && data.id.length > 0
      : object;
    if (!valid) throw invalidResponse();
    return data;
  }
  async connect() {
    try { const data = await this.call('connect', [this.#token]); this.#connection = data.connection; this.#identity = data.identity || ''; }
    finally { this.#token = ''; }
    return this.#connection;
  }
  async disconnect() {
    this.#token = '';
    if (this.#connection) { const pending = this.call('disconnect').catch(() => {}); this.#connection = ''; await pending; }
  }
  async account() {
    // Every RPC is bound and checked by the server; do not add a separate HTTP request per guard.
    if (!this.#connection) throw Object.assign(new Error('连接已断开，请重新连接并扫描。'), { code: 'CONNECTION_CHANGED' });
    return this.#connection;
  }
  async identity() {
    await this.account();
    if (!this.#identity) throw new Error('本地服务不支持任务恢复，请重启新版服务。');
    return this.#identity;
  }
  createFolder(year) { return this.call('createFolder', [year]); }
  moveBatch(ids, parentId) { return this.call('moveBatch', [ids, parentId]); }
  trashBatch(ids) { return this.call('trashBatch', [ids]); }
  taskStatus(id) { return this.call('taskStatus', [id]); }
  list(parentId, token = '', trashed = false) { return this.call('list', [parentId, token, trashed]); }
  get(id) { return this.call('get', [id]); }
  mkdir(year) { return this.call('mkdir', [year]); }
  move(id, parentId) { return this.call('move', [id, parentId]); }
  trash(id) { return this.call('trash', [id]); }
  isTrashed(id, parentId) { return this.call('isTrashed', [id, parentId]); }
}
