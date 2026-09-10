export const THRESHOLD = 100_000_000n;
export const TIMEZONE = 'Asia/Shanghai';
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '计算中';
  const total = Math.ceil(seconds), hours = Math.floor(total / 3600), minutes = Math.floor(total % 3600 / 60);
  if (hours) return `${hours} 小时 ${minutes} 分`;
  if (minutes) return `${minutes} 分 ${total % 60} 秒`;
  return `${total} 秒`;
}
export function progressStats({ completed = 0, total = 0, startedAt, estimated = false, active = 0 }, now = Date.now()) {
  const elapsed = Math.max(0, (now - startedAt) / 1000), done = Math.max(0, completed), count = Math.max(done, total);
  const rate = elapsed > 0 ? done / elapsed : 0, settled = !estimated && done >= count && active === 0;
  const remaining = settled ? 0 : elapsed >= 2 && done >= 2 && count > done && rate > 0 ? (count - done) / rate : null;
  return { elapsed, rate, remaining, percent: count > 0 ? Math.min(100, done / count * 100) : 0, completed: done, total: count };
}
const formatter = new Intl.DateTimeFormat('en', { timeZone: TIMEZONE, year: 'numeric' });

export function bytes(value) {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) return null;
  if (!['string', 'number'].includes(typeof value) || !/^\d+$/.test(String(value))) return null;
  return BigInt(value);
}
export function yearOf(value) {
  const match = typeof value === 'string' && value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/);
  if (!match) return null;
  const [, y, m, d, h, min, sec] = match;
  if (+y < 1000 || +m < 1 || +m > 12 || +d < 1 || +d > new Date(Date.UTC(+y, +m, 0)).getUTCDate() || +h > 23 || +min > 59 || +sec > 59) return null;
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) return null;
  const year = formatter.format(instant);
  return /^\d{4}$/.test(year) ? year : null;
}
export function checkStop(signal) {
  if (signal?.aborted) throw new Error('已停止；在途操作需核验，请重新扫描后继续。');
}
function fatal(error) {
  return error.fatal || error.status === 401 || ['NETWORK_ERROR', 'REQUEST_TIMEOUT', 'LOCAL_CONNECTION', 'CONNECTION_CHANGED'].includes(error.code);
}
export async function listAll(api, parentId, signal, onPage = () => {}) {
  const result = [], tokens = new Set(), ids = new Set(); let token = '';
  do {
    checkStop(signal);
    if (tokens.has(token)) throw new Error('分页标记循环，扫描不完整。');
    tokens.add(token);
    const page = await api.list(parentId, token);
    if (!Array.isArray(page.items) || typeof page.next !== 'string') throw new Error('目录分页格式不兼容。');
    for (const item of page.items) {
      if (!item.id || item.parentId !== parentId || ids.has(item.id) || item.trashed) throw new Error('目录内容重复或发生变化，请重新扫描。');
      ids.add(item.id); result.push(item);
    }
    token = page.next; onPage(result.length);
    if (result.length > 200_000 || tokens.size > 10_000) throw new Error('目录超过本工具扫描上限，已停止。');
  } while (token);
  return result;
}
export async function scan(api, { signal, onProgress = () => {}, concurrency = 4 } = {}) {
  const account = await api.account(), queue = [], seen = new Set(['']), items = [], scanErrors = [];
  const startedAt = Date.now();
  let visited = 0, cursor = 0, running = 1, failure;
  const report = message => onProgress({ stage: '扫描', message, completed: visited, total: queue.length + 1, unit: '目录', estimated: true, startedAt, active: running });
  const visit = async dir => {
    checkStop(signal);
    const children = await listAll(api, dir.id, signal, count => report(`${dir.path || '/'}：已读 ${count} 项；已发现 ${items.length} 项`));
    for (const item of children) {
      if (seen.has(item.id)) throw Object.assign(new Error('发现重复 ID 或目录循环，扫描已停止。'), { fatal: true });
      seen.add(item.id);
      const entry = { ...item, path: `${dir.path}/${item.name}`, depth: dir.depth + 1 }; items.push(entry);
      if (item.folder) queue.push({ id: item.id, path: entry.path, depth: entry.depth });
      if (items.length > 200_000) throw Object.assign(new Error('全盘超过 200,000 项，扫描已停止。'), { fatal: true });
    }
    visited++;
    report(`已完成 ${dir.path || '/'}；已发现 ${items.length} 项`);
  };
  // Root discovery must be complete before identifying any target year folder.
  await visit({ id: '', path: '', depth: 0 });
  const width = Math.max(1, Math.min(4, Math.floor(concurrency) || 1));
  running = 0;
  await new Promise((resolve, reject) => {
    const pump = () => {
      while (!failure && running < width && cursor < queue.length) {
        const dir = queue[cursor++]; running++;
        visit(dir).catch(error => {
          if (fatal(error) || signal?.aborted) failure ||= error;
          else { scanErrors.push({ id: dir.id, path: dir.path, reason: error.message }); visited++; report(`跳过 ${dir.path}；其他目录继续扫描`); }
        }).finally(() => { running--; pump(); });
      }
      if (!running && (failure || cursor >= queue.length)) failure ? reject(failure) : resolve();
    };
    pump();
  });
  checkStop(signal);
  if (await api.account() !== account) throw new Error('连接已改变，请重新扫描。');
  onProgress({ stage: '扫描完成', message: `扫描 ${visited} 个目录，发现 ${items.length} 项，跳过 ${scanErrors.length} 个目录`, completed: visited, total: queue.length + 1, unit: '目录', estimated: false, startedAt, active: 0 });
  return { account, complete: !scanErrors.length, rootComplete: true, scanErrors, scannedAt: new Date().toISOString(), items };
}
const byId = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
export function plan(snapshot) {
  if (!snapshot.complete && !snapshot.rootComplete) throw new Error('根目录扫描不完整，无法生成计划。');
  const entries = [], targets = new Map(), issues = [], byParent = new Map();
  for (const item of snapshot.items) {
    if (!byParent.has(item.parentId)) byParent.set(item.parentId, []);
    byParent.get(item.parentId).push(item);
  }
  const root = byParent.get('') || [];
  for (const item of snapshot.items.filter(i => !i.folder)) {
    const size = bytes(item.size); let action = 'move', reason = '', year = null;
    if (item.phase !== 'PHASE_TYPE_COMPLETE') { action = 'issue'; reason = '文件状态未知或尚未完成，跳过并保留'; }
    else if (size === null) { action = 'issue'; reason = '大小未知，跳过并保留'; }
    else if (size <= THRESHOLD) { action = 'trash'; reason = '小于或等于 100MB'; }
    else if (!(year = yearOf(item.addedAt))) { action = 'issue'; reason = '添加时间无效，跳过并保留'; }
    else {
      if (!targets.has(year)) {
        const matching = root.filter(i => i.name === year), folders = matching.filter(i => i.folder && i.phase === 'PHASE_TYPE_COMPLETE').sort(byId);
        targets.set(year, { year, id: folders[0]?.id || null, blocked: !folders.length && matching.length > 0 });
      }
      const target = targets.get(year);
      if (target.blocked) { action = 'issue'; reason = '年份目录名称被其他对象占用，跳过该年份'; }
      else if (target.id === item.parentId) { action = 'keep'; reason = '已位于正确年份目录'; }
      else reason = '大于 100MB，按添加年份归档';
    }
    entries.push({ ...item, action, reason, year, target: year ? `/${year}/${item.name}` : null });
  }
  const groups = new Map();
  for (const item of entries.filter(i => ['move', 'keep'].includes(i.action))) {
    const key = JSON.stringify([item.year, item.name]);
    if (!groups.has(key)) groups.set(key, []); groups.get(key).push(item);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => Number(b.action === 'keep') - Number(a.action === 'keep') || (bytes(a.size) > bytes(b.size) ? -1 : bytes(a.size) < bytes(b.size) ? 1 : 0) || Date.parse(a.addedAt) - Date.parse(b.addedAt) || byId(a, b));
    const winner = group[0];
    for (const loser of group.slice(1)) {
      loser.action = 'duplicate'; loser.keepId = winner.id; loser.target = null;
      loser.reason = `同一年份同名，删除此份；保留 ${winner.path}（${winner.size} 字节）`;
    }
    if (winner.action === 'move') {
      const occupants = byParent.get(targets.get(winner.year).id) || [];
      if (occupants.some(i => i.name === winner.name && i.id !== winner.id)) {
        winner.action = 'issue'; winner.reason = '目标有其他年份、未知信息或文件夹的同名对象，跳过此组';
        for (const loser of group.slice(1)) { loser.action = 'issue'; loser.reason = '保留文件无法归档，此同名组全部保留'; }
      }
    }
  }
  for (const item of entries.filter(i => i.action === 'issue')) issues.push(`${item.path}：${item.reason}`);
  for (const error of snapshot.scanErrors || []) issues.push(`${error.path}：目录扫描失败，整目录保留（${error.reason}）`);
  const protectedIds = new Set([...targets.values()].map(t => t.id).filter(Boolean));
  for (const error of snapshot.scanErrors || []) protectedIds.add(error.id);
  for (const dir of snapshot.items.filter(i => i.folder && i.phase !== 'PHASE_TYPE_COMPLETE')) { protectedIds.add(dir.id); issues.push(`${dir.path}：目录状态未知，保留`); }
  const directories = snapshot.items.filter(i => i.folder && !protectedIds.has(i.id)).sort((a, b) => b.depth - a.depth);
  return { snapshot, entries, directories, targets: [...targets.values()].sort((a, b) => a.year.localeCompare(b.year)), issues };
}
function assertSame(expected, actual, parentId = expected.parentId) {
  if (!actual || actual.id !== expected.id || actual.parentId !== parentId || actual.name !== expected.name || actual.folder !== expected.folder || actual.trashed || actual.phase !== 'PHASE_TYPE_COMPLETE' || (!expected.folder && (bytes(actual.size) !== bytes(expected.size) || actual.addedAt !== expected.addedAt))) {
    throw new Error(`对象已变化或结果未核验：${expected.path || expected.name}，跳过并保留。`);
  }
}
export async function execute(api, prepared, { signal, onProgress = () => {}, onRecord = async () => {}, pollDelay = 1200, pollCount = 25, concurrency = 4 } = {}) {
  if (!prepared.snapshot.complete && !prepared.snapshot.rootComplete) throw new Error('根目录扫描不完整，禁止执行。');
  const result = { moved: 0, kept: 0, trashed: 0, duplicates: 0, folders: 0, skipped: 0, failed: 0 };
  const account = prepared.snapshot.account;
  const width = Math.max(1, Math.min(4, Math.floor(concurrency) || 1)), startedAt = Date.now();
  const total = prepared.entries.length + (prepared.snapshot.scanErrors || []).length + prepared.targets.filter(t => !t.blocked).length + prepared.directories.length;
  let completed = 0, active = 0, halt, stage = '准备执行', message = '';
  const report = update => { stage = update.stage || stage; message = update.message ?? message; onProgress({ stage, message, completed, total, active, startedAt, estimated: false, unit: '项' }); };
  const check = () => { if (halt) throw halt; checkStop(signal); };
  const guard = async () => { check(); if (await api.account() !== account) throw Object.assign(new Error('连接已改变，已停止执行。'), { fatal: true }); check(); };
  const pool = async (items, fn) => {
    let cursor = 0;
    // Drain every started worker before surfacing a fatal error or cancellation.
    await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => {
      while (cursor < items.length && !halt && !signal?.aborted) {
        const item = items[cursor++]; active++; report({});
        try { await fn(item); }
        catch (error) { halt ||= error; }
        finally { active--; completed++; report({}); }
      }
    }));
    check();
  };
  const record = async (action, item, detail = '') => {
    try { await onRecord({ time: new Date().toISOString(), action, id: item.id, path: item.path || item.name, detail }); }
    catch (error) { error.fatal = true; halt ||= error; throw error; }
  };
  const attempt = async (item, fn) => {
    await guard();
    try { await fn(); return true; }
    catch (error) { if (fatal(error) || signal?.aborted) { halt ||= error; throw error; } result.failed++; await record('failed', item, error.message); return false; }
  };
  const mutate = async (action, item, fn, verify) => {
    await guard(); await record('pending', item, action); await guard();
    let requestError;
    try { await fn(); } catch (error) { requestError = error; }
    for (let n = 0; n < pollCount; n++) {
      if (await api.account() !== account) throw Object.assign(new Error('连接改变，操作结果未知。'), { fatal: true });
      if (await verify()) { await record(action, item, item.action === 'duplicate' ? item.reason : item.target || ''); return; }
      if (n + 1 < pollCount) await new Promise(resolve => setTimeout(resolve, pollDelay));
    }
    if (requestError && fatal(requestError)) throw requestError;
    throw new Error(`${item.path || item.name}：无法核验${action}结果，跳过后续相关操作。`);
  };
  await guard();
  report({});
  for (const item of prepared.entries.filter(i => i.action === 'issue')) { await guard(); result.skipped++; await record('skipped', item, item.reason); completed++; report({}); }
  for (const error of prepared.snapshot.scanErrors || []) { await guard(); result.skipped++; await record('skipped', error, error.reason); completed++; report({}); }
  report({ stage: '复核', message: '复核根目录与待操作文件，不再重复全盘扫描' });
  const rootItems = await listAll(api, '', signal), targets = new Map(), directoryCache = new Map();
  directoryCache.set('', new Set(rootItems.map(i => i.name)));
  const children = async id => { if (!directoryCache.has(id)) directoryCache.set(id, listAll(api, id, signal).then(items => new Set(items.map(i => i.name)))); return directoryCache.get(id); };
  for (const target of prepared.targets.filter(t => !t.blocked)) {
    await attempt({ id: target.id || '', name: `/${target.year}` }, async () => {
      if (target.id) {
        const found = rootItems.find(i => i.id === target.id);
        if (!found || !found.folder || found.name !== target.year || found.phase !== 'PHASE_TYPE_COMPLETE') throw new Error('年份目标已改变，跳过此年份。');
        targets.set(target.year, target.id);
      } else {
        if (rootItems.some(i => i.name === target.year)) throw new Error('预览后出现同名年份对象，跳过此年份。');
        const created = { id: '', name: `/${target.year}` };
        report({ stage: '创建目录', message: created.name });
        await mutate('created', created, () => api.mkdir(target.year), async () => {
          const found = (await listAll(api, '', signal)).filter(i => i.name === target.year);
          if (found.length > 1 || found.some(i => !i.folder)) throw new Error('年份目录冲突。');
          if (found.length === 1) { created.id = found[0].id; targets.set(target.year, created.id); return true; }
          return false;
        });
        directoryCache.set(created.id, new Set());
      }
    });
    completed++; report({});
  }
  const ready = new Map(), targetChecks = new Map(), keeperChecks = new Map();
  const sharedCheck = (cache, key, fn) => {
    if (!cache.has(key)) cache.set(key, Promise.resolve().then(fn).finally(() => cache.delete(key)));
    return cache.get(key);
  };
  const verifyTarget = async (year, id) => {
    return sharedCheck(targetChecks, id, async () => {
      const dir = await api.get(id);
      if (!dir.folder || dir.trashed || dir.parentId !== '' || dir.name !== year || dir.phase !== 'PHASE_TYPE_COMPLETE') throw new Error(`/${year} 目标目录已变化。`);
    });
  };
  report({ stage: '归档文件', message: `最多 ${width} 项同时处理` });
  await pool(prepared.entries.filter(i => ['keep', 'move'].includes(i.action)), async item => {
    const parent = targets.get(item.year);
    if (!parent) { result.skipped++; await record('skipped', item, '年份目录不可用，保留文件'); return; }
    await attempt(item, async () => {
      await verifyTarget(item.year, parent);
      assertSame(item, await api.get(item.id));
      if (item.action === 'keep') { result.kept++; await record('kept', item); ready.set(item.id, { ...item, parentId: parent }); return; }
      const occupants = await children(parent);
      if (occupants.has(item.name)) throw new Error('目标存在其他同名对象，保留此文件。');
      // Reserve before awaiting a write, so concurrent workers share the same name map.
      occupants.add(item.name);
      report({ stage: '归档文件', message: `${item.path} → /${item.year}/` });
      await mutate('moved', item, () => api.move(item.id, parent), async () => {
        const actual = await api.get(item.id);
        if (actual.parentId === item.parentId && !actual.trashed) { assertSame(item, actual); return false; }
        assertSame(item, actual, parent); await verifyTarget(item.year, parent); return true;
      });
      result.moved++; ready.set(item.id, { ...item, parentId: parent });
    });
  });
  report({ stage: '清理文件', message: '归档阶段已完成，核验并清理小文件与重复项' });
  await pool(prepared.entries.filter(i => ['trash', 'duplicate'].includes(i.action)), async item => {
    await guard();
    const keeper = item.action === 'duplicate' ? ready.get(item.keepId) : null;
    if (item.action === 'duplicate' && !keeper) { result.skipped++; await record('skipped', item, '保留文件未确认成功，此重复文件保留'); return; }
    await attempt(item, async () => {
      if (keeper) {
        await verifyTarget(keeper.year, keeper.parentId);
        assertSame(keeper, await sharedCheck(keeperChecks, keeper.id, () => api.get(keeper.id)));
        if (keeper.id === item.id || keeper.name !== item.name || keeper.year !== item.year) throw new Error('同名组信息不一致，保留文件。');
      }
      assertSame(item, await api.get(item.id));
      if (!keeper && (bytes(item.size) === null || bytes(item.size) > THRESHOLD)) throw new Error('文件不符合小文件条件，保留。');
      const action = keeper ? 'duplicate-trashed' : 'trashed';
      report({ stage: '清理文件', message: `${keeper ? '同名重复' : '小文件'}：${item.path}` });
      await mutate(action, item, () => api.trash(item.id), async () => {
        if (await api.isTrashed(item.id, item.parentId)) return true;
        assertSame(item, await api.get(item.id)); return false;
      });
      if (keeper) result.duplicates++; else result.trashed++;
    });
  });
  const protectedIds = new Set(['', ...targets.values()]);
  const layers = new Map();
  for (const dir of prepared.directories) { if (!layers.has(dir.depth)) layers.set(dir.depth, []); layers.get(dir.depth).push(dir); }
  report({ stage: '清理空目录', message: '同层目录并发处理，子目录完成后才检查父目录' });
  for (const depth of [...layers.keys()].sort((a, b) => b - a)) await pool(layers.get(depth), async dir => {
    if (protectedIds.has(dir.id)) return;
    await attempt(dir, async () => {
      assertSame(dir, await api.get(dir.id));
      // Never use the scan/destination cache for deleting folders.
      if ((await listAll(api, dir.id, signal)).length) { result.skipped++; await record('skipped', dir, '仍有内容，保留目录'); return; }
      report({ stage: '清理空目录', message: dir.path });
      await mutate('folder-trashed', dir, () => api.trash(dir.id), () => api.isTrashed(dir.id, dir.parentId));
      result.folders++;
    });
  });
  report({ stage: '执行完成', message: '所有计划项均已处理，结果和跳过原因见操作记录' });
  return result;
}
