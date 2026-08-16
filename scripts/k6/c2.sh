#!/usr/bin/env bash
# C2 — la operacion ambigua contra el ingress, bajo concurrencia.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NS=whatsapp-lab
BASE="${INGRESS_URL:-http://localhost:8081}"

curl -s -o /dev/null -m 5 "$BASE/health/ready" || { echo "El ingress no responde en $BASE."; exit 1; }

kubectl -n "$NS" port-forward svc/postgres 15432:5432 >/dev/null 2>&1 &
FORWARD_PID=$!
trap 'kill $FORWARD_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 30); do nc -z localhost 15432 2>/dev/null && break; sleep 0.5; done

DATABASE_URL="postgres://lab:lab@localhost:15432/whatsapp_lab" \
  npx tsx "$ROOT/scripts/seed.ts" --conversations=30 --devices=4 --fresh --json \
  | sed -n '/^{/,$p' > "$ROOT/infra/k6/seed.json"

k6 run -e "INGRESS_URL=$BASE" -e "SEED_FILE=$ROOT/infra/k6/seed.json" \
  ${RATE:+-e "RATE=$RATE"} ${DURATION:+-e "DURATION=$DURATION"} \
  ${TIMEOUT_CORTO:+-e "TIMEOUT_CORTO=$TIMEOUT_CORTO"} \
  "$ROOT/infra/k6/escenario-c2.js" 2>&1 | tee "$ROOT/infra/k6/c2.log" \
  | grep -E "c2_|✓|✗|checks_succ" || true

echo
echo "== La prueba de verdad: la base al final =="
DATABASE_URL="postgres://lab:lab@localhost:15432/whatsapp_lab" \
  npx tsx "$ROOT/scripts/verify-invariants.ts" 2>&1 | grep -vE "injected env" | grep -E "mensajes|operaciones|violac|VIOLA"
