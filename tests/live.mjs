// Test of live pages (--live), /_lib/ and --hc-terminal in headless Chromium. See tests/README.md.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, existsSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const SP = +(process.env.LIVE_PORT || 8962), CP = +(process.env.LIVE_CDP_PORT || 9362);
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

// a request sent as it is written, so that ../ is not removed on the way
const raw = path => new Promise((resolve, reject) => {
  const s = connect(SP, '127.0.0.1', () => s.write(`GET ${path} HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n`));
  let out = ''; s.on('data', c => out += c); s.on('end', () => resolve(out)); s.on('error', reject);
});

const tmp = mkdtempSync(join(tmpdir(), 'just-doc-live-'));
const procs = [];
let ws;
try {
  // 1. a folder with a page, its style sheet and script, and a file outside it
  const site = join(tmp, 'site');
  mkdirSync(join(site, 'sub'), { recursive: true });
  writeFileSync(join(tmp, 'secret.txt'), 'SECRET-OUTSIDE');
  writeFileSync(join(site, 'sub', 'style.css'), 'body { margin: 0 }');
  writeFileSync(join(site, 'sub', 'data.js'), 'window.DATA = [1, 4, 9];');
  const page = v => `<!doctype html><meta charset="utf-8"><title>p</title>
<link rel="stylesheet" href="/_lib/page.css"><link rel="stylesheet" href="sub/style.css">
<script src="/_lib/plotly.min.js"></script><script src="sub/data.js"></script>
<h1 id="v">${v}</h1>
<fieldset class="choice"><legend>Pick</legend><label><input type="radio" name="pick" value="A"> A</label><label><input type="radio" name="pick" value="B"> B</label></fieldset>
<label><input type="checkbox" class="toggle" name="ok"> ok</label>
<label><input type="checkbox" name="tags" value="x">x</label><label><input type="checkbox" name="tags" value="y">y</label>
<select name="many" multiple><option>m1</option><option>m2</option></select>
<form><input name="note"><textarea name="long"></textarea></form>
<div id="plot" class="plot"></div><div id="plot2" class="plot"></div><div style="height:3000px"></div>
<script>Plotly.newPlot('plot', [{y: window.DATA}]);
Plotly.newPlot('plot2', [{y: window.DATA}], {paper_bgcolor: '#ffeedd', font: {color: '#010203'}});</script>
<script type="module">
  import * as THREE from '/_lib/three/three.module.js';
  import { OrbitControls } from '/_lib/three/addons/OrbitControls.js';
  window.threeOK = typeof OrbitControls === 'function' && !!THREE.REVISION;
</script>`;
  const doc = join(site, 'page.html'), docB = join(site, 'b.html'), docC = join(site, 'c.html');
  writeFileSync(doc, page('v1'));
  writeFileSync(docB, page('b'));
  writeFileSync(docC, page('c'));
  // older times, so that a change later is seen at once
  for (const f of [doc, docB, docC]) utimesSync(f, new Date(Date.now() - 60000), new Date(Date.now() - 60000));

  // the "other machine" of --hc-machine is a second just-doc here, on port SP + 1, reached through tests/fake-ssh.py
  const RP = SP + 1, venv = join(repo, '.venv', 'bin', 'just-doc'), conf = join(tmp, 'config');
  mkdirSync(join(conf, 'just-doc'), { recursive: true });
  writeFileSync(join(conf, 'just-doc', 'config.json'), JSON.stringify({
    ssh: `python3 ${join(repo, 'tests', 'fake-ssh.py')}`,
    machines: { fake: { target: 'fakehost', 'just-doc': `${venv} --port ${RP}` } } }));
  const env = term => ({ ...process.env, XDG_CACHE_HOME: join(tmp, 'cache'), XDG_CONFIG_HOME: conf, HC_TERMINAL_ID: term });
  const jd = (...a) => ['run', '--project', repo, 'just-doc', ...a, '--port', String(SP), '--no-window'];
  const run = (term, ...a) => spawnSync('uv', jd(...a), { cwd: repo, env: env(term), encoding: 'utf8' });
  const base = `http://127.0.0.1:${SP}`;

  // 2. server with the live page, from terminal t1
  try { await fetch(base + '/api/tabs'); console.log(`port ${SP} is in use; set LIVE_PORT`); process.exit(1); } catch {}
  procs.push(spawn('uv', jd(doc, '--live'), { cwd: repo, env: env('t1'), stdio: 'ignore' }));
  const tabs = await until(async () => (await fetch(base + '/api/tabs')).json(), 30000);
  if (!tabs) throw new Error('server did not start');
  const tab = tabs.tabs[0];
  check('the tab is marked live', tab?.live === true, JSON.stringify(tabs));
  const at = `/live/${tab.id}/`;

  // 3. the page and its folder over HTTP
  let r = await fetch(base + at + 'page.html');
  check('live page served as text/html', r.status === 200 && /^text\/html/.test(r.headers.get('content-type')) && (await r.text()).includes('v1'));
  r = await fetch(base + at + 'sub/style.css');
  check('relative asset served as text/css', r.status === 200 && /^text\/css/.test(r.headers.get('content-type')));
  for (const p of ['../secret.txt', '%2e%2e/secret.txt', '..%2fsecret.txt', '/' + join(tmp, 'secret.txt'), 'sub/../../secret.txt']) {
    const got = await raw(at + p);
    check(`no file outside the folder: ${p.slice(0, 40)}`, /^HTTP\/1\.\d 404/.test(got) && !got.includes('SECRET-OUTSIDE'), got.split('\r\n')[0]);
  }
  check('unknown live id gives 404', (await fetch(base + '/live/nothing/page.html')).status === 404);
  for (const [p, type] of [['plotly.min.js', 'text/javascript'], ['three/three.module.js', 'text/javascript'],
                           ['three/addons/OrbitControls.js', 'text/javascript'], ['page.css', 'text/css']]) {
    r = await fetch(`${base}/_lib/${p}`);
    check(`/_lib/${p} served as ${type}`, r.status === 200 && r.headers.get('content-type')?.startsWith(type), `${r.status} ${r.headers.get('content-type')}`);
  }

  // 4. the window in headless Chromium
  const bin = ['chromium', 'google-chrome-stable', 'google-chrome', 'brave'].find(has);
  if (!bin) throw new Error('no chromium/chrome/brave found');
  procs.push(spawn(bin, ['--headless=new', '--disable-gpu', `--user-data-dir=${join(tmp, 'chr')}`,
    `--remote-debugging-port=${CP}`, '--window-size=1200,800', 'about:blank'], { stdio: 'ignore' }));
  const target = await until(async () => (await (await fetch(`http://127.0.0.1:${CP}/json`)).json()).find(x => x.type === 'page'), 15000);
  if (!target) throw new Error('chromium did not start');
  ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
  let id = 0; const waiting = {}; const excs = [];
  ws.onmessage = m => {
    const d = JSON.parse(m.data);
    if (d.id && waiting[d.id]) waiting[d.id](d.result || d);
    if (d.method === 'Runtime.exceptionThrown') excs.push(JSON.stringify(d.params.exceptionDetails).slice(0, 300));
  };
  const cmd = (method, params = {}) => new Promise(r => { waiting[++id] = r; ws.send(JSON.stringify({ id, method, params })); });
  await cmd('Runtime.enable'); await cmd('Page.enable');
  await cmd('Page.navigate', { url: base + '/' });
  const top = async e => (await cmd('Runtime.evaluate', { expression: `(()=>{${e}})()`, returnByValue: true })).result?.value;
  // run JS in the frame of the shown tab; w = its window, d = its document
  const ev = e => top(`const f=document.querySelector('iframe.on'); if(!f||!f.contentDocument) return null; const w=f.contentWindow, d=w.document; ${e}`);

  const ran = await until(() => ev(`return w.threeOK && !!d.querySelector('#plot .main-svg') && d.getElementById('v')?.textContent`), 20000);
  check('page runs: Plotly plot drawn, three.js and OrbitControls imported, relative script loaded', ran === 'v1', String(ran));
  check('the tab bar shows the live mark', !!(await top(`const t=document.querySelector('.tab.on i'); return t && t.textContent==='live' && t.offsetParent!==null`)));

  // Plotly follows light and dark (plotly-theme.js, served with plotly.min.js); a page's own colours win
  const look = () => ev(`const L=d.getElementById('plot')._fullLayout, M=d.getElementById('plot2')._fullLayout;
    return [L.paper_bgcolor, L.font.color, M.paper_bgcolor, M.font.color, w.getComputedStyle(d.body).backgroundColor].join(' | ')`);
  const light = await look();
  check('light: plot background transparent, dark text', /^rgba\(0,0,0,0\) \| #1f2328 \| #ffeedd \| #010203/.test(light), light);
  await cmd('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  const dark = await until(async () => { const v = await look(); return v?.includes('#e6edf3') && v; }, 5000);
  check('dark: plot redrawn with light text on the dark page, not white', !!dark && /^rgba\(0,0,0,0\) \| #e6edf3 \| #ffeedd \| #010203 \| rgb\(13, 17, 23\)/.test(dark), dark || await look());
  await cmd('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  check('light again', !!(await until(async () => (await look())?.includes('#1f2328'), 5000)));

  // 5. a change of the file loads the page again, at the same scroll position
  await ev(`w.scrollTo(0, 500); w.marker = 1; return 1`);
  writeFileSync(doc, page('v2'));
  utimesSync(doc, new Date(Date.now() - 5000), new Date(Date.now() - 5000));
  const again = await until(() => ev(`return d.getElementById('v')?.textContent === 'v2' && !w.marker`), 15000);
  check('page loads again when the file changes', !!again);
  const y = await until(() => ev(`return w.scrollY`), 3000);
  check('scroll position kept', Math.abs(y - 500) < 2, String(y));

  // 6. answers: the named fields at Ctrl+Enter, for --live --wait and --live --read
  const waiter = spawn('uv', jd(doc, '--live', '--wait'), { cwd: repo, env: env('t1'), stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(waiter);
  let wout = ''; waiter.stdout.on('data', c => wout += c); waiter.stderr.on('data', c => wout += c);
  let wexit = null; waiter.on('exit', c => wexit = c);
  await until(() => wout.includes('waiting for Ctrl+Enter'), 15000);
  const pill = () => ev(`return w.getComputedStyle(d.querySelector('fieldset.choice label:nth-of-type(2)')).backgroundColor`);
  const before = await pill();
  await ev(`d.querySelector('input[name=pick][value=B]').closest('label').click(); d.querySelector('input[name=ok]').click();
    d.querySelector('input[name=tags][value=y]').click(); d.querySelector('select[name=many]').options[1].selected = true;
    d.querySelector('input[name=note]').value = 'hi'; d.querySelector('textarea[name=long]').value = 'two\\nlines'; w.marker = 2;
    d.querySelector('form').requestSubmit(); return 1`);
  check('a chosen pill looks selected', (await pill()) !== before && await ev(`return d.querySelector('input[name=pick][value=B]').checked`), `${before} -> ${await pill()}`);
  await sleep(300);
  check('a form in the page is not sent', (await ev(`return w.marker`)) === 2);
  await ev(`d.querySelector('textarea[name=long]').dispatchEvent(new w.KeyboardEvent('keydown', {key: 'Enter', ctrlKey: true, bubbles: true})); return 1`);
  check('Ctrl+Enter ends --live --wait', (await until(() => wexit !== null, 15000)) && wexit === 0, wout.slice(-300));
  const want = { pick: 'B', ok: true, tags: ['y'], many: ['m2'], note: 'hi', long: 'two\nlines' };
  const parsed = t => { try { return JSON.parse(t.slice(t.indexOf('{'))); } catch { return null; } };
  const got = parsed(wout);
  check('--live --wait prints the answers', JSON.stringify(got?.answers) === JSON.stringify(want) && got?.round === 1, wout.slice(-300));
  check('the window says it was handed over', /Handed over 6 answer/.test(await top(`return document.getElementById('toast').textContent`) || ''));
  const rd = run('t1', doc, '--live', '--read');
  check('--live --read prints the last answers', rd.status === 0 && JSON.stringify(parsed(rd.stdout)?.answers) === JSON.stringify(want), rd.stdout + rd.stderr);
  check('answers are kept next to the page', existsSync(join(site, 'page.answers.json')));
  const rn = run('t1', docB, '--live', '--read');
  check('--live --read without answers fails cleanly', rn.status === 1 && /no answers yet/.test(rn.stderr), rn.stderr);

  // 7. --hc-terminal: the last document opened or changed from a terminal
  run('t1', docB, '--live');
  run('t2', docC, '--live');
  const ids = Object.fromEntries((await (await fetch(base + '/api/tabs')).json()).tabs.map(t => [t.name, t.id]));
  check('three live tabs', Object.keys(ids).length === 3, JSON.stringify(ids));
  // no hyprctl on the PATH, so no real window is raised
  const hc = term => spawnSync(venv, ['--hc-terminal', term, '--port', String(SP)],
    { env: { HOME: process.env.HOME, PATH: '/nonexistent', XDG_CACHE_HOME: join(tmp, 'cache') }, encoding: 'utf8' });
  const focus = async () => (await (await fetch(base + '/api/tabs')).json()).focus;
  await top(`document.querySelectorAll('.tab')[0].click(); return 1`);
  let h = hc('t1');
  check('--hc-terminal t1 succeeds', h.status === 0, h.stderr || h.stdout);
  check('--hc-terminal t1 selects the document opened last from t1', await focus() === ids['b.html']);
  check('the window shows that tab', !!(await until(() => top(`return document.querySelector('.tab.on')?.textContent.includes('b.html')`), 5000)));
  writeFileSync(doc, page('v3'));
  h = hc('t1');
  check('--hc-terminal t1 then selects the document changed last', h.status === 0 && await focus() === ids['page.html']);
  h = hc('t2');
  check('--hc-terminal t2 selects its own document', h.status === 0 && await focus() === ids['c.html']);
  h = hc('t99');
  check('--hc-terminal for an unknown terminal fails cleanly',
    h.status === 1 && /no open document from terminal t99/.test(h.stderr) && !h.stdout, `${h.status} ${h.stderr} ${h.stdout}`);

  // 8. --hc-machine: a live page of "another machine", here a second just-doc reached through tests/fake-ssh.py
  const rdoc = join(site, 'remote.html');
  writeFileSync(rdoc, page('r1'));
  utimesSync(rdoc, new Date(Date.now() - 60000), new Date(Date.now() - 60000));
  procs.push(spawn(venv, [rdoc, '--live', '--no-window', '--port', String(RP)],
    { env: { ...env('t5'), WAYLAND_DISPLAY: '', DISPLAY: '' }, stdio: 'ignore' }));
  await until(async () => (await fetch(`http://127.0.0.1:${RP}/api/tabs`)).ok, 15000);
  const pr = spawnSync(venv, ['--hc-terminal', 't5', '--print', '--port', String(RP)], { encoding: 'utf8' });
  const printed = (() => { try { return JSON.parse(pr.stdout); } catch { return null; } })();
  check('--print gives the port and address of the page', pr.status === 0 && printed?.port === RP && printed?.live
    && printed?.url === `/live/${printed?.id}/remote.html`, pr.stdout + pr.stderr);
  const none = spawnSync(venv, ['--hc-terminal', 't77', '--print', '--port', String(RP)], { encoding: 'utf8' });
  check('--print for an unknown terminal fails cleanly', none.status === 1 && !none.stdout, none.stdout + none.stderr);
  const hcm = (term, machine) => spawnSync(venv, ['--hc-terminal', term, '--hc-machine', machine, '--port', String(SP)],
    { env: { HOME: process.env.HOME, PATH: '/usr/bin:/bin', XDG_CONFIG_HOME: conf, XDG_CACHE_HOME: join(tmp, 'cache') },
      encoding: 'utf8', timeout: 60000 });
  h = hcm('t5', 'fake');
  check('--hc-machine succeeds', h.status === 0, h.stderr || h.stdout);
  const rt = (await (await fetch(base + '/api/tabs')).json());
  const rtab = rt.tabs.find(t => t.remote === 'fake');
  check('a remote tab, named with its machine, is shown', !!rtab && rtab.name === 'fake: remote.html' && rt.focus === rtab.id, JSON.stringify(rtab));
  const rran = await until(() => ev(`return w.threeOK && !!d.querySelector('#plot .main-svg') && d.getElementById('v')?.textContent`), 20000);
  check('remote page runs through the forward (/_lib/, relative script)', rran === 'r1', String(rran));
  check('the remote tab shows the machine and the live mark',
    !!(await top(`const t=document.querySelector('.tab.on'); return t && t.textContent.includes('fake: remote.html') && t.querySelector('i')?.textContent==='live'`)));
  await ev(`w.marker = 1; return 1`);
  writeFileSync(rdoc, page('r2'));
  utimesSync(rdoc, new Date(Date.now() - 5000), new Date(Date.now() - 5000));
  check('remote page loads again when its file changes', !!(await until(() => ev(`return d.getElementById('v')?.textContent === 'r2' && !w.marker`), 20000)));
  // answers of a remote page are kept on its machine and read there
  await ev(`d.querySelector('input[name=note]').value = 'from afar'; d.body.dispatchEvent(new w.KeyboardEvent('keydown', {key: 'Enter', ctrlKey: true, bubbles: true})); return 1`);
  const far = await until(() => { const r = spawnSync(venv, [rdoc, '--live', '--read'], { encoding: 'utf8' }); return r.status === 0 && parsed(r.stdout); }, 8000);
  check('Ctrl+Enter in a remote page saves its answers there', far?.answers?.note === 'from afar', JSON.stringify(far));
  h = hcm('t77', 'fake');
  check('--hc-machine for an unknown terminal fails cleanly', h.status === 1 && /no open document/.test(h.stderr) && !h.stdout, `${h.status} ${h.stderr}`);
  check('no uncaught exceptions', excs.length === 0, excs[0]);
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
