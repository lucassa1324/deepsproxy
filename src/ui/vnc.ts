/*
 * File: vnc.ts
 * Project: deepsproxy
 * Purpose: Login remoto via VNC. Serve o cliente noVNC em /vnc e faz a
 * ponte WebSocket (navegador) -> x11vnc (TCP 5900). Com isso o login do
 * DeepSeek pode ser feito por um navegador "virtual" que roda no servidor,
 * mesmo sem tela física.
 */

import { readFile } from 'fs/promises';
import path from 'path';
import net from 'net';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';

const NOVNC_DIR = process.env.NOVNC_DIR || '/usr/share/novnc';
const VNC_HOST = process.env.VNC_HOST || '127.0.0.1';
const VNC_PORT = parseInt(process.env.VNC_PORT || '5900');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.gif': 'image/gif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function mimeOf(p: string): string {
  return MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';
}

export function vncEnabled(): boolean {
  return process.env.ENABLE_VNC === 'true';
}

export function vncUrl(): string {
  const token = process.env.API_KEY ? `?token=${encodeURIComponent(process.env.API_KEY)}` : '';
  return `/vnc/${token}`;
}

function send401(socket: any) {
  socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
  socket.destroy();
}

export function attachVnc(app: any) {
  if (!vncEnabled()) return;

  app.get('/vnc', (c: any) => c.redirect('/vnc/'));

  app.get('/vnc/', async (c: any) => {
    const html = await readFile(fileURLToPath(new URL('./vnc-client.html', import.meta.url)), 'utf-8');
    return c.html(html);
  });

  app.get('/vnc/*', async (c: any) => {
    const rel = c.req.path.slice('/vnc/'.length);
    const filePath = path.normalize(path.join(NOVNC_DIR, rel));
    if (!filePath.startsWith(NOVNC_DIR)) return c.text('Not Found', 404);
    try {
      const data = await readFile(filePath);
      return c.body(data, 200, { 'Content-Type': mimeOf(filePath) });
    } catch {
      return c.text('Not Found', 404);
    }
  });
}

export function attachVncWs(server: any) {
  if (!vncEnabled()) return;

  server.on('upgrade', (req: any, socket: any, head: any) => {
    const url = req.url || '';
    let parsed: URL;
    try {
      parsed = new URL(url, 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }
    if (parsed.pathname !== '/vnc/ws') {
      socket.destroy();
      return;
    }
    const token = parsed.searchParams.get('token') || '';
    if (process.env.API_KEY && token !== process.env.API_KEY) {
      send401(socket);
      return;
    }

    const wss = new WebSocketServer({ noServer: true });
    wss.handleUpgrade(req, socket, head, (ws) => {
      const tcp = net.connect({ host: VNC_HOST, port: VNC_PORT });
      const cleanup = () => {
        try { ws.close(); } catch { /* ignore */ }
        try { tcp.destroy(); } catch { /* ignore */ }
      };
      tcp.on('connect', () => {
        ws.on('message', (data) => {
          if (tcp.writable) tcp.write(Buffer.from(data as any));
        });
        tcp.on('data', (chunk) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
        });
        tcp.on('error', cleanup);
        tcp.on('close', cleanup);
        ws.on('close', cleanup);
        ws.on('error', cleanup);
      });
      tcp.on('error', cleanup);
    });
  });
}
