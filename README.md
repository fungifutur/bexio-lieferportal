# bexio Lieferportal 0.1

Interne Node.js-Webanwendung für:

- Kunden aus den bexio Kontaktgruppen **Detailhandel** und **Gastronomie** auswählen
- Produkte aus den bexio Artikelgruppen **Frischpilze**, **Dörrpilze** und **Fertig Produkte** auswählen
- mehrere Bestellungen nacheinander erfassen
- offene Bestellungen gesammelt verarbeiten
- Monatsauftrag `Sammelrechnung {Monat} {Jahr}` finden bzw. optional automatisch anlegen
- Textposition `Datum Lieferung LS-xxxxx` vor den Produktpositionen ergänzen
- aus den neu angelegten Auftragspositionen einen bexio Lieferschein erzeugen und ausstellen
- mehrere erstellte Lieferscheine in einer gemeinsamen Druckansicht drucken
- alle wichtigen Aktionen protokollieren

## v1.12: Admin-Login komplett neu anlegen

Falls Benutzername oder Passwort nicht mehr bekannt sind, kann der Admin-Login ohne Kenntnis der alten Zugangsdaten neu gesetzt werden. In Render vorübergehend `LOGIN_RECOVERY_TOKEN` mit mindestens 24 zufälligen Zeichen anlegen, deployen lassen und anschließend `/login-recovery` öffnen. Dort den temporären Code, einen neuen Benutzernamen und ein neues Passwort eingeben. Danach `LOGIN_RECOVERY_TOKEN` sofort wieder aus Render löschen. Bestellungen, Produktfreigaben und bexio-Verbindung bleiben erhalten.

Der Login vergleicht Benutzernamen ab v1.12 ohne Beachtung von Groß-/Kleinschreibung. Passwörter werden vor Hash/Prüfung auf Unicode NFC normalisiert, damit Umlaute wie `ö` konsistent funktionieren.

## Wichtiger Stand 0.1

Die Anwendung startet absichtlich mit `BEXIO_DRY_RUN=true`. Damit kann die komplette Oberfläche getestet werden, ohne in bexio Belege zu verändern.

Die öffentliche bexio API-Dokumentation, die für diesen Build geprüft wurde, dokumentiert das Erstellen einer Lieferung aus einem Auftrag (`POST /2.0/kb_order/{order_id}/delivery`), Text-/Artikelpositionen und das Ausstellen von Lieferungen. Einen offiziellen **Delivery-PDF-Endpunkt** konnten wir dort nicht verifizieren. Deshalb erzeugt 0.1 für den Massendruck eine eigene saubere A4-Druckansicht mit der bexio Lieferscheinnummer. Sobald bexio einen offiziellen Endpoint bestätigt, kann der Adapter ergänzt werden.

## Lokal starten

Voraussetzungen: Node.js 20+, PostgreSQL.

```bash
cp .env.example .env
npm install
```

Admin-Passwort hashen:

```bash
node -e "console.log(require('bcryptjs').hashSync('MEIN-SEHR-STARKES-PASSWORT', 12))"
```

Den Hash in `APP_ADMIN_PASSWORD_HASH` eintragen. Zusätzlich einen Session-Key und Verschlüsselungsschlüssel erzeugen:

```bash
openssl rand -hex 32
openssl rand -hex 32
```

Einen Wert als `SESSION_SECRET`, den anderen als `APP_ENCRYPTION_KEY` eintragen. Danach:

```bash
npm start
```

## bexio Developer App

Im bexio Developer Portal eine eigene App anlegen. Für Render als Redirect URL eintragen:

`https://DEINE-RENDER-DOMAIN/auth/bexio/callback`

In Render setzen:

- `BEXIO_CLIENT_ID`
- `BEXIO_CLIENT_SECRET`
- `BEXIO_REDIRECT_URI`
- `BEXIO_SCOPES=openid offline_access contact_show article_show kb_order_edit kb_delivery_edit`

Nach dem Login im Lieferportal auf **bexio verbinden** klicken und die Verbindung autorisieren.

## Gruppenbezeichnungen

