// just-doc: <jd-scene>, a 3D viewer of one or several parts (STL, STEP, GLB) for a live page.
//
//   <script type="module" src="/_lib/three/scene.js"></script>
//   <jd-scene id="bracket">
//     <script type="application/json">
//       {"parts": [{"src": "housing.stl"}, {"src": "cover.step", "colour": "#e15759", "opacity": 0.6}], "units": "mm"}
//     </script>
//   </jd-scene>
//
// Config keys: parts [{src, name, group, colour, opacity, visible, split}], units, height (px;
// default: the class .view of page.css), up ("z" default, or "y"; GLB files are Y-up), src (a
// .json file with the same keys instead of the script). Above the view: view buttons, a section
// plane, a part list (checkbox, colour, opacity). Parts show as they arrive.
//
// Comments: with the pointer over the model, the key a of just-doc makes a comment pinned to the
// surface point under the pointer. The page of just-doc (live.js) uses these members:
//   pick(clientX, clientY)  -> {part, point: [x, y, z], normal: [x, y, z], units} or null
//   setMarks([{id, n, state, selected, point, normal}])   numbered markers, depth aware
//   markRect(id)            -> the marker on the screen, {left, top, width, height}, or null
//   reveal(id)              turns / moves the view to the point of a marker that is not seen
//   events (bubbling):      "jd-mark" (detail {id}: a marker was clicked), "jd-view" (the picture
//                           changed while there are markers), "jd-ready" (the view is built)
//
// Derived from <canvas-scene> of agent-canvas, by Tibor Barsi Palmic (MIT, Copyright (c) 2026
// Tibor Barsi Palmic; the licence is the one of agent-canvas). What came with it: loading of
// STL, STEP and GLB in parallel, the part list, the view buttons, the section plane with lightened
// cut faces, the fit of the camera. What changed: a standalone element (no agent-canvas base, no
// shadow DOM; it takes the colours of page.css), controls in a bar above a full width view, no
// damping, touchpad(), drawing only on a change at a sharp resolution when still (fast.js), parts
// of many meshes merged by material, the background follows light and dark, and the marks of
// agent-canvas (a Mark mode, a button, a stored list) are gone: the markers are the comments of
// just-doc, drawn depth aware with the colours of their state.
import * as THREE from './three.module.js';
import { STLLoader } from './addons/STLLoader.js';
import { OrbitControls } from './addons/OrbitControls.js';
import { GLTFLoader } from './addons/GLTFLoader.js';
import { touchpad } from './touchpad.js';
import { mergeByMaterial, sharpWhenStill } from './fast.js';

const EXTENSIONS = ['.stl', '.step', '.stp', '.glb'];
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const FILL = 0.82;          // share of the limiting view dimension that the parts fill
const CAP_LIGHTEN = 0.3;    // how far the cut faces are lightened towards white
const CLICK = 4;            // px between press and release that still count as a click
const MANY = 12;            // a part with more meshes than this is merged by material
const MARKER = 26;          // px, the diameter of a marker
const PALETTE = ['#4e79a7', '#f28e2b', '#59a14f', '#e15759', '#76b7b2', '#edc948', '#b07aa1', '#9c755f'];
const VIEWS = {
  z: { iso: [1, -1, 0.8], top: [0, -0.001, 1], front: [0, -1, 0], side: [1, 0, 0] },
  y: { iso: [1, 0.8, 1], top: [0, 1, 0.001], front: [0, 0, 1], side: [1, 0, 0] },
};
const AXES = ['x', 'y', 'z'];
// the colours of the states of a comment, as in the panel of just-doc: fill and ink
const STATES = {
  new: ['#2f7bff', '#ffffff'], read: ['#dbe7ff', '#0050d0'], wait: ['#ffe0b0', '#7a4300'],
  skip: ['#f6cccc', '#8a1c1c'], done: ['#c9f2c9', '#14601f'], draft: ['#e4e4e0', '#555555'],
};

const round = v => Number(v.toPrecision(6));
const extensionOf = src => {
  const name = new URL(src, document.baseURI).pathname, dot = name.lastIndexOf('.');
  return dot < 0 ? '' : decodeURIComponent(name.slice(dot)).toLowerCase();
};
const stem = src => {
  const name = decodeURIComponent(new URL(src, document.baseURI).pathname).split('/').pop(), dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
};

function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v !== undefined) e.setAttribute(k, v === true ? '' : v);
  }
  e.append(...kids);
  return e;
}

// ---- config ----

function partProblem(part) {
  if (part === null || typeof part !== 'object' || Array.isArray(part)) return 'must be an object';
  if (typeof part.src !== 'string' || !part.src) return '"src" is missing';
  const ext = extensionOf(part.src);
  if (!EXTENSIONS.includes(ext)) return `src "${part.src}" must be an .stl, .step, .stp or .glb file`;
  if (part.colour !== undefined && !HEX.test(part.colour)) return `colour "${part.colour}" must be a hex colour such as #2a9d8f`;
  if (part.opacity !== undefined && !(part.opacity >= 0 && part.opacity <= 1)) return `opacity ${part.opacity} must be between 0 and 1`;
  if (part.split && !['.step', '.stp'].includes(ext)) return `split only works for STEP files, not ${part.src}`;
  return null;
}

function sceneProblem(c) {
  if (c.height !== undefined && !(c.height >= 80)) return '"height" must be at least 80';
  if (c.up !== undefined && c.up !== 'z' && c.up !== 'y') return '"up" must be "z" or "y"';
  if (!Array.isArray(c.parts) || !c.parts.length) return '"parts" must list at least one part';
  for (const [i, p] of c.parts.entries()) { const m = partProblem(p); if (m) return `part ${i + 1}: ${m}`; }
  return null;
}

