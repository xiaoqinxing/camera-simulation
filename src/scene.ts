import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { Config, optics, personFacingAngle } from './core';

const PREVIEW_SAMPLES = 4;
const PREVIEW_SHADOW_SIZE = 1024;
const EXPORT_SHADOW_SIZE = 2048;
const FULL_HD_PIXELS = 1920 * 1080;

export interface Assessment { framing: string; ratio: number | null; occlusion: string; }
type Callbacks = { onAssessment: (a: Assessment) => void; onModel: (s: string, error?: boolean) => void };

const postVertex = `varying vec2 vUv; void main(){vUv=uv; gl_Position=vec4(position,1.0);}`;
const postFragment = `
  uniform sampler2D image; uniform float k1; uniform vec2 planeSize;
  varying vec2 vUv;
  void main() {
    vec2 pd=(vUv-0.5)*planeSize;
    float rd=length(pd); float r=rd;
    if (abs(k1)>0.000001 && rd>0.000001) {
      for (int i=0; i<16; i++) {
        float derivative=1.0+3.0*k1*r*r;
        if (derivative<0.0001) break;
        r=max(0.0,r-(r+k1*r*r*r-rd)/derivative);
      }
    }
    vec2 uv=rd>0.000001 ? (pd*(r/rd))/planeSize+0.5 : vUv;
    if (uv.x<0.0 || uv.x>1.0 || uv.y<0.0 || uv.y>1.0 || abs(r+k1*r*r*r-rd)>0.0005) {
      gl_FragColor=vec4(0.0,0.0,0.0,1.0);
    } else { gl_FragColor=texture2D(image,uv); }
    #include <colorspace_fragment>
  }
`;

const m = (color: THREE.ColorRepresentation, roughness = 0.8) => new THREE.MeshStandardMaterial({ color, roughness });
const lineMaterial = new THREE.LineBasicMaterial({ color: 0x43ddbd, transparent: true, opacity: 0.8 });
function box(w: number, h: number, d: number, material: THREE.Material, x: number, y: number, z: number) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  mesh.position.set(x, y, z); mesh.castShadow = true; mesh.receiveShadow = true;
  return mesh;
}
function disposeGroup(group: THREE.Group) {
  const materials = new Set<THREE.Material>();
  group.traverse(o => {
    if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) {
      o.geometry.dispose();
      (Array.isArray(o.material) ? o.material : [o.material]).forEach(material => materials.add(material));
    }
  });
  materials.forEach(material => material.dispose());
  group.clear();
}

export class Simulation {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private room = new THREE.Group();
  private furniture = new THREE.Group();
  private person = new THREE.Group();
  private helpers = new THREE.Group();
  private line = new THREE.Line(new THREE.BufferGeometry(), lineMaterial);
  private layoutCamera = new THREE.PerspectiveCamera(42, 1, 0.05, 100);
  private camera = new THREE.PerspectiveCamera(56.74, 16 / 9, 0.05, 100);
  // The visual helper is truncated at 5 m; its angles match the imaging camera.
  private helperCamera = new THREE.PerspectiveCamera(56.74, 16 / 9, 0.05, 5);
  private frustum = new THREE.CameraHelper(this.helperCamera);
  private cameraIcon = new THREE.Group();
  private controls: OrbitControls;
  private postScene = new THREE.Scene();
  private postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private postMaterial = new THREE.ShaderMaterial({
    uniforms: { image: { value: null }, k1: { value: 0 }, planeSize: { value: new THREE.Vector2(1, 1) } },
    vertexShader: postVertex, fragmentShader: postFragment, depthTest: false, depthWrite: false,
  });
  // The camera view is rendered off-screen, so the canvas `antialias` flag does not apply to it.
  // 4x MSAA is cheap for the small preview; export uses 2x at 4K to stay within integrated-GPU memory budgets.
  private target = new THREE.WebGLRenderTarget(16, 16, { depthBuffer: true, samples: PREVIEW_SAMPLES });
  private sun: THREE.DirectionalLight;
  private config: Config;
  private model: THREE.Object3D | null = null;
  private modelBox = new THREE.Box3();
  private modelHeight = 1.75;
  private lastPersonAngle = 0;
  private frame = 0;
  private stopped = false;
  private lastRoomKey = '';
  private lastAssessment = '';
  private observer: ResizeObserver;
  private abortModel = new AbortController();
  private modelTimer?: ReturnType<typeof setInterval>;

