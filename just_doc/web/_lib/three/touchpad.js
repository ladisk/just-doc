// just-doc: touchpad navigation for a three.js view with OrbitControls.
//
//   import { touchpad } from '/_lib/three/touchpad.js';
//   touchpad(controls);
//
// On the view: two-finger scroll pans, pinch zooms (toward the cursor when controls.zoomToCursor
// is set), shift + two-finger scroll orbits; a mouse wheel zooms as before, and dragging orbits
// as before. Moves stop when the fingers stop (no damping). The page does not scroll while the
// pointer is over the view. Returns a function that takes the handling off again.
import { Vector2, Vector3, Raycaster, Plane } from './three.module.js';

export function touchpad(controls) {
  const el = controls.domElement, camera = controls.object;

  // a mouse wheel moves in steps (lines, or 100 / 120 pixels), straight up and down
  const wheel = e => e.deltaMode === 1
    || (e.deltaX === 0 && Math.abs(e.deltaY) >= 50 && (Math.abs(e.deltaY) % 120 === 0 || Math.abs(e.deltaY) % 100 === 0));

  // world units per pixel at the target
  function perPixel() {
    if (camera.isOrthographicCamera) return (camera.top - camera.bottom) / camera.zoom / el.clientHeight;
    const distance = camera.position.distanceTo(controls.target);
    return 2 * distance * Math.tan((camera.fov * Math.PI) / 360) / el.clientHeight;
  }

  function pan(dx, dy) {
    const k = perPixel() * controls.panSpeed;
    const right = new Vector3().setFromMatrixColumn(camera.matrix, 0);
    const up = new Vector3().setFromMatrixColumn(camera.matrix, 1);
    // the view moves as a page would scroll
    const move = right.multiplyScalar(dx * k).add(up.multiplyScalar(-dy * k));
    camera.position.add(move);
    controls.target.add(move);
  }

  // the point on the plane through the target, facing the camera, under the pointer
  function pointer(e) {
    const r = el.getBoundingClientRect();
    const ndc = new Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const ray = new Raycaster();
    ray.setFromCamera(ndc, camera);
    const normal = camera.getWorldDirection(new Vector3());
    return ray.ray.intersectPlane(new Plane().setFromNormalAndCoplanarPoint(normal, controls.target), new Vector3());
  }

  function zoom(e, amount) {
    // amount > 0: away; a pinch of 100 pixels is about a factor e
    const f = Math.exp(amount * 0.01 * controls.zoomSpeed);
    if (camera.isOrthographicCamera) {
      camera.zoom = Math.min(controls.maxZoom, Math.max(controls.minZoom, camera.zoom / f));
      camera.updateProjectionMatrix();
      return;
    }
    const offset = camera.position.clone().sub(controls.target);
    const length = Math.min(controls.maxDistance, Math.max(controls.minDistance, offset.length() * f));
    const g = length / offset.length();
    const at = controls.zoomToCursor ? pointer(e) : null;
    if (at) {
      // the point under the pointer stays where it is
      controls.target.lerp(at, 1 - g);
    }
    camera.position.copy(controls.target).add(offset.multiplyScalar(g));
  }

  function orbit(dx, dy) {
    const k = (2 * Math.PI * controls.rotateSpeed) / el.clientHeight;
    const offset = camera.position.clone().sub(controls.target);
    const up = camera.up.clone().normalize();
    // around the up axis, then around the right axis
    offset.applyAxisAngle(up, -dx * k);
    const right = new Vector3().crossVectors(up, offset).normalize();
    const turned = offset.clone().applyAxisAngle(right, dy * k);
    // not over the pole
    if (Math.abs(turned.clone().normalize().dot(up)) < 0.999) offset.copy(turned);
    camera.position.copy(controls.target).add(offset);
  }

  function onWheel(e) {
    if (!controls.enabled || wheel(e)) return;   // a mouse wheel: OrbitControls zooms
    e.preventDefault();
    e.stopImmediatePropagation();
    const scale = e.deltaMode === 2 ? el.clientHeight : 1;
    const dx = e.deltaX * scale, dy = e.deltaY * scale;
    if (e.ctrlKey) {
      if (controls.enableZoom) zoom(e, dy);
    } else if (e.shiftKey) {
      if (controls.enableRotate) orbit(dx, dy);
    } else if (controls.enablePan) pan(dx, dy);
    controls.update();
  }

  // before the wheel handling of OrbitControls on the same element
  el.addEventListener('wheel', onWheel, { capture: true, passive: false });
  return () => el.removeEventListener('wheel', onWheel, { capture: true });
}
