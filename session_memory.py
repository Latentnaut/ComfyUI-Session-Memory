"""
🧠 Session Memory — Reader + Writer + Feedback Editor nodes for ComfyUI.

Architecture (no graph cycle):

  🧠 Reader ──session_memory──► system prompt ──► LLM ──► Summarizer
      ↑                                                        │
      │                                                   💾 Writer
      │                                                        │
      │                                              ⭐ Feedback Editor
      │                                                        │
      └───────────────── sessions/{session_id}.json ◄──────────┘

Writer saves the run, then Feedback Editor shows it for rating/notes.
Reader loads everything (entries + feedback) at the start of the next Run.
"""

import json
import logging
import os
import re
import shutil
import threading
import time

from aiohttp import web
from server import PromptServer

logger = logging.getLogger(__name__)

# ── Session file helpers ───────────────────────────────────────────────
SESSIONS_DIR = os.path.join(os.path.dirname(__file__), "sessions")

# Threading events for blocking mode
_pending_feedback: dict[str, threading.Event] = {}


def _safe_id(session_id: str) -> str:
    """Sanitize session_id to a safe filename component."""
    return "".join(c for c in session_id if c.isalnum() or c in "-_") or "default"


def _session_path(session_id: str) -> str:
    os.makedirs(SESSIONS_DIR, exist_ok=True)
    return os.path.join(SESSIONS_DIR, f"{_safe_id(session_id)}.json")


def _load(session_id: str) -> dict:
    path = _session_path(session_id)
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError) as e:
            logger.warning(f"[Session Memory] Could not read {path}: {e}")
    return {"run_count": 0, "entries": [], "feedback": {}}


def _save(session_id: str, data: dict) -> None:
    path = _session_path(session_id)
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except OSError as e:
        logger.error(f"[Session Memory] Could not write {path}: {e}")


def _parse_prompts_from_entry(entry_text: str) -> list[dict]:
    """Extract prompt headers, concepts, and full text from a run entry string."""
    prompts = []
    prompt_blocks = re.split(r'(?=PROMPT \d+:)', entry_text)
    for block in prompt_blocks:
        m = re.match(r'PROMPT (\d+):', block)
        if m:
            prompt_num = int(m.group(1))
            concept_match = re.search(r'concept:\s*(.+)', block)
            concept = (concept_match.group(1).strip()
                       if concept_match else f"Prompt {prompt_num}")
            # Full block text (stripped), useful for frontend toggle display
            full_text = block.strip()
            prompts.append({
                "number": prompt_num,
                "concept": concept,
                "fullText": full_text,
            })
    return prompts


# ── Thumbnail helpers ──────────────────────────────────────────────────

def _session_images_dir(session_id: str) -> str:
    """Get the image storage directory for a session."""
    return os.path.join(SESSIONS_DIR, _safe_id(session_id))


