#!/usr/bin/env bash
# Restores only into a new, network-isolated, temporary PostgreSQL container.
set -euo pipefail
backup_file="${1:?Usage: verify-restore.sh BACKUP.dump}"
[ -s "$backup_file" ] || { echo 'Backup is missing or empty' >&2; exit 1; }
container="paper-restore-check-$(date -u +%Y%m%dT%H%M%SZ)-$RANDOM"
pg_image='postgres:17.11-bookworm@sha256:839fbb5a4942a7758dd93e18b42ea5649807491a0545b5eeeb8f0b8bb11857a5'
cleanup() { docker rm -f "$container" > /dev/null 2>&1 || true; }
trap cleanup EXIT
docker run --detach --rm --name "$container" --network none --tmpfs /var/lib/postgresql/data \
  -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_USER=paper_restore_admin -e POSTGRES_DB=paper_restore_check \
  "$pg_image" > /dev/null
ready=false
for attempt in {1..60}; do
  if docker exec "$container" pg_isready -U paper_restore_admin -d paper_restore_check > /dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
$ready || { echo 'Isolated restore PostgreSQL did not become ready' >&2; exit 1; }
docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U paper_restore_admin -d paper_restore_check > /dev/null <<'SQL'
CREATE ROLE paper_owner NOLOGIN;
CREATE ROLE paper_app NOLOGIN;
SQL
docker exec -i "$container" pg_restore --exit-on-error -U paper_restore_admin -d paper_restore_check < "$backup_file"
# Validate the restored financial projections without exposing identities or amounts.
docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U paper_restore_admin -d paper_restore_check <<'SQL'
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM accounts a LEFT JOIN LATERAL (
      SELECT sum(amount) AS balance,count(*) AS n,max(account_sequence) AS seq FROM cash_movements m WHERE m.account_id=a.id
    ) ledger ON true WHERE a.cash_balance IS DISTINCT FROM ledger.balance OR a.cash_sequence IS DISTINCT FROM ledger.n OR a.cash_sequence IS DISTINCT FROM ledger.seq
  ) THEN RAISE EXCEPTION 'Restored cash projection mismatch'; END IF;
  IF EXISTS (
    SELECT 1 FROM (SELECT account_id,account_sequence,resulting_balance,sum(amount) OVER (PARTITION BY account_id ORDER BY account_sequence) AS expected FROM cash_movements) m
    WHERE resulting_balance<>expected
  ) THEN RAISE EXCEPTION 'Restored running ledger mismatch'; END IF;
  IF EXISTS (
    WITH expected AS (
      SELECT account_id,instrument_id,sum(CASE WHEN side='BUY' THEN quantity ELSE -quantity END) AS quantity,
        sum(CASE WHEN side='BUY' THEN native_amount ELSE -allocated_native_cost END) AS native_cost,
        sum(CASE WHEN side='BUY' THEN settlement ELSE -allocated_base_cost END) AS base_cost
      FROM executions GROUP BY account_id,instrument_id
    ) SELECT 1 FROM expected e FULL JOIN positions p USING(account_id,instrument_id)
      WHERE coalesce(e.quantity,0)<>coalesce(p.quantity,0) OR coalesce(e.native_cost,0)<>coalesce(p.native_cost,0) OR coalesce(e.base_cost,0)<>coalesce(p.base_cost,0)
  ) THEN RAISE EXCEPTION 'Restored position projection mismatch'; END IF;
  IF EXISTS (
    SELECT 1 FROM executions e LEFT JOIN cash_movements m ON m.execution_id=e.id
    WHERE m.id IS NULL OR m.account_id<>e.account_id OR m.reason<>e.side OR m.amount<>CASE WHEN e.side='BUY' THEN -e.settlement ELSE e.settlement END
  ) THEN RAISE EXCEPTION 'Restored execution settlement mismatch'; END IF;
END $$;
SELECT max(version) AS restored_schema_version FROM schema_migrations;
SELECT 'Restore and accounting checks passed' AS result;
SQL
