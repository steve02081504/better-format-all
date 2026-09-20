# better-format-all

[English](README.md) · [简体中文](README.zh-cn.md) · [日本語](README.ja.md) · [Français](README.fr.md) · **Español** · [हिंदी](README.hi.md)

Formatea todos los archivos rastreados por git o sin confirmar de una carpeta con su formateador predeterminado, directamente desde el menú contextual del Explorador.

## Características

- **Formatear toda una carpeta** — haz clic derecho en cualquier carpeta del Explorador y elige **Formatear todos los archivos de la carpeta**.
- **Solo lo que cambió** — la primera ejecución formatea todos los archivos rastreados; las siguientes solo formatean los archivos modificados desde el último commit totalmente formateado, más todos los archivos sin rastrear y no ignorados por git. Los cambios sin confirmar siempre se incluyen.
- **Los archivos binarios se omiten** — un archivo se deja intacto cuando aparece un byte NUL en sus primeros 8 KiB.
- **Trabajo mínimo por subruta** — el último commit totalmente formateado se recuerda por subruta en `.git/better-format-all.json`, así que una subcarpeta formateada por separado no se repite cuando luego formateas su carpeta padre.
- **El formateador predeterminado** — los archivos pasan por _Format Document_, por lo que se usa el `editor.defaultFormatter` configurado. La extensión nunca elige silenciosamente el primer formateador por ti.
- **Cancelación segura** — la notificación de progreso muestra una barra de progreso y permite cancelar. Una ejecución cancelada o parcialmente fallida **no** actualiza la línea base, por lo que la siguiente ejecución todavía ve todos los archivos sin formatear. Los fallos se escriben en el canal de salida _better-format-all_, que se muestra automáticamente.
- **Interfaz localizada** — sigue el idioma de visualización de VS Code.

## Uso

1. En el Explorador, haz clic derecho en una carpeta dentro de un repositorio git.
2. Elige **Formatear todos los archivos de la carpeta**.
3. Cada archivo se abre, se formatea con su formateador predeterminado, se guarda y se cierra.

Hacer clic derecho en una carpeta que no está dentro de un repositorio git informa un error y no hace nada.

## Cómo funciona la línea base

- El estado vive en `.git/better-format-all.json` (configurable con `betterFormatAll.stateFile`). Asigna una ruta relativa al repositorio al SHA del commit en el que esa ruta se formateó por completo por última vez; la raíz del repositorio es la cadena vacía `''`.
- Un archivo usa como línea base el **ancestro registrado más profundo o a sí mismo**. Cuando una ruta se formatea por completo, las entradas más específicas por debajo se eliminan: la entrada padre ya las cubre.
- Sin línea base, se formatean todos los archivos rastreados del destino. Con una línea base, la selección es `git diff <sha>` **contra el árbol de trabajo** (por lo que cuentan las ediciones sin confirmar) más los archivos sin rastrear y no ignorados.
- La línea base solo se escribe cuando el destino terminó por completo (nada cancelado, ningún fallo).

## Configuración

| Ajuste                             | Predeterminado           | Descripción                                                             |
| ---------------------------------- | ------------------------ | ----------------------------------------------------------------------- |
| `betterFormatAll.stateFile`        | `better-format-all.json` | Nombre de archivo escrito dentro del directorio `.git` del repositorio. |
| `betterFormatAll.includeUntracked` | `true`                   | También formatea los archivos no rastreados y no ignorados por git.     |

## Requisitos

- Visual Studio Code 1.100.0 o posterior.
- `git` en el `PATH`.
- Un formateador predeterminado configurado para los lenguajes que quieras formatear (`editor.defaultFormatter`); los archivos cuyo lenguaje no tiene formateador se dejan sin cambios.

## Localización

| Idioma               | Configuración regional |
| -------------------- | ---------------------- |
| Inglés (EE. UU.)     | `en`, `en-US`          |
| Inglés (Reino Unido) | `en-gb`                |
| 简体中文             | `zh-cn`                |
| 日本語               | `ja`                   |
| Français             | `fr`                   |
| Español              | `es`                   |
| हिंदी                | `hi`                   |

Los títulos de los comandos y las notificaciones siguen el idioma de visualización de VS Code.

## Desarrollo

```powershell
npm install   # una vez
npm test      # ejecuta las pruebas con el VS Code local
npm run build # empaqueta la extensión y la instala localmente
```

Consulta `AGENTS.md` para las notas de mantenimiento.

## Licencia

[LGPL-3.0-only](LICENSE.md)
