#!/usr/bin/env bash
# Aplica los manifests y espera a que todo quede verde. Idempotente.
set -euo pipefail

NS=whatsapp-lab
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BASE="$ROOT/infra/k8s/base"

kubectl config current-context 2>/dev/null | grep -q "k3d-whatsapp-lab" || {
  echo "El contexto actual no es k3d-whatsapp-lab. Corré 'npm run cluster:up'."; exit 1; }

kubectl apply -f "$BASE/00-namespace.yaml" -f "$BASE/01-config.yaml" -f "$BASE/10-postgres.yaml"
kubectl -n "$NS" rollout status statefulset/postgres --timeout=180s

# El Job es inmutable una vez creado: para volver a aplicarlo hay que borrarlo. Eso
# es lo que hace idempotente al deploy; el runner de migraciones ya es idempotente
# por su cuenta, asi que correrlo de nuevo no rompe nada.
kubectl -n "$NS" delete job migrate --ignore-not-found >/dev/null
kubectl apply -f "$BASE/20-migrate-job.yaml"
kubectl -n "$NS" wait --for=condition=complete job/migrate --timeout=180s
kubectl -n "$NS" logs job/migrate | grep -v "injected env" | tail -3

kubectl apply -f "$BASE/30-api.yaml"
kubectl -n "$NS" rollout status deployment/api --timeout=180s

# El Ingress se aplica al final: sin backend listo, Traefik publicaria una ruta que
# devuelve 503.
kubectl apply -f "$BASE/40-ingress.yaml"
kubectl -n "$NS" get ingress api

# Los barridos periodicos. No dependen del Ingress ni de que la API este lista: hablan
# con Postgres directamente.
kubectl apply -f "$BASE/50-cronjobs.yaml"
kubectl -n "$NS" get cronjobs

# La NetworkPolicy va al final, cuando todo lo que tiene permiso ya existe: aplicarla
# antes cerraria la puerta mientras el Job de migraciones todavia la necesita.
kubectl apply -f "$BASE/60-networkpolicy.yaml"
kubectl -n "$NS" get networkpolicy

echo
kubectl -n "$NS" get pods -o wide
