export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export const file = (id, parentId = 'source', extra = {}) => ({ id, parentId, name: `${id}.bin`, size: '200000000', addedAt: '2025-05-01T00:00:00Z', phase: 'PHASE_TYPE_COMPLETE', folder: false, trashed: false, ...extra });
export const folder = (id, parentId = '', name = id) => file(id, parentId, { name, size: '0', folder: true });
export class FakeApi {
  constructor(items, latency = 0) { this.items = structuredClone(items); this.latency = latency; this.session = 'fake-account'; this.calls = []; this.activeWrites = 0; this.peakWrites = 0; this.writes = []; }
  async account() { return this.session; }
  async identity() { return 'a'.repeat(64); }
  async connect() { return this.session; }
  disconnect() { this.session = 'disconnected'; }
  async list(parentId, token = '') {
    this.calls.push(['list', parentId]); await delay(this.latency);
    const children = this.items.filter(i => i.parentId === parentId && !i.trashed), offset = Number(token || 0);
    return { items: structuredClone(children.slice(offset, offset + 10)), next: offset + 10 < children.length ? String(offset + 10) : '' };
  }
  async get(id) { this.calls.push(['get', id]); await delay(this.latency); const item = this.items.find(i => i.id === id); if (!item) throw new Error('missing'); return structuredClone(item); }
  async write(method, id, change) {
    this.activeWrites++; this.peakWrites = Math.max(this.peakWrites, this.activeWrites); this.writes.push([method, id]);
    try { await delay(this.latency); change(); } finally { this.activeWrites--; }
  }
  async mkdir(year) { await this.write('mkdir', year, () => this.items.push(folder(`year-${year}`, '', year))); }
  async createFolder(year) { await this.mkdir(year); return { id: `year-${year}` }; }
  async moveBatch(ids, parentId) {
    await this.write('moveBatch', [...ids], () => ids.forEach(id => { this.items.find(i => i.id === id).parentId = parentId; }));
    return { state: 'done', taskId: '' };
  }
  async trashBatch(ids) {
    await this.write('trashBatch', [...ids], () => ids.forEach(id => { this.items.find(i => i.id === id).trashed = true; }));
    return { state: 'done', taskId: '' };
  }
  async taskStatus(taskId) { return { state: 'done', taskId }; }
  async move(id, parentId) { await this.write('move', id, () => { this.items.find(i => i.id === id).parentId = parentId; }); }
  async trash(id) { await this.write('trash', id, () => { this.items.find(i => i.id === id).trashed = true; }); }
  async isTrashed(id) { return (await this.get(id)).trashed; }
}
export function movingFiles(count = 12) { return [folder('source'), folder('year', '', '2025'), ...Array.from({ length: count }, (_, n) => file(`f${n}`))]; }
