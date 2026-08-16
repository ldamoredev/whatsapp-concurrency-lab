#!/usr/bin/env bash
# L4 — escalones hasta el primer limite, y vuelta al baseline.
#
#   npm run k6:l4
#   ESCALONES="50 100 200 400" npm run k6:l4
#
# L4 no tiene un RPS de aprobacion. El entregable es identificar CON METRICAS que se
# saturo primero, como degrado y si recupero al volver al baseline.
#
# LA REGLA QUE HACE HONESTO ESTE ESCENARIO: no se le llama "capacidad" a un numero si
# el GENERADOR estaba saturado. Por eso cada escalon reporta `dropped_iterations`: si
# k6 no pudo emitir las llegadas pedidas, ese escalon mide el limite de k6, no el del
# sistema, y se dice.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NS=whatsapp-lab
BASE="${INGRESS_URL:-http://localhost:8081}"
ESCALONES="${ESCALONES:-50 100 200 400 50}"
POR_ESCALON="${POR_ESCALON:-45s}"

kubectl -n "$NS" port-forward svc/postgres 15432:5432 >/dev/null 2>&1 &
FORWARD_PID=$!
trap 'kill $FORWARD_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 30); do nc -z localhost 15432 2>/dev/null && break; sleep 0.5; done

DATABASE_URL="postgres://lab:lab@localhost:15432/whatsapp_lab" \
  npx tsx "$ROOT/scripts/seed.ts" --conversations=60 --devices=4 --hot-devices=60 --fresh --json \
  | sed -n '/^{/,$p' > "$ROOT/infra/k6/seed.json"

printf '\n%-8s %-10s %-10s %-10s %-12s %-10s\n' "rps" "p95" "p99" "logrado" "descartadas" "pool_wait"
printf '%s\n' "-------------------------------------------------------------------------"

for RPS in $ESCALONES; do
  INICIO=$(date -u +%s)
  k6 run -e "INGRESS_URL=$BASE" -e "SEED_FILE=$ROOT/infra/k6/seed.json" \
    -e "RATE=$RPS" -e "DURATION=$POR_ESCALON" -e "MAX_VUS=300" \
    "$ROOT/infra/k6/escenario-l1.js" > "$ROOT/infra/k6/l4-$RPS.log" 2>&1 || true

  L="$ROOT/infra/k6/l4-$RPS.log"
  P95=$(grep -oE 'p\(95\)=[0-9.]+[a-z]+' "$L" | head -1 | cut -d= -f2)
  P99=$(grep -oE 'p\(99\)=[0-9.]+[a-z]+' "$L" | head -1 | cut -d= -f2)
  LOGRADO=$(grep -oE 'iterations\.+: [0-9]+ +[0-9.]+/s' "$L" | grep -oE '[0-9.]+/s' | head -1)
  DROP=$(grep -oE 'dropped_iterations\.+: [0-9]+' "$L" | grep -oE '[0-9]+$' | head -1)
  # El maximo de conexiones esperando durante ESTE escalon, leido de Prometheus.
  WAIT=$(curl -s --get "http://localhost:9090/api/v1/query" \
    --data-urlencode "query=max_over_time(sum(lab_pg_pool_connections{state=\"waiting\"})[60s:5s])" \
    | python3 -c "import sys,json;r=json.load(sys.stdin)['data']['result'];print(r[0]['value'][1] if r else '?')" 2>/dev/null || echo '?')

  printf '%-8s %-10s %-10s %-10s %-12s %-10s\n' "$RPS" "${P95:-?}" "${P99:-?}" "${LOGRADO:-?}" "${DROP:-0}" "${WAIT:-?}"
done

echo
echo "== Invariantes al final de toda la escalera =="
DATABASE_URL="postgres://lab:lab@localhost:15432/whatsapp_lab" \
  npx tsx "$ROOT/scripts/verify-invariants.ts" 2>&1 | grep -vE "injected env" | tail -3