// the parts with defaults and unique names
function normalise(parts) {
  const seen = new Map();
  return parts.map((raw, index) => {
    let name = raw.name || stem(raw.src);
    const n = (seen.get(name) || 0) + 1;
    seen.set(name, n);
    if (n > 1) name = `${name} (${n})`;
    return { src: raw.src, name, group: raw.group || null, colour: raw.colour || null, opacity: raw.opacity ?? 1,
             visible: raw.visible ?? true, split: !!raw.split, index };
  });
}

// ---- loading: fetch with progress, STL / GLB / STEP into three.js objects ----

async function fetchBytes(url, onProgress, label = url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`could not read ${label} (${r.status})`);
  const total = Number(r.headers.get('content-length')) || 0;
  if (!r.body) return r.arrayBuffer();
  const reader = r.body.getReader(), chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress(total ? Math.min(got / total, 1) : null);
  }
  const bytes = new Uint8Array(got);
  let at = 0;
  for (const c of chunks) { bytes.set(c, at); at += c.length; }
  return bytes.buffer;
}

// occt-import-js (the OpenCASCADE reader, LGPL), loaded once when a STEP file is first needed
let occt = null;
function loadOcct() {
  if (!occt) {
    const js = new URL('../occt/occt-import-js.js', import.meta.url).href;
    const wasm = new URL('../occt/occt-import-js.wasm', import.meta.url).href;
    occt = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = js;
      s.onload = () => resolve(window.occtimportjs({ locateFile: () => wasm }));
      s.onerror = () => reject(new Error('could not load the STEP reader (/_lib/occt/)'));
      document.head.append(s);
    });
    occt.catch(() => { occt = null; });
  }
  return occt;
}

// the reader works synchronously: one file at a time keeps the page responsive between files
let stepQueue = Promise.resolve();
function readStep(bytes) {
  const job = stepQueue.then(async () => {
    await new Promise(r => setTimeout(r));
    return (await loadOcct()).ReadStepFile(new Uint8Array(bytes), null);
  });
  stepQueue = job.catch(() => {});
  return job;
}

const newMaterial = colour => new THREE.MeshStandardMaterial({ color: colour, roughness: 0.55, metalness: 0.1, side: THREE.DoubleSide });

function stepGeometry(mesh) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(mesh.attributes.position.array, 3));
  if (mesh.attributes.normal) g.setAttribute('normal', new THREE.Float32BufferAttribute(mesh.attributes.normal.array, 3));
  g.setIndex(Array.from(mesh.index.array));
  if (!mesh.attributes.normal) g.computeVertexNormals();
  return g;
}

// the names of the STEP tree nodes by mesh index
function stepNames(root) {
  const names = new Map();
  const walk = node => {
    for (const i of node.meshes || []) if (node.name && !names.has(i)) names.set(i, node.name);
    (node.children || []).forEach(walk);
  };
  if (root) walk(root);
  return names;
}

async function parseStep(bytes, src, split) {
  const result = await readStep(bytes);
  if (!result.success || !result.meshes.length) throw new Error(`${src} is not a STEP file this viewer can read`);
  const names = stepNames(result.root), shared = new Map();
  // one material for the meshes of one colour: a part of many solids merges to a few draw calls
  const materialOf = (colour, own) => {
    const key = split ? 'own' + own : colour ? colour.getHexString() : '';
    if (!shared.has(key)) {
      const m = newMaterial(colour);
      m.userData.native = !!colour;
      shared.set(key, m);
    }
    return shared.get(key);
  };
  const solids = result.meshes.map((mesh, i) => {
    const colour = mesh.color ? new THREE.Color(...mesh.color) : null;
    const object = new THREE.Group();
    object.add(new THREE.Mesh(stepGeometry(mesh), materialOf(colour, i)));
    return { name: mesh.name || names.get(i) || null, object };
  });
  if (split) return solids;
  const object = new THREE.Group();
  for (const s of solids) object.add(...s.object.children);
  return [{ name: null, object }];
}

async function parseGlb(bytes) {
  const gltf = await new GLTFLoader().parseAsync(bytes, '');
  gltf.scene.traverse(node => {
    if (!node.isMesh) return;
    for (const m of Array.isArray(node.material) ? node.material : [node.material]) { m.side = THREE.DoubleSide; m.userData.native = true; }
  });
  return [{ name: null, object: gltf.scene }];
}

function parseStl(bytes) {
  const object = new THREE.Group();
  object.add(new THREE.Mesh(new STLLoader().parse(bytes), newMaterial(null)));
  return [{ name: null, object }];
}

// solids [{name, object}]: one for STL, GLB and a STEP file that is not split
async function parseFile(src, bytes, split) {
  const ext = extensionOf(src);
  const solids = ext === '.stl' ? parseStl(bytes) : ext === '.glb' ? await parseGlb(bytes) : await parseStep(bytes, src, split);
  for (const s of solids) {
    let n = 0;
    s.object.traverse(o => { if (o.isMesh) n += o.geometry.attributes.position?.count || 0; });
    if (!n) { dispose(s.object); throw new Error(`${src} contains no triangles`); }
  }
  return solids;
}

function dispose(object) {
  object.traverse(node => {
    node.geometry?.dispose();
    for (const m of Array.isArray(node.material) ? node.material : [node.material]) {
      if (!m) continue;
      for (const v of Object.values(m)) if (v && v.isTexture) v.dispose();
      m.dispose();
    }
  });
}

// ---- the markers of the comments ----

