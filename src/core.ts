export interface Config {
  version: 1;
  room: { length: number; width: number; height: number };
  person: { height: number; x: number; z: number };
  camera: { x: number; y: number; z: number; yaw: number; pitch: number };
  lens: { pixelSize: number; sensorWidth: number; sensorHeight: number; focalLength: number };
  output: { width: number; height: number };
  distortion: { enabled: boolean; k1: number };
}

export type CameraWall = 'screen' | 'opposite' | 'left' | 'right';
export const CAMERA_WALL_INSET = 0.15;
export const CAMERA_WALL_TOP_GAP = 0.1;
/** Half-body reference height from the top of the head down to roughly the waist, in metres. */
export const PORTRAIT_HEIGHT = 0.7;

const deg = (r: number) => r * 180 / Math.PI;
const rad = (d: number) => d * Math.PI / 180;
const DEFAULT_ROOM: Config['room'] = { length: 5, width: 4, height: 2.8 };
const DEFAULT_PERSON: Config['person'] = { height: 1.75, x: -1.17, z: 0 };

/** Top-centre camera pose on a wall, aimed at the person's mid-height. */
export function cameraWallPose(c: Pick<Config, 'room' | 'person'>, wall: CameraWall): Config['camera'] {
  const y = c.room.height - CAMERA_WALL_TOP_GAP;
  const acrossLength = c.room.length / 2 - CAMERA_WALL_INSET;
  const acrossWidth = c.room.width / 2 - CAMERA_WALL_INSET;
  let x: number, z: number, inwardYaw: number;
  switch (wall) {
    case 'screen': x = 0; z = acrossLength; inwardYaw = 180; break;
    case 'opposite': x = 0; z = -acrossLength; inwardYaw = 0; break;
    case 'left': x = -acrossWidth; z = 0; inwardYaw = 90; break;
    case 'right': x = acrossWidth; z = 0; inwardYaw = -90; break;
  }
  const dx = c.person.x - x, dz = c.person.z - z;
  const horizontal = Math.hypot(dx, dz);
  if (horizontal <= 1e-8) return { x, y, z, yaw: inwardYaw, pitch: 0 };
  return {
    x, y, z,
    yaw: deg(Math.atan2(dx, dz)),
    pitch: deg(Math.atan2(c.person.height / 2 - y, horizontal)),
  };
}

export const DEFAULT_CONFIG: Config = {
  version: 1,
  room: { ...DEFAULT_ROOM },
  person: { ...DEFAULT_PERSON },
  camera: cameraWallPose({ room: DEFAULT_ROOM, person: DEFAULT_PERSON }, 'screen'),
  lens: { pixelSize: 2, sensorWidth: 3840, sensorHeight: 2160, focalLength: 4 },
  output: { width: 1920, height: 1080 },
  distortion: { enabled: false, k1: 0 },
};

export const cloneConfig = (c: Config): Config => JSON.parse(JSON.stringify(c)) as Config;

export function wallCamera(c: Config, wall: CameraWall): Config {
  const next = cloneConfig(c);
  next.camera = cameraWallPose(c, wall);
  return next;
}
/** Adjustable field-of-view range, in degrees. */
export const MIN_FOV = 0.1;
export const MAX_FOV = 179;

export const fovFromSize = (size: number, focal: number) => deg(2 * Math.atan(size / (2 * focal)));
export const focalFromFov = (size: number, fov: number) => size / (2 * Math.tan(rad(fov) / 2));

export function optics(c: Config) {
  const sensorW = c.lens.pixelSize * c.lens.sensorWidth / 1000;
  const sensorH = c.lens.pixelSize * c.lens.sensorHeight / 1000;
  const aspect = c.output.width / c.output.height;
  const width = Math.min(sensorW, sensorH * aspect);
  const height = Math.min(sensorH, sensorW / aspect);
  const f = c.lens.focalLength;
  return {
    sensorW, sensorH, width, height, aspect,
    fullHfov: fovFromSize(sensorW, f), fullVfov: fovFromSize(sensorH, f),
    hfov: fovFromSize(width, f), vfov: fovFromSize(height, f),
    dfov: fovFromSize(Math.hypot(width, height), f),
    r2max: (width * width + height * height) / (4 * f * f),
  };
}

