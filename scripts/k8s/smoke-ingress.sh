#!/usr/bin/env bash
# Smoke test DESDE FUERA del cluster, entrando por el Ingress de Traefik.
#
# Es la prueba que `k8s:smoke` no puede dar: aquella corre dentro del cluster porque
# `kubectl port-forward` no balancea. Esta entra por donde entraria un cliente real.
set -euo pipefail

BASE="${INGRESS_URL:-http://localhost:8081}"
KEY="INGRESS-$(date +%s)"

# Cada invocacion de curl abre una conexion nueva, asi que el keep-alive del cliente
# no puede enmascarar el reparto. Si alguna vez se reescribe esto como un solo curl
# con varias URLs, hay que agregar --no-keepalive: si no, curl reusa la conexion,
# Traefik la mantiene contra el mismo pod y el reparto "desaparece" sin que nada
# este roto.
for i in $(seq 1 40); do
  curl -s -o /dev/null -m 2 "$BASE/health/ready" 2>/dev/null && break
  [ "$i" = 40 ] && { echo "El ingress no responde en $BASE. ¿Corriste 'npm run k8s:deploy'?"; exit 1; }
  sleep 1
done

F=$(curl -s -X POST "$BASE/lab/reset" -H 'content-type: application/json' -d '{"deviceCount":3}')
CONV=$(printf '%s' "$F" | sed 's/.*"conversationId":"\([^"]*\)".*/\1/')
OWNER=$(printf '%s' "$F" | sed 's/.*"ownerId":"\([^"]*\)".*/\1/')
DEV=$(printf '%s' "$F" | sed 's/.*"deviceIds":\["\([^"]*\)".*/\1/')
BODY="{\"senderId\":\"$OWNER\",\"senderDeviceId\":\"$DEV\",\"clientMessageId\":\"local-1\",\"clientSequence\":1,\"body\":\"ingress\"}"

echo "== 12 requests con la MISMA Idempotency-Key, por el Ingress =="
TMP=$(mktemp)
for i in $(seq 1 12); do
  printf '  %2s  ' "$i"
  curl -s -D- -o /dev/null -X POST "$BASE/v1/conversations/$CONV/messages" \
    -H 'content-type: application/json' -H "Idempotency-Key: $KEY" -d "$BODY" \
    | grep -iE '^HTTP/|^x-instance-id' | tr -d '\r' | paste -sd'   ' - | tee -a "$TMP"
done

echo
echo "== reparto =="
grep -io 'x-instance-id: .*' "$TMP" | awk '{print "  "$2}' | sort | uniq -c
PODS=$(grep -io 'x-instance-id: .*' "$TMP" | awk '{print $2}' | sort -u | wc -l | tr -d ' ')
CREADOS=$(grep -c '201 Created' "$TMP" || true)
rm -f "$TMP"

echo
echo "== la base al final =="
curl -s "$BASE/lab/state" | sed 's/.*"counts":{\([^}]*\)}.*/  \1/'

echo
FALLOS=0
[ "$CREADOS" = "1" ] || { echo "  FALLA: se esperaba 1 creado, hubo $CREADOS"; FALLOS=1; }
[ "$PODS" -ge 2 ] || { echo "  FALLA: el ingress mando todo a $PODS pod(s); no hubo reparto"; FALLOS=1; }
curl -s "$BASE/lab/state" | grep -q '"messages":1' || { echo "  FALLA: la base no quedo con 1 mensaje"; FALLOS=1; }
[ "$FALLOS" = 0 ] && echo "  OK: 1 creado, 11 replays, 1 mensaje, repartido entre $PODS pods."
exit $FALLOS
