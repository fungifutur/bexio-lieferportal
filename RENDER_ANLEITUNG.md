# Render – Kurzsetup

## 1. Repository
Projekt in ein privates GitHub Repository pushen.

## 2. Render
Mit `render.yaml` als Blueprint deployen oder Web Service + PostgreSQL manuell anlegen.

## 3. Secrets
Folgende Werte niemals in GitHub speichern:

- `APP_ADMIN_PASSWORD_HASH`
- `SESSION_SECRET`
- `APP_ENCRYPTION_KEY`
- `BEXIO_CLIENT_ID`
- `BEXIO_CLIENT_SECRET`
- `DATABASE_URL`

## 4. URLs
Nach dem ersten Deploy:

- `APP_BASE_URL=https://<service>.onrender.com`
- `BEXIO_REDIRECT_URI=https://<service>.onrender.com/auth/bexio/callback`

Dieselbe Redirect URL muss im bexio Developer Portal registriert sein.

## 5. Erster Start
`BEXIO_DRY_RUN=true` lassen. Login → bexio verbinden → Status prüfen → Testbestellungen erfassen.

## 6. Produktivschaltung
Erst nach geprüftem Testauftrag `BEXIO_DRY_RUN=false` setzen und neu deployen.


## Ersteinrichtung Admin (v0.2)

Wenn noch kein Benutzer in der Datenbank existiert, zeigt das Portal automatisch eine einmalige Einrichtungsseite. Dort wird das erste Admin-Konto erstellt. Das Passwort wird ausschließlich als bcrypt-Hash in PostgreSQL gespeichert; ein `APP_ADMIN_PASSWORD_HASH` ist für neue Installationen nicht mehr nötig. Sobald ein Benutzer existiert, ist der Setup-Endpunkt gesperrt.


## Version 0.5

- Kundenfilter berücksichtigt jetzt sowohl bexio Kontaktgruppen als auch Kontaktbranchen (`contact_branch`).
- Standard-Branchen: `Detailhandel,Gastronomie`.
- Standard-Produktgruppen-IDs: `9,11,12` (Dörrpilze, Frischpilze, Fertigprodukte).
- Optional überschreibbar über `BEXIO_CONTACT_BRANCHES` und `BEXIO_ARTICLE_GROUP_IDS`.


## v0.6 Diagnose Kundenfilter

Die Statusanzeige listet nun alle bexio-Kontaktgruppen und Branchen mit IDs auf. Optional können `BEXIO_CONTACT_GROUP_IDS` und `BEXIO_CONTACT_BRANCH_IDS` als kommagetrennte IDs gesetzt werden.


## Version 1.5
Drucklayout für Lieferscheine überarbeitet: kompakter A4-Aufbau, klare Dokumentnummer/Datum/Kunde, Positionsnummern sowie getrennte Menge und Einheit.

## 2-Faktor per E-Mail aktivieren

Unter **Web Service → Environment** zusätzlich setzen:






## Vergessenes Admin-Passwort

1. Unter Web Service → Environment vorübergehend `PASSWORD_RESET_TOKEN` hinzufügen. Verwende einen langen zufälligen Wert mit mindestens 24 Zeichen.
2. Änderungen speichern und den Deploy abwarten.
3. `https://bexio-lieferportal.onrender.com/password-reset` öffnen.
4. Admin-Benutzername, den temporären Reset-Code und ein neues Passwort (mindestens 12 Zeichen) eingeben.
5. Nach Erfolg `PASSWORD_RESET_TOKEN` in Render **sofort wieder löschen** und erneut deployen lassen.

Der Reset löscht keine bexio-Daten, Bestellungen oder Produkteinstellungen. Er ändert nur den Passwort-Hash und beendet bestehende Portal-Sessions.


## Admin-Login komplett neu anlegen (v1.12)

1. Im Web Service unter **Environment** `LOGIN_RECOVERY_TOKEN` hinzufügen. Der Wert muss mindestens 24 zufällige Zeichen lang sein.
2. Nach dem Deploy `https://bexio-lieferportal.onrender.com/login-recovery` öffnen.
3. Den temporären Code sowie einen neuen Benutzernamen und ein neues Passwort eingeben. Der alte Benutzername ist nicht nötig.
4. Nach Erfolg `LOGIN_RECOVERY_TOKEN` in Render sofort wieder löschen und neu deployen.
5. Mit dem neuen Login anmelden.

Die Wiederherstellung aktualisiert das bestehende Admin-Konto statt es zu löschen, damit Referenzen in Bestellungen/Audit-Log erhalten bleiben.
