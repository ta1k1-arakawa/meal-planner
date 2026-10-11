#!/usr/bin/env bash
set -euo pipefail
umask 077
config=.release-wrangler.json
backup=.release-backup
wrangler=./node_modules/.bin/wrangler
test -s "$config"
: "${CLOUDFLARE_API_TOKEN:?Missing Cloudflare API token}"
: "${CLOUDFLARE_ACCOUNT_ID:?Missing Cloudflare account ID}"
case "${1:-}" in
  backup)
    # Fail before export when encryption credentials are absent.
    test "${#D1_BACKUP_KEY}" -ge 32
    mkdir -p "$backup"
    rm -f "$backup/d1.sql.enc" "$backup/migrated"
    trap 'rm -f "$backup/d1.sql" "$backup/verified.sql"' EXIT
    "$wrangler" d1 export DB --remote --config "$config" --output "$backup/d1.sql" --skip-confirmation
    test -s "$backup/d1.sql"
    node scripts/backup-crypto.mjs encrypt "$backup/d1.sql" "$backup/d1.sql.enc"
    node scripts/backup-crypto.mjs decrypt "$backup/d1.sql.enc" "$backup/verified.sql"
    cmp "$backup/d1.sql" "$backup/verified.sql"
    ;;
  migrate)
    # The workflow supplies this only after successful artifact storage.
    [[ "${BACKUP_ARTIFACT_ID:-}" =~ ^[0-9]+$ ]]
    test -s "$backup/d1.sql.enc"
    rm -f "$backup/migrated"
    "$wrangler" d1 migrations apply DB --remote --config "$config"
    touch "$backup/migrated"
    ;;
  deploy)
    test -f "$backup/migrated"
    test -s dist/index.html
    "$wrangler" deploy --config "$config"
    ;;
  *) echo 'Usage: bash scripts/release.sh backup|migrate|deploy' >&2; exit 2 ;;
esac
