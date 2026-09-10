// IndexedDB stores only explicit operation records; API objects and credentials never enter it.
let dbPromise;
function database() {
  return dbPromise ||= new Promise((resolve, reject) => {
    let blocked = false;
    const request = indexedDB.open('pikpak-year-organizer', 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('events')) db.createObjectStore('events', { keyPath: 'sequence', autoIncrement: true });
      if (!db.objectStoreNames.contains('tasks')) db.createObjectStore('tasks', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('plans')) db.createObjectStore('plans', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('batches')) db.createObjectStore('batches', { keyPath: ['taskId', 'id'] }).createIndex('taskId', 'taskId');
    };
    request.onblocked = () => { blocked = true; reject(new Error('本地任务存储升级被旧页面占用，请关闭其他整理工具页后刷新。')); };
    request.onsuccess = () => { if (blocked) { request.result.close(); return; } request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    request.onerror = () => reject(new Error('无法打开本地操作日志。'));
  });
}

async function taskTransaction(stores, mode, action) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode); let result;
    try { result = action(tx); } catch (error) { tx.abort(); reject(error); return; }
    tx.oncomplete = () => resolve(typeof result === 'function' ? result() : result?.result);
    tx.onerror = tx.onabort = () => reject(new Error('任务进度保存失败，已停止提交新批次。'));
  });
}
export const taskStore = {
  async create(bundle) {
    return taskTransaction(['tasks', 'plans', 'batches'], 'readwrite', tx => {
      const tasks = tx.objectStore('tasks');
      const request = tasks.getAll();
      request.onsuccess = () => {
        for (const previous of request.result) if (previous.identityKey === bundle.meta.identityKey && !['completed', 'superseded'].includes(previous.status)) tasks.put({ ...previous, status: 'superseded' });
        tasks.put(bundle.meta);
      };
      tx.objectStore('plans').put({ id: bundle.meta.id, plan: bundle.plan });
      for (const batch of bundle.batches) tx.objectStore('batches').put(batch);
    });
  },
  saveMeta: meta => taskTransaction(['tasks'], 'readwrite', tx => tx.objectStore('tasks').put(meta)),
  saveBatches: batches => taskTransaction(['batches'], 'readwrite', tx => { for (const batch of batches) tx.objectStore('batches').put(batch); }),
  async latest(identityKey) {
    const metas = await taskTransaction(['tasks'], 'readonly', tx => tx.objectStore('tasks').getAll());
    const meta = metas.filter(m => !['completed', 'superseded'].includes(m.status) && (!identityKey || m.identityKey === identityKey)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (!meta) return null;
    return taskTransaction(['plans', 'batches'], 'readonly', tx => {
      const plan = tx.objectStore('plans').get(meta.id), batches = tx.objectStore('batches').index('taskId').getAll(meta.id);
      return () => ({ meta, plan: plan.result.plan, batches: batches.result });
    });
  },
};
export async function closeStore() { if (dbPromise) { (await dbPromise).close(); dbPromise = undefined; } }
async function transaction(mode, action) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('events', mode);
    const request = action(tx.objectStore('events'));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = tx.onabort = () => reject(new Error('本地日志写入失败，已停止发送后续操作。'));
  });
}
export const appendRecord = record => transaction('readwrite', store => store.add(record));
export const readRecords = () => transaction('readonly', store => store.getAll());
export async function readRecent(limit = 200) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('events', 'readonly'), rows = [];
    const request = tx.objectStore('events').openCursor(null, 'prev');
    request.onsuccess = () => { const cursor = request.result; if (cursor && rows.length < limit) { rows.push(cursor.value); cursor.continue(); } };
    tx.oncomplete = () => resolve(rows.reverse());
    tx.onerror = () => reject(new Error('无法读取本地记录。'));
  });
}
