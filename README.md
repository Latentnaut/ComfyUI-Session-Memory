# 🧠 ComfyUI-Session-Memory

> Structured workflow memory and human-in-the-loop creative feedback for ComfyUI.

ComfyUI-Session-Memory gives your generation workflows **persistent memory across runs**. It accumulates structured run summaries, injects them into your LLM system prompt for context-aware generation, and provides an interactive in-node feedback panel where you can rate and annotate every prompt — all without leaving ComfyUI.

---

## ✨ Features

- **Session Memory Reader** — Loads the full accumulated history of a session and outputs it as a string ready to inject into any LLM system prompt.
- **Session Memory Writer** — Receives a structured run summary and appends it to the session's persistent JSON file. Outputs the current `run_count` for downstream nodes.
- **Session Feedback Editor** — Interactive in-node UI to rate (⭐ 1–5) and annotate each prompt after every run. Supports visual thumbnail previews of generated images, organized per prompt and per batch pass.
- **Feedback injection** — Rated prompts are automatically converted into `REPLICATE` / `AVOID` directives injected into the next run's system prompt, closing the creative feedback loop.
- **Thumbnail system** — Accepts a full image batch, downscales to ≤1 MP, and saves them organized as `sessions/{id}/run_{N}/prompt_{P}/img_{K}.jpg`. Supports multi-pass batches (`batch_count > 1`).

---

## 🔄 Architecture

```
🧠 Reader ──session_memory──► LLM System Prompt ──► Sampler
    ↑                                                   │
    │                                              💾 Writer
    │                                                   │
    │                                          ⭐ Feedback Editor
    │                                                   │
    └────────────── sessions/{session_id}.json ◄────────┘
```

The **Reader** always emits the history *before* the current run begins. The **Writer** appends the new summary *after* the run completes. The **Feedback Editor** operates non-destructively in parallel — it never blocks the Reader's next read until you explicitly save feedback.

---

## 📦 Nodes

### 🧠 Session Memory Reader

Loads and outputs the full accumulated session log.

| Input | Type | Description |
|---|---|---|
| `session_id` | `STRING` | Session identifier (must match Writer/Editor) |
| `reset_session` | `BOOLEAN` | Clears all memory and thumbnails for this session |
| `max_runs` | `INT` | Sliding window: keep only the last N runs (0 = unlimited) |

| Output | Type | Description |
|---|---|---|
| `session_memory` | `STRING` | Full log for injection into system prompt |
| `session_feedback` | `STRING` | REPLICATE/AVOID directives from rated runs |
| `run_count` | `INT` | Number of runs recorded in this session |

---

### 💾 Session Memory Writer

Appends a new run summary to the session file.

| Input | Type | Description |
|---|---|---|
| `session_id` | `STRING` | Session identifier |
| `run_summary` | `STRING` | Structured text summary from a Gemini/LLM summarizer node |

| Output | Type | Description |
|---|---|---|
| `run_count` | `INT` | Current run number after writing |
| `session_id` | `STRING` | Pass-through for chaining to Feedback Editor |

---

### ⭐ Session Feedback Editor

Interactive in-node panel for post-run creative review.

| Input | Type | Description |
|---|---|---|
| `session_id` | `STRING` | Session identifier |
| `mode` | `ENUM` | `non_blocking` (annotate later) or `blocking` (pause until saved) |
| `num_prompts` | `INT` | Number of prompts in the run |
| `batch_count` | `INT` | Sampling passes per prompt (ComfyUI's batch count) |
| `run_summary` | `STRING` | Optional — connect from Writer to enforce execution order |
| `thumbnail_images` | `IMAGE` | Optional — full image batch for thumbnail generation |

**UI features (inside the node):**
- Run navigator (`← Run 3/5 →`) to browse any past run
- Per-prompt star rating (1–5 ⭐)
- Per-prompt text notes
- Thumbnail grid — side-by-side images for each batch pass
- **Save Feedback** button — persists ratings/notes to the session JSON

---

## 📁 File Structure

```
ComfyUI-Session-Memory/
├── session_memory.py       # All node logic + API routes
├── __init__.py             # Node registration
├── web/
│   └── session_feedback_editor.js  # Frontend extension (LiteGraph)
└── sessions/               # Auto-created at runtime (gitignored)
    ├── my_project.json     # Session data: entries + feedback
    └── my_project/
        └── run_5/
            ├── prompt_1/
            │   ├── img_0.jpg
            │   └── img_1.jpg   ← second batch pass
            └── prompt_2/
                ├── img_0.jpg
                └── img_1.jpg
```

---

## 🚀 Installation

**Option A — Manual:**
```bash
cd ComfyUI/custom_nodes
git clone https://github.com/Latentnaut/ComfyUI-Session-Memory
```
Restart ComfyUI.

**Option B — ComfyUI Manager:**
Search for `Session Memory` in the ComfyUI Manager and install.

---

## 💡 Recommended Workflow

1. **Reader** → inject `session_memory` + `session_feedback` into your LLM system prompt.
2. LLM generates structured prompts aware of past runs.
3. Sampler generates images (connect the batch output to **Feedback Editor** `thumbnail_images`).
4. A Gemini/LLM summarizer creates a `run_summary` → send to **Writer**.
5. **Feedback Editor** receives the `run_summary` (for ordering) and the image batch.
6. Rate and annotate prompts inside the node. Click **Save Feedback**.
7. On the next Run, the **Reader** injects the feedback as REPLICATE/AVOID directives automatically.

---

## ⚙️ Thumbnail Details

- Images are downscaled to a maximum of **1 megapixel** (LANCZOS) and saved as JPEG (quality 85).
- Supports `batch_count > 1`: ComfyUI re-executes the graph once per batch pass, and thumbnails are **appended** (not overwritten) on each pass.
- Distribution: image `i` in the batch → `prompt_{i % num_prompts}`, pass index auto-incremented.

---

## 📋 Session JSON Format

```json
{
  "run_count": 5,
  "entries": [
    "RUN 1:\nPROMPT 1: concept: urban decay...",
    "..."
  ],
  "feedback": {
    "3": {
      "prompts": {
        "1": { "rating": 5, "notes": "Perfect composition" },
        "2": { "rating": 1, "notes": "Too repetitive" }
      }
    }
  }
}
```

---

## 📄 License

MIT
