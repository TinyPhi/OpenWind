#!/usr/bin/env bash
# bridge-setup.sh — temporary bridge until the setup-hardening PR merges upstream.
#
# Pulls the fixed setup files from the child branch (TusharSharma991/OpenWind)
# and overwrites the local (older) copies, then runs the real setup script.
#
# Usage: drop this file in the OpenWind repo root and run ./bridge-setup.sh
#
# Safe to delete once the PR merges — nothing here is meant to be permanent.
set -euo pipefail

RAW_BASE="https://raw.githubusercontent.com/TusharSharma991/OpenWind/child"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

FILES=(
  "setup.sh"
  "setup.bat"
  "scripts/setup.ps1"
  "scripts/zitadel-compose-template.yml"
  "scripts/bootstrap.ts"
  "docker-compose.yml"
)

echo ""
echo "  ============================================="
echo "   Bridge setup — fetching fixed setup files"
echo "   from child branch (pre-merge)"
echo "  ============================================="
echo ""

# Add this bridge script (and its Windows counterpart) to .gitignore, once.
GITIGNORE_ENTRIES=("bridge-setup.sh" "bridge-setup.bat" "scripts/bridge-setup.ps1")
touch .gitignore
for entry in "${GITIGNORE_ENTRIES[@]}"; do
  grep -qxF "$entry" .gitignore || echo "$entry" >> .gitignore
done
echo "  [+] .gitignore updated"

for f in "${FILES[@]}"; do
  echo "  --> Fetching $f"
  mkdir -p "$(dirname "$f")"
  curl -fsSL "$RAW_BASE/$f" -o "$f.tmp" || { echo "  [!] Failed to fetch $f"; exit 1; }
  mv "$f.tmp" "$f"
done
chmod +x setup.sh

echo ""
echo "  [+] Files replaced with fixed versions"
echo ""
echo "  ============================================="
echo "   Running setup"
echo "  ============================================="
echo ""

exec ./setup.sh
