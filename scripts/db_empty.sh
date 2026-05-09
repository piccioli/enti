#!/usr/bin/env bash
# Svuota i dati applicativi (solo TRUNCATE); import e deploy restano script separati salvo --import-and-deploy.
#
# Uso:
#   ./scripts/db_empty.sh
#   ./scripts/db_empty.sh --nuke-volume
#   ./scripts/db_empty.sh --import-and-deploy [percorso_datapack]
#     (percorso come in scripts/datapack_import.sh; default ./datapack-dist se omesso)
#
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

if ! docker compose version >/dev/null 2>&1; then
  echo "ERROR: 'docker compose' non trovato." >&2
  exit 1
fi

usage() {
  echo "USAGE: $(basename "$0") [--nuke-volume | --volume | --import-and-deploy [percorso_datapack]]" >&2
}

do_clean_tables() {
  echo "=== Svuota tabelle (solo dati) via psql nel container db ==="
  docker compose up -d db >/dev/null
  until docker compose exec -T db pg_isready -U postgres -d comuni >/dev/null 2>&1; do sleep 2; done

  docker compose exec -T db psql -U postgres -d comuni -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
TRUNCATE territorial_group_members;
TRUNCATE territorial_groups RESTART IDENTITY CASCADE;
TRUNCATE municipalities CASCADE;
TRUNCATE provinces CASCADE;
TRUNCATE regions CASCADE;
COMMIT;
SQL

  echo "OK: tabelle svuotate."
}

case "${1:-}" in
  --nuke-volume | --volume)
    echo "=== Arresto servizi ed eliminazione volume Postgres (pgdata) ==="
    docker compose down -v
    echo "OK. Al prossimo 'docker compose up -d --build' Postgres si reinizializza da db/init."
    ;;

  --import-and-deploy)
    if [[ -n "${2:-}" ]] && [[ "${2}" == -* ]]; then
      echo "ERROR: dopo --import-and-deploy atteso un percorso datapack, non '${2}'." >&2
      usage
      exit 1
    fi
    do_clean_tables
    echo "=== datapack_import ==="
    if [[ -n "${2:-}" ]]; then
      bash "${ROOT_DIR}/scripts/datapack_import.sh" "$2"
    else
      bash "${ROOT_DIR}/scripts/datapack_import.sh"
    fi
    echo "=== deploy ==="
    bash "${ROOT_DIR}/scripts/deploy.sh"
    echo "OK: clean + import datapack + deploy completati."
    ;;

  "")
    do_clean_tables
    echo "Esegui separatamente lo script di import che usi di solito."
    ;;

  *)
    echo "ERROR: opzione sconosciuta: $1" >&2
    usage
    exit 1
    ;;
esac
