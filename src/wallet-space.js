import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { payloadToSpace } from './wallet-space-math.js';

export const WALLET_SPACE_STYLES = {
  session: { label: 'Current demo wallet', color: 0xb6f36b, cssColor: '#b6f36b', size: 0.072, opacity: 1 },
  search: { label: 'Loaded / searched addresses', color: 0x55b9f7, cssColor: '#55b9f7', size: 0.058, opacity: 0.96 },
  recovery: { label: 'Recovered public addresses', color: 0xd98cff, cssColor: '#d98cff', size: 0.058, opacity: 0.96 },
  scan: { label: 'Server-scan addresses', color: 0xffbf69, cssColor: '#ffbf69', size: 0.058, opacity: 0.96 },
  puzzle: { label: 'Published puzzle catalog', color: 0x6f9fbd, cssColor: '#6f9fbd', size: 0.042, opacity: 0.82 },
};

const INITIAL_CAMERA = new THREE.Vector3(2.65, 2.05, 2.85);

/** Create an interactive WebGL view containing public address points only. */
export function createWalletSpace({ container, points, onSelect = () => {} }) {
  if (!container) throw new Error('The 3D container is unavailable.');
  if (!Array.isArray(points)) throw new TypeError('Wallet space points must be an array.');

  const enrichedPoints = points.map((point) => ({
    ...point,
    space: payloadToSpace(point.payload),
  }));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, 1, 0.01, 100);
  camera.position.copy(INITIAL_CAMERA);

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  } catch {
    throw new Error('WebGL is unavailable. Enable hardware acceleration or try a current browser.');
  }
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));
  renderer.domElement.tabIndex = 0;
  renderer.domElement.setAttribute('aria-label', 'Interactive 3D public-address map. Drag to rotate and use the wheel to zoom.');
  container.replaceChildren(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = !globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  controls.dampingFactor = 0.075;
  controls.rotateSpeed = 0.65;
  controls.zoomSpeed = 0.9;
  controls.panSpeed = 0.65;
  controls.minDistance = 0.3;
  controls.maxDistance = 9;
  controls.target.set(0, 0, 0);
  controls.update();

  const cube = new THREE.Box3(
    new THREE.Vector3(-1, -1, -1),
    new THREE.Vector3(1, 1, 1),
  );
  const bounds = new THREE.Box3Helper(cube, 0x294354);
  bounds.material.transparent = true;
  bounds.material.opacity = 0.65;
  scene.add(bounds);

  const floor = new THREE.GridHelper(2, 8, 0x285064, 0x172f3d);
  floor.position.y = -1.015;
  floor.material.transparent = true;
  floor.material.opacity = 0.6;
  scene.add(floor);

  const axes = new THREE.AxesHelper(1.12);
  axes.material.transparent = true;
  axes.material.opacity = 0.65;
  scene.add(axes);

  const pointMeshes = [];
  const grouped = new Map();
  for (const point of enrichedPoints) {
    const source = WALLET_SPACE_STYLES[point.source] ? point.source : 'search';
    if (!grouped.has(source)) grouped.set(source, []);
    grouped.get(source).push(point);
  }

  for (const [source, groupPoints] of grouped) {
    const style = WALLET_SPACE_STYLES[source];
    const positions = new Float32Array(groupPoints.length * 3);
    groupPoints.forEach((point, index) => positions.set(point.space.position, index * 3));
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.computeBoundingSphere();
    const material = new THREE.PointsMaterial({
      color: style.color,
      size: style.size,
      sizeAttenuation: true,
      transparent: true,
      opacity: style.opacity,
      depthWrite: false,
    });
    const cloud = new THREE.Points(geometry, material);
    cloud.userData.points = groupPoints;
    cloud.userData.source = source;
    cloud.renderOrder = source === 'puzzle' ? 1 : 2;
    scene.add(cloud);
    pointMeshes.push(cloud);
  }

  const selectedMarker = new THREE.Mesh(
    new THREE.SphereGeometry(0.085, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: 0.9, depthTest: false }),
  );
  selectedMarker.visible = false;
  selectedMarker.renderOrder = 20;
  scene.add(selectedMarker);

  const raycaster = new THREE.Raycaster();
  raycaster.params.Points.threshold = 0.045;
  const pointer = new THREE.Vector2();
  let pointerStart = null;
  let animationFrame = 0;
  let destroyed = false;

  function selectIntersection(event) {
    const rectangle = renderer.domElement.getBoundingClientRect();
    if (!rectangle.width || !rectangle.height) return;
    pointer.set(
      ((event.clientX - rectangle.left) / rectangle.width) * 2 - 1,
      -((event.clientY - rectangle.top) / rectangle.height) * 2 + 1,
    );
    raycaster.setFromCamera(pointer, camera);
    const [hit] = raycaster.intersectObjects(pointMeshes, false);
    if (!hit || hit.index == null) return;
    const point = hit.object.userData.points[hit.index];
    if (!point) return;
    selectedMarker.position.fromBufferAttribute(hit.object.geometry.getAttribute('position'), hit.index);
    selectedMarker.visible = true;
    onSelect(point);
  }

  function onPointerDown(event) {
    pointerStart = { x: event.clientX, y: event.clientY, id: event.pointerId };
  }

  function onPointerUp(event) {
    if (!pointerStart || pointerStart.id !== event.pointerId) return;
    const distance = Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y);
    pointerStart = null;
    if (distance <= 5) selectIntersection(event);
  }

  function onKeyDown(event) {
    if (event.key === '+' || event.key === '=') { event.preventDefault(); zoom(0.8); }
    if (event.key === '-') { event.preventDefault(); zoom(1.25); }
    if (event.key === '0') { event.preventDefault(); reset(); }
  }

  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  renderer.domElement.addEventListener('pointerup', onPointerUp);
  renderer.domElement.addEventListener('keydown', onKeyDown);

  function resize() {
    if (destroyed) return;
    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
  if (resizeObserver) resizeObserver.observe(container);
  else globalThis.addEventListener?.('resize', resize);
  resize();

  function animate() {
    if (destroyed) return;
    controls.update();
    renderer.render(scene, camera);
    animationFrame = requestAnimationFrame(animate);
  }
  animate();

  function zoom(factor) {
    const offset = camera.position.clone().sub(controls.target);
    const distance = THREE.MathUtils.clamp(offset.length() * factor, controls.minDistance, controls.maxDistance);
    offset.setLength(distance);
    camera.position.copy(controls.target).add(offset);
    controls.update();
  }

  function reset() {
    camera.position.copy(INITIAL_CAMERA);
    controls.target.set(0, 0, 0);
    controls.update();
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    cancelAnimationFrame(animationFrame);
    resizeObserver?.disconnect();
    if (!resizeObserver) globalThis.removeEventListener?.('resize', resize);
    renderer.domElement.removeEventListener('pointerdown', onPointerDown);
    renderer.domElement.removeEventListener('pointerup', onPointerUp);
    renderer.domElement.removeEventListener('keydown', onKeyDown);
    controls.dispose();
    scene.traverse((object) => {
      object.geometry?.dispose?.();
      if (Array.isArray(object.material)) object.material.forEach((material) => material.dispose?.());
      else object.material?.dispose?.();
    });
    renderer.dispose();
    renderer.domElement.remove();
  }

  return {
    points: enrichedPoints,
    zoomIn: () => zoom(0.8),
    zoomOut: () => zoom(1.25),
    reset,
    resize,
    destroy,
  };
}
