#!/usr/bin/env bash
# backup.sh — push data.json to the private backup GitHub repo
#
# Setup (first time only):
#   1. Clone your backup repo:
#        git clone git@github-backup:tvpian/Ultranote_Data.git ~/ultranote-backup
#   2. Make this script executable:
#        chmod +x backup.sh
#   3. Add a cron job for daily midnight backup:
#        crontab -e
#        Add: 0 0 * * * /media/mbwh/pop/tvp_ws/note_taking_app/backup.sh >> /media/mbwh/pop/tvp_ws/note_taking_app/backup.log 2>&1

set -euo pipefail

SOURCE="/media/mbwh/pop/tvp_ws/note_taking_app/data.json"
BACKUP_REPO="${HOME}/ultranote-backup"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

# Guard: source file must exist
if [ ! -f "$SOURCE" ]; then
  echo "[$TIMESTAMP] ERROR: $SOURCE not found — nothing to back up." >&2
  exit 1
fi

# Guard: backup repo must be cloned already
if [ ! -d "$BACKUP_REPO/.git" ]; then
  echo "[$TIMESTAMP] ERROR: Backup repo not found at $BACKUP_REPO" >&2
  echo "  Run: git clone git@github-backup:tvpian/Ultranote_Data.git $BACKUP_REPO" >&2
  exit 1
fi

cp "$SOURCE" "$BACKUP_REPO/data.json"

cd "$BACKUP_REPO"

# Nothing changed — skip commit
if git diff --quiet data.json; then
  echo "[$TIMESTAMP] No changes since last backup — skipping commit."
  exit 0
fi

git add data.json
git commit -m "backup: $TIMESTAMP"
git push origin main

echo "[$TIMESTAMP] Backup pushed successfully."
