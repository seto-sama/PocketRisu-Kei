<p align="center">
  <a href="../en/termux.md">English</a> | <a href="../ko/termux.md">한국어</a> | <strong>Deutsch</strong> | <a href="../cn/termux.md">简体中文</a> | <a href="../es/termux.md">Español</a> | <a href="../vi/termux.md">Tiếng Việt</a> | <a href="../zh-Hant/termux.md">繁體中文</a>
</p>

# Termux-Installationsanleitung

> 🌐 Diese Anleitung wurde maschinell übersetzt. Für die genauesten Informationen siehe die [englische](../en/termux.md) oder [koreanische](../ko/termux.md) Version.

Diese Anleitung erklärt, wie PocketRisu direkt auf einem Android-Telefon über Termux gebaut und ausgeführt wird. Das vorgesehene Nutzungsmuster ist das Öffnen von `http://localhost:6001` im Browser desselben Telefons.

- [1. Voraussetzungen](#1-voraussetzungen) — F-Droid Termux und Systemanforderungen
- [2. Installation und Build](#2-installation-und-build) — Einrichtung mit einem einzigen Befehl
- [3. Ausführen und Verbinden](#3-ausführen-und-verbinden) — vom Browser des Telefons öffnen
- [4. Laufen lassen](#4-laufen-lassen) — auch bei ausgeschaltetem Bildschirm
- [5. Aktualisieren](#5-aktualisieren) — neueste Version holen
- [6. Einschränkungen](#6-einschränkungen) — Funktionen, die auf Termux nicht funktionieren


## Systemanforderungen

| Element            | Minimum         | Empfohlen                       |
| ------------------ | --------------- | ------------------------------- |
| **Android**        | 7.0 (API 24)    | 10 oder neuer                   |
| **CPU**            | ARM64           | ARM64                           |
| **RAM**            | 2 GB            | 4 GB oder mehr                  |
| **Freier Speicher** | 2 GB            | 4 GB oder mehr (mit Build)      |

PocketRisu baut die Anwendung lokal auf dem Telefon, daher hängt die Build-Zeit von der Leistung des Telefons ab.


---

## 1. Voraussetzungen

### Verwenden Sie die F-Droid- oder GitHub-Releases-Version von Termux

> ⚠️ **Die Play-Store-Version von Termux kann nicht verwendet werden.**
> Die Termux-Maintainer haben die Aktualisierung der Play-Store-Version 2020 eingestellt, und sie kann die aktuellen Pakete, die PocketRisu benötigt (Node.js 24.22.1+ (24.x) / 26.12.1+ (26.x)), nicht mehr installieren.

Installieren Sie Termux von einer dieser Quellen:

- **F-Droid (empfohlen)**: https://f-droid.org/packages/com.termux/
- **GitHub Releases**: https://github.com/termux/termux-app/releases

Wenn Sie bereits die Play-Store-Version installiert haben, deinstallieren Sie sie zuerst und installieren Sie aus einer der obigen Quellen.


---

## 2. Installation und Build

Öffnen Sie Termux und führen Sie diesen einzelnen Befehl aus:

```bash
pkg install -y git && \
  git clone https://github.com/seto-sama/PocketRisu-Kei.git && \
  cd PocketRisu-Kei && \
  bash scripts/termux/build.sh
```

Der Befehl kümmert sich um:

1. Installation von `git`
2. Klonen des PocketRisu-Repositorys
3. Installation der Build-Abhängigkeiten (`nodejs-lts`, `python`, `make`, `clang`, `pnpm` usw.)
4. `pnpm install` — JavaScript-Abhängigkeiten und optionale native Beschleunigung
5. `pnpm build` — Frontend-Bundling

Wenn der Build abgeschlossen ist, sehen Sie:

```
Build OK. Start the server with:
  node server/server.cjs

Then open this address in the phone's own browser:
  http://localhost:6001
```


---

## 3. Ausführen und Verbinden

Starten Sie den Server aus demselben Verzeichnis:

```bash
node server/server.cjs
```

Sobald das Server-Boot-Protokoll erscheint, öffnen Sie den Browser des Telefons (Chrome, Firefox usw.) und navigieren Sie zu:

```
http://localhost:6001
```

Die PocketRisu-Benutzeroberfläche sollte geladen werden. `localhost` wird vom Browser automatisch als sicherer Kontext behandelt, sodass Zwischenablage, `crypto.subtle` und andere APIs, die einen sicheren Kontext erfordern, normal funktionieren.

Server stoppen mit `Strg + C`.


---

## 4. Laufen lassen

Um den Server am Leben zu halten, wenn der Bildschirm ausgeschaltet wird oder Sie zu anderen Apps wechseln, aktivieren Sie den Wake-Lock von Termux:

```bash
termux-wake-lock
```

Die Termux-Benachrichtigung zeigt den Wake-Lock-Indikator, und der Server läuft auch bei ausgeschaltetem Bildschirm weiter.

Freigeben mit: `termux-wake-unlock`

> Android kann Termux unter Speicherdruck dennoch beenden. Für langfristige Nutzung schließen Sie Termux aus den Batterieoptimierungseinstellungen Ihres Telefons aus.


---

## 5. Aktualisieren

Beenden Sie den laufenden Server mit `Ctrl + C` und führen Sie dann Folgendes aus:

```bash
cd ~/PocketRisu-Kei && \
  git pull --ff-only && \
  GYP_DEFINES="android_ndk_path=''" pnpm install --frozen-lockfile && \
  NODE_OPTIONS="--max-old-space-size=2048" pnpm build
```

Jeder Schritt wird nur ausgeführt, wenn der vorherige erfolgreich war. Wenn `git pull` fehlschlägt, stoppt der Befehl vor der Installation und dem Build. So wird der alte Quellcode nicht erneut gebaut. `pnpm install` muss ausdrücklich ausgeführt werden; es läuft nicht automatisch als Teil von `pnpm build`. Führen Sie es bei jedem Update aus. `GYP_DEFINES` ist die Termux-Einstellung aus dem Build-Skript und wird benötigt, wenn native Module wie `msgpackr-extract` kompiliert werden. Starten Sie den Server nach dem Build mit `node server/server.cjs` neu.

### Wenn `git pull` fehlschlägt

Prüfen Sie Ihre lokalen Änderungen:

```bash
cd ~/PocketRisu-Kei
git status
git diff
git diff --cached
```

Wenn Sie nicht festgeschriebene Änderungen behalten möchten, committen Sie sie oder legen Sie sie vor dem Update-Befehl oben vorübergehend mit `git stash push` ab. Stellen Sie den stash nach dem Update mit `git stash pop` wieder her und prüfen Sie, ob Konflikte aufgetreten sind. Bei der Meldung `Not possible to fast-forward` müssen Sie zuerst die Abweichung des lokalen Branches beheben. Ein stash löst keine abweichenden Commits auf.


---

## 6. Einschränkungen

**Quick Tunnel (Cloudflare Auto-Tunnel) funktioniert nicht auf Termux.** Das `cloudflared`-Binary ist nicht mit der DNS- und TLS-Umgebung von Termux kompatibel.

PocketRisu erkennt die Termux-Umgebung automatisch und zeigt eine Warnung im Menü Fernzugriff an, wobei die Start-Schaltfläche ausgeblendet wird.


---

← [Zurück zur README](../../i18n/README.de.md)
