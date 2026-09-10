import { PikPakApi } from './api.mjs';
import { scan, plan, bytes, progressStats, formatDuration } from './core.mjs';
import { appendRecord, readRecords, readRecent, taskStore } from './journal.mjs';
import { requestDriveAccess } from './connection.mjs';

const $ = id => document.getElementById(id);
const demo = location.protocol !== 'chrome-extension:' && new URLSearchParams(location.search).has('demo');
const local = !demo && location.hostname === '127.0.0.1' && document.querySelector('meta[name="pikpak-local"]')?.content === '1';
let Api = PikPakApi;
let api, prepared, busy = false, consumed = false, controller, page = 0, tail = [];
let progressState = null, logTimer;
let batchTools, currentTask = null, initialized = false;
const labels = { started: '开始整理', move: '待移动', trash: '小文件删除', duplicate: '同名重复删除', keep: '原位保留', issue: '跳过保留', directory: '检查空目录', pending: '准备操作，待核验', created: '目录已创建', moved: '移动已核验', kept: '原位保留', trashed: '小文件已删除', 'duplicate-trashed': '同名重复已删除', 'folder-trashed': '空目录已删除', skipped: '已跳过', failed: '失败，保留相关文件', stopped: '已中断', complete: '已完成' };
function view(name) {
  document.querySelectorAll('.view').forEach(el => { el.hidden = el.id !== `view-${name}`; });
  document.querySelectorAll('[data-view]').forEach(el => { el.classList.toggle('active', el.dataset.view === name); el.setAttribute('aria-current', el.dataset.view === name ? 'step' : 'false'); });
}
document.querySelectorAll('[data-view]').forEach(el => el.addEventListener('click', () => view(el.dataset.view)));
function error(message = '') { $('error').textContent = message; $('error').hidden = !message; }
function update() {
  $('connect-button').disabled = busy || !initialized; $('token').disabled = busy;
  $('disconnect').disabled = busy || !api;
  $('scan').disabled = busy || !api;
  $('apply').disabled = busy || consumed || !prepared || !prepared.entries.some(i => i.action !== 'issue') && !prepared.directories.length || !$('confirm').checked;
  $('confirm').disabled = busy || consumed;
  $('export-plan').disabled = !prepared;
  $('progress-box').hidden = !busy && !progressState;
  $('stop').disabled = !controller || controller.signal.aborted;
  $('stop').hidden = !busy;
  $('apply').textContent = currentTask && currentTask.meta.status !== 'ready' ? '继续未完成批次' : '开始批量整理';
}
function renderProgress() {
  if (!progressState) return;
  const state = progressState, now = state.finishedAt || Date.now();
  const stats = progressStats(state, now);
  $('stage').textContent = state.interrupted ? '已中断' : controller?.signal.aborted ? '正在停止' : state.stage;
  $('progress').textContent = state.message;
  $('progress-count').textContent = `${stats.completed} / ${stats.total} ${state.unit}${state.estimated ? '（已发现）' : ''}`;
  $('progress-rate').textContent = `速度 ${stats.rate.toFixed(1)} ${state.unit}/秒 · 并发 ${state.active}`;
  $('progress-elapsed').textContent = `已用 ${formatDuration(stats.elapsed)}`;
  $('progress-eta').textContent = state.interrupted || controller?.signal.aborted ? '剩余时间 —' : `预计剩余 ${stats.remaining === null ? '计算中' : formatDuration(stats.remaining)}${state.estimated ? '（动态预估）' : ''}`;
  $('progress-bar').max = Math.max(1, stats.total); $('progress-bar').value = stats.completed;
  $('progress-bar').setAttribute('aria-valuetext', $('progress-count').textContent);
  $('progress-note').textContent = state.estimated ? '扫描会继续发现子目录，预估按当前已发现的目录计算并随进度调整。' : '剩余时间按已完成速度估算，接口限流和重试会影响实际耗时。';
}
function progress(info) {
  $('stage').textContent = info.stage; $('progress').textContent = info.message;
  if (Number.isFinite(info.startedAt)) { progressState = { ...info }; $('progress-metrics').hidden = false; $('progress-bar').hidden = false; $('progress-note').hidden = false; renderProgress(); }
  else if (progressState) { progressState.stage = info.stage; progressState.message = info.message; }
}
setInterval(() => { if (busy) renderProgress(); }, 1000);
async function work(fn) {
  if (busy) return;
  busy = true; progressState = null; $('progress-metrics').hidden = true; $('progress-bar').hidden = true; $('progress-note').hidden = true; controller = new AbortController(); error(); update();
  try {
    await navigator.locks.request('pikpak-year-organizer-task', { ifAvailable: true }, async lock => {
      if (!lock) throw new Error('另一个工具页正在运行任务，请先停止该任务。');
      await fn(controller.signal);
    });
  } catch (e) { if (progressState) progressState.interrupted = true; error(e.message || '操作失败，已停止。'); }
  finally { if (progressState) { progressState.finishedAt = Date.now(); progressState.active = 0; } busy = false; controller = null; renderProgress(); update(); }
}
function displaySize(size) {
  const value = bytes(size);
  if (value === null) return '大小未知';
  if (value < 1000n) return `${value} B`;
  return `${(Number(value) / 1_000_000).toLocaleString('zh-CN', { maximumFractionDigits: 3 })} MB`;
}
function filtered() {
  if (!prepared) return [];
  if ($('filter').value === 'directory') return prepared.directories.map(i => ({ ...i, action: 'directory', reason: '清理时重新检查，只删除空目录' }));
  return prepared.entries.filter(i => $('filter').value === 'all' || i.action === $('filter').value || $('filter').value === 'trash' && i.action === 'duplicate');
}
function batchStates() {
  const states = new Map();
  for (const batch of currentTask?.batches || []) for (const id of batch.ids) states.set(id, batch.status);
  return states;
}
function cell(text, label) { const td = document.createElement('td'); td.textContent = text; if (label) td.dataset.label = label; return td; }
function renderRows() {
  const items = filtered(), pages = Math.max(1, Math.ceil(items.length / 50));
  const states = batchStates(), statusLabels = { done: '批次已完成', waiting: '整批处理中', submitting: '批次提交中', unknown: '结果待恢复', failed: '批次失败', blocked: '等待保留项完成', skipped: '已跳过' };
  page = Math.max(0, Math.min(page, pages - 1));
  $('rows').replaceChildren(); $('file-table').hidden = !items.length; $('empty').hidden = !!items.length;
  if (prepared) $('empty').textContent = '此分类没有文件。';
  for (const item of items.slice(page * 50, (page + 1) * 50)) {
    const tr = document.createElement('tr'), name = cell('');
    const badge = document.createElement('span'); badge.className = `tag ${item.action}`; badge.textContent = statusLabels[states.get(item.id)] || labels[item.action];
    const strong = document.createElement('strong'); strong.textContent = item.name;
    const path = document.createElement('small'); path.textContent = item.path;
    name.append(badge, strong, path);
    const size = cell(item.folder ? '—' : displaySize(item.size), '大小');
    if (!item.folder && bytes(item.size) !== null) { const exact = document.createElement('small'); exact.textContent = `${item.size} 字节`; size.append(exact); }
    const date = item.addedAt && Number.isFinite(Date.parse(item.addedAt)) ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(item.addedAt)) : '未知';
    const time = cell(date, '添加时间（北京时间）'); time.title = `created_time: ${item.addedAt || '缺失'}`;
    const target = cell(item.target || item.reason, '目标 / 原因');
    if (item.target) { const note = document.createElement('small'); note.textContent = item.reason; target.append(note); }
    tr.append(name, size, time, target); $('rows').append(tr);
  }
  $('page-info').textContent = prepared ? `共 ${items.length} 项 · ${page + 1} / ${pages} 页` : '尚未扫描';
  $('previous').disabled = page === 0; $('next').disabled = page + 1 >= pages;
}
function renderPlan({ resetConfirmation = true } = {}) {
  $('stats').replaceChildren();
  const states = batchStates();
  for (const [action, title] of [['move', '待归档文件'], ['trash', '小文件 / 同名删除'], ['keep', '原位保留'], ['issue', '跳过保留']]) {
    const el = document.createElement('div'); el.className = 'stat';
    const number = document.createElement('strong'); number.textContent = prepared.entries.filter(i => (i.action === action || action === 'trash' && i.action === 'duplicate') && (!['move', 'trash'].includes(action) || !['done', 'failed', 'skipped'].includes(states.get(i.id)))).length;
    const label = document.createElement('span'); label.textContent = title; el.append(number, label); $('stats').append(el);
  }
  $('issues').hidden = !prepared.issues.length;
  $('issues').textContent = `有 ${prepared.issues.length} 项将跳过并保留，其余正常项目可继续执行。${prepared.issues.slice(0, 5).join('；')}${prepared.issues.length > 5 ? '；其余请导出计划查看。' : ''}`;
  $('execution-controls').hidden = false; if (resetConfirmation) $('confirm').checked = false; renderRows(); update();
}
function renderLog() {
  $('log').replaceChildren();
  for (const record of tail.slice(-200).reverse()) {
    const li = document.createElement('li');
    const detail = record.action === 'pending' ? ({ created: '创建目录', moved: '移动文件', trashed: '删除小文件', 'duplicate-trashed': '删除同名重复文件', 'folder-trashed': '清理空目录' }[record.detail] || record.detail) : record.detail;
    li.textContent = `${new Date(record.time).toLocaleTimeString('zh-CN')} · ${labels[record.action] || record.action} · ${record.path || ''} ${detail || ''}`;
    $('log').append(li);
  }
}
function clearPlan() {
  prepared = null; currentTask = null; consumed = false; $('execution-controls').hidden = true; $('resume-banner').hidden = true;
  $('confirm').checked = false; $('stats').replaceChildren(); $('issues').hidden = true; renderRows();
}
async function save(record) {
  await appendRecord(record); tail.push(record); tail = tail.slice(-200);
  // Durable records still precede writes; only painting is coalesced to avoid rebuilding 200 rows per event.
  if (!logTimer) logTimer = setTimeout(() => { logTimer = null; renderLog(); }, 150);
}
function download(value, name) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('connect-form').addEventListener('submit', event => {
  event.preventDefault();
  if (busy || !initialized) return;
  const token = $('token').value; $('token').value = '';
  // Start the declared host-permission request while the user's gesture is still active.
  const access = local ? Promise.resolve(null) : requestDriveAccess().then(() => null, failure => failure);
  work(async () => {
    progress({ stage: '连接', message: local ? '通过本机程序读取 PikPak 根目录（最多等待 12 秒）' : '检查网盘访问权限，随后读取根目录（最多等待 12 秒）' });
    const accessFailure = await access;
    if (accessFailure) throw accessFailure;
    await api?.disconnect(); api = null; clearPlan(); $('connection-badge').textContent = '未连接';
    const candidate = new Api(token);
    try { await candidate.connect(); api = candidate; } catch (e) { await candidate.disconnect(); throw e; }
    $('connection-badge').textContent = local ? '已连接 · 本机服务' : '已连接 · 个人令牌'; view('preview');
    currentTask = await taskStore.latest(await api.identity());
    if (currentTask) {
      prepared = currentTask.plan; consumed = false; page = 0; renderPlan();
      const summary = batchTools.taskSummary(currentTask);
      $('resume-banner').hidden = false;
      $('resume-banner').textContent = `已恢复保存的任务：${summary.completedBatches}/${summary.totalBatches} 批已处理。勾选确认后继续未完成批次，无需重新扫描。`;
    }
  });
});
$('disconnect').addEventListener('click', () => work(async () => { await api?.disconnect(); api = null; clearPlan(); $('connection-badge').textContent = '未连接'; view('connect'); }));
$('scan').addEventListener('click', () => work(async signal => {
  clearPlan();
  const snapshot = await scan(api, { signal, onProgress: progress });
  prepared = plan(snapshot); currentTask = batchTools.createTask(prepared, await api.identity());
  await taskStore.create(currentTask); page = 0; renderPlan();
  $('resume-banner').hidden = false; $('resume-banner').textContent = `计划已自动保存，共 ${currentTask.batches.length} 个批次，每批最多 50 项。`;
}));
$('stop').addEventListener('click', () => { controller?.abort(); progress({ stage: '正在停止', message: '正在核验在途操作，不再发送新操作' }); update(); });
$('confirm').addEventListener('change', update);
$('filter').addEventListener('change', () => { page = 0; renderRows(); });
$('previous').addEventListener('click', () => { page--; renderRows(); });
$('next').addEventListener('click', () => { page++; renderRows(); });
$('export-plan').addEventListener('click', () => {
  if (!prepared) return;
  const { snapshot, ...details } = prepared;
  download({ ...details, scannedAt: snapshot.scannedAt, scanErrors: snapshot.scanErrors || [], fullScanComplete: snapshot.complete, scope: 'personal-root-recursive', thresholdBytes: '100000000', timezone: 'Asia/Shanghai', timestampField: 'created_time' }, 'pikpak-plan.json');
});
$('export-log').addEventListener('click', async () => { try { download(await readRecords(), 'pikpak-operations.json'); } catch (e) { error(e.message); } });
$('apply').addEventListener('click', () => work(async signal => {
  if (!prepared || !currentTask || consumed || !$('confirm').checked) throw new Error('请先审阅并保存有效计划。');
  consumed = true; update();
  const run = currentTask.meta.id;
  try {
    await save({ time: new Date().toISOString(), action: 'started', run, path: '/', detail: '批量整理，自动保存进度' });
    const result = await batchTools.runTask(api, currentTask, taskStore, { signal, onProgress: progress, onRecord: save });
    const summary = `批次 ${result.completedBatches}/${result.totalBatches}；移动 ${result.moved} 个，保留 ${result.kept} 个，小文件删除 ${result.trashed} 个，同名删除 ${result.duplicates} 个，空目录删除 ${result.folders} 个，跳过 ${result.skipped} 个，失败 ${result.failed} 个，待恢复 ${result.waiting} 批。`;
    await save({ time: new Date().toISOString(), action: result.waiting ? 'stopped' : 'complete', run, detail: summary }); $('result-summary').textContent = summary;
  } catch (e) {
    $('result-summary').textContent = '任务已暂停并保存。可回到预览继续，或刷新后用同一令牌恢复。';
    try { await save({ time: new Date().toISOString(), action: 'stopped', run, detail: e.message }); } catch { /* Preserve the original failure. */ }
    throw e;
  } finally {
    consumed = currentTask.meta.status === 'completed'; renderPlan({ resetConfirmation: false });
    const summary = batchTools.taskSummary(currentTask);
    $('resume-banner').hidden = false; $('resume-banner').textContent = `任务已保存：${summary.completedBatches}/${summary.totalBatches} 批已处理，${summary.waiting} 批待继续。`;
    view('result');
  }
}));
window.addEventListener('beforeunload', event => { if (busy) { event.preventDefault(); event.returnValue = ''; } });
if (local) {
  const { LocalApi } = await import('./local-api.mjs'); Api = LocalApi;
  $('connection-badge').textContent = '本地版 1.0.5 · 未连接';
  document.querySelector('.footnote').firstChild.textContent = '令牌经本机程序直接发往 PikPak，仅驻留内存，不写入文件。工具只监听本机地址。';
  $('token').placeholder = '由本机程序连接 PikPak，不写入文件';
  if (document.querySelector('meta[name="pikpak-server-protocol"]')?.content !== '3') {
    $('connect-form').hidden = true;
    error('本地程序仍是旧版。请等当前任务完成，或停止并等待在途操作核验后，关闭启动窗口并重新运行 start-local.cmd，再刷新本页。');
  }
} else if (demo) {
  const { DemoApi } = await import('./demo.mjs'); api = new DemoApi();
  $('demo-banner').hidden = false; $('connection-badge').textContent = '演示网盘'; view('preview');
} else if (location.protocol !== 'chrome-extension:') {
  $('connect-form').hidden = true; error('真实网盘操作请在已安装的 Chrome 扩展中使用。本地预览请打开 /task.html?demo=1。');
}
Object.assign(labels, { 'batch-submitting': '批次提交', 'batch-done': '批次完成', 'batch-failed': '批次已记录，需处理' });
try {
  if (!local || document.querySelector('meta[name="pikpak-server-protocol"]')?.content === '3') batchTools = await import('./batch.mjs');
  tail = await readRecent(); if (tail.length) renderLog();
  const saved = await taskStore.latest();
  if (saved) { $('resume-banner').hidden = false; $('resume-banner').textContent = '发现已保存任务。连接原来的令牌后会自动恢复计划和批次进度。'; }
  initialized = !!batchTools;
} catch (e) { error(e.message); }
update();