/**
 * Focal-length bounds (mm) covering every setting where either cropped
 * dimension can reach [MIN_FOV, MAX_FOV]. The other dimension follows the
 * output aspect and may go slightly outside that range.
 */
export function focalRange(o: ReturnType<typeof optics>) {
  return {
    min: focalFromFov(Math.min(o.width, o.height), MAX_FOV),
    max: focalFromFov(Math.max(o.width, o.height), MIN_FOV),
  };
}

/**
 * Distortion percentages derived from the preview model r' = r + k1·r³,
 * where r is the ideal (pinhole) image radius normalised by focal length,
 * i.e. r = imageHeight / focalLength = tan(field angle).
 * Returned values are fractions: multiply by 100 for percent.
 *   optical: (r' - r) / r = k1·r² (radial/geometric distortion at that field).
 *   tv: traditional RIAA/ISO TV distortion, edge sag divided by frame size.
 */
export function distortionMetrics(c: Config) {
  const o = optics(c), f = c.lens.focalLength;
  const k1 = c.distortion.enabled ? c.distortion.k1 : 0;
  const x = o.width / (2 * f), y = o.height / (2 * f);
  const corner2 = x * x + y * y;
  const long2 = Math.max(x, y) ** 2;
  const tvLongEdge = k1 * long2 / 2;
  return {
    enabled: c.distortion.enabled,
    k1,
    // Maximum-field optical distortion, at the image corner.
    opticalCorner: k1 * corner2,
    // Optical distortion at the mid-point of the long edge.
    opticalLongEdge: k1 * long2,
    // Traditional TV distortion on the long edge; SMIA is twice as large.
    tvLongEdge,
    smiaTvLongEdge: tvLongEdge * 2,
  };
}

export function distances(c: Config) {
  const horizontal = Math.hypot(c.person.x - c.camera.x, c.person.z - c.camera.z);
  return { horizontal, spatial: Math.hypot(horizontal, c.person.height / 2 - c.camera.y) };
}

/**
 * Frame-height fraction of the top-down half-body reference segment.
 * The segment runs from the top of the head down PORTRAIT_HEIGHT metres.
 * This is an undistorted theoretical value and is not clipped to the frame.
 * Returns null when either endpoint is at or behind the camera.
 */
export function halfBodyRatio(c: Config): number | null {
  const yaw = rad(c.camera.yaw), pitch = rad(c.camera.pitch);
  const fx = Math.sin(yaw) * Math.cos(pitch), fy = Math.sin(pitch), fz = Math.cos(yaw) * Math.cos(pitch);
  const horizontal = Math.hypot(fx, fz);
  // Camera has no roll: right = normalize(up × backward); cameraUp = backward × right.
  const rx = horizontal > 1e-8 ? -fz / horizontal : 1, rz = horizontal > 1e-8 ? fx / horizontal : 0;
  const ux = -fy * rz, uy = -fz * rx + fx * rz, uz = fy * rx;
  const tangent = (y: number) => {
    const dx = c.person.x - c.camera.x, dy = y - c.camera.y, dz = c.person.z - c.camera.z;
    const depth = dx * fx + dy * fy + dz * fz;
    if (depth <= 1e-8) return null;
    return (dx * ux + dy * uy + dz * uz) / depth;
  };
  const top = tangent(c.person.height), bottom = tangent(c.person.height - PORTRAIT_HEIGHT);
  if (top === null || bottom === null) return null;
  return Math.abs(top - bottom) / (2 * Math.tan(rad(optics(c).vfov) / 2));
}

