# ReVint

Eine Chromium-Erweiterung zum lokalen Sichern und erneuten Ausfüllen eigener Angebote auf Vinted.

Repository: <https://github.com/mxKeaton/ReVint>

## Installation

1. Chromium/Chrome öffnen und `chrome://extensions` aufrufen.
2. **Entwicklermodus** einschalten.
3. **Entpackte Erweiterung laden** wählen und diesen Ordner auswählen.
4. Vinted öffnen und die Seite mit den eigenen Artikeln neu laden.

## Länder & Sprachen

ReVint läuft auf allen Vinted-Domains (u. a. `vinted.com`, `.co.uk`, `.de`, `.at`, `.fr`, `.es`, `.it`, `.nl`, `.be`, `.pl`, `.lt`, `.lv`, `.ee`, `.cz`, `.sk`, `.hu`, `.ro`, `.se`, `.dk`, `.fi`, `.pt`, `.gr`, `.hr`, `.bg`, `.si`).

Die Sprache der Oberfläche wird automatisch aus der besuchten Domain erkannt (z. B. `.de` → Deutsch, `.fr` → Französisch). Alle Texte liegen als einzelne Dateien unter `lang/` (`de.json`, `en.json`, `fr.json`, …); fehlt eine Sprache, wird auf Englisch zurückgegriffen. Eine neue Sprache lässt sich durch eine weitere JSON-Datei mit denselben Schlüsseln ergänzen. Einstellungen gibt es nicht.

## Verwendung

Auf der Vinted-Startseite (`/`) zeigt ReVint einen kurzen Hinweis samt Button zur Mitgliederseite („… wechsle zur **Mitgliederseite**“).

Unter jedem sichtbaren **Pushen**-Button erscheint **Als Relisting speichern**. Die Erweiterung liest die Artikelseite, lädt die dort sichtbaren Fotos und legt alles lokal in der Erweiterung ab (kein Speicher-Dialog, kein Ordner, kein Server).

Rechts oben zeigt ReVint auf beiden Seiten ein gemeinsames Panel mit den gespeicherten Relistings:

- Die Liste zeigt **20 Einträge pro Seite**; mit **‹** / **›** unten wird seitenweise geblättert. Das Panel wächst mit der Anzahl der Einträge.
- Links an jedem Eintrag sitzt eine **Checkbox**. Damit lassen sich mehrere Relistings markieren; **Alle auswählen** markiert die gesamte Liste.
- **Auswahl relisten** öffnet die markierten Relistings **einzeln nacheinander** (mit Wartezeit dazwischen, um Vinteds Anfrage-Limit nicht auszulösen) in neuen Tabs und füllt dort automatisch das Formular.
- **Auswahl löschen** entfernt die markierten Relistings; beim Überfahren färbt sich die Schaltfläche rot.
- Während **Auswahl relisten** und **Sammel-Export** läuft, zeigt eine Fortschrittsanzeige neben **Alle auswählen** den Stand und ein Hinweis bittet darum, die Seite nicht zu verlassen. Nach dem Sammel-Export wird die Liste automatisch neu eingelesen.
- Über den Pfeil oben rechts neben **ReVint** lässt sich das Panel einklappen und wieder öffnen; standardmäßig ist es eingeklappt.

Ein Klick auf einen Eintrag füllt das Formular:

- Auf **Meine Artikel** (Mitgliederseite) wird dazu ein neuer Tab mit der Verkaufsseite geöffnet und das Relisting dort automatisch eingesetzt.
- Direkt auf der Verkaufsseite (`/items/new`) wird das Formular sofort gefüllt. Ist es bereits ausgefüllt, wird die Seite zuerst neu geladen, damit sich keine Angaben oder Fotos doppeln.

Zusätzlich bleiben **Alle als Relistings speichern** und **Gelistete als Relistings speichern** zum Sammel-Export auf der Mitgliederseite sowie **Relisting manuell wählen** zum Laden einer `.revint.json`-Datei erhalten. Der Sammel-Export speichert mit zeitlichem Abstand, drosselt alle Vinted-Anfragen (min. 200 ms) und wiederholt fehlgeschlagene Relistings sowie HTTP 429/5xx automatisch, damit unter Last keine Einträge übersprungen werden.

Gleichnamige Relistings überschreiben sich nicht: Existiert bereits ein Relisting mit anderem Ursprung, wird automatisch ein Zähler angehängt (`-2`, `-3`, …). Ein erneuter Export desselben Artikels überschreibt dagegen seinen vorhandenen Eintrag.

Das Angebot wird nie automatisch abgeschickt. Prüfe vor dem Hochladen besonders Größe, Zustand, Farbe, Paketgröße und Fotos. Vinted ändert seine Oberfläche regelmäßig; nicht eindeutig erkennbare Felder bleiben zur manuellen Auswahl frei.

Beim Export werden Kategoriepfad (Name und Vinted-Kategorie-ID), Marke, Größe, Zustand, Farbe, Material und ISBN mitgespeichert, bei Videospielen zusätzlich Plattform und Altersbeschränkung. Beim Import setzt die Erweiterung Titel, Beschreibung, Preis, Kategorie, Zustand, Marke, Größe, Farbe, Material, ISBN sowie (falls vorhanden) Plattform und Altersbeschränkung automatisch über Vinteds eigene Auswahl-Dropdowns. Die Marke wird nur bei exakter Übereinstimmung mit einem Vorschlag gesetzt, niemals frei erfunden. Versand- und Paketoptionen werden niemals geöffnet.

Auf der Mitgliederseite bietet das Panel zwei Sammelaktionen: alle aktuell auf der Seite gelisteten Artikel exportieren oder nur die nicht als verkauft/verborgen markierten. Browser und Rechner können bei sehr vielen bildreichen Artikeln vorübergehend stark belastet werden.

## Speicher & Datenschutz

- Keine Vinted-API und kein externer Server: Es werden nur die normalen Vinted-Webseiten und deren Bild-URLs gelesen.
- Alle Relistings (inkl. Bilder als Base64) liegen ausschließlich lokal in der Erweiterung (IndexedDB) – kein Ordner, kein Download, keine Übertragung nach außen.
- **Auswahl löschen** entfernt Einträge endgültig; das Deinstallieren der Erweiterung löscht alle Daten.
- Die Erweiterung löscht oder veröffentlicht keine Artikel. Beachte die Vinted-Regeln für doppelte bzw. erneut eingestellte Angebote.

## Veröffentlichung (Chrome Web Store)

Unter `store/` liegen die Store-Texte (`listing.md`, `reviewer-notes.md`) sowie Screenshots und ein Promotion-Bild; die Datenschutzerklärung liegt unter `docs/privacy-policy.md` und ist über GitHub Pages veröffentlicht (`https://mxkeaton.github.io/ReVint/privacy-policy.html`). Die Bilder unter `icons/` und `store/` sind noch Platzhalter. Vor der Veröffentlichung: echte Icons/Screenshots einsetzen und `store/listing.md` finalisieren.