def _save_thumbnails(session_id, run_number, num_prompts, batch_count,
                     images_tensor):
    """Save batch images as downscaled JPEG thumbnails.

    Layout: sessions/{sid}/run_{N}/prompt_{P}/img_{K}.jpg
    where K is the batch/pass index (0-based).

    Image order in tensor: [pass0_p1, pass0_p2, ..., pass1_p1, pass1_p2, ...]
    Total images = num_prompts × batch_count.
    """
    import numpy as np
    from PIL import Image as PILImage

    base_dir = _session_images_dir(session_id)
    run_dir = os.path.join(base_dir, f"run_{run_number}")

    # NOTE: Do NOT rmtree run_dir here. ComfyUI with batch_count>1
    # re-executes the whole graph for each batch. Batch 1 saves img_0,
    # then batch 2 arrives and must APPEND img_1, not destroy img_0.

    B = images_tensor.shape[0]
    saved = 0

    logger.info(
        f"[Session Feedback] Saving thumbnails: B={B}, "
        f"num_prompts={num_prompts}, batch_count_widget={batch_count}"
    )

    # Distribute images round-robin: image[i] → prompt (i % num_prompts)
    for i in range(B):
        p = i % num_prompts          # 0-based prompt index

        prompt_dir = os.path.join(run_dir, f"prompt_{p + 1}")
        os.makedirs(prompt_dir, exist_ok=True)

        # Find next available index for this prompt
        existing = [
            f for f in os.listdir(prompt_dir)
            if f.startswith("img_") and f.endswith(".jpg")
        ]
        next_idx = len(existing)

        # Get single image [H, W, C]
        img_t = images_tensor[i]
        h, w = img_t.shape[0], img_t.shape[1]

        # Downscale to max 1 megapixel
        current_mp = (h * w) / 1_000_000
        if current_mp > 1.0:
            scale = (1.0 / current_mp) ** 0.5
            new_h = max(1, int(h * scale))
            new_w = max(1, int(w * scale))
        else:
            new_h, new_w = h, w

        img_np = (img_t.cpu().numpy() * 255).clip(0, 255).astype(np.uint8)
        pil_img = PILImage.fromarray(img_np)

        if (new_h, new_w) != (h, w):
            pil_img = pil_img.resize((new_w, new_h), PILImage.LANCZOS)

        out_path = os.path.join(prompt_dir, f"img_{next_idx}.jpg")
        pil_img.save(out_path, "JPEG", quality=85)
        saved += 1
        logger.debug(
            f"[Session Feedback]   image[{i}] → prompt_{p+1}/img_{next_idx}.jpg"
        )

    logger.info(
        f"[Session Feedback] Saved {saved} thumbnails for Run {run_number} "
        f"in '{session_id}'."
    )


def _delete_session_images(session_id: str) -> int:
    """Delete all thumbnail images for a session. Returns count removed."""
    img_dir = _session_images_dir(session_id)
    if os.path.isdir(img_dir):
        # Count files before deletion
        count = sum(len(files) for _, _, files in os.walk(img_dir))
        shutil.rmtree(img_dir, ignore_errors=True)
        logger.info(
            f"[Session Memory] Deleted {count} thumbnail images "
            f"for session '{session_id}'."
        )
        return count
    return 0


# ── Feedback formatting ───────────────────────────────────────────────

def _format_feedback_block(feedback: dict) -> str:
    """Format feedback into a SESSION_FEEDBACK block for the system prompt.

    Only includes actionable feedback:
      ★1-2 -> AVOID directive (negative constraint)
      ★4-5 -> REPLICATE directive (positive reference)
      ★3   -> omitted (neutral)
      ★0   -> omitted (unrated)
    """
    if not feedback:
        return ""

    lines = []
    for run_key in sorted(feedback.keys(), key=lambda x: int(x)):
        run_data = feedback[run_key]
        prompts_fb = run_data.get("prompts", {})
        run_lines = []

        for p_key in sorted(prompts_fb.keys(), key=lambda x: int(x)):
            p_data = prompts_fb[p_key]
            rating = p_data.get("rating", 0)
            notes = p_data.get("notes", "").strip()

            if rating == 0 or rating == 3:
                continue

            stars = "\u2605" * rating + "\u2606" * (5 - rating)
            directive = "AVOID" if rating <= 2 else "REPLICATE"

            line = f"  PROMPT {p_key} ({stars} \u2014 {directive})"
            if notes:
                line += f': "{notes}"'
            run_lines.append(line)

        if run_lines:
            lines.append(f"RUN {run_key}:")
            lines.extend(run_lines)

    if not lines:
        return ""

    return "SESSION_FEEDBACK:\n" + "\n".join(lines) + "\n"


# ── API Routes ─────────────────────────────────────────────────────────

