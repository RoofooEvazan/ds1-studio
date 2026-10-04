import { errorText, TOOLS, type McpSession } from './session';

/**
 * A minimal Model Context Protocol server (JSON-RPC 2.0, one message per line): initialize, tools/list, tools/call,
 * ping. Nothing else is offered (no resources or prompts), so nothing else is advertised.
 */

const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];

interface Request {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

const INSTRUCTIONS = `DS1 Studio edits Diablo II map presets (.ds1). Open a map with open_map (list_maps to find one) or new_map, look with get_cells / render_map, change it with paint, set_cell, copy_area, find_replace, add_object…, check it with check_map, and write it with save_map (into the mod folder, keeping a .bak). Edits can be undone until saved. Cells are numbered from 0 at the map's top corner; x runs down-right, y down-left. Objects use sub-tiles: 5 per cell.`;

/** Handles one incoming line; returns the reply line, or null for notifications. */
export async function handleLine(session: () => Promise<McpSession>, line: string, version: string): Promise<string | null> {
  let msg: Request;
  try {
    msg = JSON.parse(line);
  } catch {
    return JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  const reply = (result: unknown) => JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, result });
  const error = (code: number, message: string) => JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } });
  const isNotification = msg.id === undefined;
  try {
    switch (msg.method) {
      case 'initialize': {
        const asked = String(msg.params?.protocolVersion ?? '');
        return reply({
          protocolVersion: SUPPORTED.includes(asked) ? asked : SUPPORTED[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'ds1-studio', title: 'DS1 Studio', version },
          instructions: INSTRUCTIONS,
        });
      }
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: TOOLS });
      case 'tools/call': {
        const name = String(msg.params?.name ?? '');
        const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
        return reply(await (await session()).call(name, args));
      }
      default:
        if (isNotification) return null; // notifications/initialized, cancelled…
        return error(-32601, `Method not found: ${msg.method}`);
    }
  } catch (e) {
    return isNotification ? null : error(-32603, errorText(e));
  }
}
