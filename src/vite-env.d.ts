/// <reference types="vite/client" />

declare module 'virtual:app-version' {
  interface VersionCommit {
    hash: string;
    version: string;
    date: string;
    subject: string;
  }
  interface VersionInfo {
    baseVersion: string;
    version: string;
    commit: string;
    commitDate: string;
    branch: string;
    commitCount: number;
    totalCommits: number;
    historyLimit: number;
    commits: VersionCommit[];
  }
  const info: VersionInfo;
  export default info;
}
