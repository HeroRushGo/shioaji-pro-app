#!/bin/zsh
# No project .env is sourced. Credentials go only to the private children.
set -euo pipefail
repo=${0:A:h:h}
vault=${TRADING_VAULT:-$HOME/Documents/Trading}
export TRADING_LOG_ROOT=${TRADING_LOG_ROOT:-$HOME/.trading/vendor-logs}
exec "$vault/ops/workstation-vendor-run.zsh" \
  "$vault/scripts/neo-client/.venv/bin/python" -I "$repo/scripts/run-market.py" --vault "$vault"
