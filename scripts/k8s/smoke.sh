#!/usr/bin/env bash
# Smoke test DESDE DENTRO del cluster.
#
# Se corre adentro a proposito: `kubectl port-forward` no balancea — fija un pod y
# se queda ahi, aunque apuntes al Service. El reparto solo se ve desde adentro.
set -euo pipefail

NS=whatsapp-lab
kubectl -n "$NS" delete pod smoke --ignore-not-found >/dev/null 2>&1

kubectl -n "$NS" run smoke --restart=Never --image=curlimages/curl:8.10.1 --command -- sh -c '
  F=$(curl -s -X POST http://api/lab/reset -H "content-type: application/json" -d "{\"deviceCount\":3}")
  CONV=$(echo "$F" | sed "s/.*conversationId\":\"\([^\"]*\)\".*/\1/")
  OWNER=$(echo "$F" | sed "s/.*ownerId\":\"\([^\"]*\)\".*/\1/")
  DEV=$(echo "$F" | sed "s/.*deviceIds\":\[\"\([^\"]*\)\".*/\1/")
  BODY="{\"senderId\":\"$OWNER\",\"senderDeviceId\":\"$DEV\",\"clientMessageId\":\"local-1\",\"clientSequence\":1,\"body\":\"smoke\"}"
  echo "== 12 requests con la MISMA idempotency key, contra el Service =="
  for i in $(seq 1 12); do
    curl -s -o /dev/null -D- -X POST "http://api/v1/conversations/$CONV/messages" \
      -H "content-type: application/json" -H "Idempotency-Key: SMOKE-1" -d "$BODY" \
      | grep -iE "^HTTP/|^x-instance-id" | tr -d "\r" | paste -sd"  " -
  done
  echo
  echo "== la base al final (tiene que decir messages:1) =="
  curl -s http://api/lab/state | sed "s/.*\"counts\":{\([^}]*\)}.*/\1/"
' >/dev/null 2>&1

kubectl -n "$NS" wait --for=jsonpath='{.status.phase}'=Succeeded pod/smoke --timeout=180s >/dev/null
kubectl -n "$NS" logs smoke
kubectl -n "$NS" delete pod smoke --ignore-not-found >/dev/null 2>&1
