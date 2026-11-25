// Comments on live pages, loaded by tabs.html. The page stays as it is: its comments are drawn on
// a layer over it (#__jd_marks, outside its layout) and listed in a side panel of the window.
//
// A comment is anchored to an element of the page: the id (or data-src) of the element or of the
// nearest ancestor that has one, the path from there to the element, a CSS path from <body> and
// the quoted text with a little text before and after it. After the page is loaded again, the
// comment is placed by the id first, then by the quote, then by the CSS path; one that cannot be
// placed is marked detached and stays in the list.
const LIVE = (() => {
  const S = {};          // tab id -> its state: t, f, annots, where, sel, editing, open, undo, pointer
  let panel = null;      // c: true / false; null: shown while the page has comments
  try { panel = JSON.parse(localStorage.getItem('livePanel')); } catch {}
  const side = document.createElement('div');
  side.id = 'side';
  document.body.appendChild(side);

  const api = (t, path) => t.remote ? `remote/${t.id}/${path}?d=${t.rid}` : `${path}?d=${t.id}`;
  const norm = s => (s || '').replace(/\s+/g, ' ').trim();
  const now = () => new Date().toISOString();
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const state = a => a.done ? 'done' : (a.replies || []).length && a.replies.at(-1).from ? 'answered' : 'open';

  // ---- anchoring ----

  // the text of root with runs of white space as one space, and for each character its text node and offset
  function textIndex(root) {
    const doc = root.ownerDocument, map = [];
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: n =>
      n.parentElement?.closest('script, style, noscript, template, #__jd_marks') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
    let str = '', space = true;
    for (let n; (n = walker.nextNode());) {
      const v = n.nodeValue;
      for (let i = 0; i < v.length; i++) {
        const blank = /\s/.test(v[i]);
        if (blank && space) continue;
        str += blank ? ' ' : v[i];
        map.push([n, i]);
        space = blank;
      }
    }
    return { str, map };
  }

  // the occurrences of the quote in root, the one with the best matching text around it first
  function findText(root, quote, prefix = '', suffix = '') {
    const q = norm(quote);
    if (!q || !root) return [];
    const { str, map } = textIndex(root), hits = [];
    for (let at = str.indexOf(q); at >= 0; at = str.indexOf(q, at + 1)) {
      const score = (prefix && str.slice(Math.max(0, at - prefix.length), at) === prefix ? 2 : 0)
                  + (suffix && str.slice(at + q.length, at + q.length + suffix.length) === suffix ? 1 : 0);
      hits.push({ at, end: at + q.length, score, str, map });
    }
    return hits.sort((a, b) => b.score - a.score);
  }

  function toRange(doc, h) {
    const r = doc.createRange(), [n1, i1] = h.map[h.at], [n2, i2] = h.map[h.end - 1];
    r.setStart(n1, i1);
    r.setEnd(n2, i2 + 1);
    return r;
  }

  const elementOf = node => node.nodeType === 1 ? node : node.parentElement;
  const keyed = el => el.closest('[id], [data-src]');

  // the path of tag:nth-of-type steps from root (not included) down to el
  function path(el, root) {
    const steps = [];
    for (let e = el; e && e !== root && e.parentElement; e = e.parentElement) {
      let k = 1;
      for (let s = e.previousElementSibling; s; s = s.previousElementSibling) if (s.localName === e.localName) k++;
      steps.unshift(`${CSS.escape(e.localName)}:nth-of-type(${k})`);
    }
    return steps.join(' > ');
  }

  function anchorOf(doc, el, quote, prefix, suffix) {
    let base = keyed(el);
    if (base === doc.body || base === doc.documentElement) base = null;
    const src = el.closest('[data-src]')?.getAttribute('data-src') || null;
    return { id: base?.id || null, src, path: base ? path(el, base) : null,
             selector: 'body > ' + path(el, doc.body), tag: el.localName, quote, prefix, suffix };
  }

  // where a comment is now: a text range or an element, or null when it cannot be placed
  function locate(doc, a) {
    const an = a.anchor || {};
    let base = null;
    try {
      base = an.id ? doc.getElementById(an.id) : an.src ? doc.querySelector(`[data-src="${CSS.escape(an.src)}"]`) : null;
    } catch {}
    if (base) {
      if (a.kind === 'text') {
        const h = findText(base, an.quote ?? a.text, an.prefix, an.suffix)[0];
        if (h) return { range: toRange(doc, h) };
      }
      let el = base;
      if (an.path) try { el = base.querySelector(':scope > ' + an.path) || base; } catch {}
      return { el };
    }
    // an element with an id (or data-src) that is gone was removed: its text elsewhere is another element
    if (a.kind === 'element' && (an.id || an.src)) return null;
    const h = findText(doc.body, an.quote ?? a.text, an.prefix, an.suffix)[0];
    if (h) return a.kind === 'text' ? { range: toRange(doc, h) } : { el: elementOf(h.map[h.at][0]) };
    if (an.selector) try { const el = doc.querySelector(an.selector); if (el) return { el }; } catch {}
    return null;
  }

  // ---- storage ----

  async function load(st) {
    try { st.annots = (await (await fetch(api(st.t, 'api/annotations'))).json()).annots || []; } catch { return; }
    // a new comment that is still being written is not saved yet
    const e = st.editing;
    if (e?.mode === 'new' && e.annot && !st.annots.some(a => a.id === e.id)) st.annots.push(e.annot);
  }

  async function save(st) {
    try {
      const r = await fetch(api(st.t, 'api/annotations'), { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                                            body: JSON.stringify({ annots: st.annots }) });
      if (!r.ok) throw new Error();
    } catch { toast('NOT SAVED: the server is not responding', true); return; }
    await load(st);   // the numbers come from the server
    place(st);
    draw();
  }

  // place every comment on the page; a change of "detached" is saved
  function place(st) {
    const doc = st.f.contentDocument;
    if (!doc?.body) return;
    st.where = {};
    let changed = false;
    for (const a of st.annots) {
      const loc = locate(doc, a);
      if (loc) st.where[a.id] = loc;
      if (!!a.detached !== !loc) { a.detached = !loc; changed = true; }
    }
    if (changed) save(st);
  }

  // ---- drawing ----

  function marks(st) {
    const doc = st.f.contentDocument, w = st.f.contentWindow;
    if (!doc?.documentElement) return;
    let layer = doc.getElementById('__jd_marks');
    if (!layer) {
      layer = doc.createElement('div');
      layer.id = '__jd_marks';
      layer.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none';
      layer.addEventListener('click', e => {
        const id = e.target.closest('[data-id]')?.dataset.id;
        if (id) { select(st, id, false); e.stopPropagation(); }
      });
      doc.documentElement.appendChild(layer);
    }
    let html = '';
    for (const a of st.annots) {
      const loc = st.where?.[a.id];
      if (!loc || (a.done && a.id !== st.sel)) continue;
      const rects = [...(loc.range ? loc.range.getClientRects() : [loc.el.getBoundingClientRect()])].filter(r => r.width > 0 || r.height > 0);
      if (!rects.length) continue;
      const on = a.id === st.sel, col = { open: '255,153,0', answered: '47,123,255', done: '60,160,90' }[state(a)];
      const box = r => `left:${r.left + w.scrollX}px;top:${r.top + w.scrollY}px;width:${r.width}px;height:${r.height}px`;
      for (const r of rects) {
        html += loc.range
          ? `<div style="position:absolute;${box(r)};background:rgba(${col},${on ? 0.45 : 0.25});border-radius:2px"></div>`
          : `<div style="position:absolute;${box(r)};outline:${on ? 3 : 2}px solid rgba(${col},${on ? 1 : 0.75});outline-offset:2px;border-radius:3px"></div>`;
      }
      const r = rects[0], at = a.anchor?.at;
      if (loc.el && at) {
        html += `<div style="position:absolute;left:${r.left + w.scrollX + at[0] * r.width - 6}px;top:${r.top + w.scrollY + at[1] * r.height - 6}px;
          width:12px;height:12px;border-radius:50%;background:rgb(${col});border:2px solid #fff;box-shadow:0 0 3px #000"></div>`;
      }
      html += `<div data-id="${esc(a.id)}" style="position:absolute;left:${r.left + w.scrollX}px;top:${r.top + w.scrollY - 18}px;
        pointer-events:auto;cursor:pointer;font:600 11px/16px system-ui,sans-serif;padding:0 5px;border-radius:8px;color:#fff;
        background:rgb(${col})">#${a.n ?? '…'}</div>`;
    }
    if (layer.dataset.html !== html) { layer.innerHTML = html; layer.dataset.html = html; }
  }

  function visible(st) {
    return !!st && (panel === true || (panel === null && (st.annots.length > 0 || !!st.editing)) || (panel === false && !!st.editing));
  }

  function draw() {
    const st = S[active];
    for (const id in S) {
      const on = id === active && visible(S[id]);
      S[id].f.style.width = on ? 'calc(100% - 340px)' : '';
      marks(S[id]);
    }
    side.style.display = st && visible(st) ? 'flex' : 'none';
    if (!st || !visible(st)) return;
    const rows = [...st.annots].sort((a, b) => (a.n ?? 1e9) - (b.n ?? 1e9)).map(a => {
      const big = a.id === st.sel || st.open.has(a.id) || st.editing?.id === a.id;
      const where = a.anchor?.id ? '#' + a.anchor.id : a.anchor?.src || a.anchor?.tag || '';
      let h = `<div class="it${a.id === st.sel ? ' on' : ''}${a.done ? ' done' : ''}" data-id="${esc(a.id)}">
        <div class="h"><b>#${a.n ?? '…'}</b><span class="st ${a.detached ? 'detached' : state(a)}">${a.detached ? 'detached' : state(a)}</span>
        <span class="wh">${esc(where)}${a.anchor?.src && a.anchor?.id ? ' · ' + esc(a.anchor.src) : ''}</span></div>
        <div class="q${big ? '' : ' one'}">${esc(a.kind === 'element' ? '‹' + (a.anchor?.tag || 'element') + '› ' : '')}${esc(a.text)}</div>`;
      if (a.comment || !big) h += `<div class="c${big ? '' : ' one'}">${esc(a.comment || '(no comment)')}</div>`;
      if (big) for (const r of a.replies || []) h += `<div class="r${r.from ? '' : ' me'}"><i>${esc(r.from || 'you')}</i> ${esc(r.text)}</div>`;
      if (st.editing?.id === a.id) h += `<textarea id="ed" rows="3" placeholder="${st.editing.mode === 'reply' ? 'reply' : 'comment'}: Enter saves, Esc cancels"></textarea>`;
      return h + '</div>';
    }).join('');
    side.innerHTML = `<div id="list">${rows || '<p class="none">No comments. Select text or point at an element and press <kbd>a</kbd>.</p>'}</div>
      <div id="hint"><kbd>a</kbd> comment/reply <kbd>x</kbd> done <kbd>n</kbd>/<kbd>p</kbd> next <kbd>za</kbd> open <kbd>d</kbd> delete
      <kbd>c</kbd> list <kbd>Ctrl</kbd><kbd>Enter</kbd> hand over</div>`;
    const ed = side.querySelector('#ed');
    if (ed) {
      ed.value = st.editing.text || '';
      ed.oninput = () => st.editing.text = ed.value;
      ed.onkeydown = e => {
        e.stopPropagation();
        if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey) { e.preventDefault(); commit(st, ed.value); }
        else if (e.key === 'Escape') { e.preventDefault(); cancel(st); }
      };
      ed.focus();
    }
    side.querySelector('.it.on')?.scrollIntoView({ block: 'nearest' });
  }

  side.addEventListener('click', e => {
    const it = e.target.closest('.it');
    const st = S[active];
    if (it && st && !e.target.closest('textarea')) select(st, it.dataset.id, true);
  });

  // ---- actions ----

  function select(st, id, scroll) {
    st.sel = id;
    const loc = st.where?.[id];
    if (scroll && loc) {
      const el = loc.el || elementOf(loc.range.startContainer);
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
    }
    draw();
  }

  // a: a new comment on the selected text or on the element under the mouse (or the element with an
  // id around it); on a selected comment edit
  // what you wrote last while the assistant has not seen it, else reply
  function add(st) {
    const w = st.f.contentWindow, doc = st.f.contentDocument, sel = w.getSelection();
    if (sel && !sel.isCollapsed && norm(sel.toString())) {
      const r = sel.getRangeAt(0), quote = norm(sel.toString()).slice(0, 500);
      const h = findText(doc.body, quote).find(h => r.intersectsNode(h.map[h.at][0])) || findText(doc.body, quote)[0];
      const prefix = h ? h.str.slice(Math.max(0, h.at - 32), h.at) : '', suffix = h ? h.str.slice(h.end, h.end + 32) : '';
      newComment(st, 'text', quote, anchorOf(doc, elementOf(r.commonAncestorContainer), quote, prefix, suffix));
      sel.removeAllRanges();
      return;
    }
    const a = st.annots.find(x => x.id === st.sel);
    if (a) { reply(st, a); return; }
    const p = st.pointer;
    let el = p && doc.elementFromPoint(p.x, p.y);
    // the element with an id (or data-src) around it: a section, a figure, a plot, which stays when its inside is drawn again
    const k = el && keyed(el);
    if (k && k !== doc.body && k !== doc.documentElement) el = k;
    if (!el || el === doc.body || el === doc.documentElement) { toast('Select text or point at an element with the mouse, then press a', true); return; }
    const rect = el.getBoundingClientRect();
    // the text of a plot or a drawing is tick labels and the like, no help for finding it again
    const quote = el.querySelector('svg, canvas') || /^(svg|canvas)$/.test(el.localName) ? '' : norm(el.textContent).slice(0, 120);
    const anchor = anchorOf(doc, el, quote, '', '');
    if (rect.width > 0 && rect.height > 0) anchor.at = [(p.x - rect.left) / rect.width, (p.y - rect.top) / rect.height].map(v => Math.round(Math.min(1, Math.max(0, v)) * 1000) / 1000);
    newComment(st, 'element', quote, anchor);
  }

  function newComment(st, kind, text, anchor) {
    const a = { id: 'L' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), kind, text, comment: '',
                created: now(), anchor, replies: [] };
    st.annots.push(a);
    st.where = st.where || {};
    st.where[a.id] = locate(st.f.contentDocument, a);
    st.sel = a.id;
    st.editing = { id: a.id, mode: 'new', text: '', annot: a };
    draw();
  }

  function reply(st, a) {
    const replies = a.replies || [], last = replies.at(-1);
    // what the author said last, and whether a --wait has shown it to the assistant since
    const mine = last ? (!last.from ? last : null) : a;
    const spoke = mine && (mine === a ? a.created : mine.at);
    const unseen = spoke && !(a.seen || []).some(s => s >= spoke);
    st.editing = unseen ? { id: a.id, mode: mine === a ? 'comment' : 'edit', text: mine === a ? a.comment : mine.text }
                        : { id: a.id, mode: 'reply', text: '' };
    st.open.add(a.id);
    draw();
  }

  function commit(st, text) {
    const e = st.editing, a = st.annots.find(x => x.id === e.id);
    st.editing = null;
    if (a) {
      text = text.trim();
      if (e.mode === 'new' || e.mode === 'comment') a.comment = text;
      else if (e.mode === 'edit') {
        if (text) a.replies.at(-1).text = text; else a.replies.pop();
      } else if (text) {
        a.replies = [...(a.replies || []), { text, at: now() }];
        a.done = false;
      }
    }
    st.f.contentWindow.focus();
    save(st);
  }

  function cancel(st) {
    if (st.editing?.mode === 'new') st.annots = st.annots.filter(a => a.id !== st.editing.id);
    st.editing = null;
    st.f.contentWindow.focus();
    draw();
  }

  function step(st, by) {
    const list = [...st.annots].sort((a, b) => (a.n ?? 1e9) - (b.n ?? 1e9));
    if (!list.length) return;
    const at = list.findIndex(a => a.id === st.sel);
    select(st, list[at < 0 ? (by > 0 ? 0 : list.length - 1) : (at + by + list.length) % list.length].id, true);
  }

  // Ctrl+Enter: the comments are saved already; the answers go with the hand-over
  async function handOver(st) {
    const got = answers(st.f.contentDocument), n = Object.keys(got).length;
    const open = st.annots.filter(a => state(a) === 'open' && !a.done).length;
    try {
      const r = await fetch(api(st.t, 'api/answers'), { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                                        body: JSON.stringify({ answers: got }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || r.status);
      const what = [open && `${open} open comment(s)`, n && `${n} answer(s)`].filter(Boolean).join(' and ');
      toast(!j.listening ? 'Handed over, but nobody is waiting yet: start just-doc with --live --wait'
            : what ? `Handed over ${what}` : 'Handed over, but there is no open comment and no named field');
    } catch (e) { toast('Not handed over: ' + (e.message || 'the server is not responding'), true); }
  }

  // the keys of a live page; true when the key was used
  function key(e, id) {
    const st = S[id];
    if (!st) return false;
    if (e.ctrlKey && !e.altKey && e.key === 'Enter') { handOver(st); return true; }
    if (e.ctrlKey || e.altKey || e.metaKey) return false;
    const typing = e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName || '');
    if (typing) return false;
    const a = st.annots.find(x => x.id === st.sel);
    if (st.z && Date.now() - st.z < 1500 && e.key === 'a') {
      st.z = 0;
      if (a) { st.open.has(a.id) ? st.open.delete(a.id) : st.open.add(a.id); draw(); }
      return true;
    }
    st.z = 0;
    switch (e.key) {
      case 'z': st.z = Date.now(); return true;
      case 'a': add(st); return true;
      case 'x':
        if (!a) return false;
        a.done = !a.done;
        if (a.done) a.done_at = now();
        save(st);
        return true;
      case 'd':
        if (!a) return false;
        st.undo.push(a);
        st.annots = st.annots.filter(x => x !== a);
        st.sel = null;
        save(st);
        return true;
      case 'u':
        if (!st.undo.length) return false;
        st.annots.push(st.undo.pop());
        save(st);
        return true;
      case 'n': step(st, 1); return true;
      case 'p': step(st, -1); return true;
      case 'c':
        panel = !visible(st);
        try { localStorage.setItem('livePanel', JSON.stringify(panel)); } catch {}
        draw();
        return true;
      case 'Escape':
        if (!st.sel) return false;
        st.sel = null;
        draw();
        return true;
    }
    return false;
  }

  // a live page was loaded (again): read its comments and place them
  async function attach(f, t) {
    const st = S[t.id] = S[t.id] || { annots: [], open: new Set(), undo: [] };
    Object.assign(st, { t, f, where: {}, pointer: null });
    const w = f.contentWindow;
    w.addEventListener('mousemove', e => st.pointer = { x: e.clientX, y: e.clientY }, true);
    w.addEventListener('resize', () => marks(st));
    await load(st);
    place(st);
    draw();
    // plots and other content that scripts draw a moment later
    setTimeout(() => { place(st); draw(); }, 1500);
  }

  // the comments were changed from outside (a reply of the assistant)
  async function refresh(id) {
    const st = S[id];
    if (!st) return;
    await load(st);
    place(st);
    draw();
  }

  function forget(id) { delete S[id]; }

  // the page moves under the marks when its layout changes (a plot is drawn, a window resized)
  setInterval(() => { const st = S[active]; if (st) marks(st); }, 1000);

  return { attach, key, refresh, draw, forget };
})();
