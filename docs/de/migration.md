<p align="center">
  <a href="../en/migration.md">English</a> | <a href="../ko/migration.md">한국어</a> | <strong>Deutsch</strong> | <a href="../cn/migration.md">简体中文</a> | <a href="../es/migration.md">Español</a> | <a href="../vi/migration.md">Tiếng Việt</a> | <a href="../zh-Hant/migration.md">繁體中文</a>
</p>

# RisuAI-Migrationsleitfaden

> 🌐 Diese Anleitung wurde maschinell übersetzt. Für die genauesten Informationen siehe die [englische](../en/migration.md) oder [koreanische](../ko/migration.md) Version.

Es gibt zwei Möglichkeiten, Daten von einer bestehenden RisuAI-Installation (Web-RisuAI, Lokales RisuAI) zu PocketRisu zu migrieren. Wählen Sie je nach Quellumgebung und Datenmenge.

- [1. Lokale Backup-Datei (.bin)](#1-lokale-backup-datei-bin) — Funktioniert in allen Umgebungen. Die häufigste Methode.
- [2. Save-Ordner direkt kopieren](#2-save-ordner-direkt-kopieren) — Lokales RisuAI, große Datenmengen.


## Bevor Sie beginnen

> ⚠️ **Sichern Sie Ihre vorhandenen Daten** vor der Migration. Sie können eine `.bin`-Datei aus den Einstellungen > Backup von RisuAI exportieren.


---

## 1. Lokale Backup-Datei (.bin)

Exportieren Sie eine `.bin`-Backup-Datei aus dem bestehenden RisuAI und importieren Sie sie dann in PocketRisu. Funktioniert unabhängig von der Quellumgebung (Web / Capacitor / lokal).

1. **Im bestehenden RisuAI**: Einstellungen > Backup > "Lokales Backup speichern", um eine `.bin`-Datei zu exportieren.
2. **In PocketRisu**: Einstellungen > Datenmigration > "Original Risu Local Backup importieren", um die `.bin`-Datei zu importieren.


---

## 2. Save-Ordner direkt kopieren

Geeignet für große Datenmengen (mehrere GB oder mehr). Erfordert direkten Dateisystemzugriff auf den Server.

1. Stoppen Sie den PocketRisu-Server.
2. Überschreiben Sie den `save`-Ordner von PocketRisu mit dem `save`-Ordner des bestehenden RisuAI.
3. Starten Sie den PocketRisu-Server neu — die automatische Migration beginnt.
    - Überwachen Sie den Fortschritt im Terminal oder in den PM2-Logs.
4. Archivieren oder löschen Sie die ursprünglichen Hex-Dateien nach erfolgreicher Prüfung bei Bedarf manuell.


---

## Welche Methode soll ich wählen?

| Situation                                                  | Empfohlene Methode                |
| ---------------------------------------------------------- | --------------------------------- |
| Migration von Web-RisuAI                                   | 1. `.bin`-Backup                  |
| Migration von Lokalem RisuAI, große Datenmenge (10GB+)     | 2. Save-Ordner direkt kopieren    |
| Unsicher                                                   | 1. `.bin`-Backup                  |


---

← [Zurück zur README](../../i18n/README.de.md)
