#!/usr/bin/env bash
# Run both backend (FastAPI) and frontend (Vite) for local development.
# Usage: ./dev.sh

set -e

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"

cleanup() {
  echo ""
  echo "Shutting down..."
  kill $BACKEND_PID $FRONTEND_PID 2>/dev/null
  wait $BACKEND_PID $FRONTEND_PID 2>/dev/null
  echo "Done."
}
trap cleanup EXIT INT TERM

# --- Backend ---
echo "Starting backend (FastAPI)..."
cd "$ROOT_DIR/backend"
uv run uvicorn src.main:app --reload --port 8000 &
BACKEND_PID=$!

# --- Frontend ---
echo "Starting frontend (Vite)..."
cd "$ROOT_DIR/dashboard-app"
npm run dev &
FRONTEND_PID=$!

echo ""
echo "Backend  → http://localhost:8000"
echo "Frontend → http://localhost:5173"
echo ""
echo "Press Ctrl+C to stop both."

wait
