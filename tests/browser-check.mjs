import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { handleRequest } from '../supabase/functions/create-pickup/handler.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const database = new Map();
const requestIds = [];
let mode = 'database-failure';
let site;
const server = createServer(async (req, res) => {
  if (req.url === '/functions/v1/create-pickup') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = new Request(site + req.url, { method: req.method, headers: req.headers, body: Buffer.concat(chunks) });
    requestIds.push(JSON.parse(Buffer.concat(chunks)).request_id);
    const response = await handleRequest(request, {
      ALLOWED_ORIGINS: site, SUPABASE_URL: 'https://project.supabase.co',
      SUPABASE_PUBLISHABLE_KEYS: '{"default":"sb_publishable_test"}',
      SUPABASE_SECRET_KEYS: '{"default":"sb_secret_test"}',
    }, async (_url, options) => {
      if (mode === 'database-failure') return Response.json({}, { status: 500 });
      if (mode === 'limited') return Response.json({ code: 'PT429' }, { status: 429 });
      const body = JSON.parse(options.body);
      if (!database.has(body.p_request_id)) database.set(body.p_request_id, { reference: 'LB-123456ABCDEF', preferred_date: body.p_preferred_date });
      await new Promise(resolve => setTimeout(resolve, 100));
      return Response.json(database.get(body.p_request_id));
    });
    // Simulate a connection failing after a successful database commit.
    const delivered = mode === 'lost-response' && response.ok ? Response.json({ error: 'Could not confirm. Please retry.' }, { status: 503 }) : response;
    res.writeHead(delivered.status, Object.fromEntries(delivered.headers));
    res.end(await delivered.text());
    return;
  }
  const asset = { '/': 'index.html', '/config.js': 'config.js', '/booking.js': 'booking.js' }[req.url];
  if (!asset) { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', asset.endsWith('.js') ? 'application/javascript' : 'text/html; charset=utf-8');
  res.end(await readFile(root + asset));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
site = 'http://127.0.0.1:' + server.address().port;
// shortcut: this check uses the machine's cached Chromium; set CHROME_PATH on another machine.
const chrome = spawn(process.env.CHROME_PATH || 'C:/Users/Hp/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe', [
  '--headless', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=9445', '--user-data-dir=' + root + '../.loopboard-browser-check', 'about:blank',
], { windowsHide: true, stdio: 'ignore' });
let socket;
try {
  let tabs;
  for (let i = 0; i < 100; i++) {
    try { tabs = await (await fetch('http://127.0.0.1:9445/json/list')).json(); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert(tabs, 'Browser starts');
  socket = new WebSocket(tabs.find(tab => tab.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let id = 0;
  const pending = new Map();
  const exceptions = [];
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const entry = pending.get(message.id); pending.delete(message.id);
      message.error ? entry.reject(message.error) : entry.resolve(message.result);
    }
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.text);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    pending.set(++id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails)); return result.result.value;
  };
  const settled = () => evaluate("new Promise(resolve=>{const timer=setInterval(()=>{if(!document.getElementById('submit-pickup').disabled){clearInterval(timer);resolve(true)}},20)})");
  const fill = () => evaluate("document.getElementById('nm').value='<img src=x onerror=alert(1)>';document.getElementById('ph').value='9876543210';document.getElementById('ad').value='123 Example Street';document.getElementById('dt').value=document.getElementById('dt').min");
  const submit = () => evaluate("document.getElementById('pf').requestSubmit()");
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: site });
  for (let i = 0; i < 100; i++) {
    if (await evaluate("document.readyState==='complete' && typeof form!=='undefined'")) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await submit();
  assert.equal(await evaluate('document.activeElement.id'), 'nm', 'First invalid field focused');
  assert.equal(await evaluate("document.querySelectorAll('[aria-invalid=true]').length"), 4);
  await fill(); await submit();
  assert.match(await evaluate("document.getElementById('submit-error').textContent"), /not connected/);
  assert.equal(requestIds.length, 0, 'Unconfigured form never sends');
  await evaluate('window.LOOPBOARD=' + JSON.stringify({ supabaseUrl: site, publishableKey: 'sb_publishable_test' }));
  await submit(); await settled();
  assert.equal(database.size, 0, 'Database failure never shows success');
  assert.equal(await evaluate("document.getElementById('pf').hidden"), false);
  assert.equal(await evaluate("document.getElementById('ad').value"), '123 Example Street');
  mode = 'lost-response';
  await submit();
  assert.equal(await evaluate("document.getElementById('submit-pickup').disabled"), true, 'Submit locked while sending');
  await settled();
  assert.equal(database.size, 1);
  assert.equal(await evaluate("document.getElementById('pickup-success').hidden"), true, 'Lost response does not claim success');
  mode = 'normal';
  await submit(); await settled();
  assert.equal(database.size, 1, 'Retry keeps the same request');
  assert.equal(new Set(requestIds).size, 1, 'Browser reuses its UUID for all unchanged retries');
  assert.equal(await evaluate("document.getElementById('pickup-reference').textContent"), 'LB-123456ABCDEF');
  assert.equal(await evaluate('document.activeElement.id'), 'pickup-success');
  assert.equal(await evaluate("document.querySelectorAll('#pickup-success img').length"), 0, 'Names rendered as text');
  await evaluate("document.getElementById('again').click()");
  assert.equal(await evaluate('document.activeElement.id'), 'nm');
  await fill(); mode = 'limited'; await submit(); await settled();
  assert.match(await evaluate("document.getElementById('submit-error').textContent"), /Too many requests/);
  assert.notEqual(requestIds.at(-1), requestIds[0], 'Another pickup receives a fresh UUID');
  await evaluate("window.LOOPBOARD={supabaseUrl:'',publishableKey:''};document.getElementById('pf').reset();showErrors({});document.getElementById('submit-error').textContent=''");
  await evaluate('document.fonts.ready.then(()=>Promise.all(document.getAnimations().map(animation=>animation.finished))).then(()=>true)');
  await evaluate("document.activeElement.blur();window.scrollTo({top:0,behavior:'instant'})");
  for (const width of [1440, 320, 390, 768]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true, 'No overflow at ' + width);
    if (width === 1440 || width === 390) {
      const screenshot = await send('Page.captureScreenshot', { captureBeyondViewport: true, fromSurface: true, clip: { x: 0, y: 0, width, height: await evaluate('document.documentElement.scrollHeight'), scale: 1 } });
      await writeFile(root + '../LoopBoard-light-' + (width === 1440 ? 'desktop' : 'mobile') + '.png', Buffer.from(screenshot.data, 'base64'));
    }
  }
  assert.deepEqual(exceptions, []);
  console.log('PASS: browser form validation, unconfigured/failure/loading/rate-limit states, lost-response retry, safe name rendering, success/reset focus, and 320/390/768/1440px layouts. Database transport mocked.');
  await send('Browser.close');
} finally {
  socket?.close(); chrome.kill(); server.closeAllConnections(); server.close();
}
