import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { aimAtPerson, cloneConfig, DEFAULT_CONFIG, distances, focalFromFov, fovFromSize, optics, personFacingAngle, summary, validateConfig, withDistance } from '../src/core';

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
});

describe('状态和配置', () => {
  it('水平距离沿原方向移动，三维距离使用身高中点', () => {
    const c = withDistance(DEFAULT_CONFIG, 5), d = distances(c);
    expect(d.horizontal).toBeCloseTo(5); expect(c.person.x).toBeCloseTo(DEFAULT_CONFIG.person.x);
    expect(d.spatial).toBeCloseTo(Math.hypot(5, 1.6 - 1.75 / 2));
  });
  it('对准人物是一次性角度计算', () => {
    const c = aimAtPerson(DEFAULT_CONFIG);
    expect(c.camera.yaw).toBeCloseTo(0); expect(c.camera.pitch).toBeCloseTo(-13.585991, 4);
    const changed = cloneConfig(c); changed.person.x += 1;
    expect(changed.camera.yaw).toEqual(c.camera.yaw);
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
