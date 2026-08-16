#!/usr/bin/env bash
# L1 — carga sostenida con la mezcla de operaciones de ALCANCE.
#
#   npm run k6:l1                        100 ops/s durante 5m
#   RATE=200 DURATION=2m npm run k6:l1
#
# El dataset tiene una conversacion CALIENTE con muchos mas dispositivos que las demas.
# No es realismo decorativo: el orden se serializa en una fila por conversacion, y con
# la carga repartida pareja ese punto no aparece nunca.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NS=whatsapp-lab
BASE="${INGRESS_URL:-http://localhost:8081}"
CONVERSACIONES="${CONVERSACIONES:-20}"
DISPOSITIVOS="${DISPOSITIVOS:-4}"
CALIENTES="${CALIENTES:-40}"
SEED_FILE="$ROOT/infra/k6/seed.json"
LOG="${LOG:-$ROOT/infra/k6/l1.log}"

command -v k6 >/dev/null 2>&1 || { echo "falta k6 en el PATH (brew install k6)"; exit 1; }
curl -s -o /dev/null -m 5 "$BASE/health/ready" || {
  echo "El ingress no responde en $BASE."; exit 1; }

kubectl -n "$NS" port-forward svc/postgres 15432:5432 >/dev/null 2>&1 &
FORWARD_PID=$!
trap 'kill $FORWARD_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 30); do nc -z localhost 15432 2>/dev/null && break; sleep 0.5; done

echo "== Sembrando: $CONVERSACIONES conversaciones × $DISPOSITIVOS, la caliente con $CALIENTES =="
DATABASE_URL="postgres://lab:lab@localhost:15432/whatsapp_lab" \
  npx tsx "$ROOT/scripts/seed.ts" \
    --conversations="$CONVERSACIONES" --devices="$DISPOSITIVOS" \
    --hot-devices="$CALIENTES" --fresh --json \
  | sed -n '/^{/,$p' > "$SEED_FILE"

echo
k6 run \
  -e "INGRESS_URL=$BASE" -e "SEED_FILE=$SEED_FILE" \
  ${RATE:+-e "RATE=$RATE"} ${DURATION:+-e "DURATION=$DURATION"} \
  "$ROOT/infra/k6/escenario-l1.js" 2>&1 | tee "$LOG"

echo
echo "== I1..I10 contra la base =="
DATABASE_URL="postgres://lab:lab@localhost:15432/whatsapp_lab" \
  npx tsx "$ROOT/scripts/verify-invariants.ts"
