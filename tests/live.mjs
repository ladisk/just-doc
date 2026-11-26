// Test of live pages (--live), /_lib/ and --hc-terminal in headless Chromium. See tests/README.md.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync, existsSync, copyFileSync } from 'node:fs';
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

// the first lines of an answer only (a big file is not read to the end)
const firstLines = path => new Promise((resolve, reject) => {
  const s = connect(SP, '127.0.0.1', () => s.write(`GET ${path} HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n`));
  let out = ''; s.on('data', c => { out += c.toString('latin1'); if (out.includes('\r\n\r\n')) { s.destroy(); resolve(out.split('\r\n\r\n')[0]); } });
  s.on('error', reject);
});

const tmp = mkdtempSync(join(tmpdir(), 'just-doc-live-'));
// a do-nothing hc on the PATH, so that the hc labels of the test terminals never reach a real hc
const noHc = join(tmp, 'nohc');
mkdirSync(noHc);
writeFileSync(join(noHc, 'hc'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
const procs = [];
let ws;
try {
  // 1. a folder with a page, its style sheet and script, and a file outside it
  const site = join(tmp, 'site');
  mkdirSync(join(site, 'sub'), { recursive: true });
  writeFileSync(join(tmp, 'secret.txt'), 'SECRET-OUTSIDE');
  writeFileSync(join(site, 'sub', 'style.css'), 'body { margin: 0 }');
  writeFileSync(join(site, 'sub', 'data.js'), 'window.DATA = [1, 4, 9];');
  // o.before: HTML put before the paragraph; o.noPlot: the first plot is left out
  const page = (v, o = {}) => `<!doctype html><meta charset="utf-8"><title>p</title>
<link rel="stylesheet" href="/_lib/page.css"><link rel="stylesheet" href="sub/style.css">
<script src="/_lib/plotly.min.js"></script><script src="sub/data.js"></script>
<h1 id="v">${v}</h1>
${o.before || ''}<p id="intro">${o.intro || 'The quick brown fox jumps over the lazy dog.'}</p>
<fieldset class="choice"><legend>Pick</legend><label><input type="radio" name="pick" value="A"> A</label><label><input type="radio" name="pick" value="B"> B</label></fieldset>
<label><input type="checkbox" class="toggle" name="ok"> ok</label>
<label><input type="checkbox" name="tags" value="x">x</label><label><input type="checkbox" name="tags" value="y">y</label>
<select name="many" multiple><option>m1</option><option>m2</option></select>
<form><input name="note"><textarea name="long"></textarea></form>
<p id="filler">${Array.from({ length: 45 }, (_, i) => 'filler' + i).join(' ')}</p>${o.after || ''}
${o.noPlot ? '' : '<div id="plot" class="plot"></div>'}<div id="plot2" class="plot"></div><div style="height:3000px"></div>
<script>${o.noPlot ? '' : "Plotly.newPlot('plot', [{y: window.DATA}]);"}
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
  const env = term => ({ ...process.env, PATH: `${noHc}:${process.env.PATH}`, XDG_CACHE_HOME: join(tmp, 'cache'), XDG_CONFIG_HOME: conf, HC_TERMINAL_ID: term });
  const jd = (...a) => ['run', '--project', repo, 'just-doc', ...a, '--port', String(SP), '--no-window'];
  const run = (term, ...a) => spawnSync('uv', jd(...a), { cwd: repo, env: env(term), encoding: 'utf8' });
  const base = `http://127.0.0.1:${SP}`;

  // 2. server with the live page, from terminal t1
  try { await fetch(base + '/api/tabs'); console.log(`port ${SP} is in use; set LIVE_PORT`); process.exit(1); } catch {}
  // the command returns once the page is open in a just-doc that runs in the background
  spawnSync('uv', jd(doc, '--live'), { cwd: repo, env: env('t1'), stdio: 'ignore', timeout: 60000 });
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
                           ['three/addons/OrbitControls.js', 'text/javascript'], ['three/fast.js', 'text/javascript'], ['three/scene.js', 'text/javascript'],
                           ['occt/occt-import-js.js', 'text/javascript'], ['occt/occt-import-js.wasm', 'application/wasm'], ['page.css', 'text/css']]) {
    const lines = await firstLines(`/_lib/${p}`);
    check(`/_lib/${p} served as ${type}`, /^HTTP\/1\.\d 200/.test(lines) && new RegExp(`^content-type: ${type}`, "mi").test(lines), lines.replace(/\r\n/g, ' | '));
  }

  // 4. the window in headless Chromium
  const bin = ['chromium', 'google-chrome-stable', 'google-chrome', 'brave'].find(has);
  if (!bin) throw new Error('no chromium/chrome/brave found');
  procs.push(spawn(bin, ['--headless=new', '--disable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', `--user-data-dir=${join(tmp, 'chr')}`,
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
  const top = async e => (await cmd('Runtime.evaluate', { expression: `(()=>{${e}})()`, returnByValue: true, awaitPromise: true })).result?.value;
  // run JS in the frame of the shown tab; w = its window, d = its document
  const ev = e => top(`const f=document.querySelector('iframe.on'); if(!f||!f.contentDocument) return null; const w=f.contentWindow, d=w.document; ${e}`);

  const ran = await until(() => ev(`return w.threeOK && !!d.querySelector('#plot .main-svg') && d.getElementById('v')?.textContent`), 20000);
  check('page runs: Plotly plot drawn, three.js and OrbitControls imported, relative script loaded', ran === 'v1', String(ran));
  check('the tab bar shows the live mark', !!(await top(`const t=document.querySelector('.tab.on i'); return t && t.textContent==='live' && t.offsetParent!==null`)));

  // /_lib/three/touchpad.js: touchpad wheel events on an OrbitControls view (no WebGL needed)
  const pad = await ev(`return (async () => {
    const T = await import('/_lib/three/three.module.js'), { OrbitControls } = await import('/_lib/three/addons/OrbitControls.js');
    const { touchpad } = await import('/_lib/three/touchpad.js');
    const box = d.createElement('div'); box.style.cssText = 'width:600px;height:400px'; d.body.prepend(box);
    const cam = new T.PerspectiveCamera(45, 1.5, 0.1, 100); cam.position.set(0, 0, 10);
    const c = new OrbitControls(cam, box); c.update(); touchpad(c);
    const wheel = o => { const e = new w.WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: 300, clientY: 200, deltaMode: 0, ...o }); box.dispatchEvent(e); return e.defaultPrevented; };
    const dist = () => cam.position.distanceTo(c.target), out = {};
    out.pan = wheel({ deltaX: 30, deltaY: 20 }) && c.target.x > 0 && c.target.y < 0 && Math.abs(dist() - 10) < 1e-6;
    const before = dist(); wheel({ deltaY: -50, ctrlKey: true }); out.pinch = dist() < before && dist() > before * 0.5;
    const d2 = dist(); wheel({ deltaY: 120 }); out.wheel = dist() > d2;
    const p = cam.position.clone().sub(c.target).normalize(); wheel({ deltaX: 40, deltaY: 0, shiftKey: true });
    out.shift = p.angleTo(cam.position.clone().sub(c.target).normalize()) > 0.05;
    box.remove(); return out; })()`);
  check('touchpad.js: two-finger scroll pans as the page would scroll (target moves, distance kept)', pad?.pan === true, JSON.stringify(pad));
  check('touchpad.js: pinch zooms in by the pinch amount', pad?.pinch === true, JSON.stringify(pad));
  check('touchpad.js: a mouse wheel step is left to OrbitControls and zooms', pad?.wheel === true, JSON.stringify(pad));
  check('touchpad.js: shift + scroll turns the view', pad?.shift === true, JSON.stringify(pad));

  // /_lib/three/fast.js: 500 small meshes with 3 materials become 3 draw calls, the box stays
  const fast = await ev(`return (async () => {
    const T = await import('/_lib/three/three.module.js'), { mergeByMaterial, sharpWhenStill } = await import('/_lib/three/fast.js');
    const mats = [0, 1, 2].map(i => new T.MeshStandardMaterial({ color: i * 0x333333 }));
    const root = new T.Group(), keepMe = [];
    for (let i = 0; i < 500; i++) {
      const g = i % 7 === 0 ? new T.BoxGeometry(1, 1, 1).toNonIndexed() : new T.BoxGeometry(1, 1, 1);
      if (i % 5 === 0) g.deleteAttribute('uv');
      const m = new T.Mesh(g, mats[i % 3]);
      m.position.set(i % 10 * 2, Math.floor(i / 10) % 10 * 2, Math.floor(i / 100) * 2);
      if (i % 11 === 0) m.scale.x = -1;
      if (i === 3) keepMe.push(m);
      if (i % 2) root.add(m); else { const grp = new T.Group(); grp.position.y = 0.5; root.add(grp); grp.add(m); }
    }
    root.position.set(5, 6, 7); root.rotation.y = 0.4; root.updateMatrixWorld(true);
    const pts = o => { const v = []; o.traverse(m => { if (!m.isMesh) return; const p = m.geometry.attributes.position, q = new T.Vector3();
      for (let i = 0; i < p.count; i++) v.push(q.fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld).clone()); }); return new T.Box3().setFromPoints(v); };
    const b0 = pts(root);
    const r = mergeByMaterial(root, { keep: m => keepMe.includes(m) });
    const b1 = pts(root), meshes = []; root.traverse(o => o.isMesh && meshes.push(o));
    const out = { before: r.before, after: r.after, kept: keepMe[0].parent !== null, meshes: meshes.length,
      same: b0.min.distanceTo(b1.min) < 1e-4 && b0.max.distanceTo(b1.max) < 1e-4 };
    // winding agrees with the normals everywhere, mirrored boxes included
    out.winding = meshes.filter(m => m !== keepMe[0]).every(m => { const g = m.geometry, p = g.attributes.position, n = g.attributes.normal, x = g.index.array;
      const a = new T.Vector3(), b = new T.Vector3(), c = new T.Vector3(), nn = new T.Vector3();
      for (let i = 0; i < x.length; i += 3) { a.fromBufferAttribute(p, x[i]); b.fromBufferAttribute(p, x[i + 1]); c.fromBufferAttribute(p, x[i + 2]);
        nn.fromBufferAttribute(n, x[i]); if (b.sub(a).cross(c.sub(a)).dot(nn) <= 0) return false; } return true; });
    out.sharp = typeof sharpWhenStill === 'function';
    return out; })()`);
  check('fast.js: 500 meshes, 3 materials merge (before 500, few after)', fast?.before === 500 && fast?.after >= 3 && fast?.after <= 12 && fast.after === fast.meshes, JSON.stringify(fast));
  check('fast.js: the bounding box and winding are right, a kept mesh stays', fast?.same === true && fast?.winding === true && fast?.kept === true && fast?.sharp === true, JSON.stringify(fast));

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
  const waiter = spawn('uv', jd(doc, '--live', '--wait', '--json'), { cwd: repo, env: env('t1'), stdio: ['ignore', 'pipe', 'pipe'] });
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

  // comments: a with selected text, a with the mouse on the plot; the editor is in the card beside the mark
  const press = k => ev(`d.body.dispatchEvent(new w.KeyboardEvent('keydown', {key: '${k}', bubbles: true})); return 1`);
  const typeIn = async text => {
    const ok = await until(() => ev(`return !!d.getElementById('ed')`), 3000);
    await ev(`const e = d.getElementById('ed'); e.value = ${JSON.stringify(text)}; e.dispatchEvent(new w.Event('input'));
      e.dispatchEvent(new w.KeyboardEvent('keydown', {key: 'Enter', bubbles: true})); return 1`);
    return !!ok;
  };
  const stored = (f = join(site, 'page.live.comments.json')) => { try { return JSON.parse(readFileSync(f, 'utf8')).annots; } catch { return []; } };
  const select = (id, from, to) => ev(`const t = d.getElementById('${id}').firstChild, r = d.createRange(); r.setStart(t, ${from}); r.setEnd(t, ${to});
    w.getSelection().removeAllRanges(); w.getSelection().addRange(r); return 1`);
  await select('intro', 4, 15);
  await press('a');
  check('a with selected text opens the editor in a card on the page, the list in the side panel', await typeIn('too informal')
    && await top(`return getComputedStyle(document.getElementById('side')).display === 'flex'`));
  check('the card is in the marks layer of the page, not in the panel', !!(await until(() => ev(`return !!d.querySelector('#__jd_marks #__jd_card .card')`), 3000))
    && !(await top(`return !!document.querySelector('#side textarea')`)));
  const c1 = await until(() => stored().find(a => a.n === 1), 5000);
  check('a text comment is saved next to the page with its anchor', c1?.kind === 'text' && c1.text === 'quick brown' && c1.comment === 'too informal'
    && c1.anchor?.id === 'intro' && c1.anchor.prefix.endsWith('The ') && c1.anchor.suffix.startsWith(' fox') && !!c1.anchor.selector, JSON.stringify(c1));
  check('the HTML file is not changed', !readFileSync(doc, 'utf8').includes('too informal'));
  await press('Escape');
  await ev(`d.getElementById('plot').scrollIntoView({block: 'center'}); const r = d.getElementById('plot').getBoundingClientRect();
    d.body.dispatchEvent(new w.MouseEvent('mousemove', {clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true})); return 1`);
  await press('a');
  check('a with the mouse on the plot opens the editor', await typeIn('peak here?'));
  const c2 = await until(() => stored().find(a => a.n === 2), 5000);
  check('an element comment on the plot is anchored to its id, with the point', c2?.kind === 'element' && c2.comment === 'peak here?'
    && c2.anchor?.id === 'plot' && c2.anchor.at?.length === 2 && Math.abs(c2.anchor.at[0] - 0.5) < 0.05, JSON.stringify(c2));
  check('both are marked over the page, outside its layout', !!(await until(() => ev(`return d.querySelectorAll('#__jd_marks [data-id]').length === 2`), 3000)));
  check('the page narrows for the panel', !!(await top(`return document.querySelector('iframe.on').getBoundingClientRect().width <= innerWidth - 340`)));
  check('with the panel open the plot fills the page (page.css), with no sideways scrolling', !!(await until(() => ev(
    `const W = d.documentElement.clientWidth; return Math.abs(d.getElementById('plot').getBoundingClientRect().width - (W - 40)) < 2
      && d.documentElement.scrollWidth <= W && d.getElementById('intro').getBoundingClientRect().width <= 960`), 5000)),
    await ev(`return [d.documentElement.clientWidth, d.documentElement.scrollWidth, d.getElementById('plot').getBoundingClientRect().width]`));
  check('the plot still runs', !!(await ev(`return !!d.querySelector('#plot .main-svg') && typeof d.getElementById('plot')._fullLayout === 'object'`)));
  // the key bar at the bottom, as in the PDF viewer
  check('the key bar spans the window at the bottom; page and panel end above it', !!(await top(`const f = document.getElementById('foot').getBoundingClientRect(),
    p = document.querySelector('iframe.on').getBoundingClientRect(), s = document.getElementById('side').getBoundingClientRect();
    return f.width === innerWidth && Math.abs(f.bottom - innerHeight) < 1 && p.bottom <= f.top + 0.5 && s.bottom <= f.top + 0.5
      && /hand over/.test(document.getElementById('foot').textContent) && !document.querySelector('#side kbd + kbd')`)));
  await press('?');
  check('? opens the list of live keys', !!(await top(`return document.getElementById('help').classList.contains('open')`)));
  await press('/');
  await top(`const q = document.getElementById('hq'); q.value = 'undo'; q.dispatchEvent(new Event('input')); return 1`);
  check('/ filters it', (await top(`return [...document.querySelectorAll('#help tr')].filter(t => !t.hidden).length`)) === 1);
  await top(`const q = document.getElementById('hq'); q.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
    q.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true})); return 1`);
  check('Esc clears and closes it', !(await top(`return document.getElementById('help').classList.contains('open')`)));
  await press('q');
  check('q asks before it quits', /stop just-doc/.test(await top(`return document.getElementById('fhint').textContent`)));
  await press('n');
  check('a key other than y keeps just-doc', (await top(`return document.getElementById('fhint').textContent`)) === '' && (await fetch(base + '/api/tabs')).ok);
  await ev(`d.querySelector('textarea[name=long]').dispatchEvent(new w.KeyboardEvent('keydown', {key: 'Enter', ctrlKey: true, bubbles: true})); return 1`);
  check('Ctrl+Enter ends --live --wait', (await until(() => wexit !== null, 15000)) && wexit === 0, wout.slice(-300));
  const want = { pick: 'B', ok: true, tags: ['y'], many: ['m2'], note: 'hi', long: 'two\nlines' };
  const parsed = t => { try { return JSON.parse(t.slice(t.indexOf('{'))); } catch { return null; } };
  const got = parsed(wout);
  check('--live --wait --json gives the answers', JSON.stringify(got?.answers?.answers) === JSON.stringify(want) && got?.answers?.round === 1, wout.slice(-300));
  check('--live --wait --json gives both comments with their anchors',
    got?.comments?.length === 2 && got.comments[0].anchor?.id === 'intro' && got.comments[1].anchor?.id === 'plot', wout.slice(-600));
  check('the window says it was handed over', /Handed over 2 open comment\(s\) and 6 answer/.test(await top(`return document.getElementById('toast').textContent`) || ''));
  let rd = run('t1', doc, '--live', '--read', '--json');
  check('--live --read --json prints the last answers', rd.status === 0 && JSON.stringify(parsed(rd.stdout)?.answers?.answers) === JSON.stringify(want), rd.stdout + rd.stderr);
  rd = run('t1', doc, '--live', '--read');
  check('--live --read prints the comments with their anchors and the answers',
    rd.status === 0 && /\[1\] #intro/.test(rd.stdout) && /text: +quick brown/.test(rd.stdout) && /\[2\] #plot/.test(rd.stdout)
    && /comment: peak here\?/.test(rd.stdout) && /answers \(round 1/.test(rd.stdout), rd.stdout + rd.stderr);
  check('answers are kept next to the page', existsSync(join(site, 'page.answers.json')));
  const rn = run('t1', docB, '--live', '--read');
  check('--live --read without comments or answers says so', rn.status === 0 && /no answers yet/.test(rn.stdout), rn.stdout + rn.stderr);

  // a reply from the agent shows in the panel
  const rp = run('t1', doc, '--live', '--reply', '1', 'made it formal', '--from', 'bot');
  check('--live --reply succeeds', rp.status === 0, rp.stdout + rp.stderr);
  const pillOf = id => top(`return document.querySelector('.it[data-id="${id}"] .st')?.textContent`);
  check('the panel shows comment 1 as a new reply, in blue', !!(await until(async () => (await pillOf(c1.id)) === 'new reply'
    && await top(`return document.querySelector('.it[data-id="${c1.id}"]').classList.contains('new')`), 8000)));
  await top(`document.querySelector('.it[data-id="${c1.id}"]').click(); return 1`);
  check('selecting it makes it answered, no longer new', await pillOf(c1.id) === 'answered'
    && !(await top(`return document.querySelector('.it[data-id="${c1.id}"]').classList.contains('new')`)));
  check('a comment handed over and read by the assistant, with no reply, says when', /^seen \d\d:\d\d, no reply$/.test(await pillOf(c2.id)), await pillOf(c2.id));
  const open = () => top(`return [...document.querySelectorAll('.it')].map(r => r.classList.contains('open'))`);
  await press('z'); await press('R');
  check('zR opens all rows', (await open()).every(Boolean) && (await open()).length === 2);
  await press('z'); await press('M');
  check('zM closes all rows, also the selected one', (await open()).every(x => !x));
  await press('z'); await press('a');
  check('za opens the selected row', JSON.stringify(await open()) === '[true,false]');
  check('the card of the selected comment shows its reply', await ev(`return /bot replied/.test(d.querySelector('#__jd_card .card')?.textContent) && /made it formal/.test(d.querySelector('#__jd_card .card').textContent)`));
  await press('C');
  check('C hides the marks, the selected one stays', await ev(`const m = [...d.querySelectorAll('#__jd_hl .m')]; return m.length > 0 && m.every(x => x.classList.contains('on'))`));
  await press('C');
  check('C shows them again', await ev(`return d.querySelectorAll('#__jd_hl [data-id]').length === 2`));

  // the page changes: new text before the paragraph (also with the quote in it), the plot removed
  await ev(`w.marker = 3; return 1`);
  writeFileSync(doc, page('v2', { before: '<section><p>A quick brown fox elsewhere.</p></section>', noPlot: true }));
  utimesSync(doc, new Date(Date.now() - 5000), new Date(Date.now() - 5000));
  check('page loads again', !!(await until(() => ev(`return !w.marker && !d.getElementById('plot') && !!d.querySelector('section')`), 15000)));
  const where1 = await until(() => ev(`const m = d.querySelector('#__jd_marks [data-id="${c1.id}"]'); if (!m) return null;
    const p = d.getElementById('intro').getBoundingClientRect(), b = m.getBoundingClientRect();
    return Math.abs(b.top - p.top) < 12`), 5000);
  check('the text comment stays on its paragraph (by id), not on the same words elsewhere', !!where1);
  const det = await until(() => stored().find(a => a.n === 2)?.detached === true, 5000);
  check('the comment on the removed plot is kept as detached', !!det && stored().length === 2, JSON.stringify(stored()));
  check('the panel lists it as not found on the page', !!(await until(() => top(`return /not found on the page/.test(document.querySelector('.it[data-id="${c2.id}"] .l1')?.textContent)`), 3000)));
  rd = run('t1', doc, '--live', '--read');
  check('--live --read says it is detached', /\(detached/.test(rd.stdout), rd.stdout);
  // x marks the selected comment done; it leaves the list at the next Ctrl+Enter, D shows it again
  await ev(`d.getElementById('intro').scrollIntoView(); return 1`);
  await top(`document.querySelector('.it[data-id="${c1.id}"]').click(); return 1`);
  await press('x');
  check('x marks it done (done ✓), at once and not as news', !!(await until(async () => (await pillOf(c1.id)) === 'done ✓', 5000)));
  await press('Escape');
  const rowsNow = () => top(`return document.querySelectorAll('.it').length`);
  check('a done comment stays in the list until the next Ctrl+Enter', (await rowsNow()) === 2);
  await ev(`d.body.dispatchEvent(new w.KeyboardEvent('keydown', {key: 'Enter', ctrlKey: true, bubbles: true})); return 1`);
  check('Ctrl+Enter files it: it leaves the list and the page', !!(await until(async () => (await rowsNow()) === 1, 5000))
    && /1 done . D shows them/.test(await top(`return document.getElementById('archive').textContent`))
    && await ev(`return d.querySelectorAll('#__jd_hl [data-id]').length === 0`), `${await rowsNow()} ${await top(`return document.getElementById('toast').textContent + document.getElementById('archive').textContent`)}`);
  await press('D');
  check('D shows the done comment in the list again, as in the PDF viewer not on the page', (await rowsNow()) === 2 && await top(`return document.querySelector('.it.done .st')?.textContent === 'done ✓'`));
  await press('D');
  check('D hides it again', (await rowsNow()) === 1);

  // 6b. what changed: m, M, gb, gh and the change in the list
  const SHOTS = process.env.SHOTS;
  const shot = async name => { if (!SHOTS) return; mkdirSync(SHOTS, { recursive: true });
    writeFileSync(join(SHOTS, name), Buffer.from((await cmd('Page.captureScreenshot', { format: 'png' })).data, 'base64')); };
  const fchg = () => top(`return document.getElementById('fchg').textContent`);
  const toastText = () => top(`return document.getElementById('toast').textContent`);
  await ev(`d.getElementById('intro').scrollIntoView(); return 1`);
  await select('intro', 35, 43);
  await press('a');
  check('a comment on "lazy dog" for the changes', await typeIn('dog or cat?'));
  const c3 = await until(() => stored().find(a => a.comment === 'dog or cat?'), 5000);
  await press('Escape');
  await press('M');
  check('M on a page that is not in git says so', !!(await until(async () => /not in git/.test(await toastText()), 5000)) && (await fchg()) === '', await toastText());
  await ev(`d.body.dispatchEvent(new w.KeyboardEvent('keydown', {key: 'Enter', ctrlKey: true, bubbles: true})); return 1`);
  const rounds3 = await until(async () => { const j = await (await fetch(`${base}/api/rounds?d=${tab.id}`)).json(); return j.rounds.length >= 3 && j.rounds; }, 5000);
  check('Ctrl+Enter keeps the text of the round on the server', !!rounds3 && (await (await fetch(`${base}/api/was?d=${tab.id}&n=${rounds3?.length}`)).json()).text.includes('A quick brown fox elsewhere.'));
  check('and the page of the round, served in the folder of the page',
    (await (await fetch(`${base}${at}.jd-round${rounds3?.length}.html`)).text()).includes('jumps over the lazy dog'));
  check('a round that is not kept gives 404', (await fetch(`${base}${at}.jd-round99.html`)).status === 404 && (await fetch(`${base}/api/was?d=${tab.id}&n=99`)).status === 404);
  await press('m');
  check('m right after a hand-over: no changes', !!(await until(async () => /^no changes since the last hand-over/.test(await fchg()), 5000)), await fchg());
  await press('m');
  check('m again hides the marks', !!(await until(async () => (await fchg()) === '', 3000)));
  await press('m');
  await until(async () => /no changes/.test(await fchg()), 5000);
  // the page is changed: a sentence changed in two places, a paragraph removed, new text far from the comment
  writeFileSync(doc, page('v2', { noPlot: true, intro: 'The quick brown fox leaps over the lazy cat.', after: '<h2 id="newh">Brand new closing words here</h2>', noSection: true }));
  utimesSync(doc, new Date(Date.now() - 5000), new Date(Date.now() - 5000));
  const marked = await until(() => ev(`return !!d.getElementById('newh') && d.querySelectorAll('#__jd_hl .chg').length >= 3`), 15000);
  check('the marks stay on when the page is loaded again', !!marked);
  const info = await fchg();
  check('the key bar counts the changes and the one nobody asked for', /^4 changes since the last hand-over · 1 not asked for$/.test(info), info);
  const classes = await ev(`const m = [...d.querySelectorAll('#__jd_hl .chg')]; return { cut: m.filter(x => x.classList.contains('cut')).length,
    own: m.filter(x => x.classList.contains('own')).length, all: m.length, comments: d.querySelectorAll('#__jd_hl [data-id]').length }`);
  check('a thin red mark where text was removed, one wavy mark, the others plain blue', classes.cut === 1 && classes.own === 1 && classes.all === 4, JSON.stringify(classes));
  const under = await ev(`const g = [...d.querySelectorAll('#__jd_hl .chg:not(.cut):not(.own)')][0], r = g.getBoundingClientRect(), i = d.getElementById('intro').getBoundingClientRect();
    return r.top >= i.top - 2 && r.bottom <= i.bottom + 2 && w.getComputedStyle(g).backgroundImage.includes('gradient')`);
  check('a change is a blue line under the new words, on their line', under === true);
  check('the list says how many changes have no comment', !!(await until(() => top(`return /2 changes without a comment · 2 to look at/.test(document.querySelector('.grp.chgs')?.textContent || '')`), 3000)),
    await top(`return document.querySelector('#list').innerText`));
  await shot('1-changes.png');
  // n goes through the comments, then the changes with no comment
  const cardText = () => ev(`return d.querySelector('#__jd_card .card')?.textContent || ''`);
  let seenChange = false;
  for (let i = 0; i < 8 && !seenChange; i++) { await press('n'); seenChange = /not asked for/.test(await cardText()); }
  check('n reaches a change that no comment is near: a card with the new text and "not asked for"', seenChange && /Brand new closing words here/.test(await cardText()), await cardText());
  check('its card shows the old words struck out and the new ones: del / ins', await ev(`return !!d.querySelector('#__jd_card .card ins') && d.querySelector('#__jd_card .card').classList.contains('own')`));
  check('its row in the list is marked', !!(await top(`return !!document.querySelector('.it.chg.on .st.chg')`)));
  await shot('2-change-card.png');
  await press('a');
  check('a on it opens the field', await typeIn('why this heading?'));
  const c4 = await until(() => stored().find(a => a.comment === 'why this heading?'), 5000);
  check('a comment on a change is saved with the text as it was (nothing, it is new)', c4?.change === '' && /Brand new closing words/.test(c4.text) && c4.kind === 'text', JSON.stringify(c4));
  // the first stretch of changes: the removed paragraph, the sentence changed near the comment
  await press('Escape');
  let first = false;
  for (let i = 0; i < 8 && !first; i++) { await press('n'); first = /near your comment/.test(await cardText()); }
  check('n reaches the changes near your comment, with their words', first && /leaps/.test(await cardText()) && /jumps/.test(await cardText()), await cardText());
  await press('a');
  check('a on the removed text comments on the place', await typeIn('why gone?'));
  const c5 = await until(() => stored().find(a => a.comment === 'why gone?'), 5000);
  check('a comment on removed text has no text and keeps the words as they were', c5?.change === 'A quick brown fox elsewhere.' && c5.text === '' && c5.kind === 'element', JSON.stringify(c5));
  rd = run('t1', doc, '--live', '--read');
  check('--live --read prints a comment on a change and on removed text', /removed: +A quick brown fox elsewhere\./.test(rd.stdout)
    && /a comment on a change: before it, the text was: \(nothing, it is new\)/.test(rd.stdout), rd.stdout);
  await press('z'); await press('R');
  await shot('5-list-open.png');
  await press('z'); await press('M');
  await press('Escape');
  // gb: the page as it was at the last hand-over, in place of the page
  await press('g'); await press('b');
  const old = await until(() => top(`const f = document.querySelector('iframe.ol'); return f?.contentDocument?.getElementById('intro')?.textContent`), 8000);
  check('gb shows the page as it was at the last hand-over, read only', old === 'The quick brown fox jumps over the lazy dog.', String(old));
  check('the key bar says so', /the page as it was at the last hand-over · gb: as it is now/.test(await fchg()), await fchg());
  await press('a');
  check('a on the old page is refused', /read only/.test(await toastText()) && !(await top(`return !!document.querySelector('iframe.ol')?.contentDocument?.getElementById('ed')`)));
  await shot('3-old-page.png');
  await press('g'); await press('b');
  check('gb again goes back to the page', !(await top(`return !!document.querySelector('iframe.ol')`)));
  await press('g'); await press('b'); await sleep(500);
  await press('Escape');
  check('Esc goes back too', !(await top(`return !!document.querySelector('iframe.ol')`)));
  // gh: the rounds
  await press('g'); await press('h');
  check('gh opens the history, newest round first, with the changes so far', !!(await until(() => top(`const t = document.getElementById('hist').innerText;
    return document.getElementById('hist').classList.contains('open') && /Round 3/.test(t) && /changes so far/i.test(t) && /leaps/.test(t) && /Brand new closing words here/.test(t)`), 8000)),
    await top(`return document.getElementById('hist').innerText`));
  check('it says what you handed over', /you handed over/i.test(await top(`return document.getElementById('hist').innerText`)));
  await shot('4-history.png');
  await press('j');
  check('j moves to the round before', await top(`return /Round 2/.test(document.querySelector('.hr.on .hh')?.textContent)`));
  await press('Enter');
  const end2 = await until(() => top(`const f = document.querySelector('iframe.ol'); return f?.contentDocument?.getElementById('intro')?.textContent`), 8000);
  check('Enter shows the page at the end of that round (the next hand-over)', end2 === 'The quick brown fox jumps over the lazy dog.' && /at the end of round 2/.test(await fchg()), `${end2} ${await fchg()}`);
  await press('Escape');
  await press('g'); await press('h');
  await press('Escape');
  check('Esc closes the history', !(await top(`return document.getElementById('hist').classList.contains('open')`)));
  // M: against the last commit of a page in a git repository
  const gsite = join(tmp, 'gsite'), gdoc = join(gsite, 'g.html');
  mkdirSync(gsite);
  const git = (...a) => spawnSync('git', ['-C', gsite, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
  git('init', '-q');
  writeFileSync(gdoc, '<!doctype html><meta charset="utf-8"><h1>g</h1><p id="p">One two three four five.</p><p>Second paragraph here.</p>');
  git('add', 'g.html'); git('commit', '-q', '-m', 'one');
  writeFileSync(gdoc, '<!doctype html><meta charset="utf-8"><h1>g</h1><p id="p">One twoo three four five six.</p><p>Second paragraph here.</p>');
  run('t1', gdoc, '--live');
  const gid = await until(async () => (await (await fetch(base + '/api/tabs')).json()).tabs.find(t => t.name === 'g.html')?.id, 10000);
  await top(`document.querySelectorAll('.tab').forEach(t => t.textContent.includes('g.html') && t.click()); return 1`);
  await until(() => ev(`return !!d.getElementById('__jd_marks') && d.getElementById('p')?.textContent.includes('six')`), 15000);
  await press('M');
  check('M marks what is not as it was at the last commit', !!(await until(async () => /^2 changes since the last commit · 2 not asked for$/.test(await fchg()), 15000)), await fchg());
  await press('g'); await press('b');
  const goldt = await until(() => top(`return document.querySelector('iframe.ol')?.contentDocument?.getElementById('p')?.textContent`), 8000);
  check('gb after M shows the page of the last commit', goldt === 'One two three four five.', String(goldt));
  await press('Escape');
  await press('M');
  check('M again hides the marks', !!(await until(async () => (await fchg()) === '', 3000)));
  git('commit', '-q', '-a', '-m', 'two');
  await press('M');
  check('M with nothing changed since the commit says so', !!(await until(async () => /^no changes since the last commit/.test(await fchg()), 15000)), await fchg());
  await press('M');
  await fetch(`${base}/api/close?d=${gid}`, { method: 'POST' });
  await until(async () => (await (await fetch(base + '/api/tabs')).json()).tabs.length === 1, 5000);
  await top(`document.querySelectorAll('.tab').forEach(t => t.textContent.includes('page.html') && t.click()); return 1`);

  // --shot: a picture of the page as it looks live, without the window
  const png = join(tmp, 'shot.png');
  const sh = spawnSync(venv, [doc, '--shot', png, '--size', '900x700'], { env: env('t1'), encoding: 'utf8', timeout: 120000 });
  const head = existsSync(png) ? readFileSync(png).subarray(0, 24) : Buffer.alloc(0);
  check('--shot saves a PNG of the size asked for', sh.status === 0 && head.subarray(1, 4).toString() === 'PNG'
    && head.readUInt32BE(16) === 900 && head.readUInt32BE(20) === 700, sh.stdout + sh.stderr);
  check('--shot opens no tab', (await (await fetch(base + '/api/tabs')).json()).tabs.length === 1);
  const noBrowser = /^just-doc: no browser to take a screenshot here; check the layout in the HTML\n$/;
  let ns = spawnSync(venv, [doc, '--shot', join(tmp, 'x.png')], { env: { ...env('t1'), PATH: '/nonexistent' }, encoding: 'utf8' });
  check('--shot without a browser: status 1 and one clear line', ns.status === 1 && noBrowser.test(ns.stderr), ns.stderr);
  const fake = join(tmp, 'fakebin');
  mkdirSync(fake);
  writeFileSync(join(fake, 'chromium'), '#!/bin/sh\necho "no usable sandbox" >&2\nexit 1\n', { mode: 0o755 });
  ns = spawnSync(venv, [doc, '--shot', join(tmp, 'x.png')], { env: { ...env('t1'), PATH: fake }, encoding: 'utf8' });
  check('--shot with a browser that cannot start: the same line', ns.status === 1 && noBrowser.test(ns.stderr), ns.stderr);

  // 7. --hc-terminal: the last document opened or changed from a terminal
  run('t1', docB, '--live');
  run('t2', docC, '--live');
  const ids = Object.fromEntries((await (await fetch(base + '/api/tabs')).json()).tabs.map(t => [t.name, t.id]));
  check('three live tabs', Object.keys(ids).length === 3, JSON.stringify(ids));
  // the bar shows the tabs of the shown group (t2: c.html) and one row in the list for the other (t1: two tabs)
  check('the shown live tab has the live mark, the others of its group a dot', !!(await until(() => top(
    `const t = [...document.querySelectorAll('.tab')]; return t.filter(x => x.classList.contains('on')).length === 1 && t.filter(x => x.classList.contains('on')).every(x => x.querySelector('i')?.textContent === 'live')
      && t.filter(x => !x.classList.contains('on')).every(x => x.querySelector('i.dot') && !x.querySelector('i').textContent)
      && !!document.querySelector('.grow.cur') && document.querySelector('.grow:not(.cur) .n')?.textContent === '2'`), 5000)));
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
  spawnSync(venv, [rdoc, '--live', '--no-window', '--port', String(RP)],
    { env: { ...env('t5'), WAYLAND_DISPLAY: '', DISPLAY: '' }, stdio: 'ignore', timeout: 60000 });
  await until(async () => (await fetch(`http://127.0.0.1:${RP}/api/tabs`)).ok, 15000);
  const pr = spawnSync(venv, ['--hc-terminal', 't5', '--print', '--port', String(RP)], { encoding: 'utf8' });
  const printed = (() => { try { return JSON.parse(pr.stdout); } catch { return null; } })();
  check('--print gives the port and address of the page', pr.status === 0 && printed?.port === RP && printed?.live
    && printed?.url === `/live/${printed?.id}/remote.html`, pr.stdout + pr.stderr);
  const none = spawnSync(venv, ['--hc-terminal', 't77', '--print', '--port', String(RP)], { encoding: 'utf8' });
  check('--print for an unknown terminal fails cleanly', none.status === 1 && !none.stdout, none.stdout + none.stderr);
  // --list and --doc: every page of a terminal, newest first, and one of them by id
  const ls = spawnSync(venv, ['--hc-terminal', 't1', '--list', '--port', String(SP)], { encoding: 'utf8' });
  const listed = ls.stdout.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  check('--list prints the pages of the terminal, newest first',
    ls.status === 0 && listed.length === 2 && listed[0].name === 'page.html' && listed[1].name === 'b.html'
    && listed[0].time >= listed[1].time && listed.every(d => d.id && d.path && d.live === true && d.port === SP), ls.stdout + ls.stderr);
  const lsNone = spawnSync(venv, ['--hc-terminal', 't99', '--list', '--port', String(SP)], { encoding: 'utf8' });
  check('--list for an unknown terminal fails cleanly', lsNone.status === 1 && !lsNone.stdout, lsNone.stdout + lsNone.stderr);
  h = spawnSync(venv, ['--hc-terminal', 't1', '--doc', ids['b.html'], '--port', String(SP)],
    { env: { HOME: process.env.HOME, PATH: '/nonexistent', XDG_CACHE_HOME: join(tmp, 'cache') }, encoding: 'utf8' });
  check('--doc shows that page and not the latest', h.status === 0 && await focus() === ids['b.html'], h.stderr || h.stdout);
  h = spawnSync(venv, ['--hc-terminal', 't1', '--doc', ids['c.html'], '--port', String(SP)],
    { env: { HOME: process.env.HOME, PATH: '/nonexistent', XDG_CACHE_HOME: join(tmp, 'cache') }, encoding: 'utf8' });
  check('--doc of a page of another terminal fails cleanly', h.status === 1 && !h.stdout, h.stderr);
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
  // a comment on a remote page is kept on its machine (once the window has read its comments)
  check('the remote page is ready for comments', !!(await until(() => ev(`return !!d.getElementById('__jd_marks')`), 30000)));
  // a second try: the keys work once the page has loaded, which is slow through the test's forwarder
  let typed = false;
  for (let i = 0; i < 2 && !typed; i++) {
    await select('intro', 4, 9);
    await press('a');
    typed = await typeIn('remote note');
  }
  const why = await top(`return JSON.stringify([document.getElementById('toast').textContent, document.getElementById('side').innerText.slice(0, 200)])`);
  const rc = await until(() => { const r = spawnSync(venv, [rdoc, '--live', '--read', '--json'], { encoding: 'utf8' });
    return (parsed(r.stdout)?.comments || []).find(a => a.comment === 'remote note'); }, 8000);
  check('a comment on a remote page is saved there, with its anchor', rc?.anchor?.id === 'intro' && rc.text === 'quick' && rc.n === 1, `${typed} ${why} ${JSON.stringify(rc)}`);
  const rrp = spawnSync(venv, [rdoc, '--live', '--reply', '1', 'seen remotely', '--from', 'bot', '--port', String(RP)], { encoding: 'utf8' });
  check('a reply on the remote machine reaches the panel here', rrp.status === 0 && !!(await until(() => top(
    `return document.querySelector('.it[data-id="${rc?.id}"] .st')?.textContent === 'new reply'`), 10000)), rrp.stdout + rrp.stderr);
  check('the remote comment is marked in the page', !!(await until(() => ev(`return d.querySelectorAll('#__jd_marks [data-id]').length === 1`), 3000)));
  // answers of a remote page are kept on its machine and read there
  await ev(`d.querySelector('input[name=note]').value = 'from afar'; d.body.dispatchEvent(new w.KeyboardEvent('keydown', {key: 'Enter', ctrlKey: true, bubbles: true})); return 1`);
  const far = await until(() => { const r = spawnSync(venv, [rdoc, '--live', '--read', '--json'], { encoding: 'utf8' });
    return r.status === 0 && parsed(r.stdout)?.answers?.answers?.note === 'from afar' && parsed(r.stdout); }, 8000);
  check('Ctrl+Enter in a remote page saves its answers there', far?.answers?.answers?.note === 'from afar', JSON.stringify(far));
  // a PDF of "another machine": shown by the viewer here, its requests go on there, Ctrl+Enter ends its --wait
  const rpdf = join(site, 'remote.pdf');
  spawnSync(join(repo, '.venv', 'bin', 'python'), ['-c', 'import sys; from pypdf import PdfWriter; w = PdfWriter(); w.add_blank_page(300, 200); w.write(sys.argv[1])', rpdf]);
  const pdfWaiter = spawn(venv, [rpdf, '--wait', '--json', '--no-window', '--port', String(RP)],
    { env: { ...env('t6'), WAYLAND_DISPLAY: '', DISPLAY: '' }, stdio: ['ignore', 'pipe', 'ignore'] });
  procs.push(pdfWaiter);
  let waited = ''; pdfWaiter.stdout.on('data', c => waited += c);
  let ended = false; pdfWaiter.on('exit', () => ended = true);
  await until(async () => spawnSync(venv, ['--hc-terminal', 't6', '--print', '--port', String(RP)], { encoding: 'utf8' }).status === 0, 15000);
  h = hcm('t6', 'fake');
  check('--hc-machine shows a PDF of the other machine', h.status === 0, h.stderr || h.stdout);
  const ptab = (await (await fetch(base + '/api/tabs')).json()).tabs.find(t => t.remote === 'fake' && t.name === 'fake: remote.pdf');
  check('the remote PDF tab is not live and has no src', !!ptab && ptab.live === false && !ptab.src, JSON.stringify(ptab));
  const pq = `?d=${ptab?.id}`;
  r = await fetch(base + '/doc' + pq);
  check('/doc of the remote PDF comes from the other machine', r.status === 200 && (await r.text()).startsWith('%PDF'), String(r.status));
  r = await fetch(base + '/api/info' + pq);
  check('/api/info of the remote PDF names it', (await r.json()).name === 'remote.pdf');
  r = await fetch(base + '/api/annotations' + pq, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ annots: [{ id: 'a1', page: 1, text: 'x', comment: 'pdf note', rects: [[10, 10, 50, 20]], color: 'yellow', ts: 1 }] }) });
  check('a comment on the remote PDF is accepted', r.status === 200, String(r.status));
  const pc = spawnSync(venv, [rpdf, '--read', '--json', '--port', String(RP)], { encoding: 'utf8' });
  check('the comment on the remote PDF is saved on its machine', pc.stdout.includes('"comment": "pdf note"'), pc.stdout + pc.stderr);
  r = await fetch(base + '/api/done' + pq, { method: 'POST' });
  check('Ctrl+Enter on the remote PDF reaches its --wait', r.status === 200 && !!(await until(async () => ended, 10000)) && /pdf note/.test(waited), `${r.status} ${waited}`);
  check('the remote PDF opens in the viewer here', !!(await top(`const f=[...document.querySelectorAll('iframe')].find(f=>f.src.includes('view?d=${ptab?.id}')); return !!f`)));
  h = hcm('t77', 'fake');
  check('--hc-machine for an unknown terminal fails cleanly', h.status === 1 && /no open document/.test(h.stderr) && !h.stdout, `${h.status} ${h.stderr}`);

  // 8. <jd-scene>: a model of two parts (STL and STEP), a comment pinned to a point of its surface
  copyFileSync(join(repo, 'tests', 'data', 'part.stl'), join(site, 'housing.stl'));
  copyFileSync(join(repo, 'tests', 'data', 'box.step'), join(site, 'cover.step'));
  const sceneDoc = join(site, 'scene.html');
  writeFileSync(sceneDoc, `<!doctype html><meta charset="utf-8"><title>scene</title>
<link rel="stylesheet" href="/_lib/page.css"><script type="module" src="/_lib/three/scene.js"></script>
<h1>Scene</h1>
<jd-scene id="bracket"><script type="application/json">{"parts": [{"src": "housing.stl", "name": "housing"},
  {"src": "cover.step", "name": "cover", "colour": "#e15759", "opacity": 0.7}], "units": "mm", "height": 420}</script></jd-scene>
<p id="after">after the model</p>`);
  utimesSync(sceneDoc, new Date(Date.now() - 60000), new Date(Date.now() - 60000));
  run('t7', sceneDoc, '--live');
  const S = e => ev(`const sc = d.querySelector('jd-scene'); if (!sc) return null; ${e}`);
  const here = await until(() => S(`return sc.dataset.state`), 20000);
  check('jd-scene is defined and builds its view', here === 'loading' || here === 'ready', String(here));
  const state = await until(() => S(`return sc.dataset.state === 'ready' || sc.dataset.state === 'error' ? sc.dataset.state : null`), 40000);
  const infos = await S(`return sc.partInfo()`);
  check('an STL part and a STEP part load (parallel, in the list)', state === 'ready' && infos?.length === 2 && infos.every(p => p.status === 'ready')
    && infos[0].name === 'housing' && infos[1].name === 'cover' && infos[1].colour === '#e15759', JSON.stringify([state, infos]));
  check('the view buttons and the section are above the view, the part list is a column inside it', !!(await S(`const k = [...sc.children].filter(c => c.localName !== 'script').map(c => c.className); return k[0].includes('controls') && k[1].includes('view') && sc.querySelector('.view > .jd-parts') && sc.querySelectorAll('.jd-row').length === 2`)));
  check('the canvas is drawn (not empty)', !!(await S(`const c = sc.querySelector('canvas'), g = document.createElement('canvas'); g.width = c.width; g.height = c.height;
    const x = g.getContext('2d'); x.drawImage(c, 0, 0); const px = x.getImageData(0, 0, g.width, g.height).data; const first = px.slice(0, 4).join();
    for (let i = 0; i < px.length; i += 4) if (px.slice(i, i + 4).join() !== first) return true; return false`)));
  // the point under the pointer: the middle of the view
  const mid = await S(`const r = sc.querySelector('canvas').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]`);
  await ev(`w.dispatchEvent(new w.MouseEvent('mousemove', {clientX: ${mid[0]}, clientY: ${mid[1]}, bubbles: true})); return 1`);
  const picked = await S(`return sc.pick(${mid[0]}, ${mid[1]})`);
  check('pick gives part, point and normal in model units', !!picked && ['housing', 'cover'].includes(picked.part) && picked.point.length === 3
    && picked.normal.length === 3 && picked.units === 'mm', JSON.stringify(picked));
  await press('a');
  await typeIn('what is this edge?');
  const sceneFile = join(site, 'scene.live.comments.json');
  const sc1 = await until(() => stored(sceneFile).find(a => a.comment === 'what is this edge?'), 8000);
  check('a over the model saves a comment with the point of the surface', sc1?.anchor?.id === 'bracket' && sc1.anchor.scene?.point?.length === 3
    && sc1.anchor.scene.normal?.length === 3 && ['housing', 'cover'].includes(sc1.anchor.scene.part) && sc1.anchor.scene.units === 'mm', JSON.stringify(sc1));
  const rect = await until(() => S(`return sc.markRect('${sc1?.id}')`), 5000);
  check('the model draws its marker', !!rect, JSON.stringify(rect));
  check('the card stands beside the marker, and no outline is drawn round the whole view', !!(await ev(`const c = d.querySelector('#__jd_card .card'); if (!c) return false;
    const r = c.getBoundingClientRect(), m = ${JSON.stringify(rect)}; return d.querySelectorAll('#__jd_hl .m').length === 0 && Math.abs(r.top - m.top) < 400 && (r.left > m.left + m.width || r.top > m.top + m.height || r.bottom < m.top)`)));
  await shot('6-scene-comment.png');
  // a click on the marker selects the comment; one on an empty place does not
  await press('Escape');
  check('Escape closes the card', !(await ev(`return !!d.querySelector('#__jd_card .card')`)));
  const click = (x, y) => S(`const c = sc.querySelector('canvas'); for (const t of ['pointerdown', 'pointerup']) c.dispatchEvent(new w.PointerEvent(t, {clientX: ${x}, clientY: ${y}, bubbles: true, pointerId: 1})); return 1`);
  await click(rect.left + rect.width / 2, rect.top + rect.height / 2);
  check('a click on the marker selects its comment', !!(await until(() => top(`return document.querySelector('.it.on')?.dataset.id === '${sc1?.id}'`), 3000)));
  // the list row names the part and the point; --read prints them
  check('the list row names the part and the point', await top(`return /part: (housing|cover) · at \\(/.test(document.querySelector('.it.on .l1').textContent)`));
  const rs = run('t7', sceneDoc, '--live', '--read');
  check('--live --read prints the part and the point', rs.status === 0 && /\[1\] #bracket  part: (housing|cover)  at \([-\d., e]+\) mm/.test(rs.stdout), rs.stdout + rs.stderr);
  // a selected comment turns the view only when its point is out of sight
  const cam = () => S(`return sc.camera.position.toArray().map(v => Math.round(v * 100) / 100).join()`);
  const camBefore = await cam();
  await top(`document.querySelector('.it[data-id="${sc1?.id}"]').click(); return 1`);
  check('selecting a comment whose point is seen does not move the view', (await cam()) === camBefore);
  await S(`const n = sc._marks[0].normal, p = sc.controls.target.clone();
    sc.camera.position.set(p.x - n[0] * 200, p.y - n[1] * 200, p.z - n[2] * 200); sc.controls.update(); sc.draw(); return 1`);
  const hidden = await S(`return !sc.markRect(sc._marks[0].id) || sc._hidden(sc._marks[0].point)`);
  await top(`document.querySelector('.it[data-id="${sc1?.id}"]').click(); return 1`);
  await sleep(300);
  check('a point on the far side is brought into view', !!hidden && await S(`const m = sc._marks[0], r = sc.markRect(m.id); return !!r && !sc._hidden(m.point)`));
  await shot('7-scene-turned.png');
  // the section plane cuts the model; a marker on the cut-away side is not drawn
  await S(`sc.querySelector('[aria-label="Section plane X"]').click(); return 1`);
  await sleep(400);
  check('a section plane shows its slider and value', await S(`return !sc.querySelector('.jd-sec').hidden && /^X = /.test(sc.querySelector('.jd-val').textContent) && sc.renderer.clippingPlanes.length === 1`));
  await shot('8-scene-section.png');
  await S(`sc.querySelector('[aria-label="Section off"]').click(); return 1`);
  // the markers come back after the page is loaded again
  writeFileSync(sceneDoc, readFileSync(sceneDoc, 'utf8').replace('after the model', 'after the model, changed'));
  utimesSync(sceneDoc, new Date(Date.now() - 2000), new Date(Date.now() - 2000));
  check('after a reload the marker is drawn again', !!(await until(() => S(`return d.getElementById('after').textContent.includes('changed') && sc.dataset.state === 'ready' && sc._marks.length === 1 && !!sc.markRect('${sc1?.id}')`), 30000)));

  check('no uncaught exceptions', excs.length === 0, excs[0]);
} catch (e) {
  check('test run', false, e.stack || String(e));
} finally {
  try { ws?.close(); } catch {}
  for (const p of procs.reverse()) { try { p.kill('SIGTERM'); } catch {} }
  // just-doc runs in the background, not as a child of this test
  for (const p of [SP, SP + 1]) { try { await fetch(`http://127.0.0.1:${p}/api/quit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch {} }
  await sleep(500);
  for (const p of procs) { try { if (p.exitCode === null) p.kill('SIGKILL'); } catch {} }
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
