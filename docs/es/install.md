<p align="center">
  <a href="../en/install.md">English</a> | <a href="../ko/install.md">한국어</a> | <a href="../de/install.md">Deutsch</a> | <a href="../cn/install.md">简体中文</a> | <strong>Español</strong> | <a href="../vi/install.md">Tiếng Việt</a> | <a href="../zh-Hant/install.md">繁體中文</a>
</p>

# Guía de instalación

> 🌐 Esta guía está traducida por máquina. Para obtener la información más precisa, consulte la versión en [inglés](../en/install.md) o [coreano](../ko/install.md).

PocketRisu se puede instalar de cuatro formas.

- [1. Paquete portable](#1-paquete-portable) — Binario precompilado. No requiere Node.js.
- [2. Docker](#2-docker) — Entorno de contenedores.
- [3. Script de instalación](#3-script-de-instalación) — Compilación automática desde fuente. Para servidores Linux/macOS.
- [4. Git Clone](#4-git-clone) — Compilación manual desde fuente. Para desarrolladores / usuarios avanzados.


## Requisitos del sistema

| Elemento    | Mínimo                  | Recomendado                              |
| ----------- | ----------------------- | ---------------------------------------- |
| **CPU**     | 1 núcleo                | 2+ núcleos                               |
| **RAM**     | 1 GB (solo ejecución)   | 4+ GB (incluye compilación)              |
| **Disco**   | 1 GB                    | 2+ GB                                    |
| **Node.js** | 22.12+                  | (no requerido para portable/Docker)      |

El paquete portable y Docker no requieren un paso de compilación y pueden ejecutarse con 1 GB de RAM. Las compilaciones directas (Git Clone, script de instalación) consumen memoria significativa durante la compilación, por lo que se recomiendan 4 GB o más.


---

## 1. Paquete portable

Descarga y ejecuta un binario precompilado. No requiere Node.js, Docker u otras herramientas. Compatible con Windows, macOS (Apple Silicon) y Linux (x64/ARM).

### Descarga

Obtén el archivo para tu OS desde la [página de Releases](https://github.com/seto-sama/PocketRisu-Kei/releases).

| OS                       | Archivo                                   |
| ------------------------ | ----------------------------------------- |
| Windows (x64)            | `PocketRisu-vX.X.X-win-x64.zip`           |
| macOS (Apple Silicon)    | `PocketRisu-vX.X.X-macos-arm64.tar.gz`    |
| Linux (x64)              | `PocketRisu-vX.X.X-linux-x64.tar.gz`      |
| Linux (ARM)              | `PocketRisu-vX.X.X-linux-arm64.tar.gz`    |

### Ejecutar

**Windows**

Extrae el zip y haz doble clic en `PocketRisu.exe`. Un navegador se abre automáticamente en `http://localhost:6001`.

**macOS**

```bash
tar -xzf PocketRisu-vX.X.X-macos-arm64.tar.gz
xattr -cr PocketRisu-vX.X.X-macos-arm64
open PocketRisu-vX.X.X-macos-arm64/PocketRisu.app
```

El comando `xattr` es un paso único para evitar la advertencia "Apple no puede verificar".

**Linux**

```bash
tar -xzf PocketRisu-vX.X.X-linux-*.tar.gz
cd PocketRisu-vX.X.X-linux-*
./start.sh
```

Abre `http://localhost:6001` en tu navegador.

### Servidor sin GUI (descarga en una línea)

Para servidores Linux/macOS sin interfaz gráfica, descarga y ejecuta la última versión con un solo comando.

**Linux (x64):**

```bash
RELEASE_TAG=$(curl -s https://api.github.com/repos/seto-sama/PocketRisu-Kei/releases/latest | grep -o '"tag_name":[[:space:]]*"[^"]*"' | cut -d'"' -f4)
VERSION=${RELEASE_TAG#*v}
curl -fsSL "https://github.com/seto-sama/PocketRisu-Kei/releases/download/${RELEASE_TAG}/PocketRisu-v${VERSION}-linux-x64.tar.gz" -o pocketrisu.tar.gz
tar -xzf pocketrisu.tar.gz && rm pocketrisu.tar.gz
cd PocketRisu-v${VERSION}-linux-x64
./start.sh
```

**Linux (ARM):** Reemplaza `linux-x64` por `linux-arm64` en el comando anterior.

**macOS (Apple Silicon):**

```bash
RELEASE_TAG=$(curl -s https://api.github.com/repos/seto-sama/PocketRisu-Kei/releases/latest | grep -o '"tag_name":[[:space:]]*"[^"]*"' | cut -d'"' -f4)
VERSION=${RELEASE_TAG#*v}
curl -fsSL "https://github.com/seto-sama/PocketRisu-Kei/releases/download/${RELEASE_TAG}/PocketRisu-v${VERSION}-macos-arm64.tar.gz" -o pocketrisu.tar.gz
tar -xzf pocketrisu.tar.gz && rm pocketrisu.tar.gz
xattr -cr PocketRisu-v${VERSION}-macos-arm64
cd PocketRisu-v${VERSION}-macos-arm64
./start.sh
```

### Actualizar

Haz clic en "Actualizar ahora" en el popup de actualización en la pantalla principal de la UI web, o ejecuta el script de actualización en la carpeta de instalación.

- **Windows**: Doble clic en `update.bat`
- **macOS / Linux**: `./update.sh`

Los datos en la carpeta `save/` se conservan.


---

## 2. Docker

Se ejecuta en un sistema con Docker o Docker Desktop instalado.

### Instalar Docker

- **Windows / macOS**: Instala [Docker Desktop](https://www.docker.com/products/docker-desktop/).
- **Linux**:
  ```bash
  curl -fsSL https://get.docker.com | sh
  ```

### Ejecutar

```bash
curl -L https://raw.githubusercontent.com/seto-sama/PocketRisu-Kei/main/docker-compose.yml -o docker-compose.yml
docker compose up -d
```

Abre `http://localhost:6001` en tu navegador.

### Actualizar

```bash
docker compose pull && docker compose up -d
```

### Ubicación de los datos

Todos los datos (chats, personajes, etc.) se almacenan en el volumen de Docker `risuai-save`. Los datos se conservan al actualizar.


---

## 3. Script de instalación

Descarga el código fuente y compila automáticamente con Node.js. Se ejecuta en servidores Linux/macOS. Úsalo si quieres gestionar las actualizaciones mediante `git pull`.

### Prerrequisitos

Se requiere Node.js 22.12 o superior:

```bash
node --version
# v22.12.0 o superior
```

Instala desde el [sitio oficial de Node.js](https://nodejs.org/) si no está presente.

### Instalar

```bash
curl -fsSL https://raw.githubusercontent.com/seto-sama/PocketRisu-Kei/main/install.sh | bash
```

Se muestra un mensaje de estado cuando finaliza la instalación.

### Iniciar el servidor

```bash
cd ~/pocketrisu
pnpm runserver
```

Abre `http://localhost:6001` en tu navegador.

### Actualizar

```bash
cd ~/pocketrisu
./update.sh
```

> **Nota única para v1.5.x → v1.6.0**: Si instalaste mediante `install.sh` durante la era Risuai-NodeOnly (v1.5.x o anterior), reemplaza `update.sh` con la nueva versión una vez antes de tu primera actualización a v1.6.0. (El repositorio se renombró a PocketRisu y el `update.sh` antiguo no puede encontrar el nuevo directorio fuente.)
>
> ```bash
> curl -fsSL https://raw.githubusercontent.com/seto-sama/PocketRisu-Kei/main/update.sh -o update.sh && chmod +x update.sh
> ./update.sh
> ```
>
> Las actualizaciones posteriores se ejecutan con `./update.sh` como de costumbre.


---

## 4. Git Clone

Clona y compila manualmente el código fuente. Para desarrolladores que necesitan modificar o depurar código.

```bash
git clone https://github.com/seto-sama/PocketRisu-Kei.git
cd PocketRisu-Kei
pnpm install
pnpm build
pnpm runserver
```

Abre `http://localhost:6001` en tu navegador.

### Actualizar

```bash
git pull
pnpm install
pnpm build
# Reiniciar servidor
pnpm runserver
```


---

← [Volver al README](../../i18n/README.es.md)
