#!/bin/bash
set -euo pipefail

REFRESH_SECONDS="${AIRFREYR_REFRESH_SECONDS:-$(( ${AIRFREYR_REFRESH_HOURS:-3} * 3600 ))}"

build_args() {
  ARGS=(--yes @emgeebee/airfreyr@latest serve --no-logo --no-header)
  ARGS+=(-H "${AIRFREYR_HOSTNAME:-0.0.0.0}")
  ARGS+=(-p "${AIRFREYR_PORT:-3797}")
  [[ -n "${AIRFREYR_QUEUE_DIR:-}" ]] && ARGS+=(-q "${AIRFREYR_QUEUE_DIR}")
  [[ -n "${AIRFREYR_OUTPUT_DIR:-}" ]] && ARGS+=(-D "${AIRFREYR_OUTPUT_DIR}")
  [[ -n "${AIRFREYR_CONFIG:-}" ]] && ARGS+=(-o "${AIRFREYR_CONFIG}")
  printf '%s\n' "${ARGS[@]}"
}

shutdown() {
  if [[ -n "${SERVER_PID:-}" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [[ -n "${TIMER_PID:-}" ]]; then
    kill "$TIMER_PID" 2>/dev/null || true
    wait "$TIMER_PID" 2>/dev/null || true
  fi
}
trap shutdown TERM INT

while true; do
  echo "[airfreyr] pulling latest @emgeebee/airfreyr and starting server ($(date -u +%Y-%m-%dT%H:%M:%SZ))"
  rm -rf "${HOME}/.npm/_npx" 2>/dev/null || true

  mapfile -t NPX_ARGS < <(build_args)
  npx "${NPX_ARGS[@]}" &
  SERVER_PID=$!

  (
    sleep "${REFRESH_SECONDS}"
    echo "[airfreyr] refresh interval (${AIRFREYR_REFRESH_HOURS:-3}h) elapsed, restarting..."
    kill "$SERVER_PID" 2>/dev/null || true
  ) &
  TIMER_PID=$!

  wait "$SERVER_PID" 2>/dev/null || true
  kill "$TIMER_PID" 2>/dev/null || true
  wait "$TIMER_PID" 2>/dev/null || true

  SERVER_PID=""
  TIMER_PID=""
  sleep 2
done