@PromptServer.instance.routes.get("/session_feedback/load")
async def _api_load_feedback(request):
    """Load run data + existing feedback for the frontend editor."""
    session_id = request.query.get("session_id", "default")
    run_number = request.query.get("run_number", "")

    session = _load(session_id)
    entries = session.get("entries", [])
    run_count = session.get("run_count", 0)
    feedback = session.get("feedback", {})

    if run_count == 0:
        return web.json_response({
            "run_count": 0,
            "selected_run": 0,
            "prompts": [],
            "feedback": {},
        })

    # Determine which run to show
    if run_number and run_number.isdigit():
        sel_run = int(run_number)
    else:
        sel_run = run_count

    sel_run = max(1, min(sel_run, run_count))

    idx = sel_run - 1
    entry_text = entries[idx] if idx < len(entries) else ""
    prompts = _parse_prompts_from_entry(entry_text)
    run_feedback = feedback.get(str(sel_run), {}).get("prompts", {})

    return web.json_response({
        "run_count": run_count,
        "selected_run": sel_run,
        "prompts": prompts,
        "feedback": run_feedback,
    })


@PromptServer.instance.routes.post("/session_feedback/save")
async def _api_save_feedback(request):
    """Save feedback from the frontend editor to the session file."""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    session_id = body.get("session_id", "default")
    run_number = str(body.get("run_number", ""))
    prompts_fb = body.get("prompts", {})

    if not run_number:
        return web.json_response({"error": "run_number required"}, status=400)

    session = _load(session_id)
    feedback = session.get("feedback", {})

    if run_number not in feedback:
        feedback[run_number] = {"prompts": {}}

    for p_key, p_data in prompts_fb.items():
        feedback[run_number]["prompts"][str(p_key)] = {
            "rating": int(p_data.get("rating", 0)),
            "notes": str(p_data.get("notes", "")),
        }

    session["feedback"] = feedback
    _save(session_id, session)

    logger.info(
        f"[Session Feedback] Saved feedback for Run {run_number} "
        f"in session '{session_id}' ({len(prompts_fb)} prompts)."
    )
    return web.json_response({"status": "ok"})


@PromptServer.instance.routes.post("/session_feedback/resume")
async def _api_resume_feedback(request):
    """Resume blocked execution after user saves feedback."""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    node_id = str(body.get("node_id", ""))
    event = _pending_feedback.get(node_id)
    if event:
        event.set()
        logger.info(f"[Session Feedback] Resumed execution for node {node_id}.")
        return web.json_response({"status": "resumed"})

    return web.json_response({"status": "not_found"})


@PromptServer.instance.routes.get("/session_feedback/thumbnails")
async def _api_list_thumbnails(request):
    """List available thumbnail images for a specific run."""
    session_id = request.query.get("session_id", "default")
    run_number = request.query.get("run_number", "1")

    safe_sid = _safe_id(session_id)
    run_dir = os.path.join(SESSIONS_DIR, safe_sid, f"run_{run_number}")
    result = {}

    if os.path.isdir(run_dir):
        for entry in sorted(os.listdir(run_dir)):
            if not entry.startswith("prompt_"):
                continue
            prompt_path = os.path.join(run_dir, entry)
            if not os.path.isdir(prompt_path):
                continue
            p_num = entry.replace("prompt_", "")
            imgs = sorted(
                f for f in os.listdir(prompt_path)
                if f.lower().endswith((".jpg", ".jpeg", ".png"))
            )
            result[p_num] = [
                f"/session_feedback/thumb?path="
                f"{safe_sid}/run_{run_number}/{entry}/{img}"
                for img in imgs
            ]

    return web.json_response(result)


@PromptServer.instance.routes.get("/session_feedback/thumb")
async def _api_serve_thumbnail(request):
    """Serve a single thumbnail image file."""
    rel_path = request.query.get("path", "")
    if not rel_path:
        return web.Response(status=400, text="Missing path")

    full_path = os.path.realpath(os.path.join(SESSIONS_DIR, rel_path))
    sessions_real = os.path.realpath(SESSIONS_DIR)

    # Security: prevent directory traversal
    if not full_path.startswith(sessions_real):
        return web.Response(status=403, text="Forbidden")

    if not os.path.isfile(full_path):
        return web.Response(status=404, text="Not found")

    return web.FileResponse(full_path)


