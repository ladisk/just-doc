// Test of the hc labels: the just-doc server labels the hc terminal of its documents
// (just-doc=live, just-doc=waiting, removed). See tests/README.md.
//
// hc is a fake on the PATH that notes its arguments; no browser is needed.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const P = +(process.env.LABELS_PORT || 8968), base = `http://127.0.0.1:${P}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;
const check = (name, ok, info = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(info).slice(0, 400)}`);
  if (!ok) failed++;
};
const tmp = mkdtempSync(join(tmpdir(), 'just-doc-labels-'));
const procs = [];
try {
  const bin = join(tmp, 'bin'), site = join(tmp, 'site'), log = join(tmp, 'hc.log');
  mkdirSync(bin); mkdirSync(site);
  writeFileSync(join(bin, 'hc'), `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\n`, { mode: 0o755 });
  const doc = join(site, 'page.html');
  writeFileSync(doc, '<!doctype html><title>p</title><p>page</p>');
  const venv = join(repo, '.venv', 'bin', 'just-doc');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HC_TERMINAL_ID: 'T1',
    XDG_CACHE_HOME: join(tmp, 'cache'), XDG_CONFIG_HOME: join(tmp, 'config') };
  const args = (...a) => [doc, '--live', '--port', String(P), '--no-window', ...a];
  const calls = () => { try { return readFileSync(log, 'utf8').trim().split('\n'); } catch { return []; } };
  const last = () => calls().at(-1);
  const until = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(100); } return false; };

  const srv = spawn(venv, args(), { env, stdio: 'ignore' });
  procs.push(srv);
  check('open: the terminal is labelled live', await until(() => last() === 'label T1 just-doc=live'), calls());
  const key = (await (await fetch(base + '/api/tabs')).json()).tabs[0].id;

  const w = spawn(venv, args('--wait'), { env, stdio: 'ignore' });
  procs.push(w);
  check('--wait: waiting', await until(() => last() === 'label T1 just-doc=waiting'), calls());
  const json = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' };
  await fetch(`${base}/api/done?d=${key}`, json);
  check('Ctrl+Enter: live again', await until(() => last() === 'label T1 just-doc=live'), calls());

  await fetch(`${base}/api/close?d=${key}`, json);
  check('the tab closed: the label is removed', await until(() => last() === 'label T1 just-doc='), calls());

  spawnSync(venv, args(), { env });
  check('opened again: live', await until(() => last() === 'label T1 just-doc=live'), calls());
  await fetch(`${base}/api/quit`, json);
  check('quit: the label is removed', await until(() => last() === 'label T1 just-doc='), calls());
  let stopped = false;
  for (let i = 0; i < 50 && !stopped; i++) { await sleep(100); try { await fetch(base + '/api/tabs'); } catch { stopped = true; } }
  check('just-doc stopped', stopped);

  // without hc the document opens as before
  const nohc = { ...env, PATH: '/usr/bin:/bin' };
  const s2 = spawn(venv, args(), { env: nohc, stdio: 'ignore' });
  procs.push(s2);
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { await sleep(100); try { up = (await (await fetch(base + '/api/tabs')).json()).tabs.length === 1; } catch {} }
  check('without hc the document opens', up);
  await fetch(`${base}/api/quit`, json);
} finally {
  for (const p of procs) try { p.kill(); } catch {}
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
