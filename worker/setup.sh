#!/usr/bin/env bash
# First-time setup: register workers.dev subdomain, deploy, set API key secret.
# Run once, then use deploy.sh for subsequent updates.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Error: $ENV_FILE not found."
  echo "  cp worker/.env.example worker/.env  and fill in your values."
  exit 1
fi

# shellcheck source=.env
source "$ENV_FILE"

# Make wrangler available (installed via nvm)
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[[ -s "$NVM_DIR/nvm.sh" ]] && source "$NVM_DIR/nvm.sh"

for var in CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_TOKEN CLOUDFLARE_SUBDOMAIN ANTHROPIC_API_KEY; do
  if [[ -z "${!var:-}" ]]; then
    echo "Error: $var is not set in $ENV_FILE"
    exit 1
  fi
done

echo "==> Registering workers.dev subdomain '$CLOUDFLARE_SUBDOMAIN'..."
RESP=$(curl -sf -X PUT \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/subdomain" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"subdomain\":\"$CLOUDFLARE_SUBDOMAIN\"}")

if echo "$RESP" | grep -q '"success":true'; then
  echo "    Registered: $CLOUDFLARE_SUBDOMAIN.workers.dev"
else
  # May already be registered — print response and continue
  echo "    Note: $RESP"
fi

echo "==> Deploying worker..."
cd "$SCRIPT_DIR"
wrangler deploy

echo "==> Setting ANTHROPIC_API_KEY secret..."
echo "$ANTHROPIC_API_KEY" | wrangler secret put ANTHROPIC_API_KEY

echo ""
echo "All done! Worker URL:"
echo "  https://gencon-ai-proxy.$CLOUDFLARE_SUBDOMAIN.workers.dev"
echo ""
echo "Paste that URL into the AI Suggestions panel on the schedule page."
