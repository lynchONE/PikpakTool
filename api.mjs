const BASE = 'https://api-drive.mypikpak.com';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class ApiError extends Error {
  constructor(message, status = 0, code = '') { super(message); this.status = status; this.code = code; }
}

export function normalizeToken(value) {
  if (typeof value !== 'string') throw new ApiError('TOKEN_FORMAT：请填写个人访问令牌。', 0, 'TOKEN_FORMAT');
  const token = value.trim().replace(/^Bearer\s+/i, '');
  if (!token || !/^[\x21-\x7e]+$/.test(token)) throw new ApiError('TOKEN_FORMAT：令牌含空格、换行、中文或不可见字符；请只粘贴令牌本身。', 0, 'TOKEN_FORMAT');
  return token;
}

export function batchReceipt(data) {
  const task = data?.task || data;
  const rawId = data?.task_id || data?.task?.id || '';
  const taskId = typeof rawId === 'string' ? rawId : '';
  const phase = task?.phase || '';
  if (phase === 'PHASE_TYPE_COMPLETE') return { state: 'done', taskId };
  if (phase === 'PHASE_TYPE_ERROR') return { state: 'failed', taskId };
  return { state: typeof taskId === 'string' && taskId ? 'waiting' : 'unknown', taskId: typeof taskId === 'string' ? taskId : '' };
}
function batchIds(ids) {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 50 || ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) throw new ApiError('批次必须包含 1 至 50 个不同的非空文件 ID。');
  return ids;
}

export function normalize(raw) {
  if (!raw || typeof raw.id !== 'string' || !raw.id || typeof raw.name !== 'string' ||
      !['drive#file', 'drive#folder'].includes(raw.kind) ||
      (raw.parent_id != null && typeof raw.parent_id !== 'string') ||
      (raw.trashed !== undefined && typeof raw.trashed !== 'boolean')) {
    throw new ApiError('文件元数据格式不兼容，已停止。');
  }
  return {
    id: raw.id, parentId: raw.parent_id || '', name: raw.name,
    folder: raw.kind === 'drive#folder', size: raw.size ?? null,
    addedAt: raw.created_time ?? null, phase: raw.phase ?? '',
    trashed: raw.trashed === true,
  };
}

