#!/usr/bin/env bash
set -euo pipefail
umask 077
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
env_file="${1:-$repo_root/.env.pern-compose.local}"
backup_dir="${2:-${XDG_STATE_HOME:-$HOME/.local/state}/paper-trading/backups}"
mkdir -p -- "$backup_dir"
backup_file="$(mktemp "$backup_dir/paper-pern-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX.dump")"
if ! docker compose --env-file "$env_file" -f "$repo_root/compose.pern.yml" exec -T db pg_dump -U paper_admin -d paper_pern --format=custom > "$backup_file"; then
  rm -f -- "$backup_file"
  exit 1
fi
docker compose --env-file "$env_file" -f "$repo_root/compose.pern.yml" exec -T db pg_restore --list < "$backup_file" > /dev/null
printf '%s\n' "$backup_file"
