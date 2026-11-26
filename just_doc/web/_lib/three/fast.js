// just-doc: helpers for a three.js view of a large model (CAD, KiCad: hundreds of parts or more).
//
//   import { mergeByMaterial, sharpWhenStill } from '/_lib/three/fast.js';
//   const stats = mergeByMaterial(model, { keep: m => moved.has(m) });   // after loading and measuring
//   const draw = sharpWhenStill(renderer, () => renderer.render(scene, camera));
//   controls.addEventListener('change', draw);                           // call draw() after every change
//
// mergeByMaterial(root, { keep, transparent }) replaces the meshes under root by one mesh per material (and per
// attribute set), so thousands of draw calls become a few. The picture stays the same. Every
// mesh is baked with its matrix relative to root, so the merged meshes move with root; parts that
// move on their own (an exploded view) need a root each. keep(mesh) returning true leaves that
// mesh where it is, so it can still move, hide, change colour or be found by name. Meshes by name,
// picking and measuring need the original meshes: do these before merging, or keep them.
// Meshes with a transparent material are left as they are too (they are sorted by distance, merged
// they would be drawn in another order), unless transparent: true.
// Lines, points, instanced, skinned and morphing meshes, and meshes that are hidden, stay as they are.
// Returns { before, after }: the draw calls of the meshes under root.
//
// sharpWhenStill(renderer, render, { moving = 1.5, delay = 150 }) returns draw(): call it where
// the guide example calls its draw(). It draws on the next frame (render is called once, not
// queued twice), at pixel ratio min(devicePixelRatio, moving) while changes keep coming and at the full
// devicePixelRatio once nothing changed for delay ms. The canvas keeps its size on the page.
import { BufferGeometry, BufferAttribute } from './three.module.js';
import { mergeGeometries } from './utils/BufferGeometryUtils.js';

const piecesOf = m => Array.isArray(m.material)
  ? m.geometry.groups.filter(g => m.material[g.materialIndex]).length || 0
  : 1;

function shown(o, root) {
  for (let p = o; p && p !== root.parent; p = p.parent) if (!p.visible) return false;
  return true;
}

// a copy of geometry (the part given by group, or all) with its own plain attributes and an index
function copyOf(geometry, group) {
  const g = new BufferGeometry();
  for (const name in geometry.attributes) {
    const a = geometry.attributes[name];
    if (a.isInterleavedBufferAttribute) {
      const b = new BufferAttribute(new a.array.constructor(a.count * a.itemSize), a.itemSize, a.normalized);
      for (let i = 0; i < a.count; i++) for (let k = 0; k < a.itemSize; k++) b.setComponent(i, k, a.getComponent(i, k));
      g.setAttribute(name, b);
    } else g.setAttribute(name, a.clone());
  }
  const n = geometry.attributes.position.count;
  const src = geometry.index ? geometry.index.array : null;
  const start = group ? group.start : 0;
  const count = group ? group.count : (src ? src.length : n);
  const idx = new Uint32Array(count);
  for (let i = 0; i < count; i++) idx[i] = src ? src[start + i] : start + i;
  g.setIndex(new BufferAttribute(idx, 1));
  return g;
}

function flipWinding(g) {
  const a = g.index.array;
  for (let i = 0; i < a.length; i += 3) { const t = a[i + 1]; a[i + 1] = a[i + 2]; a[i + 2] = t; }
}

const signature = g => Object.keys(g.attributes).sort().map(k => {
  const a = g.attributes[k]; return `${k}:${a.itemSize}:${a.array.constructor.name}:${a.normalized ? 1 : 0}`;
}).join(',');

export function mergeByMaterial(root, { keep, transparent = false } = {}) {
  root.updateWorldMatrix(true, true);
  const inverse = root.matrixWorld.clone().invert();
  const meshes = [];
  root.traverse(o => { if (o.isMesh) meshes.push(o); });
  const before = meshes.reduce((s, m) => s + (m.visible ? piecesOf(m) : 0), 0);

  const ids = new Map(), buckets = new Map(), taken = [];
  const idOf = m => { if (!ids.has(m)) ids.set(m, ids.size); return ids.get(m); };
  for (const mesh of meshes) {
    if (mesh === root || mesh.isInstancedMesh || mesh.isSkinnedMesh || !mesh.geometry.attributes.position
        || mesh.geometry.morphAttributes.position || !shown(mesh, root) || (keep && keep(mesh))) continue;
    // transparent meshes are drawn back to front by the position of each mesh: one merged mesh would change the picture
    if (!transparent && (Array.isArray(mesh.material) ? mesh.material.some(m => m.transparent) : mesh.material.transparent)) continue;
    const matrix = inverse.clone().multiply(mesh.matrixWorld);
    const mirrored = matrix.determinant() < 0;
    const list = Array.isArray(mesh.material) ? mesh.geometry.groups.map(g => [mesh.material[g.materialIndex], g]) : [[mesh.material, null]];
    for (const [material, group] of list) {
      if (!material) continue;
      const g = copyOf(mesh.geometry, group);
      g.applyMatrix4(matrix);
      if (mirrored) flipWinding(g);
      const key = [idOf(material), signature(g), mesh.renderOrder, mesh.castShadow, mesh.receiveShadow,
        mesh.layers.mask, mesh.frustumCulled].join('|');
      if (!buckets.has(key)) buckets.set(key, { material, mesh, parts: [] });
      buckets.get(key).parts.push(g);
    }
    taken.push(mesh);
  }

  for (const { material, mesh, parts } of buckets.values()) {
    const merged = parts.length === 1 ? parts[0] : mergeGeometries(parts);
    if (parts.length > 1) parts.forEach(g => g.dispose());
    const out = new mesh.constructor(merged, material);
    out.name = 'merged ' + (material.name || '');
    out.renderOrder = mesh.renderOrder; out.castShadow = mesh.castShadow;
    out.receiveShadow = mesh.receiveShadow; out.layers.mask = mesh.layers.mask;
    out.frustumCulled = mesh.frustumCulled;
    root.add(out);
  }
  for (const m of taken) { m.parent.remove(m); m.geometry.dispose(); }

  root.updateWorldMatrix(false, true);
  let after = 0;
  root.traverse(o => { if (o.isMesh && o.visible) after += piecesOf(o); });
  return { before, after };
}

export function sharpWhenStill(renderer, render, { moving = 1.5, delay = 150 } = {}) {
  const full = () => window.devicePixelRatio || 1;
  let queued = false, timer = 0, ratio = 0;
  const use = r => {
    // setPixelRatio keeps the size in CSS pixels and does not touch the style of the canvas
    if (r !== ratio) { ratio = r; renderer.setPixelRatio(r); }
  };
  const sharp = () => {
    timer = 0;
    if (ratio === full()) return;
    use(full()); render();
  };
  return function draw() {
    clearTimeout(timer); timer = setTimeout(sharp, delay);
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      use(timer ? Math.min(full(), moving) : full());
      render();
    });
  };
}