Die Namen werden case-insensitive, aber ansonsten exakt verglichen. Falls die Gruppen in eurem bexio anders heißen, Environment Variables anpassen:

```text
BEXIO_CONTACT_GROUPS=Detailhandel,Gastronomie
BEXIO_ARTICLE_GROUPS=Frischpilze,Dörrpilze,Fertig Produkte
```

Auf der Statuskarte zeigt die App an, welche Gruppen tatsächlich gefunden wurden.

## Monatsauftrag

Die App sucht für den Kunden einen Auftrag mit Titel:

`Sammelrechnung August 2026`

Das Format ist über `MONTHLY_ORDER_TITLE_TEMPLATE` einstellbar.

Falls keiner existiert und `AUTO_CREATE_MONTHLY_ORDER=true` gesetzt ist, wird der letzte vorhandene Auftrag desselben Kunden als **Einstellungsvorlage** verwendet. Kontakte, Titel und Gültigkeitsdatum werden ersetzt; Positionen werden nicht kopiert. Hat ein Kunde noch nie einen Auftrag, verlangt die App einmalig einen Musterauftrag in bexio. Das ist bewusst konservativ, damit keine unbekannten Zahlungs-/MwSt.-Einstellungen geraten werden.

## Ablauf bei echter Verarbeitung

1. Monatsauftrag suchen/erzeugen.
2. Textposition `20.08.2026 Lieferung …` anhängen.
3. Produktpositionen aus den bexio Artikelstammdaten anhängen.
4. Nur diese Produktpositionen an `POST /2.0/kb_order/{id}/delivery` übergeben.
5. Lieferschein ausstellen.
6. Textposition auf `20.08.2026 Lieferung LS-xxxxx` aktualisieren.
7. IDs und Nummern lokal protokollieren.

Damit bleibt die Reihenfolge im Sammelauftrag **Text → dazugehörige Produkte** erhalten, sofern bexio neu angelegte Positionen wie dokumentiert am Ende anfügt. Genau dieser Punkt sollte mit einem Testauftrag geprüft werden, bevor `BEXIO_DRY_RUN=false` gesetzt wird.

## Render Deployment

1. Neues GitHub Repository erstellen und diesen Ordner pushen.
2. In Render `New Blueprint` oder Web Service + PostgreSQL erstellen.
3. Environment Variables aus `.env.example` setzen.
4. `APP_BASE_URL` und `BEXIO_REDIRECT_URI` auf die Render-Domain setzen.
5. Deployen.
6. Login testen.
7. bexio verbinden.
8. Gruppen/Produkte prüfen.
9. Mit `BEXIO_DRY_RUN=true` mehrere Testbestellungen erfassen und Massendruck testen.
10. Erst danach mit einem separaten Testkunden `BEXIO_DRY_RUN=false` aktivieren.

## Migration auf eigenen Server

Die App ist zustandsarm. Für den Umzug benötigt ihr nur:

- Node.js 20+ oder Container
- PostgreSQL
- dieselben Environment Variables
- HTTPS Reverse Proxy
- DB-Dump/Restore

Empfohlen: Zugriff über Tailscale/WireGuard und keine öffentliche Freigabe des App-Ports.

## Bekannte Punkte für den ersten Echttest

- Prüfen, ob eure tatsächliche Artikelgruppe genau `Fertig Produkte` oder z. B. `Fertigprodukte` heißt.
- Prüfen, ob die Artikel `unit_id`, `account_id`, `tax_id` und `sale_price` vollständig besitzen.
- Prüfen, ob die Textposition + Artikelpositionen im bexio Auftrag exakt in der gewünschten Reihenfolge erscheinen.
- Prüfen, ob Preislogik kundenspezifische Preise/Rabatte benötigt. 0.1 übernimmt aktuell den Artikel-Verkaufspreis. Falls bexio bei euch kundenspezifische Preise nutzt, muss die Preisermittlung vor Produktivbetrieb ergänzt werden.
- Die 0.1-Druckansicht ist nicht das originale bexio Lieferschein-PDF.


## Ersteinrichtung Admin (v0.2)

