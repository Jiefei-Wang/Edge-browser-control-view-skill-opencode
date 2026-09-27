// Persistent CDP session for driving a real, already-running Edge via its
// remote-debugging endpoint. Attach-once; all operations reuse the session.
// Self-contained: Node stdlib + the global WebSocket only (no dependencies).
//
// Control API: HTTP on 127.0.0.1:<CDP_CTRL_PORT|9333>
//   GET  /status        -> { connected, targetId, sessionId, attachCount, uptimeMs }
//   POST /cmd  (JSON)   -> { cmd, ...args }
// Commands: status, targets, create, attach, navigate, eval, title, text,
//           snapshot, click, type, press_key, screenshot, close, shutdown
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_DIR = path.dirname(fileURLToPath(import.meta.url));
const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const PORT_FILE = path.join(local, 'Microsoft', 'Edge', 'User Data', 'DevToolsActivePort');
const CTRL_PORT = Number(process.env.CDP_CTRL_PORT || 9333);
const LOG_FILE = path.join(SKILL_DIR, 'cdp.log');
const PID_FILE = path.join(SKILL_DIR, 'cdp.pid');
const SHOT_DIR = SKILL_DIR;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

// When launched detached (no console, see launch.ps1), route console output and
// fatal errors to cdp.log so nothing is silently lost.
if (process.env.CDP_DETACHED) {
  const sink = fs.createWriteStream(LOG_FILE, { flags: 'a' });
  for (const stream of [process.stdout, process.stderr]) {
    stream.write = function (chunk, a, b) {
      try { sink.write(Buffer.isBuffer(chunk) ? chunk : String(chunk)); } catch {}
      const cb = typeof a === 'function' ? a : typeof b === 'function' ? b : null;
      if (cb) cb();
      return true;
    };
  }
  process.on('uncaughtException', (e) => log('UNCAUGHT ' + (e && e.stack ? e.stack : e)));
  process.on('unhandledRejection', (e) => log('UNHANDLED ' + (e && (e.stack || e.message) ? (e.stack || e.message) : e)));
}
const js = (s) => JSON.stringify(s);

const state = { ws: null, connected: false, sessionId: null, targetId: null, attachCount: 0, nextId: 1, pending: new Map(), startedAt: Date.now() };

function resolveWsUrl() {
  const lines = fs.readFileSync(PORT_FILE, 'utf8').trim().split(/\r?\n/).map((s) => s.trim());
  const port = lines[0];
  const p = lines[1] || '';
  return p.startsWith('/devtools/') ? `ws://127.0.0.1:${port}${p}` : `ws://127.0.0.1:${port}`;
}

function send(method, params, sessionId) {
  return new Promise((resolve, reject) => {
    const id = state.nextId++;
    const msg = { id, method, params: params || {} };
    if (sessionId) msg.sessionId = sessionId;
    state.pending.set(id, { resolve, reject });
    try { state.ws.send(JSON.stringify(msg)); } catch (e) { state.pending.delete(id); reject(e); return; }
    setTimeout(() => { if (state.pending.has(id)) { state.pending.delete(id); reject(new Error('timeout: ' + method)); } }, 20000);
  });
}

function onMessage(ev) {
  let m; try { m = JSON.parse(ev.data); } catch { return; }
  if (m.id && state.pending.has(m.id)) {
    const p = state.pending.get(m.id); state.pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error.message || JSON.stringify(m.error))); else p.resolve(m.result);
  }
}

function connect() {
  const url = resolveWsUrl();
  log('connecting ' + url);
  const ws = new WebSocket(url);
  state.ws = ws;
  ws.addEventListener('message', onMessage);
  ws.addEventListener('error', (e) => log('ws error ' + (e.message || e)));
  ws.addEventListener('close', () => { log('ws close'); state.connected = false; });
  return new Promise((res, rej) => {
    ws.addEventListener('open', () => { state.connected = true; log('connected'); res(); }, { once: true });
    ws.addEventListener('error', (e) => rej(new Error('ws error ' + (e.message || e))), { once: true });
  });
}

