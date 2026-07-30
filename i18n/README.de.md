<p align="center">
  <img src="../assets/pocketrisu-banner-1024.png" alt="PocketRisu Kei" width="900" />
</p>

<h1 align="center">PocketRisu Kei</h1>

<p align="center">
  Ein selbstgehostetes KI-Rollenspiel-Chat-Frontend auf Basis von PocketRisu, erweitert um zusätzliche Funktionen und Verbesserungen der Benutzerfreundlichkeit
</p>

<p align="center">
  <a href="../README.md">English</a> | <a href="README.ko.md">한국어</a> | <strong>Deutsch</strong> | <a href="README.cn.md">简体中文</a> | <a href="README.es.md">Español</a> | <a href="README.vi.md">Tiếng Việt</a> | <a href="README.zh-Hant.md">繁體中文</a>
</p>

> [!NOTE]
> Diese README wurde maschinell übersetzt. Die genauesten Informationen finden Sie in der [englischen](../README.md) oder [koreanischen](README.ko.md) Version.

> [!CAUTION]
> **Dieses Projekt ist ein Nightly-Build.** Funktionen und Datenstrukturen können sich ohne Vorankündigung ändern und einzelne Funktionen möglicherweise nicht korrekt arbeiten. Erstellen Sie vor jedem Update unbedingt ein Backup.

PocketRisu Kei ist eine persönliche Modifikation auf Basis von [PocketRisu](https://github.com/PocketRisu/PocketRisu) `v1.8.1` / `63832a13`. Es ist weder als stabile Veröffentlichung noch mit offiziellem Support vorgesehen.

Projektlinks: [Repository](https://github.com/seto-sama/PocketRisu-Kei) · [Veröffentlichungen](https://github.com/seto-sama/PocketRisu-Kei/releases) · [Issues](https://github.com/seto-sama/PocketRisu-Kei/issues)

## Änderungen gegenüber dem ursprünglichen PocketRisu

- Paket-, Workspace-, TypeScript-, Vite- und Vitest-Werkzeuge überarbeitet.
- Gemeinsame UI-Steuerelemente und Einstellungs-Wrapper zusammengeführt.
- Preset-Ordner und sortierbare Auswahllisten hinzugefügt.
- Prompt-Rollen und Preset-Verhalten bereinigt.
- Laufzeit und Adapter für Modell-Presets erweitert.
- Einen auf `models.dev` basierenden Modellkatalog hinzugefügt.
- Verwaltung von Modell-Presets und Zugangsdaten neu gestaltet.
- Plugin- und Modul-Tabs zusammengeführt.
- Plugin-Modelle in Modell-Presets ermöglicht.
- HypaMemory-Verwaltung, manuelle Zusammenfassung und Suche hinzugefügt.
- Verwaltung des Übersetzungs-Caches und Abbrechen laufender Übersetzungen hinzugefügt.
- Stabilität von Chat-Streaming und Rendering verbessert.
- Teilweises Bearbeiten von Nachrichten verbessert.
- Chat-Navigation, Tastenkürzel und mobiles Zurück-Verhalten verbessert.
- Themes, Chat-Textanzeige und Stiloptionen verbessert.
- Einstellungen für Bilder, TTS und Inlays neu geordnet.
- Charakterliste und Seitenleisten-UI überarbeitet.
- Bearbeitung von regulären Ausdrücken und Lorebooks verbessert.
- Chat- und Ordnerfilter für Fernzugriff sowie Synchronisierung mehrerer Geräte hinzugefügt.
- Snapshots, automatische Backups und Asset-Wiederherstellung hinzugefügt.
- Dauerhafte Anfrageprotokolle hinzugefügt.
- Nutzungsaufzeichnung und Kostenschätzung hinzugefügt.
- Einen Teil der Chat-Generierung auf den Server verlagert.
- UI- und Einstellungsstrukturen vereinheitlicht und veraltete Pfade entfernt.

## Hauptfunktionen

- Mehrere KI-Anbieter, darunter OpenAI, Claude, Gemini, OpenRouter und Ollama
- Selbstgehosteter Server für PC, Tablet und Smartphone
- Einheitliche SQLite-Speicherung für Charaktere, Chats, Einstellungen und Assets
- Server-Backup und -Wiederherstellung, Snapshots und automatische Backups
- Lorebooks, HypaMemoryV3, Übersetzung, Regex-Skripte und Plugins
- Anfrageprotokolle, Token-Nutzung und geschätzte Kosten
- TTS sowie Bilder, Audio und Video im Chat
- Weitere Funktionen finden Sie bei [PocketRisu](https://github.com/PocketRisu/PocketRisu).

## Dokumentation

- [Installationsanleitung](../docs/de/install.md)
- [RisuAI-Migrationsleitfaden](../docs/de/migration.md)
- [Fernzugriffsleitfaden](../docs/de/remote.md)
- [Android-Termux-Installationsanleitung](../docs/de/termux.md)

## RisuAI-Kompatibilität

PocketRisu Kei bleibt mit dem RisuAI-Ökosystem kompatibel. Vorhandene RisuAI-Daten, Charakterkarten, Module, Lorebooks, Presets und Backup-Dateien können importiert oder exportiert werden. Details finden Sie im [Migrationsleitfaden](../docs/de/migration.md).

## Lizenz

[GPL-3.0](../LICENSE)
