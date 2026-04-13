# 🧠 Session Memory Node

Nodo de ComfyUI que acumula un historial estructurado de cada ejecución creativa y lo inyecta en el sistema prompt de la siguiente ejecución. Diseñado para eliminar la repetición de localizaciones, conceptos y configuraciones entre Runs consecutivos del motor MoodBoard Transfer.

## Problema que resuelve

El motor MoodBoard Transfer no tiene memoria entre ejecuciones (Runs). Esto causa:

- **Reciclaje de localizaciones**: Las mismas ubicaciones aparecen en 4-5 Runs consecutivos
- **Colisiones de conceptos**: Nombres de concepto semánticamente idénticos se repiten
- **Monotonía de configuraciones**: La configuración "Worn" se acumula al 70-80%
- **Violaciones repetidas**: Los mismos patrones de fallo reaparecen en cada Run

## Cómo funciona

```
Run N comienza
  ├── 1. Session Memory EMITE el log acumulado (Runs 1..N-1)
  ├── 2. El LLM genera con conciencia del historial
  ├── 3. El output pasa al Gemini Summarizer
  ├── 4. El Summarizer extrae un digest estructurado
  └── 5. Session Memory AÑADE el digest al log (para Run N+1)
```

### Orden de ejecución clave

El nodo **primero emite** el estado actual y **después añade** el nuevo resumen. Esto resuelve la dependencia circular:

- **Run 1**: output = `""` (vacío), luego añade resumen del Run 1
- **Run 2**: output = resumen del Run 1, luego añade resumen del Run 2
- **Run N**: output = Runs 1 a N-1, luego añade resumen del Run N

## Inputs

| Input | Tipo | Requerido | Descripción |
|---|---|---|---|
| `run_summary` | `STRING` | Sí | Texto de resumen estructurado del nodo Gemini Summarizer |
| `reset_session` | `BOOLEAN` | No (default: `False`) | Limpia toda la memoria acumulada |
| `max_runs` | `INT` | No (default: `0`) | Ventana deslizante: mantiene solo los últimos N entries. 0 = ilimitado |

## Outputs

| Output | Tipo | Descripción |
|---|---|---|
| `session_memory` | `STRING` | Log acumulado completo para inyectar en `SESSION_MEMORY` del system prompt |
| `run_count` | `INT` | Número de Run actual en la sesión (1-indexed) |

## Persistencia

- **En memoria** (variable de clase): Sobrevive entre Runs dentro de la misma sesión de ComfyUI
- **Se pierde** al reiniciar ComfyUI
- `max_runs` controla una ventana deslizante para gestionar el budget de tokens

## Instalación

Copiar la carpeta `ComfyUI-Session-Memory` en `ComfyUI/custom_nodes/` y reiniciar ComfyUI.