Wenn noch kein Benutzer in der Datenbank existiert, zeigt das Portal automatisch eine einmalige Einrichtungsseite. Dort wird das erste Admin-Konto erstellt. Das Passwort wird ausschließlich als bcrypt-Hash in PostgreSQL gespeichert; ein `APP_ADMIN_PASSWORD_HASH` ist für neue Installationen nicht mehr nötig. Sobald ein Benutzer existiert, ist der Setup-Endpunkt gesperrt.


## Version 0.5

- Kundenfilter berücksichtigt jetzt sowohl bexio Kontaktgruppen als auch Kontaktbranchen (`contact_branch`).
- Standard-Branchen: `Detailhandel,Gastronomie`.
- Standard-Produktgruppen-IDs: `9,11,12` (Dörrpilze, Frischpilze, Fertigprodukte).
- Optional überschreibbar über `BEXIO_CONTACT_BRANCHES` und `BEXIO_ARTICLE_GROUP_IDS`.


## v0.6 Diagnose Kundenfilter

Die Statusanzeige listet nun alle bexio-Kontaktgruppen und Branchen mit IDs auf. Optional können `BEXIO_CONTACT_GROUP_IDS` und `BEXIO_CONTACT_BRANCH_IDS` als kommagetrennte IDs gesetzt werden.


## Preis-Anzeige (v1.0)
In der Produktauswahl wird der von der öffentlichen bexio-Artikel-API gelieferte `sale_price` angezeigt. Die öffentliche API liefert pro Artikel nur dieses eine Verkaufspreis-Feld. Falls Händler- und Direktverkaufspreise in bexio über eine zusätzliche Preislogik/Preisgruppe gepflegt werden, muss diese Zuordnung separat identifiziert werden, bevor beide Werte korrekt angezeigt oder verwendet werden können.


## Produktfreigabe (v1.0)

Administratoren können im Lieferportal über **Produkte verwalten** festlegen, welche bexio-Produkte aus den konfigurierten Artikelgruppen im Bestell-Dropdown erscheinen. Die Auswahl wird in PostgreSQL gespeichert und kann jederzeit geändert werden. Preise und Produktcodes werden direkt aus bexio angezeigt.


## Entfernen bereits erstellter Bestellungen (v1.2)
Bereits erstellte Bestellungen können aus der Portal-Liste archiviert werden. Ein bereits in bexio erstellter Lieferschein wird dabei **nicht** gelöscht oder verändert. Der Vorgang bleibt im Audit-Log nachvollziehbar.


## v1.4 – Retry-/Doppelungs-Schutz

Auftrags-, Text-, Produkt- und Lieferschein-IDs werden nach jedem erfolgreichen bexio-Schritt sofort gespeichert. Fehlgeschlagene Bestellungen können dadurch sicher erneut verarbeitet werden, ohne dieselben Positionen oder Lieferscheine nochmals anzulegen. Die bestehende Textposition wird nach erfolgreicher Ausstellung mit der definitiven LS-Nummer aktualisiert.


## Version 1.5
Drucklayout für Lieferscheine überarbeitet: kompakter A4-Aufbau, klare Dokumentnummer/Datum/Kunde, Positionsnummern sowie getrennte Menge und Einheit.

## 2-Faktor-Anmeldung per E-Mail

Version 1.7 unterstützt einen 6-stelligen E-Mail-Bestätigungscode nach erfolgreicher Passwortprüfung. Der Code ist 10 Minuten gültig, wird nur gehasht in der Session gehalten und nach erfolgreicher Anmeldung ungültig. Nach fünf falschen Versuchen muss die Anmeldung neu begonnen werden.



Neu ist außerdem **Alle sichtbaren archivieren**. Bereits in bexio erzeugte Lieferscheine bleiben dabei unverändert bestehen; nur die Portal-Einträge werden archiviert.




## Admin-Passwort zurücksetzen

