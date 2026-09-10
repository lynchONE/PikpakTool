import { listAll, checkStop } from './core.mjs';

const terminal = new Set(['done', 'failed', 'skipped']);
const chunk = (items, size = 50) => Array.from({ length: Math.ceil(items.length / size) }, (_, n) => items.slice(n * size, (n + 1) * size));
const fatal = error => error.status === 401 || ['LOCAL_CONNECTION', 'CONNECTION_CHANGED', 'NETWORK_ERROR', 'REQUEST_TIMEOUT'].includes(error.code);

export function createTask(prepared, identityKey) {
  if (!/^[a-f0-9]{64}$/.test(identityKey)) throw new Error('缺少有效连接标识，无法保存可恢复任务。');
  const id = crypto.randomUUID(), createdAt = new Date().toISOString();
  const { account, items, ...snapshot } = prepared.snapshot;
  const plan = structuredClone({ ...prepared, snapshot });
  const batches = [];
  const add = (kind, entries, extra = {}) => {
    for (const part of chunk(entries)) batches.push({ taskId: id, id: `b${batches.length}`, kind, ids: part.map(i => i.id), status: 'pending', remoteTaskId: '', skippedIds: [], ...extra,
      ...(kind === 'duplicate' ? { keepIds: part.map(i => i.keepId) } : {}),
    });
  };
  for (const target of plan.targets.filter(t => !t.blocked && !t.id)) batches.push({ taskId: id, id: `b${batches.length}`, kind: 'mkdir', year: target.year, ids: [], status: 'pending', remoteTaskId: '', skippedIds: [] });
  for (const year of [...new Set(plan.entries.filter(i => i.action === 'move').map(i => i.year))]) add('move', plan.entries.filter(i => i.action === 'move' && i.year === year), { year });
  add('trash', plan.entries.filter(i => i.action === 'trash'));
  add('duplicate', plan.entries.filter(i => i.action === 'duplicate'));
  for (const depth of [...new Set(plan.directories.map(i => i.depth))].sort((a, b) => b - a)) add('folders', plan.directories.filter(i => i.depth === depth), { depth });
  return { meta: { id, version: 1, identityKey, createdAt, updatedAt: createdAt, status: 'ready', elapsedMs: 0, targets: plan.targets.filter(t => t.id && !t.blocked).map(t => ({ year: t.year, id: t.id })) }, plan, batches };
}

export function taskSummary(task) {
  const result = { moved: 0, kept: task.plan.entries.filter(i => i.action === 'keep').length, trashed: 0, duplicates: 0, folders: 0,
    skipped: task.plan.entries.filter(i => i.action === 'issue').length + (task.plan.snapshot.scanErrors || []).length, failed: 0, waiting: 0, completedBatches: 0, totalBatches: task.batches.length };
  let completed = result.kept + result.skipped, total = completed;
  for (const batch of task.batches) {
    const count = batch.kind === 'mkdir' ? 1 : batch.ids.length + (batch.skippedIds?.length || 0);
    total += count;
    if (!terminal.has(batch.status)) { result.waiting++; continue; }
    result.completedBatches++; completed += count;
    if (batch.status === 'failed') { result.failed += count; continue; }
    if (batch.status === 'skipped') { result.skipped += count; continue; }
    result.skipped += batch.skippedIds?.length || 0;
    if (batch.kind === 'move') result.moved += batch.ids.length;
    if (batch.kind === 'trash') result.trashed += batch.ids.length;
    if (batch.kind === 'duplicate') result.duplicates += batch.ids.length;
    if (batch.kind === 'folders') result.folders += batch.ids.length;
  }
  return { ...result, completed, total };
}

