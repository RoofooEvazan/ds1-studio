import { getVersion } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { GameData } from '../game/GameData';
import { renderMapImage } from '../render/exportImage';
import { getConfig, loadFromTauri, refreshLooseFolders, tauriSaveTarget } from '../vfs/tauri';
import { handleLine } from './protocol';
import { McpSession, type SessionHost } from './session';

/**
 * `ds1-studio --mcp`: the app starts with a hidden window running this instead of the editor. The native side feeds
 * it the MCP messages read from stdin ("mcp-in" events) and writes its replies to stdout (mcp_out).
 */

const toBase64 = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

const render: SessionHost['render'] = async (scene, objects, sprites, map, area, scale, withObjects, specials, overlay) =>
  toBase64(await renderMapImage(scene, objects, sprites, map.palette, map.ds1.width, map.ds1.height, { area, scale, objects: withObjects, specials, overlay, visible: () => true, format: 'jpeg' }));

export async function startMcp(): Promise<void> {
  // The game data loads on the first tool call (with the folders chosen in the app), so the handshake is instant.
  let loading: Promise<McpSession> | null = null;
  const session = () =>
    (loading ??= (async () => {
      const config = await getConfig();
      if (!config.gameDir) throw new Error('DS1 Studio has no Diablo II folder yet: open DS1 Studio once and choose your folders.');
      const gd = await GameData.load(await loadFromTauri(config));
      // Files added, changed or removed in the mod folders while the server runs (by scripts, the editor…).
      const refresh = async () => {
        for (const p of await refreshLooseFolders(gd.fs)) if (/\.dt1$/i.test(p)) gd.forgetDt1(p);
      };
      return new McpSession(gd, { saveTarget: tauriSaveTarget(config), render, refresh });
    })().catch((e) => {
      loading = null;
      throw e;
    }));
  const version = await getVersion();
  // One message at a time, in order.
  let queue = Promise.resolve();
  await listen<string>('mcp-in', (e) => {
    queue = queue.then(async () => {
      const out = await handleLine(session, e.payload, version);
      if (out) await invoke('mcp_out', { line: out });
    });
  });
  await invoke('mcp_ready');
}
