#!/usr/bin/env node
/**
 * Connect to relay.mjs and exchange JSON messages with stdin lines.
 *
 * Terminal 1: node relay.mjs
 * Terminal 2: node peer.mjs
 * Terminal 3: node peer.mjs
 *
 * Type a line + Enter to send { type: "chat", text, t }; peer output is printed.
 * Env: WS_URL (default ws://127.0.0.1:9777)
 */
import WebSocket from "ws";
import readline from "readline";

const url = process.env.WS_URL || "ws://127.0.0.1:9777";
const ws = new WebSocket(url);

ws.on("open", () => {
  process.stderr.write(`[peer] connected to ${url}\n`);
  process.stderr.write("[peer] type a line and Enter to send; Ctrl+D to exit\n");
});

ws.on("message", (buf) => {
  let text;
  try {
    const j = JSON.parse(buf.toString());
    text = JSON.stringify(j, null, 2);
  } catch {
    text = buf.toString();
  }
  process.stdout.write(`[peer] from other:\n${text}\n`);
});

ws.on("close", () => process.exit(0));
ws.on("error", (e) => {
  process.stderr.write(`[peer] error: ${e.message}\n`);
  process.exit(1);
});

const rl = readline.createInterface({ input: process.stdin, terminal: true });
rl.on("line", (line) => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "chat", text: line, t: Date.now() }));
  }
});
