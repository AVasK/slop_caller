#!/usr/bin/env node
/**
 * Minimal WebSocket fan-out: each message is sent to every other connected client.
 * Mirrors the “room” idea: run one relay, then two `node peer.mjs` processes.
 *
 * Usage: node relay.mjs
 * Env:   PORT (default 9777)
 */
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT) || 9777;
const wss = new WebSocketServer({ port: PORT });

/** @type {import('ws').WebSocket[]} */
let clients = [];

wss.on("connection", (ws) => {
  clients.push(ws);
  process.stderr.write(`[relay] client connected (${clients.length} total)\n`);

  ws.on("message", (data) => {
    const others = clients.filter((c) => c !== ws && c.readyState === 1);
    for (const o of others) {
      o.send(data);
    }
  });

  ws.on("close", () => {
    clients = clients.filter((c) => c !== ws);
    process.stderr.write(`[relay] disconnected (${clients.length} remaining)\n`);
  });
});

process.stderr.write(`[relay] ws://127.0.0.1:${PORT} — connect two peers with: node peer.mjs\n`);