const markerTextures = new Map();
function markerTexture(n, state, selected) {
  const key = `${n}|${state}|${selected}`;
  if (!markerTextures.has(key)) {
    const [fill, ink] = STATES[state] || STATES.draft;
    const c = document.createElement('canvas');
    c.width = c.height = 80;
    const g = c.getContext('2d');
    g.beginPath(); g.arc(40, 40, 38, 0, 7); g.fillStyle = selected ? '#d00000' : '#ffffff'; g.fill();
    g.beginPath(); g.arc(40, 40, 32, 0, 7); g.fillStyle = '#ffffff'; g.fill();
    g.beginPath(); g.arc(40, 40, 29, 0, 7); g.fillStyle = fill; g.fill();
    g.lineWidth = 4; g.strokeStyle = ink; g.stroke();
    g.fillStyle = ink; g.font = `bold ${String(n).length > 2 ? 28 : 36}px system-ui, sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(String(n), 40, 42);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    markerTextures.set(key, t);
  }
  return markerTextures.get(key);
}

// ---- style: one sheet in the document, on the variables of page.css (with fallbacks) ----

const CSS = `
jd-scene { display: block; margin: 0 0 1em; }
jd-scene .jd-bar { margin-bottom: 8px; }
jd-scene .jd-grp { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 4px; }
jd-scene .jd-lbl { color: var(--muted, #656d76); margin-right: 2px; }
jd-scene .controls button, jd-scene .jd-bar button { font: inherit; padding: 2px 10px; border: 1px solid var(--line, #d0d7de); border-radius: 6px;
  background: var(--bg, #fff); color: inherit; cursor: pointer; }
jd-scene button[aria-pressed="true"] { background: var(--accent, #0969da); border-color: var(--accent, #0969da); color: #fff; }
jd-scene button:disabled, jd-scene input:disabled { opacity: .45; cursor: default; }
jd-scene .jd-sec { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 8px; }
jd-scene .jd-sec[hidden] { display: none; }
jd-scene .jd-sec input[type=range] { width: 140px; accent-color: var(--accent, #0969da); margin: 0; }
jd-scene .jd-val { min-width: 8em; color: var(--muted, #656d76); font-variant-numeric: tabular-nums; }
jd-scene .jd-size { margin-left: auto; color: var(--muted, #656d76); font-variant-numeric: tabular-nums; }
jd-scene .jd-parts { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 0 22px; margin: 0 0 8px; padding: 4px 14px;
  font-size: 0.92em; background: var(--card, #f6f8fa); border: 1px solid var(--line, #d0d7de); border-radius: var(--radius, 8px); }
jd-scene .jd-parts[hidden] { display: none; }
jd-scene .jd-row { display: grid; align-items: center; column-gap: 8px; min-height: 28px; grid-template-columns: 16px 16px minmax(0, 1fr) 84px;
  border-bottom: 1px solid var(--line, #d0d7de); position: relative; }
jd-scene .jd-row.grouped { padding-left: 18px; }
jd-scene .jd-row.group { grid-column: 1 / -1; font-weight: 600; grid-template-columns: 16px 16px minmax(0, 1fr) 120px; }
jd-scene .jd-row input[type=checkbox] { margin: 0; width: 14px; height: 14px; }
jd-scene .jd-row input[type=range] { width: 100%; margin: 0; accent-color: var(--accent, #0969da); }
jd-scene .jd-chev { display: flex; align-items: center; justify-content: center; width: 16px; height: 16px; padding: 0 !important; border: 0 !important; background: none !important; }
jd-scene .jd-chev svg { fill: var(--muted, #656d76); display: block; }
jd-scene .jd-chev[aria-expanded="false"] svg { transform: rotate(-90deg); }
jd-scene .jd-sw { position: relative; display: block; width: 14px; height: 14px; border-radius: 3px; border: 1px solid var(--line, #d0d7de); overflow: hidden; cursor: pointer; }
jd-scene .jd-sw input { position: absolute; inset: 0; width: 100%; height: 100%; padding: 0; border: 0; opacity: 0; cursor: pointer; }
jd-scene .jd-name { min-width: 0; overflow-wrap: anywhere; line-height: 1.25; padding: 3px 0; }
jd-scene .jd-name small { color: var(--muted, #656d76); font-weight: 400; }
jd-scene .jd-row[data-status="pending"] .jd-name { color: var(--muted, #656d76); }
jd-scene .jd-row[data-status="error"] .jd-name { color: var(--bad, #cf222e); }
jd-scene .jd-note { grid-column: 3 / -1; font-size: 12px; color: var(--bad, #cf222e); padding-bottom: 2px; }
jd-scene .jd-note[hidden] { display: none; }
jd-scene .jd-prog { grid-column: 1 / -1; height: 2px; }
jd-scene .jd-prog > div { height: 100%; width: 0; background: var(--accent, #0969da); }
jd-scene .jd-row[data-status="ready"] .jd-prog, jd-scene .jd-row[data-status="pending"] .jd-prog { display: none; }
jd-scene .view { position: relative; }
jd-scene canvas { display: block; width: 100%; height: 100%; touch-action: none; }
jd-scene .jd-status { position: absolute; left: 8px; bottom: 8px; padding: 2px 8px; font-size: 12px; border-radius: 10px;
  color: var(--fg, #1f2328); background: var(--bg, #fff); border: 1px solid var(--line, #d0d7de); pointer-events: none; }
jd-scene .jd-status[hidden] { display: none; }
jd-scene .jd-error { padding: 10px 14px; border: 1px solid var(--bad, #cf222e); border-radius: var(--radius, 8px); color: var(--bad, #cf222e); }
jd-scene script { display: none; }
`;

const triangle = () => {
  const s = h('span');
  s.innerHTML = '<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><polygon points="1.5,3 8.5,3 5,7.5"></polygon></svg>';
  return s.firstChild;
};

// ---- the element ----

class JdScene extends HTMLElement {
  connectedCallback() {
    if (this._started) return;
    this._started = true;
    this._marks = this._marks || [];
    const start = () => this._start().catch(e => this._fail(e.message || String(e)));
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
  }

  disconnectedCallback() {
    // moved in the DOM: it is built again; removed: the GPU resources go
    this._teardown();
    this._started = false;
  }

  _fail(message) {
    console.error('jd-scene: ' + message);
    this.dataset.state = 'error';
    this.append(h('div', { class: 'jd-error', role: 'alert' }, 'jd-scene: ' + message));
  }

  async _config() {
    const tag = this.querySelector(':scope > script[type="application/json"]');
    let c = {};
    if (tag) { try { c = JSON.parse(tag.textContent); } catch { throw new Error('the config is not valid JSON'); } }
    if (c.parts === undefined && c.src) {
      const r = await fetch(c.src, { cache: 'no-store' });
      if (!r.ok) throw new Error(`could not read ${c.src} (${r.status})`);
      let m;
      try { m = await r.json(); } catch { throw new Error(`${c.src} is not valid JSON`); }
      c = { ...m, ...c, parts: m.parts };
    }
    const problem = sceneProblem(c);
    if (problem) throw new Error(problem);
    return c;
  }

  async _start() {
    if (!document.getElementById('jd-scene-style')) {
      document.head.append(h('style', { id: 'jd-scene-style' }, CSS));
    }
    const config = await this._config();
    if (!this.isConnected) { this._started = false; return; }
    this.dataset.state = 'loading';
    this.up = config.up || 'z';
    this.units = config.units || '';
    this.cfg = normalise(config.parts);
    this.entries = [];
    this.listSig = null;
    this.collapsed = {};
    this.section = { axis: null, value: 0, flip: false };
    this.loading = 0;
    this.cutOn = { value: 0 };
    this.plane = new THREE.Plane();
    this.autoFit = true;
    this.diagonal = 1;
    this.sprites = new Map();
    this._build(config);
    this.cfg.forEach(cfg => this._addEntry(cfg));
    this._partsChanged();
    this.dispatchEvent(new CustomEvent('jd-ready', { bubbles: true }));
    for (const e of this.entries) this._loadIfWanted(e);
    if (!this.entries.some(e => e.promise)) this._settle();
  }

  // ---- DOM, renderer and camera ----

  _build(config) {
    this.canvas = h('canvas');
    this.status = h('div', { class: 'jd-status', role: 'status', hidden: true });
    this.viewEl = h('div', { class: 'view' }, this.canvas, this.status);
    if (config.height) { this.viewEl.style.height = config.height + 'px'; this.viewEl.style.minHeight = '0'; }
    this.bar = this._buildBar();
    this.listEl = h('div', { class: 'jd-parts', role: 'group', 'aria-label': 'Parts' });
    this.append(this.bar, this.listEl, this.viewEl);

    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, preserveDrawingBuffer: true });
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 1000);
    this.camera.up.set(0, this.up === 'z' ? 0 : 1, this.up === 'z' ? 1 : 0);
    this.scene.add(this.camera);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.9));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(0.4, 0.6, 1);
    const fill = new THREE.DirectionalLight(0xffffff, 0.6);
    fill.position.set(-0.8, -0.3, -0.6);
    this.camera.add(key, fill);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = false;
    this.controls.zoomToCursor = true;
    touchpad(this.controls);
    this.draw = sharpWhenStill(this.renderer, () => this._paint());
    this.controls.addEventListener('start', () => { this.autoFit = false; });
    this.controls.addEventListener('change', () => this.draw());

    this.scheme = matchMedia('(prefers-color-scheme: dark)');
    this.onScheme = () => this._background();
    this.scheme.addEventListener('change', this.onScheme);
    this._background();
    this.observer = new ResizeObserver(() => this._resize());
    this.observer.observe(this.viewEl);
    this._bindClicks();
    this._resize();
  }

  _buildBar() {
    const btn = (text, onclick, extra = {}) => h('button', { type: 'button', onclick: e => { onclick(e); e.currentTarget.blur(); }, ...extra }, text);
    const views = ['iso', 'top', 'front', 'side'].map(v => btn(v, () => this.setView(v), { 'aria-label': v + ' view' }));
    const view = h('span', { class: 'jd-grp', role: 'group', 'aria-label': 'View' }, h('span', { class: 'jd-lbl' }, 'View'), ...views,
      btn('reset', () => this.resetView(), { title: 'Back to the first view' }), btn('fit', () => this.fitVisible(), { title: 'Fit the shown parts' }));
    this.axisButtons = {};
    const axes = [null, ...AXES].map(a => {
      const b = btn(a ? a.toUpperCase() : 'off', () => this._setSectionAxis(a), { 'aria-pressed': 'false', 'aria-label': a ? `Section plane ${a.toUpperCase()}` : 'Section off' });
      this.axisButtons[a] = b;
      return b;
    });
    this.sectionSlider = h('input', { type: 'range', min: '0', max: '1000', value: '500', 'aria-label': 'Section position' });
    this.sectionSlider.addEventListener('input', () => this._moveSection());
    this.sectionSlider.addEventListener('change', () => this.sectionSlider.blur());
    this.sectionValue = h('span', { class: 'jd-val' });
    this.flipButton = btn('flip', () => this._flipSection(), { title: 'Keep the other side' });
    this.sectionExtra = h('span', { class: 'jd-sec', hidden: true }, this.sectionSlider, this.sectionValue, this.flipButton);
    const section = h('span', { class: 'jd-grp', role: 'group', 'aria-label': 'Section plane' }, h('span', { class: 'jd-lbl' }, 'Section'), ...axes, this.sectionExtra);
    this.partsButton = btn('Parts', () => { this.listEl.hidden = !this.listEl.hidden; this.partsButton.setAttribute('aria-pressed', String(!this.listEl.hidden)); },
      { 'aria-pressed': 'true' });
    this.sizeNote = h('span', { class: 'jd-size' });
    return h('div', { class: 'controls jd-bar' }, view, section, this.partsButton, this.sizeNote);
  }

  _teardown() {
    if (!this.renderer) return;
    this.observer?.disconnect();
    this.scheme?.removeEventListener('change', this.onScheme);
    this.controls.dispose();
    for (const e of this.entries) { e.removed = true; for (const p of e.parts) this._removeObject(p); }
    for (const s of this.sprites.values()) { this.scene.remove(s); s.material.dispose(); }
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer = null;
    this.replaceChildren(...[...this.children].filter(c => c.matches('script')));
  }

  // the background follows the page: the --card of page.css, else light or dark
  _background() {
    if (!this.renderer) return;
    const card = getComputedStyle(this).getPropertyValue('--card').trim();
    this.renderer.setClearColor(new THREE.Color(card || (this.scheme.matches ? '#161b22' : '#f6f8fa')));
    this.draw?.();
  }

  _resize() {
    if (!this.renderer) return;
    const w = this.viewEl.clientWidth, hgt = this.viewEl.clientHeight;
    if (!w || !hgt) return;
    this.renderer.setSize(w, hgt, false);
    this.camera.aspect = w / hgt;
    this.camera.updateProjectionMatrix();
    this._scaleSprites();
    this.draw();
  }

  _paint() {
    if (!this.renderer) return;
    this.renderer.render(this.scene, this.camera);
    if (this._marks.length) this.dispatchEvent(new CustomEvent('jd-view', { bubbles: true }));
  }

  // ---- parts ----

  get allParts() { return this.entries.flatMap(e => e.parts); }

  partInfo() {
    return this.allParts.map(p => ({ id: p.id, name: p.name, group: p.group, status: p.status, visible: p.set.visible, opacity: p.set.opacity,
                                     colour: this._colourOf(p), error: p.error, meshes: this._meshCount(p) }));
  }

  _meshCount(p) { let n = 0; p.object?.traverse(o => { if (o.isMesh) n++; }); return n; }

  _makePart(entry, id, name, group) {
    const c = entry.cfg;
    return { entry, id, name, group, status: 'pending', progress: 0, error: null, object: null, materials: [], box: null, native: null,
             set: { visible: c.visible, opacity: c.opacity, colour: c.colour } };
  }

  _addEntry(cfg) {
    const entry = { cfg, parts: [], promise: null };
    entry.parts = [this._makePart(entry, `${cfg.src}|${cfg.name}`, cfg.name, cfg.group)];
    this.entries.push(entry);
  }

  _loadIfWanted(entry) {
    if (entry.promise) return;
    if (entry.parts.some(p => p.set.visible)) this._startLoad(entry);
  }

  _startLoad(entry) {
    this.loading++;
    for (const p of entry.parts) { p.status = 'loading'; p.progress = 0; p.error = null; }
    entry.promise = this._loadEntry(entry).finally(() => {
      this.loading--;
      this._partsChanged();
      if (!this.loading) this._settle();
    });
    this._partsChanged();
  }

  _settle() {
    this.dataset.state = 'ready';
    this.draw();
    this.dispatchEvent(new CustomEvent('jd-loaded', { bubbles: true }));
  }

  async _loadEntry(entry) {
    const { src, split } = entry.cfg;
    try {
      const bytes = await fetchBytes(new URL(src, document.baseURI).href, f => {
        for (const p of entry.parts) p.progress = f ?? 0.5;
        this._syncList();
      }, src);
      const solids = await parseFile(src, bytes, split);
      if (entry.removed || !this.renderer) { solids.forEach(s => dispose(s.object)); return; }
      this._install(entry, solids);
    } catch (e) {
      if (entry.removed) return;
      for (const p of entry.parts) { p.status = 'error'; p.error = e.message || String(e); }
      console.error(`jd-scene: part "${entry.cfg.name}": ${e.message || e}`);
    }
  }

  // the parsed solids into the scene; a split file replaces its placeholder row by one row per solid
  _install(entry, solids) {
    const { cfg } = entry, placeholder = entry.parts[0];
    let parts = [placeholder];
    if (cfg.split) {
      const group = cfg.group || stem(cfg.src), seen = new Map();
      parts = solids.map((s, i) => {
        let name = s.name || `${cfg.name} ${i + 1}`;
        const n = (seen.get(name) || 0) + 1;
        seen.set(name, n);
        if (n > 1) name = `${name} (${n})`;
        const p = this._makePart(entry, `${cfg.src}#${name}`, name, group);
        p.set = { ...placeholder.set };
        return p;
      });
      entry.parts = parts;
    }
    parts.forEach((p, i) => this._fill(p, solids[i], entry));
    this._partsChanged();
    if (this.autoFit) this._fitInitial();
    this.draw();
  }

  _fill(part, solid, entry) {
    part.object = solid.object;
    part.status = 'ready';
    part.progress = 1;
    // a part of many meshes becomes a few draw calls; the part keeps its materials, so colour, opacity and visibility still work
    if (this._meshCount(part) > MANY) mergeByMaterial(part.object);
    const materials = new Set();
    part.object.traverse(node => {
      if (!node.isMesh) return;
      node.userData.part = part;
      for (const m of Array.isArray(node.material) ? node.material : [node.material]) materials.add(m);
    });
    part.materials = [...materials];
    for (const m of part.materials) this._prepareMaterial(m, entry);
    part.native = part.materials.find(m => m.userData.native)?.color.clone() || null;
    this.scene.add(part.object);
    part.object.updateMatrixWorld(true);
    part.box = new THREE.Box3().setFromObject(part.object);
    this._applyPart(part);
  }

  // remember the file's own look; the cut faces show in a flat, lighter colour
  _prepareMaterial(m, entry) {
    m.userData.nativeColour = m.color ? m.color.clone() : null;
    m.userData.nativeOpacity = m.opacity;
    m.userData.nativeTransparent = m.transparent;
    m.userData.cap = { value: new THREE.Vector3(1, 1, 1) };
    const cap = m.userData.cap, cutOn = this.cutOn;
    m.onBeforeCompile = shader => {
      shader.uniforms.uCutOn = cutOn;
      shader.uniforms.uCap = cap;
      shader.fragmentShader = 'uniform float uCutOn;\nuniform vec3 uCap;\n' + shader.fragmentShader.replace('#include <dithering_fragment>',
        '#include <dithering_fragment>\nif (uCutOn > 0.5 && !gl_FrontFacing) gl_FragColor.rgb = uCap;');
    };
    m.customProgramCacheKey = () => 'jd-scene-cut';
    m.userData.entryIndex = entry.cfg.index;
  }

  _removeObject(p) {
    if (!p.object) return;
    this.scene.remove(p.object);
    dispose(p.object);
    p.object = null;
    p.materials = [];
  }

  _colourOf(p) {
    if (p.set.colour) return p.set.colour;
    if (p.native) return '#' + p.native.getHexString();
    return PALETTE[p.entry.cfg.index % PALETTE.length];
  }

  _patch(ids, patch) {
    const wanted = new Set(ids);
    for (const p of this.allParts) {
      if (!wanted.has(p.id)) continue;
      Object.assign(p.set, patch);
      this._applyPart(p);
      if (patch.visible) this._loadIfWanted(p.entry);
    }
    this._partsChanged();
  }

  _applyPart(p) {
    if (!p.object) return;
    p.object.visible = p.set.visible;
    for (const m of p.materials) {
      const { nativeColour, nativeOpacity, nativeTransparent } = m.userData;
      const override = p.set.colour || (m.userData.native ? null : PALETTE[p.entry.cfg.index % PALETTE.length]);
      if (override) m.color.set(override); else m.color.copy(nativeColour);
      const effective = nativeOpacity * p.set.opacity, transparent = effective < 1 || nativeTransparent;
      if (m.transparent !== transparent) m.needsUpdate = true;
      m.opacity = effective;
      m.transparent = transparent;
      m.depthWrite = effective >= 1;
      const rgb = m.color.getRGB({}, THREE.SRGBColorSpace);
      m.userData.cap.value.set(...[rgb.r, rgb.g, rgb.b].map(c => c + (1 - c) * CAP_LIGHTEN));
    }
  }

  _shown(p) { return !!p.object && p.set.visible; }

  _partsChanged() {
    if (!this.renderer) return;
    this._syncList();
    this._syncSection();
    this._sizeNote();
    this._updateClip();
    this._placeSprites();
    this.draw();
  }

  // ---- the part list: built when its structure changes, then only values are set ----

  _syncList() {
    if (!this.listEl) return;
    const groups = [], byName = new Map();
    for (const p of this.allParts) {
      if (!byName.has(p.group)) { const g = { name: p.group, parts: [] }; byName.set(p.group, g); groups.push(g); }
      byName.get(p.group).parts.push(p);
    }
    groups.sort((a, b) => (a.name === null ? -1 : 0) - (b.name === null ? -1 : 0));
    const sig = JSON.stringify(groups.map(g => [g.name, !!this.collapsed[g.name], g.parts.map(p => [p.id, p.name])]));
    if (sig !== this.listSig) this._buildList(groups);
    this.listSig = sig;
    const active = document.activeElement;
    for (const [id, r] of this.rows) {
      const p = this.allParts.find(x => x.id === id);
      if (!p) continue;
      r.row.dataset.status = p.status;
      r.check.checked = p.set.visible;
      r.swatch.style.background = this._colourOf(p);
      if (active !== r.colour) r.colour.value = this._colourOf(p);
      if (active !== r.opacity) r.opacity.value = String(p.set.opacity);
      r.fill.style.width = Math.round((p.progress || 0) * 100) + '%';
      const note = p.status === 'error' ? p.error : '';
      r.note.hidden = !note;
      r.note.textContent = note;
      r.name.title = note ? `${p.name}: ${note}` : p.name;
    }
    for (const g of this.groupRows) {
      const members = g.ids.map(id => this.allParts.find(x => x.id === id)).filter(Boolean);
      const on = members.filter(p => p.set.visible).length;
      g.check.checked = on === members.length;
      g.check.indeterminate = on > 0 && on < members.length;
      if (active !== g.opacity) g.opacity.value = String(members.reduce((s, p) => s + p.set.opacity, 0) / (members.length || 1));
    }
    this.partsButton.textContent = `Parts (${this.allParts.length})`;
    const waiting = this.allParts.filter(p => p.status === 'loading').length;
    this.status.hidden = !waiting;
    if (waiting) this.status.textContent = `Loading ${waiting} of ${this.allParts.length} parts…`;
  }

  _buildList(groups) {
    this.rows = new Map();
    this.groupRows = [];
    const slider = (label, on) => {
      const i = h('input', { type: 'range', min: '0', max: '1', step: '0.05', 'aria-label': label });
      i.addEventListener('input', () => on(Number(i.value)));
      i.addEventListener('change', () => i.blur());
      return i;
    };
    const tick = (label, on) => {
      const c = h('input', { type: 'checkbox', 'aria-label': label });
      c.addEventListener('change', () => { on(c.checked); c.blur(); });
      return c;
    };
    const out = [];
    for (const g of groups) {
      const ids = g.parts.map(p => p.id);
      if (g.name !== null) {
        const chev = h('button', { type: 'button', class: 'jd-chev', 'aria-expanded': String(!this.collapsed[g.name]), 'aria-label': `${this.collapsed[g.name] ? 'Expand' : 'Collapse'} group ${g.name}`,
          onclick: () => { this.collapsed[g.name] = !this.collapsed[g.name]; this._syncList(); } }, triangle());
        const check = tick(`Show group ${g.name}`, v => this._patch(ids, { visible: v }));
        const opacity = slider(`Opacity of group ${g.name}`, v => this._patch(ids, { opacity: v }));
        this.groupRows.push({ check, opacity, ids });
        out.push(h('div', { class: 'jd-row group' }, chev, check, h('span', { class: 'jd-name', title: g.name }, g.name, ' ', h('small', {}, String(ids.length))), opacity));
      }
      if (g.name !== null && this.collapsed[g.name]) continue;
      for (const p of g.parts) {
        const check = tick(`Show ${p.name}`, v => this._patch([p.id], { visible: v }));
        const colour = h('input', { type: 'color', 'aria-label': `Colour of ${p.name}` });
        colour.addEventListener('input', () => this._patch([p.id], { colour: colour.value }));
        const swatch = h('label', { class: 'jd-sw', title: 'Change the colour' }, colour);
        const name = h('span', { class: 'jd-name', title: p.name }, p.name);
        const opacity = slider(`Opacity of ${p.name}`, v => this._patch([p.id], { opacity: v }));
        const note = h('div', { class: 'jd-note', hidden: true }), fill = h('div');
        const row = h('div', { class: 'jd-row' + (g.name !== null ? ' grouped' : ''), 'data-part': p.id }, check, swatch, name, opacity, note, h('div', { class: 'jd-prog' }, fill));
        this.rows.set(p.id, { row, check, colour, swatch, opacity, note, fill, name });
        out.push(row);
      }
    }
    this.listEl.replaceChildren(...out);
  }

  // ---- size, depth range ----

  _boxOf(parts) {
    const box = new THREE.Box3();
    for (const p of parts) if (p.box) box.union(p.box);
    return box.isEmpty() ? null : box;
  }

  _visibleBox() { return this._boxOf(this.allParts.filter(p => this._shown(p))); }

  _sizeNote() {
    const box = this._visibleBox();
    if (!box) { this.sizeNote.textContent = ''; return; }
    const s = box.getSize(new THREE.Vector3()).toArray().map(v => Number(v.toPrecision(4))).join(' × ');
    this.sizeNote.textContent = s + (this.units ? ' ' + this.units : '');
  }

  _updateClip() {
    const box = this._boxOf(this.allParts);
    if (!box) return;
    this.diagonal = box.getSize(new THREE.Vector3()).length() || 1;
    this.camera.near = this.diagonal * 0.005;
    this.camera.far = this.diagonal * 200;
    this.camera.updateProjectionMatrix();
  }

  // ---- camera ----

  _direction(name) { return new THREE.Vector3(...VIEWS[this.up][name]).normalize(); }

  // the camera on direction, so that the projected box fills FILL of the limiting dimension
  _placeCamera(box, direction) {
    const centre = box.getCenter(new THREE.Vector3());
    const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1e-6);
    const corners = [0, 1, 2, 3, 4, 5, 6, 7].map(i => new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z));
    const dir = direction.clone().normalize();
    let distance = radius * 3;
    for (let step = 0; step < 8; step++) {
      this.camera.position.copy(centre).addScaledVector(dir, distance);
      this.camera.lookAt(centre);
      this.camera.updateMatrixWorld(true);
      const half = Math.max(...corners.map(c => { const p = c.clone().project(this.camera); return Math.max(Math.abs(p.x), Math.abs(p.y)); }));
      const ratio = half / FILL;
      if (Math.abs(ratio - 1) < 0.01) break;
      distance = Math.max(radius * 0.2, distance * ratio);
    }
    this.camera.position.copy(centre).addScaledVector(dir, distance);
    this.controls.target.copy(centre);
    this.controls.update();
    this.draw();
  }

  setView(name) {
    const box = this._visibleBox() || this._boxOf(this.allParts);
    this.autoFit = false;
    if (box) this._placeCamera(box, this._direction(name));
  }

  fitVisible() {
    const box = this._visibleBox();
    if (!box) return;
    this.autoFit = false;
    this._placeCamera(box, this.camera.position.clone().sub(this.controls.target).normalize());
  }

  _initialBox() { return this._boxOf(this.allParts.filter(p => p.box && p.entry.cfg.visible)) || this._visibleBox(); }
  _fitInitial() { const box = this._initialBox(); if (box) this._placeCamera(box, this._direction('iso')); }
  resetView() { const box = this._initialBox(); if (!box) return; this.autoFit = false; this._placeCamera(box, this._direction('iso')); }

  // ---- section plane ----

  _setSectionAxis(axis) {
    const s = this.section, changed = s.axis !== axis;
    s.axis = axis;
    if (axis && changed) {
      const box = this._visibleBox(), i = AXES.indexOf(axis);
      s.value = box ? (box.min.getComponent(i) + box.max.getComponent(i)) / 2 : 0;
    }
    this._syncSection();
    this._placeSprites();
    this.draw();
  }

  _moveSection() {
    const box = this._visibleBox(), s = this.section;
    if (!box || !s.axis) return;
    const i = AXES.indexOf(s.axis), lo = box.min.getComponent(i), hi = box.max.getComponent(i);
    s.value = lo + (Number(this.sectionSlider.value) / 1000) * (hi - lo);
    this._syncSection();
    this._placeSprites();
    this.draw();
  }

  _flipSection() { this.section.flip = !this.section.flip; this._syncSection(); this._placeSprites(); this.draw(); }

  _syncSection() {
    if (!this.axisButtons) return;
    const s = this.section;
    for (const [axis, b] of Object.entries(this.axisButtons)) b.setAttribute('aria-pressed', String(s.axis === (axis === 'null' ? null : axis)));
    const box = this._visibleBox(), active = !!s.axis && !!box;
    this.sectionExtra.hidden = !s.axis;
    this.sectionSlider.disabled = this.flipButton.disabled = !active;
    this.cutOn.value = active ? 1 : 0;
    this.renderer.clippingPlanes = active ? [this.plane] : [];
    if (!active) { this.sectionValue.textContent = ''; return; }
    const i = AXES.indexOf(s.axis), lo = box.min.getComponent(i), hi = box.max.getComponent(i);
    const f = hi > lo ? (s.value - lo) / (hi - lo) : 0.5;
    if (document.activeElement !== this.sectionSlider) this.sectionSlider.value = String(Math.round(Math.min(Math.max(f, 0), 1) * 1000));
    this.sectionValue.textContent = `${s.axis.toUpperCase()} = ${Number(s.value.toPrecision(3))}${this.units ? ' ' + this.units : ''}`;
    this.plane.set(new THREE.Vector3().setComponent(i, s.flip ? 1 : -1), s.flip ? -s.value : s.value);
  }

  // ---- the comments of just-doc: pick, markers, reveal ----

  _rayAt(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    if (!r.width || clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) return null;
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1), this.camera);
    return ray;
  }

  // the first surface hit: only parts that are shown and not cut away
  _hits(ray) {
    if (!this.renderer) return [];
    this.camera.updateMatrixWorld(true);
    const targets = this.allParts.filter(p => this._shown(p) && p.set.opacity > 0.02).map(p => p.object);
    const cutting = this.cutOn.value > 0.5;
    return ray.intersectObjects(targets, true).filter(h => !cutting || this.plane.distanceToPoint(h.point) >= 0);
  }

  pick(clientX, clientY) {
    const ray = this._rayAt(clientX, clientY);
    const hit = ray && this._hits(ray)[0];
    if (!hit || !hit.face) return null;
    const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
    if (normal.dot(ray.ray.direction) > 0) normal.negate();   // facing the viewer
    return { part: hit.object.userData.part?.name || '', point: hit.point.toArray().map(round), normal: normal.toArray().map(round), units: this.units };
  }

  setMarks(list) {
    const sig = JSON.stringify(list);
    if (sig === this._marksSig) return;
    this._marksSig = sig;
    this._marks = list;
    if (this.renderer) { this._placeSprites(); this.draw(); }
  }

  // markers: sprites of a constant size on the screen, tested against the depth buffer
  _placeSprites() {
    if (!this.renderer) return;
    const ids = new Set(this._marks.map(m => m.id));
    for (const [id, s] of this.sprites) if (!ids.has(id)) { this.scene.remove(s); s.material.dispose(); this.sprites.delete(id); }
    const cutting = this.cutOn.value > 0.5;
    for (const m of this._marks) {
      let s = this.sprites.get(m.id);
      if (!s) { s = new THREE.Sprite(new THREE.SpriteMaterial({ sizeAttenuation: false, depthWrite: false })); s.renderOrder = 10; this.scene.add(s); this.sprites.set(m.id, s); }
      const key = `${m.n}|${m.state}|${!!m.selected}`;
      if (s.userData.key !== key) {
        s.userData.key = key;
        s.material.map = markerTexture(m.n, m.state, !!m.selected);
        s.material.opacity = m.state === 'done' ? 0.55 : 1;
        s.material.transparent = true;
        s.material.needsUpdate = true;
      }
      s.userData.big = m.selected ? 1.3 : 1;
      s.position.fromArray(m.point).addScaledVector(new THREE.Vector3(...(m.normal || [0, 0, 0])), this.diagonal * 0.004);
      s.visible = !(cutting && this.plane.distanceToPoint(new THREE.Vector3(...m.point)) < 0);
    }
    this._scaleSprites();
  }

  _scaleSprites() {
    const hpx = this.viewEl?.clientHeight || 1;
    const k = (MARKER / hpx) * 2 * Math.tan((this.camera.fov * Math.PI) / 360);
    for (const s of this.sprites.values()) s.scale.set(k * s.userData.big, k * s.userData.big, 1);
  }

  _project(point) {
    this.camera.updateMatrixWorld(true);
    const v = new THREE.Vector3(...point).project(this.camera);
    const r = this.canvas.getBoundingClientRect();
    return { v, x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
  }

  // whether a surface of a part that is shown lies in front of the point, on the line from the camera
  _hidden(point) {
    const p = new THREE.Vector3(...point), from = this.camera.position.clone(), d = p.clone().sub(from), dist = d.length();
    const ray = new THREE.Raycaster(from, d.normalize());
    const first = this._hits(ray)[0];
    return !!first && first.distance < dist - this.diagonal * 0.01;
  }

  markRect(id) {
    const m = this._marks.find(x => x.id === id);
    if (!m || !this.renderer || this.sprites.get(id)?.visible === false) return null;   // cut away by the section
    const { v, x, y } = this._project(m.point);
    if (v.z > 1 || Math.abs(v.x) > 1 || Math.abs(v.y) > 1) return null;
    const half = MARKER / 2;
    return { left: x - half, top: y - half, width: MARKER, height: MARKER };
  }

  // the point of a comment is brought into view only when it is not: off the screen, hidden behind
  // the model or on its far side; then the view turns to look at it along its normal
  reveal(id) {
    const m = this._marks.find(x => x.id === id);
    if (!m || !this.renderer) return;
    const { v } = this._project(m.point);
    const inside = v.z < 1 && Math.abs(v.x) < 0.94 && Math.abs(v.y) < 0.94;
    if (inside && !this._hidden(m.point)) return;
    const p = new THREE.Vector3(...m.point), n = new THREE.Vector3(...(m.normal || [0, 0, 1])).normalize();
    const away = this.camera.position.clone().sub(p).normalize();
    const distance = this.camera.position.distanceTo(this.controls.target) || this.diagonal;
    // seen from the front but off the screen: the view moves; else it turns to the normal of the surface
    const dir = !inside && n.dot(away) > 0.2 ? away : n.clone();
    const up = this.camera.up.clone();
    if (Math.abs(dir.dot(up)) > 0.995) dir.addScaledVector(new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 0), 0.05).normalize();
    this.autoFit = false;
    this.controls.target.copy(p);
    this.camera.position.copy(p).addScaledVector(dir, distance);
    this.controls.update();
    this.draw();
  }

  // a click on a marker (not a drag) selects its comment
  _bindClicks() {
    let press = null;
    this.canvas.addEventListener('pointerdown', e => { press = { x: e.clientX, y: e.clientY }; });
    this.canvas.addEventListener('pointerup', e => {
      const start = press;
      press = null;
      if (!start || !this._marks.length || Math.hypot(e.clientX - start.x, e.clientY - start.y) > CLICK) return;
      let best = null;
      for (const m of this._marks) {
        const { v, x, y } = this._project(m.point);
        const d = Math.hypot(e.clientX - x, e.clientY - y);
        if (v.z < 1 && d <= MARKER / 2 + 2 && (!best || d < best.d) && !this._hidden(m.point)) best = { m, d };
      }
      if (best) this.dispatchEvent(new CustomEvent('jd-mark', { bubbles: true, detail: { id: best.m.id } }));
    });
  }
}

if (!customElements.get('jd-scene')) customElements.define('jd-scene', JdScene);
