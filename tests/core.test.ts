import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { aimAtPerson, CAMERA_WALL_INSET, CAMERA_WALL_TOP_GAP, cameraWallPose, cloneConfig, DEFAULT_CONFIG, distances, focalFromFov, fovFromSize, halfBodyRatio, optics, PORTRAIT_HEIGHT, personFacingAngle, summary, validateConfig, wallCamera, withDistance } from '../src/core';

describe('光学计算', () => {
  it('符合指定 2 μm / 3840×2160 / 4 mm 样例', () => {
    const o = optics(DEFAULT_CONFIG);
    expect(o.sensorW).toBeCloseTo(7.68, 8); expect(o.sensorH).toBeCloseTo(4.32, 8);
    expect(o.hfov).toBeCloseTo(87.661721, 5); expect(o.vfov).toBeCloseTo(56.738093, 5);
  });
  it('输出 4:3 时中心裁切，并计算实际成像区域', () => {
    const c = cloneConfig(DEFAULT_CONFIG); c.output = { width: 1600, height: 1200 };
    const o = optics(c);
    expect(o.width).toBeCloseTo(5.76); expect(o.height).toBeCloseTo(4.32);
    expect(o.hfov).toBeCloseTo(71.5078, 3); expect(o.vfov).toBeCloseTo(56.7381, 3);
    expect(o.fullHfov).toBeCloseTo(87.6617, 3);
  });
  it('焦距和视场角双向互逆，增大焦距缩小视场', () => {
    for (const size of [1, 4.32, 7.68, 12]) for (const f of [0.5, 4, 15, 50]) {
      expect(focalFromFov(size, fovFromSize(size, f))).toBeCloseTo(f, 8);
      expect(fovFromSize(size, f * 2)).toBeLessThan(fovFromSize(size, f));
    }
  });
  it('Three.js 透视投影上下左右视角与计算值一致', () => {
    for (const output of [{ width: 1920, height: 1080 }, { width: 1600, height: 1200 }, { width: 1080, height: 1920 }]) {
      const c = cloneConfig(DEFAULT_CONFIG); c.output = output; const o = optics(c);
      const camera = new THREE.PerspectiveCamera(o.vfov, o.aspect, 0.05, 100); camera.updateProjectionMatrix();
      const top = new THREE.Vector3(0, Math.tan(THREE.MathUtils.degToRad(o.vfov / 2)), -1).project(camera);
      const right = new THREE.Vector3(Math.tan(THREE.MathUtils.degToRad(o.hfov / 2)), 0, -1).project(camera);
      expect(top.y).toBeCloseTo(1, 8); expect(right.x).toBeCloseTo(1, 8);
    }
  });
  it('距离增加时，固定条件下透视高度占比减小', () => {
    const c = cloneConfig(DEFAULT_CONFIG), camera = new THREE.PerspectiveCamera(optics(c).vfov, optics(c).aspect, 0.05, 100);
    const projectedHeight = (z: number) => Math.abs(new THREE.Vector3(0, 1, -z).project(camera).y - new THREE.Vector3(0, 0, -z).project(camera).y);
    expect(projectedHeight(4)).toBeLessThan(projectedHeight(2));
  });
  it('半身人像占比默认约 20.4%，并与 Three.js 投影一致', () => {
    const c = DEFAULT_CONFIG, o = optics(c);
    const camera = new THREE.PerspectiveCamera(o.vfov, o.aspect, 0.05, 100);
    camera.position.set(c.camera.x, c.camera.y, c.camera.z);
    const yaw = THREE.MathUtils.degToRad(c.camera.yaw), pitch = THREE.MathUtils.degToRad(c.camera.pitch);
    camera.lookAt(camera.position.clone().add(new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch))));
    camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
    const top = new THREE.Vector3(c.person.x, c.person.height, c.person.z).project(camera);
    const bottom = new THREE.Vector3(c.person.x, c.person.height - PORTRAIT_HEIGHT, c.person.z).project(camera);
    const expected = Math.abs(top.y - bottom.y) / 2;
    const ratio = halfBodyRatio(c);
    expect(ratio).not.toBeNull();
    expect(ratio!).toBeCloseTo(expected, 10);
    expect(ratio!).toBeCloseTo(0.2036, 3);
  });
  it('半身人像占比随距离减小、随焦距增大', () => {
    const near = halfBodyRatio(withDistance(DEFAULT_CONFIG, 2)), far = halfBodyRatio(withDistance(DEFAULT_CONFIG, 5));
    expect(near).not.toBeNull(); expect(far).not.toBeNull();
    expect(near!).toBeGreaterThan(far!);
    const long = cloneConfig(DEFAULT_CONFIG); long.lens.focalLength = 8;
    expect(halfBodyRatio(long)!).toBeGreaterThan(halfBodyRatio(DEFAULT_CONFIG)!);
  });
  it('人物位于相机后方时半身人像占比不可用', () => {
    const c = cloneConfig(DEFAULT_CONFIG);
    c.person.x = c.camera.x + 1; c.person.z = c.camera.z + 2;
    expect(halfBodyRatio(c)).toBeNull();
  });
});

