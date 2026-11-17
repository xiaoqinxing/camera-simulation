import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readVersionInfo } from './scripts/version.mjs';

const VIRTUAL_ID = 'virtual:app-version';
const RESOLVED_ID = `\0${VIRTUAL_ID}`;

/**
 * 把构建时的 Git 提交信息暴露为虚拟模块，版本号随提交数自动递增。
 * 读取失败时 readVersionInfo 会回退到 package.json，不会阻断构建。
 */
function versionPlugin(): Plugin {
  let payload = JSON.stringify(readVersionInfo());
  return {
    name: 'app-version',
    configResolved() {
      payload = JSON.stringify(readVersionInfo());
    },
    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_ID : null;
    },
    load(id) {
      return id === RESOLVED_ID ? `export default ${payload};` : null;
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), versionPlugin()],
  build: { sourcemap: false },
});
