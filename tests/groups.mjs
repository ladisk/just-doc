// Test of the groups of tabs (one group per hc terminal) in headless Chromium. See tests/README.md.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const SP = +(process.env.GROUPS_PORT || 8981), CP = +(process.env.GROUPS_CDP_PORT || 9381), RP = SP + 1;
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

const tmp = mkdtempSync(join(tmpdir(), 'just-doc-groups-'));
const noHc = join(tmp, 'nohc');
mkdirSync(noHc);
writeFileSync(join(noHc, 'hc'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
const procs = [];
let ws;
try {
  const page = t => `<!doctype html><meta charset="utf-8"><title>${t}</title><link rel="stylesheet" href="/_lib/page.css"><h1>${t}</h1><p>Text of ${t}.</p>`;
  const make = (rel, text) => { const p = join(tmp, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); return p; };
  mkdirSync(join(tmp, 'kolektor-etra-2026', '.git'), { recursive: true });
  const a = make('kolektor-etra-2026/report/a.html', page('a')), b = make('kolektor-etra-2026/b.html', page('b'));
  const x = make('knauf/x.html', page('x')), y = make('knauf/y.html', page('y'));
  const z = join(tmp, 'loose', 'z.pdf');
  mkdirSync(dirname(z), { recursive: true });
  const py = join(repo, '.venv', 'bin', 'python'), jdbin = join(repo, '.venv', 'bin', 'just-doc');
  spawnSync(py, ['-c', 'import sys; from pypdf import PdfWriter; w = PdfWriter(); w.add_blank_page(300, 200); w.write(sys.argv[1])', z]);
  // a second knauf folder elsewhere: the same label, so the terminal id is added
  const k2 = make('work/knauf/k.html', page('k'));
  // the "other machine": a second just-doc, a project with a .git and a page in a subfolder
  mkdirSync(join(tmp, 'thesis', '.git'), { recursive: true });
  const r = make('thesis/chapters/r.html', page('r'));

  const conf = join(tmp, 'config');
  mkdirSync(join(conf, 'just-doc'), { recursive: true });
  writeFileSync(join(conf, 'just-doc', 'config.json'), JSON.stringify({
    ssh: `python3 ${join(repo, 'tests', 'fake-ssh.py')}`,
    machines: { work2: { target: 'fakehost', 'just-doc': `${jdbin} --port ${RP}` } } }));
  const env = (term, extra = {}) => ({ ...process.env, PATH: `${noHc}:${process.env.PATH}`, XDG_CACHE_HOME: join(tmp, 'cache'),
    XDG_CONFIG_HOME: conf, HC_TERMINAL_ID: term, WAYLAND_DISPLAY: '', DISPLAY: '', ...extra });
  const run = (term, file, ...args) => spawnSync(jdbin, [file, ...args, '--port', String(SP), '--no-window'], { env: env(term), encoding: 'utf8', timeout: 60000 });
  const base = `http://127.0.0.1:${SP}`;
  const api = async () => (await fetch(base + '/api/tabs')).json();
  try { await fetch(base + '/api/tabs'); console.log(`port ${SP} is in use; set GROUPS_PORT`); process.exit(1); } catch {}

  procs.push(spawn(jdbin, [a, '--live', '--port', String(SP), '--no-window'], { env: env('t1', { JUST_DOC_BUILD: 'old' }), stdio: 'ignore' }));
  if (!(await until(async () => (await api()).tabs.length === 1, 30000))) throw new Error('server did not start');
  // 1. one group: no chip
  // 2. the window in headless Chromium
  const bin = ['chromium', 'google-chrome-stable', 'google-chrome', 'brave'].find(has);
  if (!bin) throw new Error('no chromium/chrome/brave found');
  procs.push(spawn(bin, ['--headless=new', '--disable-gpu', `--user-data-dir=${join(tmp, 'chr')}`,
    `--remote-debugging-port=${CP}`, '--window-size=1200,700', 'about:blank'], { stdio: 'ignore' }));
  const target = await until(async () => (await (await fetch(`http://127.0.0.1:${CP}/json`)).json()).find(t => t.type === 'page'), 15000);
  ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise(res => ws.onopen = res);
  let id = 0; const waiting = {}; const excs = [];
  ws.onmessage = m => {
    const d = JSON.parse(m.data);
    if (d.id && waiting[d.id]) waiting[d.id](d.result || d);
    if (d.method === 'Runtime.exceptionThrown') excs.push(JSON.stringify(d.params.exceptionDetails).slice(0, 300));
  };
  const cmd = (method, params = {}) => new Promise(res => { waiting[++id] = res; ws.send(JSON.stringify({ id, method, params })); });
  await cmd('Runtime.enable'); await cmd('Page.enable');
  await cmd('Page.navigate', { url: base + '/' });
  const top = async e => (await cmd('Runtime.evaluate', { expression: `(()=>{${e}})()`, returnByValue: true, awaitPromise: true })).result?.value;
  const shot = async name => {
    if (!process.env.SHOTS) return;
    mkdirSync(process.env.SHOTS, { recursive: true });
    const g = await cmd('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(process.env.SHOTS, name), Buffer.from(g.data, 'base64'));
  };
  // the tab bar as text: chips and tabs
  const bar = () => top(`return [...document.querySelectorAll('#tabs > div')].filter(e => e.id !== 'keys').map(e => (e.classList.contains('chip') ? '[' : '') + [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').replace(/ ▾$/, '').trim() + (e.querySelector('small') ? e.querySelector('small').textContent : '') + (e.classList.contains('chip') ? ']' : '')).join('|')`);
  const shown = () => top(`return [...(document.querySelector('.tab.on')?.childNodes || [])].filter(n => n.nodeType === 3).map(n => n.textContent).join('')`);
  // a key in the shown frame, as the viewer or the live page gets it
  const key = (k, mods = {}) => top(`const f = document.querySelector('iframe.on'); const w = f.contentWindow, d = w.document;
    (f.contentDocument.querySelector('#pdfroot, #viewer') ? d : d.body).dispatchEvent(new w.KeyboardEvent('keydown', {key: ${JSON.stringify(k)}, bubbles: true, ...${JSON.stringify(mods)}})); return 1`);
  const groups = async () => (await api()).groups;
  const label = async gid => (await groups()).find(g => g.id === gid)?.label;

  check('one group: the bar has no chip', !!(await until(async () => (await bar()) === 'a.html', 10000)), await bar());

  // 3. two terminals, two folders
  run('t1', b, '--live'); run('t2', x, '--live'); run('t2', y, '--live');
  const st = await api();
  check('two groups, t1 and t2', st.groups.map(g => g.id).join() === 't1,t2' && st.groups[0].count === 2 && st.groups[1].count === 2, JSON.stringify(st.groups));
  check('label of t1: the repository folder, not the subfolder of a.html', await label('t1') === 'kolektor-etra-2026', await label('t1'));
  check('label of t2: the folder of its pages', await label('t2') === 'knauf', await label('t2'));
  check('every tab names its group, the old fields stay', st.tabs.every(t => t.group && t.id && t.name && t.path && 'live' in t && 'rev' in t), JSON.stringify(st.tabs[0]));
  check('the bar: chip of the shown group, its tabs, one chip for the other',
    !!(await until(async () => (await bar()) === '[knauf]|x.html|y.html|[kolektor-etra-2026 ▸ 2]', 8000)), await bar());
  check('the new document is shown (group t2, y.html)', await shown() === 'y.html' || (await shown())?.includes('y.html'), await shown());

  // 4. keys: H / L stay in the group and wrap
  await key('H'); await sleep(300);
  check('H goes to x.html', (await shown())?.includes('x.html'), await shown());
  await key('H'); await sleep(300);
  check('H wraps within the group, to y.html (not to the other group)', (await shown())?.includes('y.html'), await shown());
  await key('L'); await sleep(300);
  check('L wraps to x.html', (await shown())?.includes('x.html'));
  await key('ArrowRight', { altKey: true }); await sleep(300);
  check('Alt+Right stays in the group', (await shown())?.includes('y.html'));
  // Alt+Down: the other group, its tab shown last
  await key('ArrowDown', { altKey: true }); await sleep(400);
  check('Alt+Down shows the group t1 and its first tab', (await bar()).startsWith('[kolektor-etra-2026') && (await shown())?.includes('a.html'), await bar() + ' ' + await shown());
  await key('L'); await sleep(300);
  await key('ArrowDown', { altKey: true }); await sleep(400);
  check('Alt+Down wraps to t2, with y.html (shown last)', (await bar()).startsWith('[knauf]') && (await shown())?.includes('y.html'), await bar());
  await key('ArrowUp', { altKey: true }); await sleep(400);
  check('Alt+Up goes back to t1, with b.html (shown last)', (await bar()).startsWith('[kolektor-etra-2026]') && (await shown())?.includes('b.html'), await bar());
  // a click on the chip
  await top(`document.querySelector('.chip.other').click(); return 1`); await sleep(400);
  check('a click on the chip of a group shows it', (await bar()).startsWith('[knauf]'), await bar());

  // 5. a PDF in the group "other": Alt+Down works while the PDF viewer has the focus
  run('', z);
  const pdf = (await api()).tabs.find(t => t.name === 'z.pdf');
  check('a document without terminal is in the group "other"', pdf?.group === 'other' && await label('other') === 'other', JSON.stringify(pdf));
  check('the viewer of the PDF is shown', !!(await until(() => top(`const f = document.querySelector('iframe.on'); return f?.src.includes('view?d=${pdf?.id}') && !!f.contentDocument?.getElementById('foot')`), 15000)));
  await sleep(500);
  await key('ArrowDown', { altKey: true }); await sleep(400);
  check('Alt+Down in a PDF tab goes to the next group (wraps to t1)', (await bar()).startsWith('[kolektor-etra-2026]'), await bar());
  await key('ArrowUp', { altKey: true }); await sleep(400);
  check('Alt+Up in a live tab goes back to "other"', (await bar()).startsWith('[other]') && !!(await top(`return document.querySelector('iframe.on').src.includes('view?d=${pdf?.id}')`)), await bar());
  await key('ArrowUp', { altKey: true }); await sleep(400);
  check('Alt+Up from a PDF tab goes to the previous group', (await bar()).startsWith('[knauf]'), await bar());
  await shot('groups-four.png');

  // 6. --hc-terminal activates the group
  const hc = term => spawnSync(jdbin, ['--hc-terminal', term, '--port', String(SP)],
    { env: { HOME: process.env.HOME, PATH: '/nonexistent', XDG_CACHE_HOME: join(tmp, 'cache') }, encoding: 'utf8' });
  let h = hc('t1');
  check('--hc-terminal t1 shows the group t1', h.status === 0 && !!(await until(async () => (await bar()).startsWith('[kolektor-etra-2026]'), 5000)), h.stderr);
  h = hc('t2');
  check('--hc-terminal t2 shows the group t2', h.status === 0 && !!(await until(async () => (await bar()).startsWith('[knauf]'), 5000)), h.stderr);
  run('t1', b, '--live');
  check('a new document from t1 shows its group with it active', !!(await until(async () => (await bar()).startsWith('[kolektor-etra-2026]') && (await shown())?.includes('b.html'), 5000)), await bar());

  // 7. closing the last tab of a group drops the group
  await fetch(`${base}/api/close?d=${pdf.id}`, { method: 'POST' });
  check('the group "other" is gone with its last tab', !!(await until(async () => (await groups()).map(g => g.id).join() === 't1,t2', 5000)), JSON.stringify(await groups()));

  // 8. the same label twice gets the terminal id
  run('t4', k2, '--live');
  const two = (await groups()).filter(g => g.id === 't2' || g.id === 't4').map(g => g.label).sort().join();
  check('two groups called knauf: the terminal id is added', two === 'knauf t2,knauf t4', two);
  await fetch(`${base}/api/close?d=${(await api()).tabs.find(t => t.name === 'k.html').id}`, { method: 'POST' });

  // 9. a group of another machine: the terminal and the project folder come from there
  procs.push(spawn(jdbin, [r, '--live', '--no-window', '--port', String(RP)], { env: env('t6'), stdio: 'ignore' }));
  await until(async () => (await fetch(`http://127.0.0.1:${RP}/api/tabs`)).ok, 15000);
  h = spawnSync(jdbin, ['--hc-terminal', 't6', '--hc-machine', 'work2', '--port', String(SP)],
    { env: { HOME: process.env.HOME, PATH: '/usr/bin:/bin', XDG_CONFIG_HOME: conf, XDG_CACHE_HOME: join(tmp, 'cache') }, encoding: 'utf8', timeout: 60000 });
  check('--hc-machine opens the remote page', h.status === 0, h.stderr || h.stdout);
  check('the remote group is "work2: thesis" (its repository folder)', await label('work2:t6') === 'work2: thesis', JSON.stringify(await groups()));
  check('the remote group is the shown one', !!(await until(async () => (await bar()).startsWith('[work2: thesis]|work2: r.html'), 5000)), await bar());
  await sleep(1500);
  await shot('groups-three.png');

  // 10. a restart keeps the groups
  const before = JSON.stringify((await groups()).map(g => [g.id, g.label, g.count]));
  const rs = spawnSync(jdbin, [b, '--live', '--port', String(SP), '--no-window'], { env: env('t1'), encoding: 'utf8', timeout: 60000 });
  const after = await until(async () => { const g = JSON.stringify((await groups()).map(g => [g.id, g.label, g.count])); return g === before && g; }, 20000);
  check('after a restart (update) the groups are the same', !!after, `${rs.stdout}${rs.stderr} ${before} ${JSON.stringify(await groups())}`);
  check('the window shows them again', !!(await until(async () => (await bar()).includes('[knauf ▸ 2]') && (await bar()).includes('[work2: thesis ▸ 1]'), 15000)), await bar());
  check('no uncaught exceptions', excs.length === 0, excs[0]);
} catch (e) {
  check('test run', false, e.stack || String(e));
} finally {
  try { ws?.close(); } catch {}
  for (const p of procs.reverse()) { try { p.kill('SIGTERM'); } catch {} }
  // the just-doc of the restart is not a child of this test
  for (const p of [SP, RP]) { try { await fetch(`http://127.0.0.1:${p}/api/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch {} }
  await sleep(500);
  for (const p of procs) { try { if (p.exitCode === null) p.kill('SIGKILL'); } catch {} }
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