  constructor(private host: HTMLElement, private layout: HTMLElement, private cameraView: HTMLElement, config: Config, private callbacks: Callbacks) {
    this.config = config;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setClearColor(0x101a23);
    this.renderer.domElement.className = 'webgl-canvas';
    this.renderer.domElement.setAttribute('aria-hidden', 'true');
    host.prepend(this.renderer.domElement);
    // The off-screen pass stays linear; the post shader applies the display encoding once.
    this.scene.background = new THREE.Color(0xdde4e3);
    this.scene.add(this.room, this.furniture, this.person, this.helpers);
    this.scene.add(new THREE.HemisphereLight(0xe7f6ff, 0x918b80, 2.15));
    this.sun = new THREE.DirectionalLight(0xfff0d7, 2.0);
    this.sun.position.set(-3, 7, -2); this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(PREVIEW_SHADOW_SIZE, PREVIEW_SHADOW_SIZE);
    this.sun.shadow.camera.left = -8; this.sun.shadow.camera.right = 8;
    this.sun.shadow.camera.top = 8; this.sun.shadow.camera.bottom = -8;
    this.sun.shadow.bias = -0.00015;
    this.scene.add(this.sun);
    this.layoutCamera.position.set(7, 6.3, 8);
    this.layoutCamera.layers.enable(2);
    this.camera.layers.enable(1);
    this.controls = new OrbitControls(this.layoutCamera, layout);
    this.controls.target.set(0, 0.7, 0); this.controls.enableDamping = true;
    this.controls.minDistance = 2; this.controls.maxDistance = 30;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.addEventListener('change', () => this.updateLayoutWalls());
    this.controls.update();
    this.helpers.add(this.frustum, this.line, this.cameraIcon);
    const accent = new THREE.Color(0x4bd5b4), subtle = new THREE.Color(0x8bc8bb);
    this.frustum.setColors(accent, accent, accent, subtle, subtle);
    const iconBody = box(0.28, 0.18, 0.17, m(0x243b50, 0.5), 0, 0, 0);
    const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.12, 24), m(0x42d8bc, 0.4));
    lens.rotation.x = Math.PI / 2; lens.position.z = -0.13;
    this.cameraIcon.add(iconBody, lens);
    this.helpers.traverse(o => o.layers.set(2));
    this.postScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.postMaterial));
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(host);
    this.update(config);
    this.resize();
    this.loadModel();
    this.animate();
  }

  private loadModel() {
    this.callbacks.onModel('正在加载写实人物…');
    const url = `${import.meta.env.BASE_URL}assets/hsrd-hsr0040-body-023-web.glb`;
    let received = 0;
    this.modelTimer = setInterval(() => this.callbacks.onModel(`正在加载写实人物… 已下载 ${(received / 1048576).toFixed(1)} MB；网络较慢时请耐心等待。`), 1000);
    fetch(url, { signal: this.abortModel.signal }).then(response => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (!response.body) return response.arrayBuffer();
      const reader = response.body.getReader(), chunks: Uint8Array[] = [];
      const read = async (): Promise<ArrayBuffer> => {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          chunks.push(part.value); received += part.value.byteLength;
        }
        const data = new Uint8Array(received);
        let offset = 0; for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
        if (this.modelTimer) { clearInterval(this.modelTimer); this.modelTimer = undefined; }
        this.callbacks.onModel('人物下载完成，正在解析模型…');
        return data.buffer;
      };
      return read();
    }).then(data => new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(data, '')).then(gltf => {
      if (this.stopped) return;
      this.model = gltf.scene;
      const anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
      this.model.traverse(o => {
        if (!(o instanceof THREE.Mesh)) return;
        o.castShadow = true; o.receiveShadow = true;
        const materials = Array.isArray(o.material) ? o.material : [o.material];
        for (const material of materials) {
          const standard = material as THREE.MeshStandardMaterial;
          for (const texture of [standard.map, standard.normalMap, standard.roughnessMap, standard.metalnessMap, standard.aoMap, standard.emissiveMap]) {
            if (texture) texture.anisotropy = anisotropy;
          }
        }
      });
      this.model.updateMatrixWorld(true);
      this.modelBox.setFromObject(this.model);
      this.modelHeight = this.modelBox.max.y - this.modelBox.min.y;
      if (!(this.modelHeight > 0)) { this.callbacks.onModel('人物模型尺寸无效。', true); return; }
      this.model.position.y -= this.modelBox.min.y;
      this.modelBox.translate(new THREE.Vector3(0, -this.modelBox.min.y, 0));
      this.person.add(this.model);
      this.update(this.config);
      this.callbacks.onModel('写实人物已就绪 · HSRD-100');
    }).catch(() => { if (!this.stopped) this.callbacks.onModel('人物加载失败：请检查网络或离线包内的 GLB 文件。', true); })
      .finally(() => { if (this.modelTimer) clearInterval(this.modelTimer); });
  }

  private buildRoom(c: Config) {
    disposeGroup(this.room); disposeGroup(this.furniture);
    const { width: w, length: l, height: h } = c.room;
    const floorMat = m(0x8f9f9e), wallMat = m(0xe8e9e3), trimMat = m(0xaab7b2), wood = m(0xa77c58), dark = m(0x354756), fabric = m(0x556b73);
    this.room.add(box(w, 0.06, l, floorMat, 0, -0.03, 0));
    const wall = (a: THREE.Mesh, side: string) => { a.layers.set(1); a.castShadow = false; a.userData.wallSide = side; this.room.add(a); };
    wall(box(w, h, 0.04, wallMat, 0, h / 2, l / 2), 'z+');
    wall(box(w, h, 0.04, wallMat, 0, h / 2, -l / 2), 'z-');
    wall(box(0.04, h, l, wallMat, -w / 2, h / 2, 0), 'x-');
    wall(box(0.04, h, l, wallMat, w / 2, h / 2, 0), 'x+');
    wall(box(Math.min(1.5, w * 0.55), 0.8, 0.03, dark, 0, Math.min(h - 0.5, 1.6), l / 2 - 0.04), 'z+');
    wall(box(Math.min(1.7, w * 0.6), 0.12, 0.04, trimMat, 0, Math.min(h - 0.15, 2.45), l / 2 - 0.05), 'z+');
    const outline = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, l)), new THREE.LineBasicMaterial({ color: 0x879e9b, transparent: true, opacity: 0.65 }));
    outline.position.y = h / 2; outline.layers.set(2); this.room.add(outline);
    const gridSize = Math.ceil(Math.max(w, l));
    const grid = new THREE.GridHelper(gridSize, gridSize, 0x93b2ab, 0xabbfba);
    grid.position.y = 0.003; grid.layers.set(2);
    const gridMaterials = Array.isArray(grid.material) ? grid.material : [grid.material];
    gridMaterials.forEach(material => { material.depthTest = false; material.transparent = true; material.opacity = 0.55; });
    grid.renderOrder = 2; this.room.add(grid);
    this.furniture.add(box(1.2, 0.06, 2.2, wood, 0, 0.75, 0));
    for (const x of [-0.45, 0.45]) for (const z of [-0.93, 0.93]) this.furniture.add(box(0.08, 0.72, 0.08, dark, x, 0.36, z));
    // Chairs sit on the left and right sides, so their sides face the screen wall (+Z).
    for (const x of [-1.17, 1.17]) for (const z of [-0.65, 0.65]) {
      this.furniture.add(box(0.52, 0.12, 0.52, fabric, x, 0.49, z));
      this.furniture.add(box(0.09, 0.58, 0.52, fabric, x + (x > 0 ? 0.24 : -0.24), 0.78, z));
      for (const dx of [-0.19, 0.19]) for (const dz of [-0.19, 0.19]) this.furniture.add(box(0.035, 0.43, 0.035, dark, x + dx, 0.215, z + dz));
    }
    this.updateLayoutWalls();
  }

  private updateLayoutWalls() {
    for (const child of this.room.children) {
      const side = child.userData.wallSide as string | undefined;
      if (!side) continue;
      // Show the far walls for context while keeping the near walls out of the orbit view.
      const visible = side === 'x+' ? this.layoutCamera.position.x < 0 : side === 'x-' ? this.layoutCamera.position.x > 0 : side === 'z+' ? this.layoutCamera.position.z < 0 : this.layoutCamera.position.z > 0;
      if (visible) child.layers.enable(2); else child.layers.disable(2);
    }
  }

  update(c: Config) {
    this.config = c;
    const roomKey = JSON.stringify(c.room);
    if (roomKey !== this.lastRoomKey) { this.buildRoom(c); this.lastRoomKey = roomKey; }
    const o = optics(c);
    this.camera.fov = o.vfov; this.camera.aspect = o.aspect;
    this.camera.position.set(c.camera.x, c.camera.y, c.camera.z);
    const yaw = THREE.MathUtils.degToRad(c.camera.yaw), pitch = THREE.MathUtils.degToRad(c.camera.pitch);
    const direction = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
    this.camera.lookAt(this.camera.position.clone().add(direction));
    this.camera.updateProjectionMatrix(); this.camera.updateMatrixWorld(true);
    this.cameraIcon.position.copy(this.camera.position); this.cameraIcon.quaternion.copy(this.camera.quaternion);
    this.helperCamera.fov = this.camera.fov; this.helperCamera.aspect = this.camera.aspect;
    this.helperCamera.position.copy(this.camera.position); this.helperCamera.quaternion.copy(this.camera.quaternion);
    this.helperCamera.updateProjectionMatrix(); this.helperCamera.updateMatrixWorld(true);
    this.frustum.update();
    this.person.position.set(c.person.x, 0, c.person.z);
    this.person.scale.setScalar(c.person.height / this.modelHeight);
    this.lastPersonAngle = personFacingAngle(c, this.lastPersonAngle);
    this.person.rotation.set(0, this.lastPersonAngle, 0);
    this.person.updateMatrixWorld(true);
    this.line.geometry.dispose();
    this.line.geometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(c.camera.x, 0.015, c.camera.z), new THREE.Vector3(c.person.x, 0.015, c.person.z),
    ]);
    this.postMaterial.uniforms.k1.value = c.distortion.enabled ? c.distortion.k1 : 0;
    this.postMaterial.uniforms.planeSize.value.set(o.width / c.lens.focalLength, o.height / c.lens.focalLength);
    this.evaluate();
  }

  private evaluate() {
    if (!this.model) return;
    const c = this.config, o = optics(c), box = this.modelBox;
    const coords: THREE.Vector2[] = [];
    let behind = 0;
    // Sample the edges of the conservative local AABB; distortion can curve edges.
    const corners: THREE.Vector3[] = [];
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) corners.push(new THREE.Vector3(x, y, z));
    for (let a = 0; a < 8; a++) for (let b = a + 1; b < 8; b++) {
      if (((a ^ b) & ((a ^ b) - 1)) !== 0) continue;
      for (let i = 0; i <= 12; i++) {
        const p = corners[a].clone().lerp(corners[b], i / 12).applyMatrix4(this.person.matrixWorld);
        const v = p.clone().applyMatrix4(this.camera.matrixWorldInverse);
        if (-v.z <= this.camera.near) { behind++; continue; }
        let x = v.x / -v.z, y = v.y / -v.z;
        const k = c.distortion.enabled ? c.distortion.k1 : 0;
        const scale = 1 + k * (x * x + y * y); x *= scale; y *= scale;
        coords.push(new THREE.Vector2(x / (o.width / c.lens.focalLength) + 0.5, y / (o.height / c.lens.focalLength) + 0.5));
      }
    }
    if (behind && coords.length) return this.publish({ framing: '不确定（人物跨越近裁剪面）', ratio: null, occlusion: '无法可靠判断' });
    if (!coords.length) return this.publish({ framing: '完全画外（位于相机后方）', ratio: 0, occlusion: '不适用' });
    if (c.distortion.enabled && Math.abs(c.distortion.k1) > 1e-8) return this.publish({ framing: '畸变开启：入画不确定', ratio: null, occlusion: '畸变画面无法可靠判断' });
    const xs = coords.map(p => p.x), ys = coords.map(p => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const outside = maxX < 0 || minX > 1 || maxY < 0 || minY > 1;
    // Do not claim completeness where distorted boundaries could intersect the sampled box.
    const full = minX >= 0 && maxX <= 1 && minY >= 0 && maxY <= 1;
    const ratio = outside ? 0 : Math.max(0, Math.min(1, maxY) - Math.max(0, minY));
    let occlusion = '未发现采样点遮挡';
    if (!outside) {
      const raycaster = new THREE.Raycaster();
      const hits = [0.12, 0.45, 0.75, 0.92].filter(h => {
        const point = new THREE.Vector3(c.person.x, c.person.height * h, c.person.z);
        const delta = point.clone().sub(this.camera.position);
        raycaster.set(this.camera.position, delta.normalize()); raycaster.far = this.camera.position.distanceTo(point) - 0.05;
        raycaster.layers.enable(1);
        return raycaster.intersectObjects([this.furniture, this.room], true).some(hit => hit.object instanceof THREE.Mesh);
      }).length;
      if (hits) occlusion = `可能被遮挡（${hits}/4 个中心采样点）`;
    } else occlusion = '不适用';
    this.publish({ framing: outside ? '预计完全画外' : full ? '预计完整入画' : '部分出画或临界（保守估计）', ratio, occlusion });
  }

  private publish(a: Assessment) {
    const s = JSON.stringify(a);
    if (s !== this.lastAssessment) { this.lastAssessment = s; this.callbacks.onAssessment(a); }
  }

  private resize() {
    const rect = this.host.getBoundingClientRect();
    if (rect.width && rect.height) this.renderer.setSize(rect.width, rect.height, false);
  }
  private viewport(element: HTMLElement) {
    const h = this.host.getBoundingClientRect(), r = element.getBoundingClientRect();
    return { x: r.left - h.left, y: h.bottom - r.bottom, w: r.width, h: r.height };
  }
  private setShadowQuality(size: number) {
    const quality = Math.min(size, this.renderer.capabilities.maxTextureSize);
    if (this.sun.shadow.mapSize.x === quality) return;
    this.sun.shadow.mapSize.set(quality, quality);
    this.sun.shadow.map?.dispose();
    this.sun.shadow.map = null;
    this.sun.shadow.needsUpdate = true;
  }
  private renderCamera(w: number, h: number, target?: THREE.WebGLRenderTarget) {
    const destination = target ?? this.target;
    destination.setSize(Math.max(1, Math.floor(w)), Math.max(1, Math.floor(h)));
    this.renderer.setScissorTest(false);
    this.renderer.setRenderTarget(destination);
    this.renderer.clear(); this.renderer.render(this.scene, this.camera);
    this.postMaterial.uniforms.image.value = destination.texture;
    this.renderer.setRenderTarget(null);
  }
  private animate = () => {
    if (this.stopped) return;
    this.frame = requestAnimationFrame(this.animate);
    this.controls.update();
    const l = this.viewport(this.layout), v = this.viewport(this.cameraView);
    if (!l.w || !l.h || !v.w || !v.h) return;
    const pixel = this.renderer.getPixelRatio();
    this.renderCamera(v.w * pixel, v.h * pixel);
    this.renderer.setRenderTarget(null);
    this.renderer.setScissorTest(false);
    this.renderer.setViewport(0, 0, this.host.clientWidth, this.host.clientHeight);
    this.renderer.setClearColor(0x0b1217);
    this.renderer.clear();
    this.renderer.setScissorTest(true);
    this.renderer.setViewport(l.x, l.y, l.w, l.h); this.renderer.setScissor(l.x, l.y, l.w, l.h);
    this.layoutCamera.aspect = l.w / l.h; this.layoutCamera.updateProjectionMatrix();
    this.renderer.render(this.scene, this.layoutCamera);
    this.renderer.setViewport(v.x, v.y, v.w, v.h); this.renderer.setScissor(v.x, v.y, v.w, v.h);
    this.renderer.render(this.postScene, this.postCamera);
    this.renderer.setScissorTest(false);
  };

  async screenshot(): Promise<Blob> {
    const { width, height } = this.config.output;
    const gl = this.renderer.getContext();
    const max = Math.min(this.renderer.capabilities.maxTextureSize, gl.getParameter(gl.MAX_RENDERBUFFER_SIZE));
    if (width > max || height > max) throw new Error(`当前 GPU 最大渲染尺寸为 ${max} 像素，无法导出该分辨率。`);
    // The export renders into its own target so the preview stays at window resolution.
    // 4x MSAA up to 1080p; 2x above that (including 4K) keeps integrated-GPU memory use reasonable.
    const samples = width * height > FULL_HD_PIXELS ? 2 : 4;
    const sceneTarget = new THREE.WebGLRenderTarget(width, height, { depthBuffer: true, samples });
    const result = new THREE.WebGLRenderTarget(width, height, { depthBuffer: false });
    // The post shader outputs linear values; sRGB storage makes the GPU encode them on write,
    // matching the preview. readRenderTargetPixels then returns the encoded bytes.
    result.texture.colorSpace = THREE.SRGBColorSpace;
    // Export uses a higher shadow resolution than the 1024 px live preview; 2048 keeps
    // integrated-GPU memory use moderate while removing blocky shadow edges at 4K.
    this.setShadowQuality(EXPORT_SHADOW_SIZE);
    try {
      this.renderCamera(width, height, sceneTarget);
      this.renderer.setRenderTarget(result);
      this.renderer.render(this.postScene, this.postCamera);
      const bytes = new Uint8Array(width * height * 4);
      this.renderer.readRenderTargetPixels(result, 0, 0, width, height, bytes);
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('无法创建截图画布。');
      const image = ctx.createImageData(width, height);
      for (let y = 0; y < height; y++) image.data.set(bytes.subarray((height - 1 - y) * width * 4, (height - y) * width * 4), y * width * 4);
      ctx.putImageData(image, 0, 0);
      return await new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('PNG 编码失败。')), 'image/png'));
    } finally {
      this.renderer.setRenderTarget(null);
      sceneTarget.dispose(); result.dispose();
      this.setShadowQuality(PREVIEW_SHADOW_SIZE);
      this.postMaterial.uniforms.image.value = this.target.texture;
    }
  }
  resetView() { this.layoutCamera.position.set(7, 6.3, 8); this.controls.target.set(0, 0.7, 0); this.controls.update(); }
  dispose() {
    this.stopped = true; this.abortModel.abort(); if (this.modelTimer) clearInterval(this.modelTimer); cancelAnimationFrame(this.frame); this.observer.disconnect(); this.controls.dispose();
    disposeGroup(this.room); disposeGroup(this.furniture);
    this.target.dispose(); this.postMaterial.dispose(); this.renderer.dispose(); this.renderer.domElement.remove();
  }
}
