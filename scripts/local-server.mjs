import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { PikPakApi } from '../api.mjs';

const root = new URL('../', import.meta.url);
const assets = new Set(['task.html', 'task.css', 'task.mjs', 'core.mjs', 'api.mjs', 'connection.mjs', 'local-api.mjs', 'journal.mjs', 'progress.mjs', 'batch.mjs', 'demo.mjs']);
const types = { html: 'text/html', css: 'text/css', mjs: 'text/javascript' };
const COOKIE = 'pikpak_organizer_session';
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

async function readBody(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 16384) throw fail('请求体过大。', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail('请求格式错误。'); }
}

export async function startLocalServer({ port = 8788, apiFactory = token => new PikPakApi(token) } = {}) {
  const sessions = new Map();
  let authority;
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; connect-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('X-Frame-Options', 'DENY');
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
    // Exact Host prevents DNS rebinding; no CORS or arbitrary URL forwarding exists.
    if (req.headers.host !== authority) { json(403, { message: '拒绝非本机地址。' }); return; }
    const url = new URL(req.url, `http://${authority}`);
    const sessionId = req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    let session = sessions.get(sessionId);
    if (session) session.touched = Date.now();
    if (url.pathname === '/local/rpc') {
      if (req.method !== 'POST' || req.headers.origin !== `http://${authority}` || req.headers['x-organizer-request'] !== '1' || req.headers['content-type'] !== 'application/json') { json(403, { message: '拒绝跨站或非工具页面请求。' }); return; }
      if (!session) { json(401, { message: '本机会话失效，请刷新工具页。' }); return; }
      let locked = false, exclusive = false, writeKeys = [];
      try {
        const { method, args, connection } = await readBody(req);
        if (!Array.isArray(args) || args.length > 3) throw fail('请求参数无效。');
        exclusive = ['connect', 'disconnect'].includes(method);
        if (['moveBatch', 'trashBatch'].includes(method)) {
          if (!Array.isArray(args[0]) || args[0].length < 1 || args[0].length > 50 || args[0].some(id => typeof id !== 'string' || !id || id.length > 8192) || new Set(args[0]).size !== args[0].length) throw fail('批次 ID 列表无效。');
          writeKeys = args[0].map(id => `file:${id}`);
        } else if (['move', 'trash'].includes(method)) writeKeys = [`file:${args[0]}`];
        else if (['mkdir', 'createFolder'].includes(method)) writeKeys = [`year:${args[0]}`];
        session.writeKeys ||= new Set();
        if (session.exclusive || (exclusive && session.active) || session.active >= 24 || (writeKeys.length && (writeKeys.some(key => session.writeKeys.has(key)) || session.writeRequests >= 4))) throw fail('此对象正在操作或并发已满，请稍后重试。', 409);
        session.active = (session.active || 0) + 1;
        if (exclusive) session.exclusive = true;
        if (writeKeys.length) { writeKeys.forEach(key => session.writeKeys.add(key)); session.writeRequests = (session.writeRequests || 0) + 1; }
        locked = true; session.busy = true;
        if (method === 'connect') {
          if (args.length !== 1 || typeof args[0] !== 'string' || args[0].length > 8192) throw fail('令牌格式无效。');
          session.api?.disconnect(); session.api = null; session.connection = '';
          const candidate = apiFactory(args[0]);
          try { await candidate.connect(); session.connection = await candidate.account(); session.identity = candidate.identity ? await candidate.identity() : ''; session.api = candidate; }
          catch (error) { candidate.disconnect(); throw error; }
          json(200, { connection: session.connection, identity: session.identity });
        } else {
          if (!session.api || !connection || connection !== session.connection) throw Object.assign(fail('连接已改变或已断开，请重新连接并扫描。', 409), { code: 'CONNECTION_CHANGED' });
          const signature = { account: [], disconnect: [], list: ['string', 'string', 'boolean'], get: ['string'], mkdir: ['string'], move: ['string', 'string'], trash: ['string'], isTrashed: ['string', 'string'], createFolder: ['string'], moveBatch: ['array', 'string'], trashBatch: ['array'], taskStatus: ['string'] };
          if (!Object.hasOwn(signature, method) || args.length !== signature[method].length || args.some((arg, i) => (signature[method][i] === 'array' ? !Array.isArray(arg) : typeof arg !== signature[method][i]) || (typeof arg === 'string' && arg.length > 8192))) throw fail('不支持的操作或参数。');
          if (method === 'disconnect') { session.api.disconnect(); session.api = null; session.connection = ''; json(200, {}); }
          else {
            const data = await session.api[method](...args);
            json(200, ['mkdir', 'move', 'trash'].includes(method) ? {} : data);
          }
        }
      } catch (error) {
        const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 502;
        // ApiError messages are sanitized by the adapter; never return raw fetch exceptions.
        json(status, { message: error.message, status, code: error.code || '' });
      } finally {
        if (locked) { session.active--; if (exclusive) session.exclusive = false; if (writeKeys.length) { writeKeys.forEach(key => session.writeKeys.delete(key)); session.writeRequests--; } session.busy = session.active > 0; }
      }
      return;
    }
    const name = url.pathname.slice(1) || 'task.html';
    if (req.method !== 'GET' || !assets.has(name)) { json(404, { message: '页面不存在。' }); return; }
    if (req.headers['sec-fetch-site'] === 'cross-site') { json(403, { message: '请直接打开本机工具地址。' }); return; }
    try {
      let content = await readFile(new URL(name, root));
      if (name === 'task.html') {
        if (!session) {
          if (sessions.size >= 16) throw fail('打开的工具会话过多，请关闭旧页面后重启。', 429);
          const id = randomBytes(24).toString('hex');
          session = { api: null, connection: '', busy: false, touched: Date.now() }; sessions.set(id, session);
          res.setHeader('Set-Cookie', `${COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/`);
        }
        // The shared UI detects local mode only when served by this server.
        content = content.toString('utf8').replace('<head>', '<head>\n<meta name="pikpak-local" content="1">\n<meta name="pikpak-server-protocol" content="3">');
      }
      res.writeHead(200, { 'Content-Type': `${types[name.split('.').pop()]}; charset=utf-8` }); res.end(content);
    } catch { json(500, { message: '无法加载工具文件。' }); }
  });
  server.requestTimeout = 30000; server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  authority = `127.0.0.1:${server.address().port}`;
  const reap = setInterval(() => { for (const [id, session] of sessions) if (!session.busy && Date.now() - session.touched > 15 * 60_000) { session.api?.disconnect(); sessions.delete(id); } }, 60_000);
  reap.unref();
  server.once('close', () => { clearInterval(reap); for (const session of sessions.values()) session.api?.disconnect(); sessions.clear(); });
  return { server, url: `http://${authority}/task.html` };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { url } = await startLocalServer({ port: Number(process.env.PIKPAK_LOCAL_PORT || 8788) });
    console.log(`PikPak 本地整理工具：${url}\n仅监听本机，不记录访问令牌。关闭窗口会停止本机服务。`);
    if (process.argv.includes('--open') && process.platform === 'win32') {
      spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    }
  } catch (error) { console.error(error.code === 'EADDRINUSE' ? '8788 端口已被占用。请使用已启动的工具，或设置 PIKPAK_LOCAL_PORT 后重试。' : '本机工具启动失败，请确认文件完整和 Node.js 版本。'); process.exitCode = 1; }
}
