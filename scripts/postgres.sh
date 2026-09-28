#!/usr/bin/env bash
# postgres.sh — a disposable Postgres in Docker for the gated Postgres suites.
#
#   scripts/postgres.sh up     start (or reuse) the container, wait until ready,
#                              and print the KYNETA_PG_URL to export
#   scripts/postgres.sh url    print the KYNETA_PG_URL
#   scripts/postgres.sh down   stop and remove the container and its data
#
# Typical use:
#   eval "$(scripts/postgres.sh up)"
#   pnpm verify
#
# The suites create and drop their own tables, so the database starts empty.
# Port 55432 keeps clear of a Postgres already running on 5432.

set -euo pipefail

NAME="kyneta-postgres"
IMAGE="postgres:17"
PORT="${KYNETA_PG_PORT:-55432}"
DB="kyneta_test"
USER="kyneta"
PASSWORD="kyneta"
URL="postgres://${USER}:${PASSWORD}@localhost:${PORT}/${DB}"

require_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "docker not found. Install a runtime, e.g.: brew install colima docker && colima start" >&2
    exit 1
  fi
  if ! docker info >/dev/null 2>&1; then
    # Colima's socket, when the CLI has no context pointing at it.
    local colima_sock="${HOME}/.colima/default/docker.sock"
    if [ -z "${DOCKER_HOST:-}" ] && [ -S "$colima_sock" ]; then
      export DOCKER_HOST="unix://${colima_sock}"
    fi
  fi
  if ! docker info >/dev/null 2>&1; then
    echo "docker is installed but no daemon is reachable (try: colima start)" >&2
    exit 1
  fi
}

up() {
  require_docker
  if [ -z "$(docker ps -aq --filter "name=^${NAME}$")" ]; then
    docker run -d --name "$NAME" \
      -e POSTGRES_DB="$DB" \
      -e POSTGRES_USER="$USER" \
      -e POSTGRES_PASSWORD="$PASSWORD" \
      -p "${PORT}:5432" \
      "$IMAGE" >/dev/null
  elif [ -z "$(docker ps -q --filter "name=^${NAME}$")" ]; then
    docker start "$NAME" >/dev/null
  fi
  for _ in $(seq 1 60); do
    if docker exec "$NAME" pg_isready -U "$USER" -d "$DB" >/dev/null 2>&1; then
      echo "export KYNETA_PG_URL=${URL}"
      return 0
    fi
    sleep 1
  done
  echo "postgres did not become ready within 60s" >&2
  exit 1
}

down() {
  require_docker
  docker rm -f "$NAME" >/dev/null 2>&1 || true
}

case "${1:-}" in
  up) up ;;
  url) echo "export KYNETA_PG_URL=${URL}" ;;
  down) down ;;
  *)
    echo "usage: $0 up|url|down" >&2
    exit 2
    ;;
esac
