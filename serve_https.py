#!/usr/bin/env python3
"""
Serve this folder over HTTPS (for iPhone / camera testing).

1. Install mkcert:   brew install mkcert
2. Trust the local CA:   mkcert -install
3. Create a cert for this machine (use your Mac's LAN IP from: ipconfig getifaddr en0):
     mkcert localhost 127.0.0.1 192.168.1.42
   mkcert prints two filenames, e.g. ./localhost+2.pem and ./localhost+2-key.pem
4. Run:
     python3 serve_https.py localhost+2.pem localhost+2-key.pem
5. On iPhone: open https://192.168.1.42:8765 (your IP). If Safari warns, install the
   mkcert root CA on iOS (see https://github.com/FiloSottile/mkcert#mobile-devices )

6. WebRTC signaling must use WSS on the same host (Safari blocks ws:// from https://).
   In another terminal, using the SAME two .pem files as step 3:
     python3 signaling_server.py localhost+2.pem localhost+2-key.pem
   (Plain python3 signaling_server.py is only for http:// pages.)
"""

from __future__ import annotations

import http.server
import os
import ssl
import sys
from pathlib import Path

PORT = 8765
ROOT = Path(__file__).resolve().parent


def main() -> None:
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    cert = sys.argv[1]
    key = sys.argv[2]
    if not os.path.isfile(cert) or not os.path.isfile(key):
        print("Cert or key file not found.", file=sys.stderr)
        sys.exit(1)

    os.chdir(ROOT)
    server_address = ("0.0.0.0", PORT)
    httpd = http.server.HTTPServer(server_address, http.server.SimpleHTTPRequestHandler)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(certfile=cert, keyfile=key)
    httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)

    print(f"Serving HTTPS on 0.0.0.0 port {PORT}")
    print(f"  e.g. https://127.0.0.1:{PORT}/  or  https://<this-mac-lan-ip>:{PORT}/")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