# ── Node: Feedback Editor ─────────────────────────────────────────────
class SessionFeedbackEditorNode:
    """
    ⭐ Session Feedback Editor

    Placed AFTER the Writer. Shows the latest Run for the director to
    rate (1-5 stars) and annotate each prompt. Optionally receives a
    batch of images to save as thumbnails for visual preview.

    Two modes:
      - non_blocking: execution completes, user annotates at leisure
      - blocking: execution pauses until user clicks Save
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "session_id": ("STRING", {
                    "default": "default",
                    "tooltip": "Session identifier. Must match Reader/Writer.",
                }),
                "mode": (["non_blocking", "blocking"], {
                    "default": "non_blocking",
                    "tooltip": "blocking = pauses workflow until you save feedback. "
                               "non_blocking = workflow finishes, annotate later.",
                }),
                "num_prompts": ("INT", {
                    "default": 4,
                    "min": 1,
                    "max": 20,
                    "step": 1,
                    "tooltip": "Number of prompts per run (e.g. 4).",
                }),
                "batch_count": ("INT", {
                    "default": 1,
                    "min": 1,
                    "max": 50,
                    "step": 1,
                    "tooltip": "Times each prompt was sampled. "
                               "Total images = num_prompts × batch_count.",
                }),
            },
            "optional": {
                "run_summary": ("STRING", {
                    "forceInput": True,
                    "tooltip": "Connect from Writer to ensure execution order.",
                }),
                "thumbnail_images": ("IMAGE", {
                    "tooltip": "Batch of images from sampler. "
                               "Total = num_prompts × batch_count.",
                }),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ()
    OUTPUT_NODE = True
    FUNCTION = "process"
    CATEGORY = "\U0001f9e0 Memory"

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("NaN")

    def process(self, session_id: str = "default", mode: str = "non_blocking",
                num_prompts: int = 4, batch_count: int = 1,
                run_summary: str = "", thumbnail_images=None,
                unique_id=None):
        session = _load(session_id)
        run_count = session.get("run_count", 0)

        if run_count == 0:
            logger.info("[Session Feedback Editor] No runs yet.")
            return {"ui": {"status": ["no_runs"]}}

        # Save thumbnails if images provided
        if thumbnail_images is not None:
            _save_thumbnails(
                session_id, run_count, num_prompts, batch_count,
                thumbnail_images,
            )

        # Get latest run prompts + existing feedback
        entries = session.get("entries", [])
        latest_entry = entries[-1] if entries else ""
        prompts = _parse_prompts_from_entry(latest_entry)
        feedback = session.get("feedback", {})
        run_feedback = feedback.get(str(run_count), {}).get("prompts", {})

        # Notify frontend via websocket
        PromptServer.instance.send_sync("session_feedback_update", {
            "node_id": str(unique_id),
            "session_id": session_id,
            "run_count": run_count,
            "selected_run": run_count,
            "prompts": prompts,
            "feedback": run_feedback,
            "mode": mode,
        })

        if mode == "blocking":
            logger.info(
                f"[Session Feedback Editor] Blocking — waiting for feedback "
                f"on Run {run_count} (node {unique_id})..."
            )
            event = threading.Event()
            _pending_feedback[str(unique_id)] = event
            try:
                # Wait up to 10 minutes
                timeout = 600
                start = time.time()
                while not event.is_set():
                    if time.time() - start > timeout:
                        logger.warning(
                            "[Session Feedback Editor] Timeout — "
                            "continuing without feedback."
                        )
                        break
                    event.wait(timeout=1.0)
            finally:
                _pending_feedback.pop(str(unique_id), None)

            logger.info("[Session Feedback Editor] Resumed after feedback.")
        else:
            logger.info(
                f"[Session Feedback Editor] Non-blocking — Run {run_count} "
                f"ready for feedback in UI."
            )

        return {"ui": {"status": ["done"]}}


# ── Node: Reader ───────────────────────────────────────────────────────
class SessionMemoryReaderNode:
    """
    🧠 Session Memory Reader

    Placed at the start of the workflow. Reads the accumulated session log
    AND feedback from disk, outputs it for injection into the system prompt.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "session_id": ("STRING", {
                    "default": "default",
                    "tooltip": "Session identifier. Must match Writer/Feedback nodes.",
                }),
            },
            "optional": {
                "reset_session": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "Clear all memory, feedback, AND thumbnail images.",
                }),
            },
        }

    RETURN_TYPES = ("STRING", "INT", "STRING")
    RETURN_NAMES = ("session_memory", "run_count", "session_id")
    FUNCTION = "read"
    CATEGORY = "\U0001f9e0 Memory"

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("NaN")

    def read(self, session_id: str = "default", reset_session: bool = False):
        if reset_session:
            _save(session_id, {"run_count": 0, "entries": [], "feedback": {}})
            deleted = _delete_session_images(session_id)
            logger.info(
                f"[Session Memory Reader] Session '{session_id}' reset "
                f"({deleted} thumbnail images removed)."
            )
            return ("", 0, session_id)

        session = _load(session_id)
        entries = session.get("entries", [])
        run_count = session.get("run_count", 0)
        feedback = session.get("feedback", {})

        session_memory = "\n".join(entries) if entries else ""

        # Append feedback block if any
        feedback_block = _format_feedback_block(feedback)
        if feedback_block:
            session_memory = session_memory + "\n" + feedback_block

        logger.info(
            f"[Session Memory Reader] Session '{session_id}' — "
            f"{run_count} runs, {len(session_memory)} chars"
            f"{', with feedback' if feedback_block else ''}."
        )
        return (session_memory, run_count, session_id)