/** Only a yaw is computed; camera height deliberately has no effect. */
export function personFacingAngle(c: Config, previous: number): number {
  const dx = c.camera.x - c.person.x, dz = c.camera.z - c.person.z;
  return Math.hypot(dx, dz) > 1e-8 ? Math.atan2(dx, dz) : previous;
}

export function withDistance(c: Config, distance: number): Config {
  const next = cloneConfig(c);
  let dx = c.person.x - c.camera.x, dz = c.person.z - c.camera.z;
  const old = Math.hypot(dx, dz);
  if (old < 1e-8) { dx = 0; dz = 1; } else { dx /= old; dz /= old; }
  next.person.x = c.camera.x + dx * distance;
  next.person.z = c.camera.z + dz * distance;
  return next;
}

export function aimAtPerson(c: Config): Config {
  const next = cloneConfig(c);
  const dx = c.person.x - c.camera.x, dz = c.person.z - c.camera.z;
  const d = Math.hypot(dx, dz);
  if (d < 1e-8) throw new Error('摄像机与人物水平位置重合，无法确定水平朝向。');
  next.camera.yaw = deg(Math.atan2(dx, dz));
  next.camera.pitch = deg(Math.atan2(c.person.height / 2 - c.camera.y, d));
  return next;
}

const bounds: Record<string, [number, number, boolean?]> = {
  'room.length': [2, 12], 'room.width': [2, 10], 'room.height': [2, 5],
  'person.height': [1.2, 2.2], 'person.x': [-20, 20], 'person.z': [-20, 20],
  'camera.x': [-20, 20], 'camera.y': [0.05, 10], 'camera.z': [-20, 20],
  'camera.yaw': [-180, 180], 'camera.pitch': [-89, 89],
  'lens.pixelSize': [0.5, 10], 'lens.sensorWidth': [256, 12000, true],
  'lens.sensorHeight': [256, 12000, true], 'lens.focalLength': [0.0001, 100000],
  'output.width': [256, 4096, true], 'output.height': [256, 4096, true],
  'distortion.k1': [-0.35, 0.35],
};

/** Validate the entire object before applying it, including loaded files. */
export function validateConfig(input: unknown): string | null {
  if (!input || typeof input !== 'object') return '配置必须是 JSON 对象。';
  const obj = input as Record<string, unknown>;
  if (obj.version !== 1) return '不支持的配置版本，当前仅支持版本 1。';
  for (const [path, [min, max, integer]] of Object.entries(bounds)) {
    const [group, key] = path.split('.');
    const parent = obj[group];
    const value = parent && typeof parent === 'object' ? (parent as Record<string, unknown>)[key] : undefined;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
      return `${path} 必须是 ${min}–${max} 范围内的${integer ? '整数' : '有限数字'}。`;
    }
  }
  const d = obj.distortion as Record<string, unknown>;
  if (typeof d.enabled !== 'boolean') return 'distortion.enabled 必须是布尔值。';
  const c = input as Config;
  const o = optics(c);
  const fovs = [o.hfov, o.vfov];
  // One axis may fall outside [0.1°, 179°] when the output aspect differs:
  // the user can still set either displayed FOV to a limit and the other
  // dimension follows the aspect ratio. Both must stay inside the pinhole model.
  if (fovs.some(v => !(v > 0) || v >= 180)) return '计算出的视场角必须大于 0° 且小于 180°。';
  if (Math.max(...fovs) < MIN_FOV - 1e-6) return `计算出的视场角不能小于 ${MIN_FOV}°。`;
  if (Math.min(...fovs) > MAX_FOV + 1e-6) return `计算出的视场角不能大于 ${MAX_FOV}°。`;
  if (d.enabled && 1 + 3 * c.distortion.k1 * o.r2max < 0.4) {
    return '桶形畸变过强：该视场边缘的径向映射会失去稳定性，请减小强度。';
  }
  return null;
}

