#!/usr/bin/env bash
# Prometheus + Grafana a pedido.
#
#   npm run obs:up      levanta, deja port-forwards y dice las URLs
#   npm run obs:down    los saca
#
# A pedido y no en `deploy.sh` porque no son parte del sistema bajo prueba: scrapear
# agrega trabajo a los mismos pods que se estan midiendo.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NS=whatsapp-lab
ACCION="${1:-up}"

if [ "$ACCION" = "down" ]; then
  kubectl delete -f "$ROOT/infra/k8s/observabilidad/" --ignore-not-found
  exit 0
fi

kubectl apply -f "$ROOT/infra/k8s/observabilidad/"
kubectl -n "$NS" rollout status deployment/prometheus --timeout=180s
kubectl -n "$NS" rollout status deployment/grafana --timeout=180s

echo
echo "Targets que Prometheus esta scrapeando:"
kubectl -n "$NS" run curl-obs --rm -i --restart=Never --image=whatsapp-concurrency-lab:v1 \
  --image-pull-policy=IfNotPresent --labels=app=obs-probe --command -- \
  node -e "fetch('http://prometheus:9090/api/v1/targets').then(r=>r.json()).then(d=>{
    for (const t of d.data.activeTargets) console.log('  ', t.labels.instance||t.scrapeUrl, t.health);
  })" 2>/dev/null | grep -v "^pod "

echo
echo "  Grafana:     http://localhost:3000/d/whatsapp-lab   (kubectl port-forward)"
echo "  Prometheus:  http://localhost:9090"
echo
echo "Para abrirlos:"
echo "  kubectl -n $NS port-forward svc/grafana 3000:3000 &"
echo "  kubectl -n $NS port-forward svc/prometheus 9090:9090 &"
