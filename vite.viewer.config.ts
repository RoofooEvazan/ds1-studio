// The DT1 Viewer page published with the guide (GitHub Pages, /dt1-viewer/). It ships no game files: visitors open
// their own Diablo II folder in the browser. `vite --config vite.viewer.config.ts` serves the local test install too.
import { defineConfig } from 'vite';
import { gameDataPlugin } from './tools/vite-plugin-gamedata';

export default defineConfig(({ command }) => ({
  root: 'viewer',
  base: './',
  plugins: command === 'serve' ? [gameDataPlugin()] : [],
  server: { port: 5189, strictPort: true },
  build: { outDir: '../dist-viewer', emptyOutDir: true },
}));
