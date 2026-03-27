/**
 * WebSocket broadcaster — singleton that holds all connected clients.
 * Import { broadcast, getBroadcaster } from here to push real-time events.
 *
 * Event types:
 *   { type: 'metrics',          data: MetricsPayload }
 *   { type: 'positions',        data: Position[] }
 *   { type: 'trade',            data: TradePayload }
 *   { type: 'candle',           data: { symbol, timeframe, candle } }
 *   { type: 'tier_change',      data: { from, to, balance } }
 *   { type: 'log',              data: { level, message, timestamp } }
 *   { type: 'ping' }
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import type { Server } from 'http';
import { log } from '../logger';

let wss: WebSocketServer | null = null;

export interface WsEvent {
  type: string;
  data?: unknown;
}

/** Attach WebSocket server to an existing HTTP server. Call once at startup. */
export function attachWsServer(httpServer: Server): WebSocketServer {
  wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const ip = req.socket.remoteAddress ?? 'unknown';
    log.debug(`[WS] client connected from ${ip}`);

    // Send initial ping so client knows it's alive
    ws.send(JSON.stringify({ type: 'ping' }));

    ws.on('error', (err) => {
      log.debug(`[WS] client error: ${err.message}`);
    });

    ws.on('close', () => {
      log.debug('[WS] client disconnected');
    });

    // Ignore all incoming messages — dashboard is read-only push
    ws.on('message', () => {});
  });

  wss.on('error', (err) => {
    log.error('[WS] server error', { error: err.message });
  });

  log.info('[WS] WebSocket broadcaster ready at ws://127.0.0.1/ws');
  return wss;
}

/** Broadcast a typed event to all connected clients. Safe to call anytime. */
export function broadcast(event: WsEvent): void {
  if (!wss) return;
  const msg = JSON.stringify(event);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg, (err) => {
        if (err) log.debug(`[WS] send error: ${err.message}`);
      });
    }
  });
}

/** How many clients are currently connected */
export function wsClientCount(): number {
  return wss ? wss.clients.size : 0;
}
