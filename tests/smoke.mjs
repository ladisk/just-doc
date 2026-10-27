// Smoke test of the viewer in headless Chromium. See tests/README.md.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const SP = +(process.env.SMOKE_PORT || 8961), CP = +(process.env.SMOKE_CDP_PORT || 9361);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const has = c => spawnSync('sh', ['-c', `command -v ${c}`]).status === 0;
const until = async (fn, ms = 10000, step = 150) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch {} await sleep(step); }
  return null;
};

let failed = 0;
const check = (name, ok, info = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && info ? '  [' + info + ']' : ''}`);
  if (!ok) failed++;
};

const tmp = mkdtempSync(join(tmpdir(), 'just-doc-smoke-'));
const procs = [];
let ws;
try {
  // 1. test document, isolated cache
  const env = { ...process.env, XDG_CACHE_HOME: join(tmp, 'cache') };
  let doc;
  if (has('pandoc')) { doc = join(tmp, 'report.md'); copyFileSync(join(repo, 'examples/review/report.md'), doc); }
  else { console.log('pandoc missing: cannot make a test document'); process.exit(1); }
  const jd = (...a) => ['run', '--project', repo, 'just-doc', doc, ...a, '--port', String(SP), '--no-window'];
  const run = (...a) => spawnSync('uv', jd(...a), { cwd: repo, env, encoding: 'utf8' });
  const base = `http://127.0.0.1:${SP}`;

  // 2. server
  try { await fetch(base + '/api/tabs'); console.log(`port ${SP} is in use; set SMOKE_PORT`); process.exit(1); } catch {}
  const srv = spawn('uv', jd(), { cwd: repo, env, stdio: 'ignore' });
  procs.push(srv);
  const tabs = await until(async () => (await fetch(base + '/api/tabs')).json(), 30000);
  if (!tabs) throw new Error('server did not start');
  const docId = JSON.stringify(tabs).match(/"(?:id|d)":\s*"([^"]+)"/)?.[1];
  if (!docId) throw new Error('no document id in ' + JSON.stringify(tabs));
  const annots = async () => (await (await fetch(`${base}/api/annotations?d=${encodeURIComponent(docId)}`)).json()).annots || [];

  // 3. chromium
  const bin = ['chromium', 'google-chrome-stable', 'google-chrome', 'brave'].find(has);
  if (!bin) throw new Error('no chromium/chrome/brave found');
  procs.push(spawn(bin, ['--headless=new', '--disable-gpu', `--user-data-dir=${join(tmp, 'chr')}`,
    `--remote-debugging-port=${CP}`, '--window-size=1500,950', 'about:blank'], { stdio: 'ignore' }));
  const page = await until(async () => (await (await fetch(`http://127.0.0.1:${CP}/json`)).json()).find(x => x.type === 'page'), 15000);
  if (!page) throw new Error('chromium did not start');
  ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
  let id = 0; const waiting = {}; const excs = [];
  ws.onmessage = m => {
    const d = JSON.parse(m.data);
    if (d.id && waiting[d.id]) waiting[d.id](d.result || d);
    if (d.method === 'Runtime.exceptionThrown') {
      const s = JSON.stringify(d.params.exceptionDetails);
      if (!s.includes('pdf.min.mjs') && !/cancel/i.test(s)) excs.push(s.slice(0, 300));
    }
  };
  const cmd = (method, params = {}) => new Promise(r => { waiting[++id] = r; ws.send(JSON.stringify({ id, method, params })); });
  await cmd('Runtime.enable'); await cmd('Page.enable');
  await cmd('Page.navigate', { url: base + '/' });
  // run JS in the viewer iframe; w = its window, d = its document, F = frame rect
  const ev = async e => (await cmd('Runtime.evaluate', { expression:
    `(()=>{const f=document.querySelector('iframe'); if(!f||!f.contentDocument) return null; const w=f.contentWindow, d=w.document, F=f.getBoundingClientRect(); ${e}})()`,
    returnByValue: true })).result?.value;
  const key = (k, o = {}, target = 'd.body') => ev(
    `${target}.dispatchEvent(new w.KeyboardEvent('keydown',{key:${JSON.stringify(k)},bubbles:true,...${JSON.stringify(o)}})); return 1`);
  const mouse = (type, x, y) => cmd('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons: type === 'mouseReleased' ? 0 : 1 });
  const type = async text => {
    await ev(`const t=d.getElementById('etext'); t.value=${JSON.stringify(text)}; t.dispatchEvent(new w.Event('input',{bubbles:true})); return 1`);
    await key('Enter', {}, "d.getElementById('etext')");
  };
  const list = () => ev(`return d.getElementById('list').innerText`);

  // checks
  const rendered = await until(() => ev(`return d.querySelectorAll('.textLayer span').length`), 20000);
  await sleep(500);
  check('page renders text', !!rendered);
  check('no uncaught exceptions on load', excs.length === 0, excs[0]);

  // comment through a real mouse drag
  const pts = await until(() => ev(`const sp=[...d.querySelectorAll('.pg .textLayer span')].filter(s=>{const r=s.getBoundingClientRect();return r.top>100&&r.top<700&&r.width>200})[0]; if(!sp) return null; const r=sp.getBoundingClientRect(); return [F.left+r.left+r.width*0.2, F.left+r.left+r.width*0.6, F.top+r.top+r.height/2]`), 10000);
  if (!pts) throw new Error('no text line to drag over');
  await mouse('mousePressed', pts[0], pts[2]);
  for (let k = 1; k <= 5; k++) await mouse('mouseMoved', pts[0] + (pts[1] - pts[0]) * k / 5, pts[2]);
  await mouse('mouseReleased', pts[1], pts[2]);
  const mode = await until(async () => (await ev(`return d.getElementById('mode').textContent`)) === 'visual', 3000);
  check('mouse drag gives visual mode', !!mode, await ev(`return d.getElementById('mode').textContent`));
  await key('a');
  const ed = await until(() => ev(`return !!d.querySelector('.pg .card #etext, #etext') && d.getElementById('etext').offsetParent!==null`), 3000);
  check('a opens the comment field', !!ed);
  await type('smoke comment');
  const got = await until(async () => (await annots()).some(a => a.comment === 'smoke comment'), 4000);
  check('comment saved in /api/annotations', !!got, JSON.stringify(await annots()).slice(0, 200));

  // hand over while --wait runs
  const waiter = spawn('uv', jd('--wait'), { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(waiter);
  let out = ''; waiter.stdout.on('data', c => out += c); waiter.stderr.on('data', c => out += c);
  let exited = false; waiter.on('exit', () => exited = true);
  await sleep(1500);
  await ev(`d.getElementById('etext').blur(); d.activeElement && d.activeElement.blur(); return 1`);
  await key('Enter', { ctrlKey: true });
  const done = await until(() => exited, 15000);
  check('Ctrl+Enter ends --wait', !!done);
  check('--wait output lists the comment', out.includes('smoke comment'), out.slice(0, 200));

  // agent reply
  const rep = run('--reply', '1', 'test reply', '--from', 'bot');
  check('--reply succeeds', rep.status === 0, (rep.stderr || rep.stdout || '').slice(0, 200));
  const seen = await until(async () => (await list()).includes('test reply'), 8000);
  check('reply shows in the side list', !!seen, (await list() || '').slice(0, 200));

  // navigate
  await key('n');
  const card = await until(() => ev(`const c=d.querySelector('.pg .card'); return c && c.textContent.includes('bot replied')`), 4000);
  check('n shows a card with "bot replied"', !!card, await ev(`return d.querySelector('.pg .card')?.textContent`));
  await key('A');
  const inCard = await until(() => ev(`return !!d.querySelector('.pg .card #etext')`), 3000);
  check('A opens a reply field inside the card', !!inCard);
  await type('author reply');
  const ar = await until(async () => (await annots()).some(a => (a.replies || []).some(r => r.text === 'author reply' && !r.from)), 4000);
  check('author reply saved (no "from")', !!ar, JSON.stringify((await annots())[0]?.replies));

  // second comment on a later line, with its own reply
  await key('Escape'); await sleep(300);
  const pts2 = await ev(`const sp=[...d.querySelectorAll('.pg .textLayer span')].filter(s=>{const r=s.getBoundingClientRect();return r.top>100&&r.top<800&&r.width>200}); const s=sp[sp.length-1]; if(!s) return null; const r=s.getBoundingClientRect(); return [F.left+r.left+r.width*0.2, F.left+r.left+r.width*0.6, F.top+r.top+r.height/2]`);
  if (!pts2 || Math.abs(pts2[2] - pts[2]) < 20) throw new Error('no second text line, ' + JSON.stringify([pts, pts2]));
  await mouse('mousePressed', pts2[0], pts2[2]);
  for (let k = 1; k <= 5; k++) await mouse('mouseMoved', pts2[0] + (pts2[1] - pts2[0]) * k / 5, pts2[2]);
  await mouse('mouseReleased', pts2[1], pts2[2]);
  await until(async () => (await ev(`return d.getElementById('mode').textContent`)) === 'visual', 3000);
  await key('a');
  await until(() => ev(`return d.getElementById('etext').offsetParent!==null`), 3000);
  await type('second comment');
  const got2 = await until(async () => (await annots()).some(a => a.comment === 'second comment'), 4000);
  check('second comment saved', !!got2);
  const rep2 = run('--reply', '2', 'second reply', '--from', 'bot');
  check('--reply 2 succeeds', rep2.status === 0, (rep2.stderr || rep2.stdout || '').slice(0, 200));
  await until(async () => (await list()).includes('second reply'), 8000);

  // n / p between the two comments
  const framed = () => ev(`return [...d.querySelectorAll('#list .it')].findIndex(x=>x.classList.contains('on'))`);
  const rowText = i => ev(`return d.querySelectorAll('#list .it')[${i}]?.innerText`);
  const cardText = () => ev(`return d.querySelector('.pg .card')?.innerText`);
  const marker = t => /smoke comment/.test(t || '') ? 1 : /second comment/.test(t || '') ? 2 : 0;
  await key('Escape'); await sleep(200);
  for (let k = 0; k < 5 && marker(await rowText(await framed())) !== 1; k++) { await key('p'); await sleep(300); }
  const f1 = await framed(), c1 = await cardText();
  check('first comment framed, card matches row', f1 >= 0 && marker(await rowText(f1)) === 1 && marker(c1) === 1, `row=${f1} card=${(c1 || '').slice(0, 80)}`);
  await key('n'); await sleep(400);
  const f2 = await framed(), c2 = await cardText();
  check('n goes to the second comment (other row, other card)', f2 >= 0 && f2 !== f1 && marker(c2) === 2 && c2 !== c1, `row=${f2} card=${(c2 || '').slice(0, 80)}`);
  check('framed row matches the card', marker(await rowText(f2)) === marker(c2) && marker(c2) !== 0);
  check('card says "bot replied"', /bot replied/.test(c2 || ''));
  await key('p'); await sleep(400);
  const f3 = await framed(), c3 = await cardText();
  check('p returns to the first comment', f3 === f1 && marker(c3) === 1, `row=${f3} card=${(c3 || '').slice(0, 80)}`);
  check('no uncaught exceptions during the run', excs.length === 0, excs[0]);
} catch (e) {
  check('test run', false, e.stack || String(e));
} finally {
  try { ws?.close(); } catch {}
  for (const p of procs.reverse()) { try { p.kill('SIGTERM'); } catch {} }
  await sleep(500);
  for (const p of procs) { try { if (p.exitCode === null) p.kill('SIGKILL'); } catch {} }
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