async function evalInPage(expr) {
  if (!state.sessionId) throw new Error('not attached');
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, state.sessionId);
  if (r.exceptionDetails) throw new Error('page exception: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text || 'unknown'));
  return r.result ? r.result.value : undefined;
}

const SNAPSHOT_JS = `(() => {
  document.querySelectorAll('[data-opencode-ref]').forEach(e => e.removeAttribute('data-opencode-ref'));
  const sel = 'a[href],button,[role="button"],input,select,textarea,[contenteditable="true"],[onclick],[tabindex]:not([tabindex="-1"])';
  const out = []; const els = Array.from(document.querySelectorAll(sel)); let n = 0;
  for (const el of els) {
    if (n >= 300) break;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const text = ((el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.title || '').replace(/\\s+/g,' ').trim());
    const isControl = ['INPUT','SELECT','TEXTAREA','BUTTON','A'].includes(el.tagName);
    if (!text && !isControl && !el.id && !el.name) continue;
    const ref = 'e' + (++n);
    el.setAttribute('data-opencode-ref', ref);
    out.push({ ref, tag: el.tagName.toLowerCase(), type: el.getAttribute('type') || null, role: el.getAttribute('role') || null, id: el.id || null, text: text.slice(0,100) });
  }
  return { url: location.href, title: document.title, count: out.length, items: out };
})()`;

function refSel(ref) { return '[data-opencode-ref="' + ref + '"]'; }

async function realClick(pos) {
  const sid = state.sessionId;
  const x = Math.round(pos.x), y = Math.round(pos.y);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sid);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sid);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sid);
  return { clicked: true, x, y };
}

const KEYMAP = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38, nativeVirtualKeyCode: 38 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37, nativeVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 },
};

async function pressKey(name) {
  if (!state.sessionId) throw new Error('not attached');
  const k = KEYMAP[name];
  if (!k) return false;
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...k }, state.sessionId);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...k }, state.sessionId);
  return true;
}

