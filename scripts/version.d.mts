export interface VersionCommit {
  /** Abbreviated commit hash. */
  hash: string;
  /** Version derived from the commit count at that point. */
  version: string;
  /** Committer date, YYYY-MM-DD. */
  date: string;
  /** First line of the commit message. */
  subject: string;
}

export interface VersionInfo {
  /** package.json version, used as the major.minor base. */
  baseVersion: string;
  /** Display version: major.minor.<commitCount>. */
  version: string;
  /** Abbreviated HEAD hash, empty when Git is unavailable. */
  commit: string;
  /** HEAD committer date, YYYY-MM-DD. */
  commitDate: string;
  /** Current branch, empty for a detached HEAD or unavailable Git. */
  branch: string;
  /** Number of commits reachable from HEAD. */
  commitCount: number;
  /** Same as commitCount; kept for clarity in the UI. */
  totalCommits: number;
  /** Maximum number of commits returned in `commits`. */
  historyLimit: number;
  /** Newest first. */
  commits: VersionCommit[];
}

export function readBaseVersion(): string;
export function deriveVersion(baseVersion: string, commitCount: number): string;
export function readVersionInfo(): VersionInfo;