export class PikPakApi {
  #token;
  #session;
  #fetch;
  #nextRequest = 0;
  #identity;
  constructor(token, { fetchFn = fetch, spacing = 100, retryDelay = 800, timeout = 20000 } = {}) {
    this.#token = normalizeToken(token);
    this.#session = crypto.randomUUID();
    // Preserve the native Window/Worker receiver when invoking through a class field.
    this.#fetch = fetchFn.bind(globalThis);
    this.spacing = spacing; this.retryDelay = retryDelay; this.timeout = timeout;
  }
  async account() {
    if (!this.#token) throw new ApiError('连接已断开，请重新连接并扫描。');
    return this.#session;
  }
  async identity() {
    if (!this.#token) throw new ApiError('连接已断开。');
    this.#identity ||= crypto.subtle.digest('SHA-256', new TextEncoder().encode(this.#token)).then(buffer => [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join(''));
    return this.#identity;
  }
  disconnect() { this.#token = ''; }
  async request(method, path, data, { readAttempts = 3, timeout = this.timeout } = {}) {
    if (!this.#token) throw new ApiError('连接已断开。');
    // Host and routes are constants, never taken from remote responses or UI input.
    const url = new URL(path, BASE);
    if (url.origin !== BASE || !url.pathname.startsWith('/drive/v1/')) throw new ApiError('拒绝非网盘请求。');
    if (method === 'GET' && data) for (const [key, value] of Object.entries(data)) url.searchParams.set(key, String(value));
    const attempts = method === 'GET' ? readAttempts : 1; // Never blindly replay writes after a timeout.
    for (let attempt = 0; attempt < attempts; attempt++) {
      const slot = Math.max(Date.now(), this.#nextRequest);
      this.#nextRequest = slot + this.spacing;
      await sleep(Math.max(0, slot - Date.now()));
      let response, payload;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        response = await this.#fetch(url.href, {
          method, credentials: 'omit', redirect: 'error', cache: 'no-store',
          headers: { Authorization: `Bearer ${this.#token}`, ...(method !== 'GET' ? { 'Content-Type': 'application/json' } : {}) },
          ...(method !== 'GET' ? { body: JSON.stringify(data) } : {}),
          signal: controller.signal,
        });
        if (response.ok && response.status !== 204) {
          const text = await response.text();
          try { payload = JSON.parse(text); }
          catch { throw new ApiError('JSON_INVALID：网盘返回了非 JSON 数据，接口或代理响应不兼容。', response.status, 'JSON_INVALID'); }
        }
      } catch (error) {
        if (error instanceof ApiError) throw error;
        if (attempt + 1 < attempts) { await sleep(this.retryDelay * 2 ** attempt); continue; }
        const code = controller.signal.aborted ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR';
        const reason = controller.signal.aborted ? `请求超过 ${Math.round(timeout / 1000)} 秒未返回` : '未能取得接口响应，请检查运行环境的代理/网络；扩展模式还需检查网站访问权限';
        throw new ApiError(`${code}：${method} ${url.origin}${url.pathname}：${reason}。${method === 'GET' ? '此次读取未修改网盘。' : '此写操作结果需重新核验，禁止直接重试。'}`, 0, code);
      } finally { clearTimeout(timer); }
      if (response.status === 401) throw new ApiError(`HTTP 401：${method} ${url.pathname}：认证未通过，请检查个人令牌是否完整、有效。`, 401, 'UNAUTHENTICATED');
      if (response.status === 403) throw new ApiError(`HTTP 403：${method} ${url.pathname}：访问被拒绝，请检查令牌“管理文件”权限或 PikPak 账号验证状态。`, 403, 'ACCESS_DENIED');
      if (!response.ok) {
        if ((response.status === 429 || response.status >= 500) && attempt + 1 < attempts) {
          const retryAfter = response.headers.get('retry-after');
          const seconds = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : 0;
          const delay = Math.min(60000, Math.max(seconds * 1000, this.retryDelay * 2 ** attempt));
          this.#nextRequest = Math.max(this.#nextRequest, Date.now() + delay);
          await sleep(delay); continue;
        }
        throw new ApiError(`网盘接口返回 HTTP ${response.status}，已停止。`, response.status);
      }
      if (response.status === 204) return {};
      if (!payload || typeof payload !== 'object' || payload.error || payload.error_code || payload.error_description) {
        throw new ApiError('网盘返回业务错误，已停止；请在 PikPak 检查账号状态。');
      }
      return payload;
    }
  }
  async connect() {
    // The organizer needs file access, not account/quota access. Fail promptly on a bad connection.
    await this.list('', '', false, { readAttempts: 1, timeout: Math.min(this.timeout, 12000) });
    return this.account();
  }
  async list(parentId, token = '', trashed = false, requestOptions) {
    const payload = await this.request('GET', '/drive/v1/files', {
      parent_id: parentId, page_token: token, limit: 100,
      // Do not filter phase: incomplete uploads must remain visible and protect their folders.
      filters: JSON.stringify({ trashed: { eq: trashed } }),
      with_audit: 'true',
    }, requestOptions);
    if (!Array.isArray(payload.files) || (payload.next_page_token != null && typeof payload.next_page_token !== 'string')) {
      throw new ApiError('目录分页格式不兼容，无法确认完整扫描。');
    }
    const items = payload.files.map(normalize);
    if (items.some(i => i.trashed !== trashed)) throw new ApiError('网盘未遵循回收站过滤条件，扫描已停止。');
    return { items, next: payload.next_page_token || '' };
  }
  async get(id) {
    const raw = await this.request('GET', `/drive/v1/files/${encodeURIComponent(id)}`);
    return normalize(raw);
  }
  async mkdir(year) {
    if (!/^\d{4}$/.test(year)) throw new ApiError('年份目录名无效。');
    return this.request('POST', '/drive/v1/files', { kind: 'drive#folder', name: year, parent_id: '' });
  }
  async createFolder(year) {
    const result = await this.mkdir(year), id = result.file?.id;
    if (typeof id !== 'string' || !id) throw new ApiError('目录创建请求已提交，但未返回目录 ID；恢复时将重新读取根目录。');
    return { id };
  }
  async moveBatch(ids, parentId) {
    if (typeof parentId !== 'string' || !parentId) throw new ApiError('目标目录 ID 缺失。');
    return batchReceipt(await this.request('POST', '/drive/v1/files:batchMove', { ids: batchIds(ids), to: { parent_id: parentId } }));
  }
  async trashBatch(ids) {
    return batchReceipt(await this.request('POST', '/drive/v1/files:batchTrash', { ids: batchIds(ids) }));
  }
  async taskStatus(id) {
    if (typeof id !== 'string' || !id) throw new ApiError('批次任务 ID 缺失。');
    const data = await this.request('GET', `/drive/v1/tasks/${encodeURIComponent(id)}`), task = data.task || data;
    return { state: task.phase === 'PHASE_TYPE_COMPLETE' ? 'done' : task.phase === 'PHASE_TYPE_ERROR' ? 'failed' : 'waiting', taskId: id, progress: Number(task.progress) || 0 };
  }
  async move(id, parentId) {
    if (!id || !parentId) throw new ApiError('移动文件 ID 或目标目录 ID 缺失。');
    return this.request('POST', '/drive/v1/files:batchMove', { ids: [id], to: { parent_id: parentId } });
  }
  async trash(id) {
    if (!id) throw new ApiError('禁止删除根目录。');
    return this.request('POST', '/drive/v1/files:batchTrash', { ids: [id] });
  }
  async isTrashed(id, parentId) {
    try {
      const item = await this.get(id);
      if (item.id !== id) throw new ApiError('回收站结果 ID 不一致。');
      return item.trashed;
    } catch (error) {
      if (error.status !== 404) throw error;
      // A 404 alone does NOT prove a successful trash operation.
      let token = ''; const tokens = new Set();
      do {
        if (tokens.has(token) || tokens.size > 10000) throw new ApiError('回收站分页异常。');
        tokens.add(token);
        const page = await this.list(parentId, token, true);
        if (page.items.some(item => item.id === id && item.trashed)) return true;
        token = page.next;
      } while (token);
      return false;
    }
  }
}
