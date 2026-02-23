#!/usr/bin/env bash
# backup_data.sh — copies data.json to the private backup repo and pushes it.
# Run manually or via cron. No output unless something fails.
#
# Setup (one-time):
#   git clone git@github.com:tvpian/Ultranote_Data.git ~/ultranote-data
#   chmod +x /media/mbwh/pop/tvp_ws/note_taking_app/backup_data.sh

set -euo pipefail

APP_DIR="/media/mbwh/pop/tvp_ws/note_taking_app"
BACKUP_DIR="$HOME/ultranote-data"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

# Check the backup repo exists
if [[ ! -d "$BACKUP_DIR/.git" ]]; then
  echo "ERROR: Backup repo not found at $BACKUP_DIR" >&2
  echo "Run: git clone git@github.com:tvpian/Ultranote_Data.git $BACKUP_DIR" >&2
  exit 1
fi

# Check source data exists
if [[ ! -f "$APP_DIR/data.json" ]]; then
  echo "ERROR: data.json not found at $APP_DIR" >&2
  exit 1
fi

cd "$BACKUP_DIR"

# Pull any remote changes first to avoid conflicts
git pull --quiet --rebase origin main 2>/dev/null || true

# Copy the live data
cp "$APP_DIR/data.json" "$BACKUP_DIR/data.json"

# Only commit if something actually changed
if git diff --quiet data.json 2>/dev/null && git ls-files --error-unmatch data.json 2>/dev/null; then
  # No changes, nothing to do
  exit 0
fi

git add data.json
git commit -m "backup: $TIMESTAMP" --quiet
git push --quiet origin main

echo "Backup complete: $TIMESTAMP"
