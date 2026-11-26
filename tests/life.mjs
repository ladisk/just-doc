// Test of the life of a just-doc: started in the background, kept alive, its tabs kept. See tests/README.md.
//
// A command with no just-doc running returns at once and leaves a just-doc of its own session;
// killing the process group of the command that started it, or a SIGHUP, leaves it running; its
// tabs are kept in the cache folder, and `just-doc` without a file starts it again with them; the
// log records start, restart, resume and exit.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const P = +(process.env.LIFE_PORT || 8984);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 10000, step = 100) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch {} await sleep(step); }
  return null;
};
let failed = 0;
const check = (name, ok, info = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(info).slice(0, 400)}`);
  if (!ok) failed++;
};

const tmp = mkdtempSync(join(tmpdir(), 'just-doc-life-'));
const noHc = join(tmp, 'nohc');
mkdirSync(noHc);
writeFileSync(join(noHc, 'hc'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
const procs = [];
try {
  const py = join(repo, '.venv', 'bin', 'python');
  const site = join(tmp, 'site'), cache = join(tmp, 'cache', 'just-doc');
  mkdirSync(site);
  for (const n of ['a', 'b', 'c', 'd']) writeFileSync(join(site, `${n}.html`), `<!doctype html><title>${n}</title>${n}`);
  const env = build => ({ ...process.env, PATH: `${noHc}:${process.env.PATH}`, XDG_CACHE_HOME: join(tmp, 'cache'),
    XDG_CONFIG_HOME: join(tmp, 'config'), HC_TERMINAL_ID: '', JUST_DOC_BUILD: build || '', WAYLAND_DISPLAY: '', DISPLAY: '' });
  const jd = (port, ...a) => spawnSync(py, ['-c', 'import just_doc; just_doc.main()', ...a, '--port', String(port), '--no-window'],
    { cwd: repo, env: env(), encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
  const tabs = async port => (await (await fetch(`http://127.0.0.1:${port}/api/tabs`)).json());
  const up = async port => { try { await tabs(port); return true; } catch { return false; } };
  const pidOf = port => +(spawnSync('sh', ['-c', `ss -ltnpH 'sport = :${port}' | grep -o 'pid=[0-9]*' | head -1`], { encoding: 'utf8' }).stdout.trim().slice(4));
  const sid = pid => +readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[3];
  const logOf = port => { try { return readFileSync(join(cache, `server-${port}.log`), 'utf8'); } catch { return ''; } };
  const quit = port => fetch(`http://127.0.0.1:${port}/api/quit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  for (const port of [P, P + 1, P + 2]) if (await up(port)) { console.log(`port ${port} is in use; set LIFE_PORT`); process.exit(1); }

  // 1. no just-doc running: the command returns at once and leaves one in the background
  const t0 = Date.now();
  let r = jd(P, join(site, 'a.html'), '--live');
  const took = Date.now() - t0;
  check('a command with no just-doc running returns promptly', r.status === 0 && took < 10000, `${r.status} ${took} ms ${r.stdout}${r.stderr}`);
  check('and the page is open in a just-doc that runs on', (await tabs(P)).tabs.map(t => t.name).join() === 'a.html', r.stdout);
  const pid = pidOf(P);
  check('that just-doc has a session of its own', pid > 0 && sid(pid) === pid, `${pid} ${pid && sid(pid)}`);
  check('the log records its start', /pid \d+ start: /.test(logOf(P)), logOf(P));

  // 2. a --wait that started the just-doc, killed with its whole process group
  const w = spawn(py, ['-c', 'import just_doc; just_doc.main()', join(site, 'b.html'), '--live', '--wait', '--port', String(P + 1), '--no-window'],
    { cwd: repo, env: env(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(w);
  w.out = ''; w.stdout.on('data', c => w.out += c); w.stderr.on('data', c => w.out += c);
  check('a --wait with no just-doc running waits', !!(await until(() => w.out.includes('waiting for Ctrl+Enter'), 15000)), w.out);
  process.kill(-w.pid, 'SIGKILL');
  await until(() => w.exitCode !== null || w.signalCode !== null, 3000);
  await sleep(1000);
  check('killing the process group of the command leaves the just-doc running',
    (await tabs(P + 1).catch(() => null))?.tabs?.[0]?.name === 'b.html');

  // 3. SIGHUP (the terminal of the command closed) is ignored and noted
  const pid1 = pidOf(P + 1);
  process.kill(pid1, 'SIGHUP');
  await sleep(500);
  check('a SIGHUP leaves it running', await up(P + 1));
  check('the log notes the SIGHUP', /SIGHUP ignored/.test(logOf(P + 1)), logOf(P + 1));

  // 4. SIGTERM ends it; the log says so; its tabs stay in the cache folder
  process.kill(pid1, 'SIGTERM');
  await until(async () => !(await up(P + 1)), 5000);
  check('SIGTERM ends it and the log says why', /exit: SIGTERM/.test(logOf(P + 1)), logOf(P + 1));
  const saved = JSON.parse(readFileSync(join(cache, `session-${P + 1}.json`), 'utf8'));
  check('its tabs are kept in session-<port>.json', saved.length === 1 && saved[0].path.endsWith('b.html'), JSON.stringify(saved));

  // 5. just-doc without a file and none running: started again with the kept tabs; a file that is gone is left out
  r = jd(P, join(site, 'c.html'), '--live');
  r = jd(P, join(site, 'd.html'), '--live');
  check('two more pages open', (await tabs(P)).tabs.length === 3, r.stdout + r.stderr);
  process.kill(pidOf(P), 'SIGKILL');
  await until(async () => !(await up(P)), 5000);
  unlinkSync(join(site, 'c.html'));
  r = jd(P);
  const back = await tabs(P).catch(() => null);
  check('just-doc without a file starts it again with the pages it had', r.status === 0
    && back?.tabs.map(t => t.name).join() === 'a.html,d.html', `${r.status} ${r.stdout} ${r.stderr} ${JSON.stringify(back?.tabs.map(t => t.name))}`);
  check('the focus is kept', back?.tabs.find(t => t.id === back.focus)?.name === 'd.html', JSON.stringify(back));
  check('the log records the restore and the page that was left out',
    /start: .*2 tab\(s\) restored, dropped: .*c\.html \(file gone\)/.test(logOf(P)), logOf(P));

  // 6. q y keeps the list; a later just-doc without a file brings it back
  await quit(P);
  await until(async () => !(await up(P)), 5000);
  check('q y: the log says so', /exit: quit from the window \(q y\), 2 tab\(s\)/.test(logOf(P)), logOf(P));
  r = jd(P);
  check('after q y, just-doc without a file brings the pages back', r.status === 0 && (await tabs(P)).tabs.length === 2, r.stdout + r.stderr);
  // closing every tab empties the list: nothing to start again
  for (const t of (await tabs(P)).tabs) await fetch(`http://127.0.0.1:${P}/api/close?d=${t.id}`, { method: 'POST' });
  await sleep(300);
  await quit(P);
  await until(async () => !(await up(P)), 5000);
  r = jd(P);
  check('with every tab closed: no just-doc started, status 1', r.status === 1 && !(await up(P)) && /no just-doc is running/.test(r.stderr),
    `${r.status} ${r.stderr}`);

  // 7. an update restart keeps the tabs in the cache folder and is in the log
  const old = spawnSync(py, ['-c', 'import just_doc; just_doc.main()', join(site, 'a.html'), '--live', '--port', String(P + 2), '--no-window'],
    { cwd: repo, env: env('old-build'), encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
  check('a just-doc of another version runs', old.status === 0 && (await tabs(P + 2)).version === 'old-build', old.stdout + old.stderr);
  r = jd(P + 2, join(site, 'd.html'), '--live');
  const upd = await tabs(P + 2);
  check('a command of this version updates it, with the tabs', upd.version !== 'old-build' && upd.tabs.length === 2, r.stderr);
  check('the log has its restart, the exit of the old one and the start of the new one',
    /exit: stopped by a just-doc of another version[\s\S]*restart: old-build -> [\s\S]*start: .*1 tab\(s\) restored/.test(logOf(P + 2))
    || /restart: old-build -> [\s\S]*exit: stopped by a just-doc of another version[\s\S]*start: .*1 tab\(s\) restored/.test(logOf(P + 2)), logOf(P + 2));

  // 8. the log keeps its last 200 lines
  spawnSync(py, ['-c', `import just_doc\nfor i in range(250): just_doc.log(${P}, f"line {i}")`], { cwd: repo, env: env() });
  const lines = logOf(P).trim().split('\n');
  check('the log keeps its last 200 lines', lines.length === 200 && lines.at(-1).endsWith('line 249'), lines.length);
} catch (e) {
  check('test run', false, e.stack || String(e));
} finally {
  for (const port of [P, P + 1, P + 2]) { try { await fetch(`http://127.0.0.1:${port}/api/quit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch {} }
  for (const p of procs) { try { process.kill(-p.pid, 'SIGKILL'); } catch {} }
  await sleep(1500);
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
