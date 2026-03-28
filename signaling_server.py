#!/usr/bin/env python3
"""
Minimal WebRTC signaling relay: two WebSocket clients per room exchange JSON messages
(offer / answer / ice). The browser uses a random session id as the room name (query
param ?session=...) so two peers opening the same link join the same room.

Run (plain WebSocket, use with http:// pages):
  pip install websockets && python3 signaling_server.py

If the page is served over HTTPS (e.g. serve_https.py on iPhone), Safari requires
wss:// — use the same certificate files as your HTTPS server:
  python3 signaling_server.py localhost+2.pem localhost+2-key.pem
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import ssl
import sys
from typing import Any

try:
    import websockets
except ImportError:
    print("Install dependencies: pip install -r requirements-signaling.txt", file=sys.stderr)
    raise

logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger("signaling")

HOST = "0.0.0.0"
PORT = 8787
MAX_PEERS_PER_ROOM = 2

# room -> list of websocket connections (order = join order)
rooms: dict[str, list[Any]] = {}
ws_room: dict[Any, str] = {}


async def forward_others(room: str, sender: Any, raw: str) -> None:
    for ws in rooms.get(room, []):
        if ws is not sender:
            await ws.send(raw)


async def handler(ws: Any) -> None:
    room: str | None = None
    try:
        async for raw in ws:
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                continue
            msg_type = data.get("type")
            if msg_type == "join":
                r = str(data.get("room") or "default").strip()[:64] or "default"
                if r in rooms and len(rooms[r]) >= MAX_PEERS_PER_ROOM:
                    await ws.send(json.dumps({"type": "error", "message": "room full"}))
                    continue
                room = r
                ws_room[ws] = room
                if room not in rooms:
                    rooms[room] = []
                rooms[room].append(ws)
                n = len(rooms[room])
                await ws.send(json.dumps({"type": "joined", "room": room, "peers": n}))
                logger.info("join room=%s peers=%s", room, n)
                if n == MAX_PEERS_PER_ROOM:
                    w_offer, w_answer = rooms[room][0], rooms[room][1]
                    await w_offer.send(json.dumps({"type": "peer", "role": "offer"}))
                    await w_answer.send(json.dumps({"type": "peer", "role": "answer"}))
                    logger.info("room %s paired", room)
                continue
            if msg_type in ("offer", "answer", "ice", "peer-info"):
                r = ws_room.get(ws)
                if r:
                    await forward_others(r, ws, raw)
    finally:
        if ws not in ws_room:
            return
        r = ws_room.pop(ws)
        if r in rooms:
            rooms[r] = [w for w in rooms[r] if w is not ws]
            if not rooms[r]:
                del rooms[r]
            else:
                for other in rooms[r]:
                    try:
                        await other.send(json.dumps({"type": "peer-left"}))
                    except Exception:
                        pass
            logger.info("disconnect room=%s remaining=%s", r, len(rooms.get(r, [])))


def load_ssl_context() -> ssl.SSLContext | None:
    if len(sys.argv) < 3:
        return None
    cert, key = sys.argv[1], sys.argv[2]
    if not os.path.isfile(cert) or not os.path.isfile(key):
        print("Cert or key not found; starting without TLS.", file=sys.stderr)
        return None
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(certfile=cert, keyfile=key)
    return ctx


async def main() -> None:
    ssl_ctx = load_ssl_context()
    kwargs: dict[str, Any] = {}
    if ssl_ctx is not None:
        kwargs["ssl"] = ssl_ctx
    async with websockets.serve(handler, HOST, PORT, **kwargs):
        if ssl_ctx is not None:
            logger.info(
                "Signaling WebSocket wss://%s:%s (TLS — use with https:// pages on iPhone)",
                HOST,
                PORT,
            )
        else:
            logger.info(
                "Signaling WebSocket ws://%s:%s (plain WS — use with http:// or set ?signal=)",
                HOST,
                PORT,
            )
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nStopped.")
