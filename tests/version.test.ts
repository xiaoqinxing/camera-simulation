import { describe, expect, it } from 'vitest';
import { deriveVersion } from '../scripts/version.mjs';

describe('版本号', () => {
  it('patch 号随提交总数自动递增，主次版本来自 package.json', () => {
    expect(deriveVersion('1.0.0', 1)).toBe('1.0.1');
    expect(deriveVersion('1.0.0', 8)).toBe('1.0.8');
    expect(deriveVersion('2.3.0', 41)).toBe('2.3.41');
  });
  it('没有可用的 Git 历史时回退到 package.json 的版本', () => {
    expect(deriveVersion('1.0.5', 0)).toBe('1.0.5');
    expect(deriveVersion('1.0.0', Number.NaN)).toBe('1.0.0');
  });
});
