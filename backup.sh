#!/usr/bin/env bash
# backup.sh — push data.json to the private backup GitHub repo
#
# Setup (first time only):
#   1. Clone your backup repo:
#        git clone git@github-backup:tvpian/Ultranote_Data.git ~/.local/share/ultranote-data
#   2. Make this script executable:
#        chmod +x backup.sh
#   3. Add a cron job for daily midnight backup:
#        crontab -e
#        Add: 0 0 * * * /media/mbwh/pop1/tvp_ws/note_taking_app/backup.sh >> /media/mbwh/pop1/tvp_ws/note_taking_app/backup.log 2>&1

set -euo pipefail

# Resolve SOURCE relative to this script so the path keeps working if the
# parent drive is renamed (e.g. /media/mbwh/pop -> /media/mbwh/pop1).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE="$SCRIPT_DIR/data.json"
ATTACHMENTS_SOURCE="$SCRIPT_DIR/attachments"
BACKUP_REPO="${HOME}/.local/share/ultranote-data"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

# Guard: source file must exist
if [ ! -f "$SOURCE" ]; then
  echo "[$TIMESTAMP] ERROR: $SOURCE not found — nothing to back up." >&2
  exit 1
fi

# Guard: backup repo must be cloned already
if [ ! -d "$BACKUP_REPO/.git" ]; then
  echo "[$TIMESTAMP] ERROR: Backup repo not found at $BACKUP_REPO" >&2
  echo "  Run: git clone git@github-backup:tvpian/Ultranote_Data.git ~/.local/share/ultranote-data" >&2
  exit 1
fi

cp "$SOURCE" "$BACKUP_REPO/data.json"

# Images/audio/video/files now live on disk under attachments/<id>.bin
# (moved out of data.json to keep saves fast — see out-of-band attachment
# store in server.js). Mirror that folder into the backup repo too, otherwise
# a note that references an attachment id would restore with a broken image.
mkdir -p "$BACKUP_REPO/attachments"
if [ -d "$ATTACHMENTS_SOURCE" ]; then
  rsync -a --delete "$ATTACHMENTS_SOURCE"/ "$BACKUP_REPO/attachments"/
fi

cd "$BACKUP_REPO"

# Pull remote changes first to avoid conflicts from concurrent pushes
git pull --rebase --quiet origin main 2>/dev/null || true

git add data.json attachments

# Nothing changed (neither data.json nor any attachment file) — skip commit
if git diff --cached --quiet; then
  echo "[$TIMESTAMP] No changes since last backup — skipping commit."
  exit 0
fi

git commit -m "backup: $TIMESTAMP"
git push origin main

echo "[$TIMESTAMP] Backup pushed successfully."
