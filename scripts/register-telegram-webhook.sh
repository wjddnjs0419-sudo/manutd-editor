#!/usr/bin/env bash
set -euo pipefail

: "${TELEGRAM_BOT_TOKEN:?TELEGRAM_BOT_TOKEN is required}"
: "${TELEGRAM_WEBHOOK_URL:?TELEGRAM_WEBHOOK_URL is required}"
: "${TELEGRAM_WEBHOOK_SECRET:?TELEGRAM_WEBHOOK_SECRET is required}"

case "$TELEGRAM_WEBHOOK_URL" in
  https://*) ;;
  *)
    echo "TELEGRAM_WEBHOOK_URL must use HTTPS" >&2
    exit 1
    ;;
esac

telegram_api_url="https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook"
response=$(curl --fail --silent --show-error --max-time 30 \
  --request POST \
  --url "$telegram_api_url" \
  --data-urlencode "url=${TELEGRAM_WEBHOOK_URL}" \
  --data-urlencode "secret_token=${TELEGRAM_WEBHOOK_SECRET}") || {
  echo "Telegram webhook registration request failed" >&2
  exit 1
}

if [[ "$response" != *'"ok":true'* ]]; then
  echo "Telegram webhook registration was rejected" >&2
  exit 1
fi

echo "Telegram webhook registration succeeded"
