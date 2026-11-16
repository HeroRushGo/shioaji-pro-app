#!/bin/zsh -f
set -euo pipefail
repo=${0:A:h:h}
vault=${TRADING_VAULT:-$HOME/Documents/Trading}
exec "$vault/scripts/neo-client/.venv/bin/python" -I "$repo/scripts/pro_web_ctl.py" "$@"
