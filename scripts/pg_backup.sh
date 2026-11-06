#!/usr/bin/env bash
# Täglicher, unabhängiger Datenbank-Dump (Audit OPS-01 / M2). Legt eine verschlüsselte Datei AUSSERHALB von Render ab.
#
# Benötigt: pg_dump (passend zur Postgres-Version bei Render) und gpg.
# Umgebungsvariablen:
#   BACKUP_DATABASE_URL   externe Verbindungs-URL der Render-Datenbank (Render → Datenbank → «External Database URL»)
#   BACKUP_GPG_RECIPIENT  E-Mail/ID des GPG-Schlüssels, mit dem verschlüsselt wird (öffentlicher Schlüssel genügt)
#   BACKUP_PASSPHRASE     Alternative: Passwort für symmetrische Verschlüsselung (einfacher, z. B. für GitHub Actions)
#   BACKUP_DIR            Zielordner, z. B. ein gemountetes Laufwerk bei hosttech oder ein lokaler Ordner (Standard: ./backups)
#   BACKUP_EXCLUDE_DATA   Tabellen, deren INHALT nicht gesichert wird (Standard: user_sessions = Login-Sitzungen,
#                         werden nach einer Wiederherstellung nicht gebraucht). Leer setzen für Vollsicherung.
#   BACKUP_KEEP_DAYS      Aufbewahrung in Tagen (Standard 30)
# Beispiel Cron (täglich 02:30):  30 2 * * *  /pfad/zu/scripts/pg_backup.sh >> /var/log/pilz_backup.log 2>&1
set -euo pipefail
: "${BACKUP_DATABASE_URL:?BACKUP_DATABASE_URL fehlt}"
: "${BACKUP_GPG_RECIPIENT:=}"; : "${BACKUP_PASSPHRASE:=}"
[ -n "$BACKUP_GPG_RECIPIENT$BACKUP_PASSPHRASE" ] || { echo "BACKUP_GPG_RECIPIENT oder BACKUP_PASSPHRASE fehlt" >&2; exit 1; }
DIR="${BACKUP_DIR:-./backups}"; KEEP="${BACKUP_KEEP_DAYS:-30}"
mkdir -p "$DIR"
EXCL=(); EX="${BACKUP_EXCLUDE_DATA-user_sessions}"
for t in $EX; do EXCL+=(--exclude-table-data="$t"); done
FILE="$DIR/lieferportal_$(date +%Y%m%d_%H%M%S).dump.gpg"
if [ -n "$BACKUP_PASSPHRASE" ]; then
  pg_dump --format=custom --no-owner --no-privileges "${EXCL[@]}" "$BACKUP_DATABASE_URL" | gpg --batch --yes --pinentry-mode loopback --passphrase-fd 3 --symmetric --cipher-algo AES256 --output "$FILE" 3<<<"$BACKUP_PASSPHRASE"
else
  pg_dump --format=custom --no-owner --no-privileges "${EXCL[@]}" "$BACKUP_DATABASE_URL" | gpg --batch --yes --encrypt --recipient "$BACKUP_GPG_RECIPIENT" --output "$FILE"
fi
[ -s "$FILE" ] || { echo "Backup ist leer: $FILE" >&2; exit 1; }
echo "Backup erstellt: $FILE ($(du -h "$FILE" | cut -f1))"
find "$DIR" -name 'lieferportal_*.dump.gpg' -mtime +"$KEEP" -delete
# Wiederherstellung testen (mindestens einmal!):
#   gpg --decrypt DATEI.dump.gpg | pg_restore --no-owner --clean --if-exists -d "<URL einer LEEREN Test-Datenbank>"
