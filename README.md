# Cupra Datenexport – lokale Visualisierung

Zeigt die Fahrzeugdaten aus dem VW Group **EU Data Act Portal** (Cupra, VW, Seat, Škoda, Audi) im Browser an.
Läuft komplett offline – keine Installation, kein Server, keine Daten verlassen den Rechner.

## Starten

`index.html` per Doppelklick öffnen (Edge, Chrome oder Firefox).

Dann Export-Dateien laden:
- **Dateien laden** – eine oder mehrere `.json`- oder `.zip`-Dateien
- **Ordner laden** – einen ganzen Ordner mit Exporten
- oder Dateien/Ordner einfach ins Fenster ziehen

Geladene Exporte merkt sich der Browser (IndexedDB) bis zum Klick auf **Alles entfernen**.

## Ansichten

| Tab | Inhalt |
|---|---|
| Übersicht | Ladestand, Energieinhalt, Kilometerstand, Laden, Temperaturen, Status, Einstellungen eines Exports |
| Verlauf | Zeitreihen aller Zahlenwerte über mehrere Exporte, Statusverlauf (z. B. Ladezustand) |
| Aktivität | Wann das Fahrzeug Daten gesendet hat (pro Stunde/Tag, Tageszeit), Nachrichtentypen |
| Rohdaten | Alle Felder mit Werten, durchsuchbar, CSV-Export |
| Dateien | Geladene Dateien, einzeln entfernbar |

## Hinweise zum Datenformat

- Ein Export ist ein JSON `{ vin, user_id, Data: [{ key, dataFieldName, value }] }`.
- Die Datensätze haben **keinen eigenen Zeitstempel** und sind gemischt aus mehreren Fahrzeugmeldungen.
  Unterscheiden sich Werte innerhalb eines Exports, zeigt die App den Bereich (z. B. 50–56 %).
- Als Zeitpunkt eines Exports gilt die letzte enthaltene Meldung (`car_captured_time`, `timestamp` …),
  alternativ die Zeit aus dem Dateinamen (`FIN_JJJJMMTTHHMMSS.json`, als UTC interpretiert).
- `energy_contents.*.physical_value` wird als Zehntel-kWh angenommen (595,5 → 59,55 kWh).
- Feldbezeichnungen und Übersetzungen stehen in `fields.js` und lassen sich dort ergänzen.

Bibliotheken (lokal in `lib/`): Chart.js 4.4.1, chartjs-adapter-date-fns 3.0.0, chartjs-plugin-zoom 2.0.1, Hammer.js 2.0.8, JSZip 3.10.1.
