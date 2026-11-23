// Minimal HTTPS JSON POST with HTTPS_PROXY support (CONNECT tunnel), no dependencies.
// Node's built-in fetch ignores HTTPS_PROXY unless started with a flag; corporate networks and
// sandboxes often need the proxy. Copyright (C) 2026 chinesepowered. SPDX-License-Identifier: AGPL-3.0-or-later
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

function proxyFor(u: URL): URL | null {
  const p = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  if (!p) return null;
  const no = (process.env.NO_PROXY ?? process.env.no_proxy ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const host = u.hostname;
  for (const n of no) {
    if (n === '*') return null;
    const bare = n.replace(/^\*?\./, '');
    if (host === bare || host.endsWith(`.${bare}`)) return null;
  }
  try {
    return new URL(p.includes('://') ? p : `http://${p}`);
  } catch {
    return null;
  }
}

function tunnel(proxy: URL, host: string, port: number, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: proxy.hostname,
      port: Number(proxy.port || 80),
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers: { host: `${host}:${port}` },
      timeout: timeoutMs,
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode === 200) resolve(socket);
      else {
        socket.destroy();
        reject(new Error(`proxy CONNECT failed: HTTP ${res.statusCode}`));
      }
    });
    req.on('timeout', () => req.destroy(new Error('proxy timeout')));
    req.on('error', reject);
    req.end();
  });
}

export interface HttpResult {
  status: number;
  body: string;
}

export async function postJson(url: string, payload: unknown, headers: Record<string, string>, timeoutMs: number): Promise<HttpResult> {
  const u = new URL(url);
  const data = Buffer.from(JSON.stringify(payload));
  const port = Number(u.port || (u.protocol === 'http:' ? 80 : 443));
  const proxy = u.protocol === 'https:' ? proxyFor(u) : null;
  const socket = proxy ? await tunnel(proxy, u.hostname, port, timeoutMs) : undefined;
  const lib = u.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        method: 'POST',
        host: u.hostname,
        port,
        path: u.pathname + u.search,
        headers: { ...headers, 'content-type': 'application/json', 'content-length': String(data.length) },
        timeout: timeoutMs,
        ...(socket ? { createConnection: () => tls.connect({ socket, servername: u.hostname }) } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error(`request timed out after ${timeoutMs} ms`)));
    req.on('error', reject);
    req.end(data);
  });
}
