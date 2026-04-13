"""Smoke test for Session Memory Reader + Writer nodes."""
import sys, os, shutil
sys.path.insert(0, ".")
from session_memory import (
    SessionMemoryReaderNode as Reader,
    SessionMemoryWriterNode as Writer,
    NODE_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS,
    SESSIONS_DIR,
)

TEST_SESSION = "test_smoke"
TEST_FILE = os.path.join(SESSIONS_DIR, f"{TEST_SESSION}.json")


def cleanup():
    if os.path.exists(TEST_FILE):
        os.remove(TEST_FILE)


def test():
    cleanup()

    reader = Reader()
    writer = Writer()

    # ── Test 1: First read on empty session ───────────────────────────
    mem, count, sid = reader.read(TEST_SESSION)
    assert mem == "", f"Empty session should return empty string, got: {repr(mem)}"
    assert count == 0, f"Empty session run_count should be 0, got: {count}"
    assert sid == TEST_SESSION
    print("PASS: Empty session read")

    # ── Test 2: Write Run 1, then read ────────────────────────────────
    writer.write(TEST_SESSION, "concept: Alpha\nlocation: Vespa corner")
    mem, count, _ = reader.read(TEST_SESSION)
    assert "Alpha" in mem, "After writing Run 1, Reader should output it"
    assert count == 1
    print("PASS: Write Run 1, read back correctly")

    # ── Test 3: Write Run 2 — Run 1 still visible ─────────────────────
    writer.write(TEST_SESSION, "concept: Beta\nlocation: Metro platform")
    mem, count, _ = reader.read(TEST_SESSION)
    assert "Alpha" in mem and "Beta" in mem
    assert count == 2
    assert "--- RUN 1 ---" in mem and "--- RUN 2 ---" in mem
    print("PASS: Both runs accumulate correctly")

    # ── Test 4: Empty summary is ignored ──────────────────────────────
    writer.write(TEST_SESSION, "   ")
    _, count2, _ = reader.read(TEST_SESSION)
    assert count2 == 2, "Empty summary should not increment run_count"
    print("PASS: Empty summary ignored")

    # ── Test 5: Sliding window ────────────────────────────────────────
    cleanup()
    writer.write(TEST_SESSION, "Entry A")
    writer.write(TEST_SESSION, "Entry B")
    writer.write(TEST_SESSION, "Entry C")
    writer.write(TEST_SESSION, "Entry D", max_runs=2)
    mem, count, _ = reader.read(TEST_SESSION)
    assert "Entry A" not in mem, "Entry A should be trimmed"
    assert "Entry B" not in mem, "Entry B should be trimmed"
    assert "Entry C" in mem and "Entry D" in mem
    assert count == 4  # run_count is cumulative, not windowed
    print("PASS: Sliding window (max_runs=2)")

    # ── Test 6: Reset ─────────────────────────────────────────────────
    mem, count, _ = reader.read(TEST_SESSION, reset_session=True)
    assert mem == "" and count == 0
    mem2, count2, _ = reader.read(TEST_SESSION)
    assert mem2 == "" and count2 == 0
    print("PASS: Reset clears session")

    # ── Test 7: session_id passthrough from Writer ─────────────────────
    result = writer.write(TEST_SESSION, "Passthrough check")
    assert result == ("Passthrough check",), f"Writer should passthrough summary: {result}"
    print("PASS: Writer passthrough")

    # ── Test 8: Node metadata ──────────────────────────────────────────
    assert "SessionMemoryReader" in NODE_CLASS_MAPPINGS
    assert "SessionMemoryWriter" in NODE_CLASS_MAPPINGS
    assert Reader.CATEGORY == "🧠 Memory"
    assert Writer.CATEGORY == "🧠 Memory"
    assert Writer.OUTPUT_NODE is True
    import math
    assert math.isnan(Reader.IS_CHANGED())
    print("PASS: Node metadata correct")

    # ── Test 9: session_id sanitization ───────────────────────────────
    from session_memory import _safe_id
    cleanup()
    bad_id = "../../../evil; rm -rf"
    writer.write(bad_id, "Sanitization test")
    safe_name = _safe_id(bad_id)
    safe_path = os.path.join(SESSIONS_DIR, f"{safe_name}.json")
    assert os.path.exists(safe_path), f"Sanitized file not found: {safe_path}"
    # Confirm the path is strictly inside SESSIONS_DIR (no path traversal)
    assert os.path.abspath(safe_path).startswith(os.path.abspath(SESSIONS_DIR)), \
        "Path traversal not prevented!"
    os.remove(safe_path)
    print("PASS: session_id sanitization")

    # ── Test 10: Corrupt file recovery ────────────────────────────────
    cleanup()
    os.makedirs(SESSIONS_DIR, exist_ok=True)
    with open(TEST_FILE, "w") as f:
        f.write("NOT VALID JSON {{{{")
    mem, count, _ = reader.read(TEST_SESSION)
    assert mem == "" and count == 0, "Corrupt file should gracefully return empty"
    print("PASS: Corrupt file graceful recovery")

    print("\n✅ ALL 10 TESTS PASSED")
    cleanup()


if __name__ == "__main__":
    test()
