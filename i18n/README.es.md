<p align="center">
  <img src="../assets/pocketrisu-banner-1024.png" alt="PocketRisu Kei" width="900" />
</p>

<h1 align="center">PocketRisu Kei</h1>

<p align="center">
  Un frontend autoalojado de chat de roleplay con IA basado en PocketRisu, ampliado con funciones adicionales y mejoras de usabilidad
</p>

<p align="center">
  <a href="../README.md">English</a> | <a href="README.ko.md">한국어</a> | <a href="README.de.md">Deutsch</a> | <a href="README.cn.md">简体中文</a> | <strong>Español</strong> | <a href="README.vi.md">Tiếng Việt</a> | <a href="README.zh-Hant.md">繁體中文</a>
</p>

> [!NOTE]
> Este README se ha traducido mediante traducción automática. Para obtener la información más precisa, consulta la versión en [inglés](../README.md) o [coreano](README.ko.md).

> [!CAUTION]
> **Este proyecto es una compilación nightly.** Las funciones y las estructuras de datos pueden cambiar sin previo aviso, y algunas funciones podrían no operar correctamente. Crea siempre una copia de seguridad antes de actualizar.

PocketRisu Kei es una modificación personal basada en [PocketRisu](https://github.com/PocketRisu/PocketRisu) `v1.8.1` / `63832a13`. No está concebida como una versión estable ni ofrece soporte oficial.

Enlaces del proyecto: [Repositorio](https://github.com/seto-sama/PocketRisu-Kei) · [Versiones](https://github.com/seto-sama/PocketRisu-Kei/releases) · [Issues](https://github.com/seto-sama/PocketRisu-Kei/issues)

## Cambios respecto al PocketRisu original

- Refactorización de las herramientas de paquetes, workspace, TypeScript, Vite y Vitest.
- Unificación de controles de UI compartidos y envoltorios de ajustes.
- Incorporación de carpetas de presets y selectores ordenables.
- Organización de roles de prompts y comportamiento de presets.
- Ampliación del entorno de ejecución y los adaptadores de presets de modelos.
- Incorporación de un catálogo de modelos basado en `models.dev`.
- Rediseño de la gestión de presets de modelos y credenciales.
- Unificación de las pestañas de plugins y módulos.
- Compatibilidad con modelos proporcionados por plugins en los presets.
- Gestión de HypaMemory, resumen manual y búsqueda.
- Gestión de caché de traducción y cancelación de traducciones.
- Mejoras en la estabilidad del streaming y renderizado del chat.
- Mejoras en la edición parcial de mensajes.
- Mejoras en la navegación del chat, atajos y comportamiento de retroceso en móviles.
- Mejoras en temas, visualización del texto del chat y opciones de estilo.
- Reorganización de los ajustes de imagen, TTS e inlays.
- Rediseño de la lista de personajes y la barra lateral.
- Mejoras en la edición de expresiones regulares y lorebooks.
- Filtrado de chats y carpetas para acceso remoto y sincronización multidispositivo.
- Snapshots, copias de seguridad automáticas y recuperación de recursos.
- Registros persistentes de solicitudes.
- Registro de uso y estimación de costes.
- Traslado de parte de la generación de chat al servidor.
- Unificación de las estructuras de UI y ajustes y limpieza de rutas heredadas.

## Funciones principales

- Varios proveedores de IA, incluidos OpenAI, Claude, Gemini, OpenRouter y Ollama
- Servidor autoalojado accesible desde PC, tablet y smartphone
- Almacenamiento SQLite unificado para personajes, chats, ajustes y recursos
- Copia y restauración desde el servidor, snapshots y copias automáticas
- Lorebooks, HypaMemoryV3, traducción, scripts regex y plugins
- Registros de solicitudes, uso de tokens y costes estimados
- TTS e imágenes, audio y vídeo integrados en el chat
- Para otras funciones, consulta [PocketRisu](https://github.com/PocketRisu/PocketRisu).

## Documentación

- [Guía de instalación](../docs/es/install.md)
- [Guía de migración desde RisuAI](../docs/es/migration.md)
- [Guía de acceso remoto](../docs/es/remote.md)
- [Guía de instalación de Termux en Android](../docs/es/termux.md)

## Compatibilidad con RisuAI

PocketRisu Kei mantiene la compatibilidad con el ecosistema RisuAI. Es posible importar o exportar datos existentes de RisuAI, tarjetas de personajes, módulos, lorebooks, presets y archivos de copia de seguridad. Consulta la [guía de migración](../docs/es/migration.md) para obtener más información.

## Licencia

[GPL-3.0](../LICENSE)