async function handle(body) {
  const c = body.cmd;
  try {
    switch (c) {
      case 'status':
        return { connected: state.connected, targetId: state.targetId, sessionId: state.sessionId, attachCount: state.attachCount, uptimeMs: Date.now() - state.startedAt };
      case 'targets': {
        const r = await send('Target.getTargets');
        return r.targetInfos.filter((t) => ['page', 'other'].includes(t.type)).map((t) => ({ type: t.type, id: t.targetId, attached: t.attached, url: t.url }));
      }
      case 'create': {
        const r = await send('Target.createTarget', { url: body.url || 'about:blank' });
        return { targetId: r.targetId };
      }
      case 'attach': {
        let tid = body.targetId || state.targetId;
        if (!tid) { const r = await send('Target.getTargets'); tid = r.targetInfos.find((t) => t.type === 'page').targetId; }
        const r = await send('Target.attachToTarget', { targetId: tid, flatten: true });
        state.sessionId = r.sessionId; state.targetId = tid; state.attachCount++;
        log(`ATTACH #${state.attachCount} target=${tid} session=${r.sessionId}`);
        await send('Page.enable', {}, state.sessionId).catch(() => {});
        await send('Runtime.enable', {}, state.sessionId).catch(() => {});
        return { attached: true, targetId: tid, sessionId: r.sessionId, attachCount: state.attachCount };
      }
      case 'navigate': {
        if (!state.sessionId) throw new Error('not attached');
        const r = await send('Page.navigate', { url: body.url }, state.sessionId);
        return { navigated: body.url, frameId: r.frameId };
      }
      case 'eval': {
        return { result: await evalInPage(body.expr) };
      }
      case 'title': {
        return { title: await evalInPage('document.title') };
      }
      case 'text': {
        const max = body.max || 8000;
        return { text: await evalInPage(`(() => { const t = (document.body && document.body.innerText) || ''; return t.slice(0, ${max}); })()`) };
      }
      case 'snapshot': {
        return await evalInPage(SNAPSHOT_JS);
      }
      case 'click': {
        if (!state.sessionId) throw new Error('not attached');
        const posExpr = `(() => { const el = document.querySelector(${js(refSel(body.ref))}); if(!el) return {found:false}; try{ el.scrollIntoView({block:'center',inline:'center'}); }catch(e){} const r = el.getBoundingClientRect(); return {found:true, x:r.left+r.width/2, y:r.top+r.height/2, text:((el.innerText||el.value||'').slice(0,60))}; })()`;
        let pos = await evalInPage(posExpr);
        if ((!pos || !pos.found) && body.css) {
          pos = await evalInPage(`(() => { const el = document.querySelector(${js(body.css)}); if(!el) return {found:false}; try{ el.scrollIntoView({block:'center'}); }catch(e){} const r = el.getBoundingClientRect(); return {found:true, x:r.left+r.width/2, y:r.top+r.height/2}; })()`);
        }
        if (!pos || !pos.found) return { error: 'element not found for ref ' + body.ref };
        const out = await realClick(pos);
        out.text = pos.text || null;
        return out;
      }
      case 'type': {
        if (!state.sessionId) throw new Error('not attached');
        const ref = body.ref;
        const f = await evalInPage(`(() => { const el = document.querySelector(${js(refSel(ref))}); if(!el) return {found:false}; el.focus(); return {found:true, tag:el.tagName.toLowerCase()}; })()`);
        if (!f || !f.found) return { error: 'element not found for ref ' + ref };
        if (body.clear !== false) { await send('Runtime.evaluate', { expression: `(() => { const el = document.querySelector(${js(refSel(ref))}); if('value' in el) el.value = ''; return true; })()`, returnByValue: true }, state.sessionId).catch(() => {}); }
        await send('Input.insertText', { text: body.text || '' }, state.sessionId);
        let submitted = false;
        if (body.submit) { await pressKey('Enter'); submitted = true; }
        return { typed: true, ref, chars: (body.text || '').length, tag: f.tag, submitted };
      }
      case 'press_key': {
        return { pressed: body.key, ok: await pressKey(body.key) };
      }
      case 'screenshot': {
        if (!state.sessionId) throw new Error('not attached');
        const r = await send('Page.captureScreenshot', { format: 'png' }, state.sessionId);
        const p = path.join(SHOT_DIR, `shot_${Date.now()}.png`);
        fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
        return { path: p };
      }
      case 'close': {
        const tid = body.targetId || state.targetId;
        const r = await send('Target.closeTarget', { targetId: tid });
        if (tid === state.targetId) { state.sessionId = null; state.targetId = null; }
        return { closed: tid, success: r.success };
      }
      case 'shutdown':
        return { shuttingDown: true };
      default:
        throw new Error('unknown cmd: ' + c);
    }
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const sendJson = (o) => { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(o)); };
  if (u.pathname === '/status') { handle({ cmd: 'status' }).then(sendJson); return; }
  if (u.pathname === '/cmd' && req.method === 'POST') {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', async () => {
      let body;
      try { body = JSON.parse(d || '{}'); } catch { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'bad json' })); return; }
      const out = await handle(body);
      sendJson(out);
      if (body.cmd === 'shutdown') setTimeout(() => { try { state.ws && state.ws.close(); } catch {} try { fs.unlinkSync(PID_FILE); } catch {} process.exit(0); }, 200);
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('nf');
});

function probeStatus() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: CTRL_PORT, path: '/status', timeout: 2000 }, (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve(d));
    });
    req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    probeStatus().then((d) => {
      if (d && d.includes('"connected"')) { log('port busy, existing session healthy - reusing it'); process.exit(0); }
      else { log('FATAL port ' + CTRL_PORT + ' busy by a non-healthy process'); process.exit(1); }
    });
    return;
  }
  log('FATAL ' + (e.message || e)); process.exit(1);
});

connect().then(() => {
  server.listen(CTRL_PORT, '127.0.0.1', () => {
    try { fs.writeFileSync(PID_FILE, String(process.pid)); } catch (e) { log('pid write failed ' + (e.message || e)); }
    log('control listening on ' + CTRL_PORT + ' pid=' + process.pid);
  });
}).catch((e) => { log('FATAL ' + (e.message || e)); process.exit(1); });