describe('墙面快捷机位', () => {
  it('默认机位在屏幕墙顶部中央并对准人物中点', () => {
    const c = DEFAULT_CONFIG;
    expect(c.camera.x).toBeCloseTo(0, 8);
    expect(c.camera.z).toBeCloseTo(c.room.length / 2 - CAMERA_WALL_INSET, 8);
    expect(c.camera.y).toBeCloseTo(c.room.height - CAMERA_WALL_TOP_GAP, 8);
    const aimed = aimAtPerson(c).camera;
    expect(c.camera.yaw).toBeCloseTo(aimed.yaw, 10);
    expect(c.camera.pitch).toBeCloseTo(aimed.pitch, 10);
  });
  it('四个机位位于各墙水平中心、顶部并对准人物', () => {
    const c = DEFAULT_CONFIG, top = c.room.height - CAMERA_WALL_TOP_GAP;
    const screen = cameraWallPose(c, 'screen'), opposite = cameraWallPose(c, 'opposite');
    const left = cameraWallPose(c, 'left'), right = cameraWallPose(c, 'right');
    expect(screen.x).toBeCloseTo(0); expect(screen.z).toBeCloseTo(c.room.length / 2 - CAMERA_WALL_INSET);
    expect(opposite.x).toBeCloseTo(0); expect(opposite.z).toBeCloseTo(-(c.room.length / 2 - CAMERA_WALL_INSET));
    expect(left.z).toBeCloseTo(0); expect(left.x).toBeCloseTo(-(c.room.width / 2 - CAMERA_WALL_INSET));
    expect(right.z).toBeCloseTo(0); expect(right.x).toBeCloseTo(c.room.width / 2 - CAMERA_WALL_INSET);
    for (const pose of [screen, opposite, left, right]) {
      expect(pose.y).toBeCloseTo(top);
      const aimed = aimAtPerson({ ...c, camera: pose }).camera;
      expect(pose.yaw).toBeCloseTo(aimed.yaw, 10);
      expect(pose.pitch).toBeCloseTo(aimed.pitch, 10);
    }
  });
  it('房间尺寸变化后机位随之调整，且不修改原配置', () => {
    const c = cloneConfig(DEFAULT_CONFIG);
    c.room = { length: 7, width: 6, height: 3 };
    const placed = wallCamera(c, 'screen');
    expect(placed.camera.z).toBeCloseTo(3.35, 8);
    expect(placed.camera.y).toBeCloseTo(2.9, 8);
    expect(c.camera).toEqual(DEFAULT_CONFIG.camera);
  });
  it('人物与机位水平重合时朝向室内且保持水平', () => {
    const c = cloneConfig(DEFAULT_CONFIG);
    const expected = { screen: 180, opposite: 0, left: 90, right: -90 } as const;
    for (const wall of ['screen', 'opposite', 'left', 'right'] as const) {
      const anchor = cameraWallPose(c, wall);
      const pose = cameraWallPose({ room: c.room, person: { ...c.person, x: anchor.x, z: anchor.z } }, wall);
      expect(pose.yaw).toBe(expected[wall]);
      expect(pose.pitch).toBe(0);
    }
  });
});

describe('状态和配置', () => {
  it('水平距离沿原方向移动，三维距离使用身高中点', () => {
    const origin = distances(DEFAULT_CONFIG), c = withDistance(DEFAULT_CONFIG, 5), d = distances(c);
    expect(d.horizontal).toBeCloseTo(5);
    expect(c.person.x - DEFAULT_CONFIG.camera.x).toBeCloseTo((DEFAULT_CONFIG.person.x - DEFAULT_CONFIG.camera.x) * 5 / origin.horizontal);
    expect(d.spatial).toBeCloseTo(Math.hypot(5, DEFAULT_CONFIG.camera.y - 1.75 / 2));
  });
  it('对准人物是一次性角度计算', () => {
    const c = aimAtPerson(DEFAULT_CONFIG);
    expect(c.camera.yaw).toBeCloseTo(-153.5326, 4); expect(c.camera.pitch).toBeCloseTo(-34.807, 4);
    const changed = cloneConfig(c); changed.person.x += 1;
    expect(changed.camera.yaw).toEqual(c.camera.yaw);
  });
  it('默认人物位于两把椅子之间、桌子旁', () => {
    expect(DEFAULT_CONFIG.person.x).toBeCloseTo(-1.17, 8);
    expect(DEFAULT_CONFIG.person.z).toBeCloseTo(0, 8);
  });
  it('人物只在水平面转向，相机高度无影响，重合时保持朝向', () => {
    const c = cloneConfig(DEFAULT_CONFIG);
    const previous = personFacingAngle(c, 0);
    c.camera.y = 8; expect(personFacingAngle(c, 0)).toBe(previous);
    c.camera.x += 1; expect(personFacingAngle(c, 0)).not.toBe(previous);
    c.camera.x = c.person.x; c.camera.z = c.person.z; expect(personFacingAngle(c, 0.4)).toBe(0.4);
  });
  it('配置 JSON 往返和整体校验', () => {
    const c = cloneConfig(DEFAULT_CONFIG); c.room.width = 6; c.lens.focalLength = 8; c.distortion = { enabled: true, k1: 0.1 };
    const loaded = JSON.parse(JSON.stringify(c)); expect(validateConfig(loaded)).toBeNull(); expect(loaded).toEqual(c);
    expect(summary(loaded)).toContain('实际焦距：8.00 mm');
    expect(summary(loaded)).toContain('半身人像占比');
    loaded.output.width = 0; expect(validateConfig(loaded)).toMatch(/output.width/);
    loaded.output.width = 1920; loaded.lens.pixelSize = NaN; expect(validateConfig(loaded)).toMatch(/lens.pixelSize/);
    expect(validateConfig({ version: 99 })).toMatch(/版本/);
  });
  it('拒绝桶形映射在视场内变得不稳定的组合', () => {
    const c = cloneConfig(DEFAULT_CONFIG); c.distortion = { enabled: true, k1: -0.35 };
    expect(validateConfig(c)).toMatch(/畸变过强/);
    c.distortion.enabled = false; expect(validateConfig(c)).toBeNull();
  });
});
