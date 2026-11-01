<p align="center">
  <a href="../en/install.md">English</a> | <a href="../ko/install.md">한국어</a> | <a href="../de/install.md">Deutsch</a> | <a href="../cn/install.md">简体中文</a> | <strong>Español</strong> | <a href="../vi/install.md">Tiếng Việt</a> | <a href="../zh-Hant/install.md">繁體中文</a>
</p>

# Guía de instalación

> 🌐 Esta guía está traducida por máquina. Para obtener la información más precisa, consulte la versión en [inglés](../en/install.md) o [coreano](../ko/install.md).

PocketRisu se puede instalar de dos formas.

- [1. Docker](#1-docker) — Entorno de contenedores.
- [2. Git Clone](#2-git-clone) — Clona y compila el código fuente tú mismo.


## Requisitos del sistema

| Elemento    | Mínimo                  | Recomendado                              |
| ----------- | ----------------------- | ---------------------------------------- |
| **CPU**     | 1 núcleo                | 2+ núcleos                               |
| **RAM**     | 1 GB (solo ejecución)   | 4+ GB (incluye compilación)              |
| **Disco**   | 1 GB                    | 2+ GB                                    |
| **Node.js** | 24.22.1+ (24.x) / 26.12.1+ (26.x) | (no requerido para Docker)      |

Docker no requiere un paso de compilación y puede ejecutarse con 1 GB de RAM. Las compilaciones directas (Git Clone) consumen memoria significativa durante la compilación, por lo que se recomiendan 4 GB o más.


---

## 1. Docker

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

## 2. Git Clone

Clona el código fuente y compílalo tú mismo.

Se requiere Node.js 24.x (24.22.1 o superior) o 26.x (26.12.1 o superior):

```bash
node --version
# v24.22.1+ (24.x) o v26.12.1+ (26.x)
```

Instala desde el [sitio oficial de Node.js](https://nodejs.org/) si no está presente.

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
