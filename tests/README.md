# Smoke test

`smoke.mjs` drives the viewer in headless Chromium (DevTools protocol, no npm
packages). It makes a comment with a mouse drag, hands over with Ctrl+Enter
(`--wait`), adds an agent reply, answers it, and checks `n` / `p`, replying and editing a reply with `a`, and `x`.

Needs Node 22 or newer, `uv`, `pandoc` and Chromium or Chrome. It uses a temp
folder, its own cache, port 8961 and debugging port 9361 (`SMOKE_PORT`,
`SMOKE_CDP_PORT`), and removes everything afterwards.

    node tests/smoke.mjs     # exit code 1 if a check fails

`live.mjs` tests the live pages the same way: `--live` serves the page and its
relative files and nothing outside its folder, `/_lib/` serves Plotly, three.js
and `page.css` with the right content types, the page runs and loads again
(at the same scroll position) when the file changes, and `--hc-terminal`
selects the last document of a terminal and fails cleanly for an unknown one.
For `--hc-machine` it starts a second just-doc on port 8963 as the "other
machine" and reaches it through `tests/fake-ssh.py` (named in a config file in
the temp folder), which runs commands and forwards ports on this machine.
It needs Node 22, `uv` and Chromium, uses port 8962 and debugging port 9362
(`LIVE_PORT`, `LIVE_CDP_PORT`), and runs `--hc-terminal` without `hyprctl` on
the PATH, so no real window is raised.

    node tests/live.mjs      # exit code 1 if a check fails