# ── Node: Writer ───────────────────────────────────────────────────────
class SessionMemoryWriterNode:
    """
    💾 Session Memory Writer

    Placed at the end of the workflow, after the Gemini Summarizer.
    Appends the structured run summary to the session file on disk.
    Outputs session_id so it can chain to the Feedback Editor.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "session_id": ("STRING", {
                    "default": "default",
                    "tooltip": "Session identifier. Must match Reader/Feedback.",
                }),
                "run_summary": ("STRING", {
                    "multiline": True,
                    "default": "",
                    "tooltip": "Structured summary from the Gemini Summarizer.",
                }),
            },
            "optional": {
                "max_runs": ("INT", {
                    "default": 0,
                    "min": 0,
                    "max": 100,
                    "step": 1,
                    "tooltip": "Sliding window: keep only the last N entries. "
                               "0 = unlimited.",
                }),
            },
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("run_summary", "session_id")
    OUTPUT_NODE = True
    FUNCTION = "write"
    CATEGORY = "\U0001f9e0 Memory"

    def write(
        self,
        session_id: str = "default",
        run_summary: str = "",
        max_runs: int = 0,
    ):
        stripped = run_summary.strip()
        if not stripped:
            logger.info(
                f"[Session Memory Writer] Empty summary — nothing written "
                f"to session '{session_id}'."
            )
            return (run_summary, session_id)

        session = _load(session_id)
        run_count = session.get("run_count", 0) + 1
        entries: list[str] = session.get("entries", [])
        feedback = session.get("feedback", {})

        entry = f"--- RUN {run_count} ---\n{stripped}\n"
        entries.append(entry)

        # Sliding window
        if max_runs > 0 and len(entries) > max_runs:
            trimmed = len(entries) - max_runs
            entries = entries[-max_runs:]
            logger.info(
                f"[Session Memory Writer] Trimmed {trimmed} oldest entries "
                f"(window={max_runs})."
            )

        _save(session_id, {
            "run_count": run_count,
            "entries": entries,
            "feedback": feedback,
        })
        logger.info(
            f"[Session Memory Writer] Written Run {run_count} to session "
            f"'{session_id}' ({len(stripped)} chars, {len(entries)} entries)."
        )
        return (run_summary, session_id)


# ── Registration ───────────────────────────────────────────────────────
NODE_CLASS_MAPPINGS = {
    "SessionFeedbackEditor": SessionFeedbackEditorNode,
    "SessionMemoryReader": SessionMemoryReaderNode,
    "SessionMemoryWriter": SessionMemoryWriterNode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "SessionFeedbackEditor": "\u2b50 Session Feedback Editor",
    "SessionMemoryReader": "\U0001f9e0 Session Memory Reader",
    "SessionMemoryWriter": "\U0001f4be Session Memory Writer",
}
