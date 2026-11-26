// Test of the update of a running just-doc of another version. See tests/README.md.
//
// A just-doc that runs another version (JUST_DOC_BUILD set to something else, or the real code of an
// older commit) is restarted by the next command as this version, with its tabs, terminals, comments
// and a Ctrl+Enter not taken yet; the window stays and loads itself again. With a --wait waiting on
// it, it is left alone.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const P = +(process.env.UPDATE_PORT || 8964), CP = +(process.env.UPDATE_CDP_PORT || 9364);
const OLD_COMMIT = 'da9d93f';   // before the version check: no features, no /api/session
const sleep = ms => new Promise(r => setTimeout(r, ms));
const has = c => spawnSync('sh', ['-c', `command -v ${c}`]).status === 0;
const until = async (fn, ms = 10000, step = 150) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch {} await sleep(step); }
  return null;
};
let failed = 0;
const check = (name, ok, info = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(info).slice(0, 400)}`);
  if (!ok) failed++;
};

const tmp = mkdtempSync(join(tmpdir(), 'just-doc-update-'));
// a do-nothing hc on the PATH, so that the hc labels of the test terminals never reach a real hc
const noHc = join(tmp, 'nohc');
mkdirSync(noHc);
writeFileSync(join(noHc, 'hc'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
const procs = [];
let ws;
try {
  const py = join(repo, '.venv', 'bin', 'python');
  const site = join(tmp, 'site');
  mkdirSync(site);
  const page = v => `<!doctype html><meta charset="utf-8"><title>${v}</title><h1 id="v">${v}</h1>`;
  for (const n of ['a', 'c', 'd', 'e']) writeFileSync(join(site, `${n}.html`), page(n));
  const pdf = join(site, 'b.pdf');
  spawnSync(py, ['-c', `from pypdf import PdfWriter; w = PdfWriter(); w.add_blank_page(200, 200); w.write(${JSON.stringify(pdf)})`]);
  // no display: no window is opened by just-doc itself
  const env = (term, build) => ({ ...process.env, PATH: `${noHc}:${process.env.PATH}`, XDG_CACHE_HOME: join(tmp, 'cache'), XDG_CONFIG_HOME: join(tmp, 'config'),
    HC_TERMINAL_ID: term, JUST_DOC_BUILD: build || '', WAYLAND_DISPLAY: '', DISPLAY: '' });
  const jd = (port, term, build, ...a) => spawnSync(py, ['-c', 'import just_doc; just_doc.main()', ...a, '--port', String(port), '--no-window'],
    { cwd: repo, env: env(term, build), encoding: 'utf8', timeout: 60000 });
  const bg = (port, term, build, ...a) => {
    const p = spawn(py, ['-c', 'import just_doc; just_doc.main()', ...a, '--port', String(port), '--no-window'],
      { cwd: repo, env: env(term, build), stdio: ['ignore', 'pipe', 'pipe'] });
    p.out = ''; p.stdout.on('data', c => p.out += c); p.stderr.on('data', c => p.out += c);
    procs.push(p);
    return p;
  };
  const get = async (port, path) => (await fetch(`http://127.0.0.1:${port}${path}`)).json();
  const post = (port, path, body) => fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  for (const port of [P, P + 1, P + 2]) {
    try { await fetch(`http://127.0.0.1:${port}/api/tabs`); console.log(`port ${port} is in use; set UPDATE_PORT`); process.exit(1); } catch {}
  }

  // 1. a just-doc of "another version" with a live page (terminal t1) and a PDF (terminal t2)
  bg(P, 't1', 'old-build', join(site, 'a.html'), '--live');
  const first = await until(() => get(P, '/api/tabs'), 15000);
  check('a just-doc of another version runs', first?.version === 'old-build', JSON.stringify(first));
  let r = jd(P, 't2', 'old-build', pdf);
  const old = await get(P, '/api/tabs');
  const [ta, tb] = old.tabs;
  check('it has two tabs', old.tabs.length === 2 && ta.live && !tb.live, r.stdout + r.stderr);
  // a comment and a Ctrl+Enter (answers) that no --wait has taken yet
  await post(P, `/api/annotations?d=${ta.id}`, { annots: [{ id: 'k1', kind: 'text', text: 'a', comment: 'keep me',
    created: new Date().toISOString(), replies: [] }] });
  await post(P, `/api/answers?d=${ta.id}`, { answers: { pick: 'B' } });
  const oldPid = spawnSync('sh', ['-c', `ss -ltnpH 'sport = :${P}' | grep -o 'pid=[0-9]*'`], { encoding: 'utf8' }).stdout.trim();

  // 2. its window, in headless Chromium
  const bin = ['chromium', 'google-chrome-stable', 'google-chrome', 'brave'].find(has);
  if (!bin) throw new Error('no chromium/chrome/brave found');
  procs.push(spawn(bin, ['--headless=new', '--disable-gpu', `--user-data-dir=${join(tmp, 'chr')}`,
    `--remote-debugging-port=${CP}`, '--window-size=1000,700', 'about:blank'], { stdio: 'ignore' }));
  const target = await until(async () => (await (await fetch(`http://127.0.0.1:${CP}/json`)).json()).find(x => x.type === 'page'), 15000);
  if (!target) throw new Error('chromium did not start');
  ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
  let id = 0; const waiting = {};
  ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && waiting[d.id]) waiting[d.id](d.result || d); };
  const cmd = (method, params = {}) => new Promise(r => { waiting[++id] = r; ws.send(JSON.stringify({ id, method, params })); });
  await cmd('Runtime.enable'); await cmd('Page.enable');
  await cmd('Page.navigate', { url: `http://127.0.0.1:${P}/` });
  const top = async e => (await cmd('Runtime.evaluate', { expression: `(()=>{${e}})()`, returnByValue: true })).result?.value;
  check('the window shows both tabs', !!(await until(() => top(`const n = () => document.querySelectorAll('.tab').length + [...document.querySelectorAll('.chip.other small')].reduce((s, e) => s + +e.textContent.replace(/[^0-9]/g, ''), 0); return n() === 2`), 10000)));
  await top(`window.marker = 1; return 1`);

  // 3. a command of this version updates it
  r = jd(P, 't3', '', join(site, 'c.html'), '--live');
  check('the command says it updated just-doc', r.status === 0 && /updated the running just-doc .*\(2 tab\(s\) kept\)/.test(r.stderr), r.stdout + r.stderr);
  const now = await get(P, '/api/tabs');
  const newPid = spawnSync('sh', ['-c', `ss -ltnpH 'sport = :${P}' | grep -o 'pid=[0-9]*'`], { encoding: 'utf8' }).stdout.trim();
  check('a new just-doc of this version runs on the same port', now.version !== 'old-build' && newPid && newPid !== oldPid, `${now.version} ${oldPid} ${newPid}`);
  check('the tabs are kept, with the same ids, and the new document added',
    now.tabs.map(t => t.id).join() === [ta.id, tb.id, now.tabs[2]?.id].join() && now.tabs[2]?.name === 'c.html', JSON.stringify(now.tabs));
  const latest = await get(P, '/api/latest?t=t1');
  check('the terminal of each tab is kept', latest?.name === 'a.html' && (await get(P, '/api/latest?t=t2'))?.name === 'b.pdf', JSON.stringify(latest));
  check('the comment is still there', (await get(P, `/api/annotations?d=${ta.id}`)).annots?.[0]?.comment === 'keep me');
  check('the Ctrl+Enter not taken yet is kept', now.tabs[0].pending === true);
  r = jd(P, 't1', '', join(site, 'a.html'), '--live', '--wait', '--json', '--timeout', '10');
  let got = null; try { got = JSON.parse(r.stdout.slice(r.stdout.indexOf('{'))); } catch {}
  check('a --wait gets that Ctrl+Enter at once', r.status === 0 && got?.answers?.answers?.pick === 'B'
    && got.comments?.[0]?.comment === 'keep me', r.stdout + r.stderr);
  check('the window stays and loads itself again', !!(await until(() => top(
    `const n = () => document.querySelectorAll('.tab').length + [...document.querySelectorAll('.chip.other small')].reduce((s, e) => s + +e.textContent.replace(/[^0-9]/g, ''), 0); return !window.marker && n() === 3`), 15000)));

  // 4. with a --wait waiting on it, another version is left alone
  bg(P + 1, 't1', 'old-build', join(site, 'd.html'), '--live');
  await until(() => get(P + 1, '/api/tabs'), 15000);
  const waiter = bg(P + 1, 't1', 'old-build', join(site, 'd.html'), '--live', '--wait');
  await until(() => waiter.out.includes('waiting for Ctrl+Enter'), 15000);
  r = jd(P + 1, 't3', '', join(site, 'e.html'), '--live');
  const busy = await get(P + 1, '/api/tabs');
  check('with a --wait waiting: not restarted, one clear line, the request done',
    r.status === 0 && busy.version === 'old-build' && busy.tabs.length === 2
    && /note: the just-doc at .* runs another version; it is updated when the just-doc --wait that waits on it ends/.test(r.stderr),
    `${r.status} ${busy.version} ${r.stdout} ${r.stderr}`);
  check('the --wait still waits', waiter.exitCode === null);

  // 5. the real code of an older commit, which knows no features: its window closes, the tabs are kept
  const oldCode = join(tmp, 'old');
  mkdirSync(oldCode);
  const ar = spawnSync('sh', ['-c', `git -C ${JSON.stringify(repo)} archive ${OLD_COMMIT} just_doc | tar -x -C ${JSON.stringify(oldCode)}`]);
  if (ar.status) throw new Error('git archive failed');
  const legacy = spawn(py, ['-c', 'import just_doc; just_doc.main()', join(site, 'd.html'), '--live', '--port', String(P + 2), '--no-window'],
    { cwd: oldCode, env: { ...env('t4'), PYTHONPATH: oldCode }, stdio: 'ignore' });
  procs.push(legacy);
  const lst = await until(() => get(P + 2, '/api/tabs'), 15000);
  check('an older just-doc without a version check runs', !!lst && !lst.features, JSON.stringify(lst));
  r = jd(P + 2, 't3', '', pdf);
  const after = await get(P + 2, '/api/tabs');
  check('it is updated too, its tab kept', r.status === 0 && after.version === now.version && after.tabs.length === 2
    && after.tabs[0].live && after.tabs[0].name === 'd.html', r.stderr + JSON.stringify(after));
  check('the older just-doc has ended', !!(await until(() => legacy.exitCode !== null, 5000)));
} catch (e) {
  check('test run', false, e.stack || String(e));
} finally {
  try { ws?.close(); } catch {}
  // the updated just-docs were started by just-doc itself, not by this test
  for (const port of [P, P + 1, P + 2]) {
    try { await fetch(`http://127.0.0.1:${port}/api/quit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch {}
  }
  for (const p of procs.reverse()) { try { p.kill('SIGTERM'); } catch {} }
  await sleep(1000);
  for (const p of procs) { try { if (p.exitCode === null) p.kill('SIGKILL'); } catch {} }
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
