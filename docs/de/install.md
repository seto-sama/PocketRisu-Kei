<p align="center">
  <a href="../en/install.md">English</a> | <a href="../ko/install.md">한국어</a> | <strong>Deutsch</strong> | <a href="../cn/install.md">简体中文</a> | <a href="../es/install.md">Español</a> | <a href="../vi/install.md">Tiếng Việt</a> | <a href="../zh-Hant/install.md">繁體中文</a>
</p>

# Installationsanleitung

> 🌐 Diese Anleitung wurde maschinell übersetzt. Für die genauesten Informationen siehe die [englische](../en/install.md) oder [koreanische](../ko/install.md) Version.

PocketRisu kann auf zwei Arten installiert werden.

- [1. Docker](#1-docker) — Container-Umgebung.
- [2. Git Clone](#2-git-clone) — Quellcode klonen und selbst bauen.


## Systemanforderungen

| Element     | Minimum              | Empfohlen                                  |
| ----------- | -------------------- | ------------------------------------------ |
| **CPU**     | 1 Kern               | 2+ Kerne                                   |
| **RAM**     | 1 GB (nur Ausführen) | 4+ GB (inkl. Build)                        |
| **Disk**    | 1 GB                 | 2+ GB                                      |
| **Node.js** | 24.22.1+ (24.x) / 26.12.1+ (26.x) | (nicht erforderlich für Docker)   |

Docker benötigt keinen Build-Schritt und kann mit 1 GB RAM laufen. Direkte Builds (Git Clone) verbrauchen während des Builds viel Speicher; 4 GB oder mehr werden empfohlen.


---

## 1. Docker

Läuft auf einem System mit installiertem Docker oder Docker Desktop.

### Docker installieren

- **Windows / macOS**: Installieren Sie [Docker Desktop](https://www.docker.com/products/docker-desktop/).
- **Linux**:
  ```bash
  curl -fsSL https://get.docker.com | sh
  ```

### Ausführen

```bash
curl -L https://raw.githubusercontent.com/seto-sama/PocketRisu-Kei/main/docker-compose.yml -o docker-compose.yml
docker compose up -d
```

Öffnen Sie `http://localhost:6001` in Ihrem Browser.

### Aktualisieren

```bash
docker compose pull && docker compose up -d
```

### Datenstandort

Alle Daten (Chats, Charaktere usw.) werden im Docker-Volume `risuai-save` gespeichert. Daten bleiben bei Updates erhalten.


---

## 2. Git Clone

Klonen Sie den Quellcode und bauen Sie ihn selbst.

Node.js 24.x (24.22.1 oder höher) oder 26.x (26.12.1 oder höher) ist erforderlich:

```bash
node --version
# v24.22.1+ (24.x) oder v26.12.1+ (26.x)
```

Installieren Sie von der [offiziellen Node.js-Website](https://nodejs.org/), falls nicht vorhanden.

```bash
git clone https://github.com/seto-sama/PocketRisu-Kei.git
cd PocketRisu-Kei
pnpm install
pnpm build
pnpm runserver
```

Öffnen Sie `http://localhost:6001` in Ihrem Browser.

### Aktualisieren

```bash
git pull
pnpm install
pnpm build
# Server neu starten
pnpm runserver
```


---

← [Zurück zur README](../../i18n/README.de.md)
