#!/usr/bin/env bash
# I11 — matar una replica durante la carga no rompe I1..I10.
#
#   npm run caos:pod-kill                 muerte gracil (SIGTERM, con drenaje)
#   MODO=abrupto npm run caos:pod-kill    muerte abrupta (SIGKILL, sin drenaje)
#
# LAS DOS MUERTES PRUEBAN COSAS DISTINTAS y por eso estan las dos:
#
#   gracil   `kubectl delete pod` manda SIGTERM y espera terminationGracePeriodSeconds.
#            Ejercita el drenaje que el Deployment construyo a proposito: readiness
#            baja, se esperan DRAIN_DELAY_MS a que Traefik saque al pod de rotacion, y
#            recien ahi se cierra el pool. Si el drenaje anda, esto casi no se nota.
#
#   abrupto  --grace-period=0 --force: el contenedor muere sin SIGTERM y sin drenaje.
#            Es la mitad contra la que NO protege ningun PodDisruptionBudget. Acá SI
#            se esperan requests en vuelo perdidas; lo que NO se acepta es una
#            invariante rota.
#
# El criterio de exito no es "k6 en verde". Es la auditoria contra la base al final:
# ALCANCE lo dice explicito — contar respuestas 2xx no demuestra ninguna invariante.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NS=whatsapp-lab
BASE="${INGRESS_URL:-http://localhost:8081}"
MODO="${MODO:-gracil}"
# L2 pide matar durante el plateau de L1, o sea con la MEZCLA de operaciones, no con
# el escenario base de un solo tipo de request. Se deja elegir para poder comparar.
ESCENARIO="${ESCENARIO:-escenario-l1.js}"
RATE="${RATE:-100}"
DURATION="${DURATION:-3m}"
MATAR_A_LOS="${MATAR_A_LOS:-60}"
CONVERSACIONES="${CONVERSACIONES:-20}"
DISPOSITIVOS="${DISPOSITIVOS:-4}"
CALIENTES="${CALIENTES:-40}"
SEED_FILE="$ROOT/infra/k6/seed.json"
LOG="$ROOT/infra/k6/caos-$MODO.log"

command -v k6 >/dev/null 2>&1 || { echo "falta k6 en el PATH (brew install k6)"; exit 1; }
kubectl config current-context 2>/dev/null | grep -q "k3d-whatsapp-lab" || {
  echo "El contexto actual no es k3d-whatsapp-lab."; exit 1; }
curl -s -o /dev/null -m 5 "$BASE/health/ready" || {
  echo "El ingress no responde en $BASE."; exit 1; }

abrir_forward() {
  kubectl -n "$NS" port-forward svc/postgres 15432:5432 >/dev/null 2>&1 &
  FORWARD_PID=$!
  for _ in $(seq 1 30); do nc -z localhost 15432 2>/dev/null && return 0; sleep 0.5; done
  echo "el port-forward a postgres no levanto"; exit 1
}
cerrar_forward() { kill "${FORWARD_PID:-0}" 2>/dev/null || true; }
trap cerrar_forward EXIT

# --fresh: sin esto la corrida manda las mismas Idempotency-Key, recibe replays en vez
# de crear, y mide una operacion distinta con un p95 que no significa nada.
echo "== Sembrando ${CONVERSACIONES}×${DISPOSITIVOS}, streams virgenes =="
abrir_forward
DATABASE_URL="postgres://lab:lab@localhost:15432/whatsapp_lab" \
  npx tsx "$ROOT/scripts/seed.ts" \
    --conversations="$CONVERSACIONES" --devices="$DISPOSITIVOS" \
    --hot-devices="$CALIENTES" --fresh --json \
  | sed -n '/^{/,$p' > "$SEED_FILE"
cerrar_forward

echo
echo "== Pods antes =="
kubectl -n "$NS" get pods -l app=api -o custom-columns='POD:.metadata.name,NODO:.spec.nodeName' --no-headers

echo
echo "== Carga: $RATE req/s durante $DURATION, matando un pod a los ${MATAR_A_LOS}s (modo: $MODO) =="
k6 run -e "INGRESS_URL=$BASE" -e "SEED_FILE=$SEED_FILE" -e "RATE=$RATE" -e "DURATION=$DURATION" \
  "$ROOT/infra/k6/$ESCENARIO" > "$LOG" 2>&1 &
K6_PID=$!

sleep "$MATAR_A_LOS"
VICTIMA=$(kubectl -n "$NS" get pods -l app=api -o jsonpath='{.items[0].metadata.name}')
echo "  matando $VICTIMA …"
MOMENTO_MUERTE=$(date +%s)
if [ "$MODO" = "abrupto" ]; then
  kubectl -n "$NS" delete pod "$VICTIMA" --grace-period=0 --force >/dev/null 2>&1
else
  kubectl -n "$NS" delete pod "$VICTIMA" >/dev/null 2>&1
fi
echo "  muerto a los $(( $(date +%s) - MOMENTO_MUERTE ))s de pedirlo"

wait $K6_PID || true

echo
echo "== Resultado de la carga =="
grep -E "p\(95\)|p\(99\)|✓|✗|l1_tasa|dropped_iterations|checks_succeeded|iterations\.\.\." "$LOG" | sed 's/^/  /'

echo
echo "== Pods despues =="
kubectl -n "$NS" get pods -l app=api -o custom-columns='POD:.metadata.name,NODO:.spec.nodeName,EDAD:.metadata.creationTimestamp' --no-headers

echo
echo "== I1..I10 contra la base — este es el criterio de exito =="
abrir_forward
DATABASE_URL="postgres://lab:lab@localhost:15432/whatsapp_lab" \
  npx tsx "$ROOT/scripts/verify-invariants.ts"
RESULTADO=$?
cerrar_forward

exit $RESULTADO