Falls das Admin-Passwort vergessen wurde, kann vorübergehend in Render die Environment Variable `PASSWORD_RESET_TOKEN` mit einem langen zufälligen Wert (mindestens 24 Zeichen) gesetzt werden. Nach dem Deploy wird `/password-reset` geöffnet. Dort werden Benutzername, temporärer Reset-Code und das neue Passwort eingegeben. Nach erfolgreichem Reset werden alle bestehenden Login-Sessions beendet. `PASSWORD_RESET_TOKEN` muss danach sofort wieder aus Render gelöscht werden. Das Klartext-Passwort wird nie gespeichert; in PostgreSQL liegt nur der bcrypt-Hash.


## v1.13 Login-Fix
Die Login- und Setup-Formular-Handler im Browser wurden wiederhergestellt. Nach erfolgreicher Anmeldung wird die serverseitige Session gesetzt und die Seite neu geladen. API-Aufrufe senden Cookies explizit mit `credentials: same-origin`.

## v1.14 Drucklayout
- Absenderblock oben links mit mehr Abstand zum Papierrand (22 mm links / 20 mm oben).
- Kundenname im C5-Sichtfenster deutlich grösser und stärker hervorgehoben.


## v1.15 Monatsauswertung und manuelle Umsätze
Neu gibt es im Lieferportal den Bereich **Auswertung**.

- Monatsauswertung mit Gesamtumsatz, Portal-Umsatz, manuellen Umsätzen und verkauften kg.
- Auswertung nach Kunde und nach Produkt/Sorte.
- Archivierte Lieferungen bleiben in der Statistik enthalten.
- Neue Bestellungen speichern den Verkaufspreis als Snapshot. Dadurch bleiben spätere Preisänderungen in bexio ohne Einfluss auf historische Auswertungen.
- Ältere Bestellungen ohne Preis-Snapshot werden in der Auswertung mit dem aktuellen bexio-Verkaufspreis geschätzt und entsprechend markiert.
- Manuelle Buchungen laufen vollständig parallel zu bexio und werden nicht synchronisiert.
- Vorauswahl für manuelle Buchungen: TWINT, Märit Bern, Märit Thun und Bar.
- Manuelle Buchungen können optional einem Produkt und einer Menge zugeordnet werden; kg-Mengen fliessen dann auch in die Sorten-/Mengenauswertung ein.


## v1.16 Märit Bern und Lohnabrechnung
Für **Märit Bern** ist die manuelle Erfassung jetzt separat:

- Person: **Victoria** oder **Sali**
- Bar-Umsatz
- TWINT-Umsatz
- Tagesumsatz wird automatisch als Summe berechnet.
- Produkt und Menge werden bei Märit Bern nicht mehr abgefragt.

Die Monatsauswertung berechnet pro Person und Verkaufstag:
- Tagesumsatz bis CHF 600: **CHF 200 Bruttolohn**
- über CHF 600: zusätzlich **30% des Mehrumsatzes**
- Beispiel CHF 650 Tagesumsatz: CHF 200 + 30% von CHF 50 = **CHF 215**
- Monats-Bruttolohn = Summe aller Tageslöhne
- Abzug = **6.4% des Monats-Bruttolohns**
- Nettolohn = Bruttolohn minus 6.4%

Die Berechnung wird für Victoria und Sali separat angezeigt.

## v1.17
Die Produktauswahl hat jetzt eine echte Suchfunktion über mehrere Zeichen und beliebige Teile von Produktname oder Produktcode. `+ Produkt` steht unter der Produktauswahl; `Bestellung hinzufügen` folgt mit mehr Abstand darunter.

## v1.18
Das zusätzliche Produktsuchfeld aus v1.17 wurde wieder entfernt. Die Produktauswahl erfolgt wieder direkt über das Dropdown. Die Positionen von `+ Produkt` und `Bestellung hinzufügen` bleiben wie gewünscht.

## v1.19 Stabilität und Backups