export function layoutWarnings(c: Config): string[] {
  const w: string[] = [];
  // Fixed 1.2 x 2.2 m table; chairs extend to x=±1.455 m and z=±0.91 m.
  if (c.room.width < 3.5 || c.room.length < 2.8) w.push('房间较小：固定尺寸的桌椅可能越界或缺少通行空间。');
  if (Math.abs(c.camera.x) > c.room.width / 2 || Math.abs(c.camera.z) > c.room.length / 2 || c.camera.y > c.room.height) w.push('摄像机位于房间边界之外。');
  if (Math.abs(c.person.x) > c.room.width / 2 || Math.abs(c.person.z) > c.room.length / 2 || c.person.height > c.room.height) w.push('人物位于房间边界之外或高于房间。');
  if (Math.abs(c.person.x) < 0.85 && Math.abs(c.person.z) < 1.35) w.push('人物可能与会议桌重叠；请调整人物位置。');
  if ([-1.17, 1.17].some(x => [-0.65, 0.65].some(z => Math.abs(c.person.x - x) < 0.5 && Math.abs(c.person.z - z) < 0.5))) w.push('人物可能与椅子重叠；请调整人物位置。');
  if (distances(c).horizontal < 1e-6) w.push('摄像机与人物水平位置重合：人物保留上一次朝向。');
  if (optics(c).hfov > 120 || optics(c).vfov > 120) w.push('视场角很大：直线透视模型可能不适用于真实超广角镜头。');
  return w;
}

export function summary(c: Config, status = ''): string {
  const o = optics(c), d = distances(c), dm = distortionMetrics(c), p = halfBodyRatio(c), n = (x: number) => x.toFixed(2);
  const pct = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(2)}%`;
  return [
    '镜界 · 摄像机效果仿真参数摘要', '用途：演示与初步选型；理论值不等于真实实测值。', '',
    `房间（长×宽×高）：${c.room.length} × ${c.room.width} × ${c.room.height} m`,
    `人物身高：${c.person.height} m；地面位置 X=${n(c.person.x)}、Z=${n(c.person.z)} m`,
    `水平距离：${n(d.horizontal)} m；摄像机到人物身高中点的三维距离：${n(d.spatial)} m`,
    `半身人像占比（头顶向下 ${PORTRAIT_HEIGHT} m）：${p === null ? '—' : `${(p * 100).toFixed(1)}%`}`,
    `摄像机位置 X=${n(c.camera.x)}、Y=${n(c.camera.y)}、Z=${n(c.camera.z)} m`,
    `水平角：${n(c.camera.yaw)}°；俯仰角：${n(c.camera.pitch)}°；横滚：0°`,
    `像素大小：${c.lens.pixelSize} μm；有效成像像素：${c.lens.sensorWidth} × ${c.lens.sensorHeight} px`,
    `有效成像尺寸：${n(o.sensorW)} × ${n(o.sensorH)} mm`,
    `实际焦距：${n(c.lens.focalLength)} mm；输出：${c.output.width} × ${c.output.height} px`,
    `中心裁切后成像尺寸：${n(o.width)} × ${n(o.height)} mm`,
    `画面无畸变理论视场角：水平 ${n(o.hfov)}°、垂直 ${n(o.vfov)}°、对角 ${n(o.dfov)}°`,
    `完整有效区域视场角：水平 ${n(o.fullHfov)}°、垂直 ${n(o.fullVfov)}°`,
    `畸变：${c.distortion.enabled ? `简化径向 k1=${c.distortion.k1}；光学畸变（画面角落）${pct(dm.opticalCorner)}，TV 畸变（长边）${pct(dm.tvLongEdge)}；采样越界为黑边` : '关闭'}`,
    status ? `人物画面评估：${status}` : '',
    '限制：未模拟真实镜头标定、ISP、噪声、动态范围、景深和自动曝光/白平衡。',
  ].filter(Boolean).join('\n') + '\n';
}
