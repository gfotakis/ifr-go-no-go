#!/bin/sh
# IFR Go/No-Go: run to start; Ctrl+C or the Quit button stops it.
cd "$(dirname "$0")" || exit 1
exec python3 server.py "$@"
