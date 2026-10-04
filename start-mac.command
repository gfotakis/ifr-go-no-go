#!/bin/bash
# IFR Go/No-Go: double-click to start. Close this window to stop.
cd "$(dirname "$0")" || exit 1
exec python3 server.py