- **Kein Doppelklick-Duplikat mehr:** „Bestellung hinzufügen“ ist während des Speicherns gesperrt. Zusätzlich sendet der Browser pro Erfassung einen eindeutigen Schlüssel; dieselbe Anfrage legt serverseitig nie eine zweite Bestellung an.
- **Kein Absturz bei Fehlern:** Fehler in Server-Routen (z. B. kurzer bexio-Ausfall beim Erfassen) werden als Fehlermeldung beantwortet statt den Prozess zu beenden.
- **Hängende Verarbeitung löst sich selbst:** Bestellungen, die länger als 10 Minuten „in Bearbeitung“ stehen (Neustart/Deploy während der Verarbeitung), werden auf „Fehler“ gesetzt und können erneut erstellt werden. Bereits angelegte bexio-Schritte werden dabei nicht doppelt ausgeführt.
- **Datum korrekt:** Lieferdatum und Monat werden in Schweizer Zeit vorgeschlagen (vorher zwischen 00:00 und 01:00/02:00 Uhr der Vortag). Datumsfelder aus PostgreSQL werden unabhängig von der Server-Zeitzone verarbeitet. Die Lohntabelle Märit Bern zeigt wieder echte Daten statt „Invalid Date“ und ist chronologisch sortiert.
- Der Kundenname einer Bestellung wird aus bexio übernommen, nicht aus dem Browser.
- `render.yaml` entspricht den gebuchten Instanzen (Web `0.5c-512mb`, DB `0.1c-256mb`).

## Tägliches Backup nach Google Drive

Render sichert die bezahlte Datenbank nur 3 Tage zurück (Point-in-Time-Recovery). Zusätzlich läuft jede Nacht `.github/workflows/db-backup.yml` (gleiches Verfahren wie bei der Pilzverwaltung): `pg_dump` → AES-256-verschlüsselt → Google Drive-Ordner `Lieferportal-Backups`, 30 Tage Aufbewahrung.

Einrichtung im GitHub-Repo unter **Settings → Secrets and variables → Actions**:

| Secret | Wert |
|---|---|
| `BACKUP_DATABASE_URL` | Render → Lieferportal-Datenbank → **External Database URL** |
| `BACKUP_PASSPHRASE` | langes zufälliges Passwort (im Passwortmanager ablegen) |
| `GDRIVE_RCLONE_TOKEN` | derselbe rclone-Token wie bei der Pilzverwaltung |

Optional als **Variable**: `PG_MAJOR` (Postgres-Version der Render-DB, Standard 16), `BACKUP_KEEP_DAYS`.

Danach unter **Actions → DB-Backup nach Google Drive → Run workflow** einmal manuell starten und prüfen, ob die Datei in Google Drive erscheint.

Hinweise:
- Die gespeicherte bexio-Verbindung ist im Backup mit `APP_ENCRYPTION_KEY` verschlüsselt. Diesen Wert ebenfalls im Passwortmanager ablegen; ohne ihn muss nach einer Wiederherstellung nur bexio neu verbunden werden.
- Bei öffentlichen Repos deaktiviert GitHub zeitgesteuerte Workflows nach 60 Tagen ohne Aktivität im Repo (GitHub schickt vorher eine E-Mail). Repo privat stellen oder den Workflow bei Bedarf wieder aktivieren.
- Wiederherstellung testen: `gpg --decrypt DATEI.dump.gpg | pg_restore --no-owner --clean --if-exists -d "<URL einer LEEREN Test-Datenbank>"`

## v1.20 Lohnabrechnung Märit Bern

In der Monatsauswertung hat jede Person (Victoria, Sali) unter „Lohn Märit Bern“ den Button **Lohnabrechnung erstellen**. Er öffnet eine A4-Lohnabrechnung für den gewählten Monat mit allen Verkaufstagen (Bar, TWINT, Tagesumsatz, Grundlohn, 30 % über CHF 600, Tageslohn), Bruttolohn, Abzug 6.4 % und Nettolohn sowie Unterschriftsfeldern. Der Druckdialog öffnet sich automatisch; als Drucker **„Als PDF speichern“** wählen.

Tageslöhne werden jetzt pro Tag auf Rappen gerundet und dann summiert, damit die Summe der Tageslöhne auf der Abrechnung exakt dem Bruttolohn entspricht (Unterschied zu vorher höchstens 1 Rappen).