export async function runTask(api, task, store, { signal, onProgress = () => {}, onRecord = async () => {}, pollDelay = 1500, pollCount = 10, concurrency = 2 } = {}) {
  if (await api.identity() !== task.meta.identityKey) throw new Error('当前令牌与保存任务不一致，请使用原令牌恢复，或重新扫描创建新任务。');
  const session = await api.account(), resumed = task.meta.status !== 'ready', startedAt = Date.now() - task.meta.elapsedMs;
  const width = Math.max(1, Math.min(4, Math.floor(concurrency) || 2));
  const entryById = new Map(task.plan.entries.map(i => [i.id, i]));
  const dirById = new Map(task.plan.directories.map(i => [i.id, i]));
  const targets = new Map(task.meta.targets.map(t => [t.year, t.id]));
  let halt, active = 0, stage = resumed ? '恢复任务' : '批量执行';
  const check = async () => { if (halt) throw halt; checkStop(signal); if (await api.account() !== session) throw Object.assign(new Error('连接已改变，任务已保存。'), { code: 'CONNECTION_CHANGED' }); };
  const report = message => {
    const summary = taskSummary(task);
    onProgress({ stage, message: `${message}；批次 ${summary.completedBatches}/${summary.totalBatches}`, completed: summary.completed, total: summary.total, unit: '项', active, startedAt, estimated: false });
  };
  const saveMeta = async () => { task.meta.elapsedMs = Date.now() - startedAt; task.meta.updatedAt = new Date().toISOString(); await store.saveMeta(structuredClone(task.meta)); };
  const checkpoint = async (...batches) => {
    try { await store.saveBatches(structuredClone(batches)); await saveMeta(); }
    catch (error) { error.fatal = true; halt ||= error; throw error; }
  };
  const record = async (batch, action) => {
    try { await onRecord({ time: new Date().toISOString(), run: task.meta.id, action, id: batch.id, path: batch.year ? `/${batch.year}/` : '/', detail: `${batch.kind === 'mkdir' ? 1 : batch.ids.length} 项；${batch.error || batch.remoteTaskId || ''}` }); }
    catch (error) { error.fatal = true; halt ||= error; throw error; }
  };
  const setTarget = (year, id) => { targets.set(year, id); task.meta.targets = [...targets].map(([year, id]) => ({ year, id })); };
  const poll = async batch => {
    for (let n = 0; n < pollCount; n++) {
      await check();
      const result = await api.taskStatus(batch.remoteTaskId);
      if (result.state === 'done' || result.state === 'failed') { batch.status = result.state; await checkpoint(batch); await record(batch, result.state === 'done' ? 'batch-done' : 'batch-failed'); return; }
      report(`PikPak 处理中：${batch.ids.length} 项，${Math.max(0, Math.min(100, Number(result.progress) || 0))}%`);
      if (n + 1 < pollCount) await new Promise(resolve => setTimeout(resolve, pollDelay));
    }
    batch.status = 'waiting'; batch.error = 'PikPak 仍在处理，已保存任务编号，可稍后继续。'; await checkpoint(batch);
  };
  // Only interrupted requests with no receipt need reconciliation. Normal batches
  // never read individual file details or recheck files after an acknowledged task.
  const reconcile = async batch => {
    try {
      if (batch.kind === 'mkdir') {
        const found = (await listAll(api, '', signal)).filter(i => i.folder && i.name === batch.year);
        if (found.length === 1) { setTarget(batch.year, found[0].id); batch.status = 'done'; }
      } else if (batch.kind === 'move') {
        const parent = targets.get(batch.year);
        if (parent) { const present = new Set((await listAll(api, parent, signal)).map(i => i.id)); if (batch.ids.every(id => present.has(id))) batch.status = 'done'; }
      } else {
        let all = true;
        for (const id of batch.ids) { await check(); const original = entryById.get(id) || dirById.get(id); if (!await api.isTrashed(id, original.parentId)) { all = false; break; } }
        if (all) batch.status = 'done';
      }
      if (batch.status !== 'done') { batch.status = 'unknown'; batch.error = '上次提交结果仍不明确，不自动重发此批。'; }
      await checkpoint(batch);
    } catch (error) { if (fatal(error) || signal?.aborted) throw error; batch.status = 'unknown'; batch.error = '暂时无法确定此批结果，不自动重发。'; await checkpoint(batch); }
  };
  const submit = async batch => {
    await check();
    batch.status = 'submitting'; batch.error = ''; await checkpoint(batch); await record(batch, 'batch-submitting');
    try { await check(); } catch (error) { batch.status = 'pending'; await checkpoint(batch); throw error; }
    let receipt;
    try {
      if (batch.kind === 'mkdir') {
        const result = await api.createFolder(batch.year); setTarget(batch.year, result.id); receipt = { state: 'done', taskId: '' };
      } else if (batch.kind === 'move') receipt = await api.moveBatch(batch.ids, targets.get(batch.year));
      else receipt = await api.trashBatch(batch.ids);
    } catch (error) {
      batch.status = error.status >= 400 && error.status < 500 ? 'failed' : 'unknown'; batch.error = error.message;
      await checkpoint(batch); await record(batch, 'batch-failed');
      if (fatal(error)) throw error;
      return;
    }
    batch.status = receipt.state; batch.remoteTaskId = receipt.taskId || ''; await checkpoint(batch);
    if (receipt.state === 'waiting' && batch.remoteTaskId) { await poll(batch); return; }
    await record(batch, receipt.state === 'done' ? 'batch-done' : 'batch-failed');
  };
  const runBatch = async batch => {
    if (terminal.has(batch.status)) return;
    await check();
    if (batch.remoteTaskId) { await poll(batch); return; }
    if (['submitting', 'unknown'].includes(batch.status)) { await reconcile(batch); return; }
    if (batch.kind === 'move' && !targets.has(batch.year)) { batch.status = 'blocked'; batch.error = '年份目录尚未完成，保留此批。'; await checkpoint(batch); return; }
    if (batch.kind === 'folders') {
      const waitingDirectories = new Set();
      for (const upstream of task.batches.filter(b => ['move', 'trash', 'duplicate'].includes(b.kind) && !terminal.has(b.status))) {
        for (const id of upstream.ids) {
          let parent = entryById.get(id)?.parentId;
          while (parent && !waitingDirectories.has(parent)) { waitingDirectories.add(parent); parent = dirById.get(parent)?.parentId; }
        }
      }
      if (batch.ids.some(id => waitingDirectories.has(id))) {
        batch.status = 'blocked'; batch.error = '目录内仍有未完成的文件批次，恢复后继续清理。'; await checkpoint(batch); return;
      }
      const eligible = [], skipped = [...(batch.skippedIds || [])];
      // Empty-folder checks remain necessary: unknown/new content must not be trashed recursively.
      for (const part of chunk(batch.ids, 4)) {
        await check();
        const results = await Promise.allSettled(part.map(id => listAll(api, id, signal)));
        for (let n = 0; n < results.length; n++) {
          const result = results[n], id = part[n];
          if (result.status === 'fulfilled') { if (result.value.length) skipped.push(id); else eligible.push(id); }
          else { if (fatal(result.reason) || signal?.aborted) throw result.reason; skipped.push(id); }
        }
      }
      batch.ids = eligible; batch.skippedIds = skipped; await checkpoint(batch);
      if (!eligible.length) { batch.status = 'done'; await checkpoint(batch); return; }
    }
    await submit(batch);
  };
  const pool = async batches => {
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(width, batches.length) }, async () => {
      while (cursor < batches.length && !halt && !signal?.aborted) {
        const batch = batches[cursor++]; active++;
        const label = { mkdir: '创建目录', move: '移动', trash: '小文件删除', duplicate: '同名删除', folders: '空目录清理' }[batch.kind];
        report(`处理${label}批次，${batch.kind === 'mkdir' ? 1 : batch.ids.length} 项`);
        try { await runBatch(batch); }
        catch (error) { halt ||= error; }
        finally { active--; report('批次进度已保存'); }
      }
    }));
    await check();
  };
  task.meta.status = 'running'; await saveMeta();
  try {
    stage = '准备年份目录'; await pool(task.batches.filter(b => b.kind === 'mkdir' && !terminal.has(b.status)));
    stage = '批量移动'; await pool(task.batches.filter(b => b.kind === 'move' && !terminal.has(b.status)));
    stage = '批量删除小文件'; await pool(task.batches.filter(b => b.kind === 'trash' && !terminal.has(b.status)));
    const ready = new Set(task.plan.entries.filter(i => i.action === 'keep').map(i => i.id));
    for (const batch of task.batches.filter(b => b.kind === 'move' && b.status === 'done')) batch.ids.forEach(id => ready.add(id));
    // A bad keeper only blocks its own duplicates; split mixed batches atomically.
    for (const batch of [...task.batches].filter(b => b.kind === 'duplicate' && ['pending', 'blocked'].includes(b.status))) {
      const allowed = [], blocked = [];
      batch.ids.forEach((id, n) => (ready.has(batch.keepIds[n]) ? allowed : blocked).push({ id, keepId: batch.keepIds[n] }));
      if (!allowed.length) { batch.status = 'blocked'; batch.error = '保留文件批次尚未成功，重复项保留。'; await checkpoint(batch); continue; }
      if (blocked.length) {
        const deferred = { ...structuredClone(batch), id: `${batch.id}-deferred`, ids: blocked.map(i => i.id), keepIds: blocked.map(i => i.keepId), status: 'blocked' };
        batch.ids = allowed.map(i => i.id); batch.keepIds = allowed.map(i => i.keepId); batch.status = 'pending';
        await checkpoint(batch, deferred); task.batches.push(deferred);
      } else batch.status = 'pending';
    }
    stage = '批量删除重复项'; await pool(task.batches.filter(b => b.kind === 'duplicate' && !terminal.has(b.status) && b.status !== 'blocked'));
    {
      stage = '批量清理空目录';
      for (const depth of [...new Set(task.batches.filter(b => b.kind === 'folders').map(b => b.depth))].sort((a, b) => b - a)) {
        await pool(task.batches.filter(b => b.kind === 'folders' && b.depth === depth && !terminal.has(b.status)));
        if (task.batches.some(b => b.kind === 'folders' && b.depth === depth && !terminal.has(b.status))) break;
      }
    }
    task.meta.status = task.batches.every(b => terminal.has(b.status)) ? 'completed' : 'attention';
    stage = task.meta.status === 'completed' ? '执行完成' : '进度已保存'; report('已完成批次不会重发；等待中或结果未知的批次可继续恢复');
    return taskSummary(task);
  } catch (error) { task.meta.status = 'paused'; throw error; }
  finally { await saveMeta(); }
}
