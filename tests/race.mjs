// Test of commands started at the same moment. See tests/README.md.
//
// Three just-doc commands at once, with no just-doc running and against one of another version,
// must give one just-doc, one window and every document. The window is a fake browser on the PATH
// that only notes that it was started.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const P = +(process.env.RACE_PORT || 8967);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;
const check = (name, ok, info = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(info).slice(0, 400)}`);
  if (!ok) failed++;
};
const tmp = mkdtempSync(join(tmpdir(), 'just-doc-race-'));
const procs = [];
try {
  const py = join(repo, '.venv', 'bin', 'python');
  const site = join(tmp, 'site'), fake = join(tmp, 'bin'), log = join(tmp, 'windows.log');
  mkdirSync(site); mkdirSync(fake);
  writeFileSync(join(fake, 'chromium'), `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\n`, { mode: 0o755 });
  for (const n of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) writeFileSync(join(site, `${n}.html`), `<!doctype html><title>${n}</title>${n}`);
  const env = build => ({ ...process.env, PATH: `${fake}:/usr/bin:/bin`, WAYLAND_DISPLAY: 'fake', DISPLAY: '',
    XDG_CACHE_HOME: join(tmp, 'cache'), XDG_CONFIG_HOME: join(tmp, 'config'), JUST_DOC_BUILD: build || '' });
  const start = (port, build, name) => {
    const p = spawn(py, ['-c', 'import just_doc; just_doc.main()', join(site, name), '--live', '--port', String(port)],
      { cwd: repo, env: env(build), stdio: ['ignore', 'pipe', 'pipe'] });
    p.out = ''; p.stdout.on('data', c => p.out += c); p.stderr.on('data', c => p.out += c);
    procs.push(p);
    return p;
  };
  const servers = async port => {
    const found = [];
    for (let q = port; q < port + 6; q++) {
      try { const s = await (await fetch(`http://127.0.0.1:${q}/api/tabs`)).json(); found.push([q, s]); } catch {}
    }
    return found;
  };
  const windows = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).length : 0;
  for (const q of [P, P + 10]) if ((await servers(q)).length) { console.log(`port ${q} is in use; set RACE_PORT`); process.exit(1); }

  // 1. no just-doc running: three first starts at once
  for (const n of ['a', 'b', 'c']) start(P, '', `${n}.html`);
  await sleep(6000);
  let found = await servers(P);
  check('three first starts at once: one just-doc', found.length === 1, JSON.stringify(found.map(f => f[0])));
  check('with all three documents', found[0]?.[1].tabs.length === 3, JSON.stringify(found[0]?.[1].tabs.map(t => t.name)));
  check('and one window', windows() === 1, String(windows()));

  // 2. a just-doc of another version, then three commands at once
  writeFileSync(log, '');
  const Q = P + 10;
  start(Q, 'old-build', 'd.html');
  await sleep(2500);
  check('a just-doc of another version runs, with its window', (await servers(Q))[0]?.[1].version === 'old-build' && windows() === 1);
  const cmds = ['e', 'f', 'g'].map(n => start(Q, '', `${n}.html`));
  await sleep(9000);
  found = await servers(Q);
  check('three commands at once against it: one just-doc, of this version', found.length === 1 && found[0][1].version !== 'old-build',
    JSON.stringify(found.map(f => [f[0], f[1].version])));
  check('with all four documents', found[0]?.[1].tabs.length === 4, JSON.stringify(found[0]?.[1].tabs.map(t => t.name)));
  const updates = cmds.filter(c => /updated the running just-doc/.test(c.out)).length;
  check('updated once', updates === 1, cmds.map(c => c.out).join(' | '));
  check('still one window', windows() === 1, String(windows()));
} catch (e) {
  check('test run', false, e.stack || String(e));
} finally {
  for (const q of [P, P + 1, P + 10, P + 11]) {
    try { await fetch(`http://127.0.0.1:${q}/api/quit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch {}
  }
  for (const p of procs) { try { p.kill('SIGTERM'); } catch {} }
  await sleep(1000);
  for (const p of procs) { try { if (p.exitCode === null) p.kill('SIGKILL'); } catch {} }
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
