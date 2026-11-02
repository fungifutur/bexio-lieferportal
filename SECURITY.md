# Sicherheitsarchitektur

## Ziel
Das Lieferportal ist eine interne Geschäftsanwendung mit Schreibzugriff auf bexio. Es soll deshalb nach dem Prinzip **Least Privilege** betrieben werden und nie API-Schlüssel oder Passwörter im Quellcode enthalten.

## Schutzschichten

1. **HTTPS**
   - Auf Render ausschließlich über die HTTPS-URL verwenden.
   - Auf dem eigenen Server später Reverse Proxy (z. B. Caddy/Nginx) + TLS; idealerweise zusätzlich VPN/Tailscale/WireGuard.

2. **Eigener Login**
   - Passwörter werden nur als bcrypt-Hash gespeichert.
   - Sessions liegen serverseitig in PostgreSQL.
   - Session-Cookie: HttpOnly, SameSite=Lax, in Produktion Secure.
   - Login ist rate-limitiert.

3. **CSRF-Schutz**
   - Schreibende API-Aufrufe benötigen ein Session-gebundenes CSRF-Token.

4. **bexio OAuth statt dauerhaftem Vollzugriffstoken**
   - Produktion: Authorization Code Flow + `offline_access`.
   - Angeforderte Scopes sind auf Kontakte/Artikel lesen sowie Aufträge/Lieferungen bearbeiten begrenzt.
   - Access-/Refresh-Tokens werden AES-256-GCM verschlüsselt in PostgreSQL gespeichert.
   - Client Secret und Verschlüsselungsschlüssel bleiben in Render Environment Variables.

5. **Keine Stammdatenkopie**
   - Kunden und Artikel werden live aus bexio gelesen.
   - Lokal gespeichert werden nur Arbeitsdaten, IDs, Mengen, Belegnummern und Audit-Informationen.

6. **Berechtigungsprüfung am Server**
   - Der Browser kann keine beliebigen bexio Kontakt-/Artikel-IDs einschleusen: vor dem Speichern werden die IDs erneut gegen die freigegebenen bexio Gruppen geprüft.

7. **Doppelausführungsschutz**
   - Jede Bestellung besitzt eine eindeutige ID/Idempotency-Kennung.
   - Verarbeitung sperrt die Datenbankzeile (`FOR UPDATE`) und verarbeitet einen bereits erstellten Lieferschein nicht nochmals.

8. **Audit-Log**
   - Login, Entwurf, Lieferscheinerstellung und Fehler werden mit Zeit, Benutzer und IP protokolliert.

9. **Sicherer Rollout**
   - `BEXIO_DRY_RUN=true` ist Standard. In diesem Modus werden keine Aufträge oder Lieferscheine in bexio verändert.
   - Erst nach Test mit echten Kunden-/Artikelgruppen auf `false` umstellen.

## Empfohlene Produktion

- Separates bexio Developer-App-Set für Test und Produktion.
- Kein PAT für den Dauerbetrieb: PATs haben laut bexio alle Default-Scopes und laufen nach 60 Tagen ab. OAuth ist für diese Anwendung besser geeignet.
- Render PostgreSQL mit Backups bzw. eigener regelmäßiger `pg_dump`-Sicherung.
- Später auf eigenem Server: Docker/Podman, nicht-root Container, Firewall, automatisierte Sicherheitsupdates und Zugriff vorzugsweise nur via VPN.
- Für mehrere Mitarbeitende: eigene Benutzerkonten statt gemeinsamem Login; die Datenbank ist bereits darauf vorbereitet.


## Ersteinrichtung Admin (v0.2)

Wenn noch kein Benutzer in der Datenbank existiert, zeigt das Portal automatisch eine einmalige Einrichtungsseite. Dort wird das erste Admin-Konto erstellt. Das Passwort wird ausschließlich als bcrypt-Hash in PostgreSQL gespeichert; ein `APP_ADMIN_PASSWORD_HASH` ist für neue Installationen nicht mehr nötig. Sobald ein Benutzer existiert, ist der Setup-Endpunkt gesperrt.


## Entfernen bereits erstellter Bestellungen (v1.2)
Bereits erstellte Bestellungen können aus der Portal-Liste archiviert werden. Ein bereits in bexio erstellter Lieferschein wird dabei **nicht** gelöscht oder verändert. Der Vorgang bleibt im Audit-Log nachvollziehbar.




## Temporärer Passwort-Reset

Der Reset-Endpunkt `/password-reset` ist nur aktiv, wenn `PASSWORD_RESET_TOKEN` mit mindestens 24 Zeichen gesetzt ist. Der Token wird nicht in URLs übertragen, sondern per POST-Formular eingegeben, und Vergleiche erfolgen über konstante Hash-Längen. Erfolgreiche Resets invalidieren bestehende Sessions. Die Environment Variable muss unmittelbar nach dem Reset entfernt werden, damit der öffentliche Reset-Endpunkt wieder deaktiviert ist.


## Login-Wiederherstellung

`LOGIN_RECOVERY_TOKEN` ist ausschließlich als kurzfristiger Notfallmechanismus gedacht. Solange die Variable gesetzt ist, ist `/login-recovery` erreichbar. Verwende einen zufälligen Wert mit mindestens 24 Zeichen und entferne die Variable unmittelbar nach erfolgreicher Wiederherstellung. Der alte Benutzername und das alte Passwort werden nicht benötigt. Alle bestehenden Web-Sessions werden nach der Wiederherstellung gelöscht.
