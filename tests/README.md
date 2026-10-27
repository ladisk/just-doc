# Smoke test

`smoke.mjs` drives the viewer in headless Chromium (DevTools protocol, no npm
packages). It makes a comment with a mouse drag, hands over with Ctrl+Enter
(`--wait`), adds an agent reply, answers it, and checks `n` / `p` / `A`.

Needs Node 22 or newer, `uv`, `pandoc` and Chromium or Chrome. It uses a temp
folder, its own cache, port 8961 and debugging port 9361 (`SMOKE_PORT`,
`SMOKE_CDP_PORT`), and removes everything afterwards.

    node tests/smoke.mjs     # exit code 1 if a check fails
