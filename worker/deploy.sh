#!/usr/bin/env bash
# Redeploy the worker after code changes.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/.env"

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[[ -s "$NVM_DIR/nvm.sh" ]] && source "$NVM_DIR/nvm.sh"

cd "$SCRIPT_DIR"
wrangler deploy
echo "Deployed: https://gencon-ai-proxy.$CLOUDFLARE_SUBDOMAIN.workers.dev"
