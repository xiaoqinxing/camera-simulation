import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HISTORY_LIMIT = 200;

function git(args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 8 * 1024 * 1024,
  }).trim();
}

export function readBaseVersion() {
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : '1.0.0';
  } catch {
    return '1.0.0';
  }
}

/**
 * Patch 版本号跟随提交总数自动递增，例如 1.0.0 + 第 8 次提交 => 1.0.8。
 * 主次版本仍由 package.json 控制。
 */
export function deriveVersion(baseVersion, commitCount) {
  const parts = String(baseVersion).split('.').map(n => Number.parseInt(n, 10));
  const major = Number.isFinite(parts[0]) ? parts[0] : 1;
  const minor = Number.isFinite(parts[1]) ? parts[1] : 0;
  const fallbackPatch = Number.isFinite(parts[2]) ? parts[2] : 0;
  const count = Number.isFinite(commitCount) ? Math.max(0, Math.trunc(commitCount)) : 0;
  return `${major}.${minor}.${count > 0 ? count : fallbackPatch}`;
}

function readCommits(baseVersion, commitCount) {
  try {
    const raw = git(['log', `-n`, String(HISTORY_LIMIT), '--date=short', '--pretty=format:%h%x1f%cs%x1f%s%x1e']);
    return raw
      .split('\x1e')
      .map(record => record.trim())
      .filter(Boolean)
      .map((record, index) => {
        const [hash, date, subject] = record.split('\x1f');
        return {
          hash: hash ?? '',
          version: deriveVersion(baseVersion, commitCount - index),
          date: date ?? '',
          subject: subject ?? '',
        };
      });
  } catch {
    return [];
  }
}

/**
 * 收集构建时的版本信息。Git 不可用（如从源码压缩包构建）时回退到 package.json，
 * 不影响构建与运行。
 */
export function readVersionInfo() {
  const baseVersion = readBaseVersion();
  const info = {
    baseVersion,
    version: deriveVersion(baseVersion, 0),
    commit: '',
    commitDate: '',
    branch: '',
    commitCount: 0,
    totalCommits: 0,
    historyLimit: HISTORY_LIMIT,
    commits: [],
  };

  try {
    const commitCount = Number.parseInt(git(['rev-list', '--count', 'HEAD']), 10);
    if (!Number.isFinite(commitCount) || commitCount <= 0) return info;
    const commit = git(['rev-parse', '--short=7', 'HEAD']);
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
    const commitDate = git(['show', '-s', '--format=%cs', 'HEAD']);
    return {
      ...info,
      version: deriveVersion(baseVersion, commitCount),
      commit,
      commitDate,
      branch: branch && branch !== 'HEAD' ? branch : '',
      commitCount,
      totalCommits: commitCount,
      commits: readCommits(baseVersion, commitCount),
    };
  } catch {
    return info;
  }
}
