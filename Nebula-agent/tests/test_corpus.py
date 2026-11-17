"""Offline test for the corpus / reference-library layer — no model, no GPU.

Verifies the full loop the feature promises:
    feed a batch of reference docs -> it learns them -> retrieve them while working
    -> user decides which to drop (delete as a unit by source)

Cases:
  a. ingest a .txt/.md doc -> it chunks and lands multiple source-tagged rows
  b. search finds content from the ingested doc
  c. sources() reports the document with its chunk count
  d. delete_source drops every chunk of that doc, search no longer finds it
  e. a second doc survives (delete is scoped to its own source)
  f. PDF is honestly skipped (pure-stdlib can't parse it)
  g. HTML is parsed to visible text only (script/style content is NOT stored)
  h. media (image/audio/video) is honestly skipped with a transcribe-first message
Run from the Nebula-agent folder with the managed python:
    python tests/test_corpus.py
"""
from __future__ import annotations

import os
import sys
import shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))

from memory.semantic import SemanticMemory  # noqa: E402
from corpus import ingest_file, source_id_for  # noqa: E402

SCRATCH = os.path.join(ROOT, "tests", "_scratch_corpus")


def _write(name, text):
    p = os.path.join(SCRATCH, name)
    with open(p, "w", encoding="utf-8") as f:
        f.write(text)
    return p


def main():
    if os.path.isdir(SCRATCH):
        try:
            shutil.rmtree(SCRATCH)
        except Exception:
            pass
    os.makedirs(SCRATCH, exist_ok=True)

    sem = SemanticMemory(os.path.join(SCRATCH, "sem.db"))

    doc1 = _write("api_spec.md", (
        "# API Spec\n\nThe gateway exposes JSON-RPC over stdio.\n\n"
        "Authentication uses a bearer token from the platform.\n\n"
        "Rate limits are enforced per client id at the edge.\n\n"
        "Pagination uses opaque cursors returned in the envelope.\n\n"
        "Idempotency keys are required on all mutating requests.\n\n"
        "Webhook deliveries are retried with exponential backoff.\n\n"
        "Schema versions are negotiated during the initialize handshake.\n\n"
        "The initialize handshake returns the server capabilities object.\n\n"
        "Tool definitions are advertised as JSON schema fragments per tool.\n\n"
        "Prompts are templates parameterized by named variables.\n\n"
        "Resources are addressed by URIs with a content MIME type.\n\n"
        "Progress notifications are sent on long-running tool calls.\n\n"
        "Cancellation is requested by the client via a JSON-RPC method.\n\n"
        "Logging levels are configurable per server for diagnostics.\n\n"
        "Sampling requests allow the server to ask the client for a completion.\n\n"
        "Root changes notifications tell clients when the workspace tree changes.\n\n"
        "Completion hints advertise auto-complete support on prompt arguments.\n"
    ))
    doc2 = _write("deploy_notes.txt", (
        "Deploy targets a single host behind a health check.\n\n"
        "Rollbacks are performed by repointing the symlink and reloading.\n"
    ))

    # --- Case a: ingest doc1 -> multiple source-tagged chunks ---
    r1 = ingest_file(sem, doc1)
    assert r1["chunks_added"] >= 2, f"case a: doc1 should chunk into multiple rows: {r1}"
    assert r1["source"] == source_id_for(doc1), "case a: source id mismatch"

    r2 = ingest_file(sem, doc2)
    assert r2["chunks_added"] >= 1, f"case a: doc2 ingested nothing: {r2}"
    print(f"case a OK: doc1={r1['chunks_added']} chunks, doc2={r2['chunks_added']} chunks")

    # --- Case b: search finds content from doc1 ---
    hits = sem.search("bearer token authentication", top_k=5)
    assert any("bearer token" in (h.get("text", "").lower()) for h in hits), \
        f"case b: search did not surface doc1 content: {hits}"
    print("case b OK: search surfaces ingested doc content")

    # --- Case c: sources() reports both docs with counts ---
    srcs = {s["source"]: s["chunks"] for s in sem.list_sources()}
    assert srcs.get(source_id_for(doc1), 0) >= 1, f"case c: doc1 not in sources: {srcs}"
    assert srcs.get(source_id_for(doc2), 0) >= 1, f"case c: doc2 not in sources: {srcs}"
    print(f"case c OK: sources lists both docs {srcs}")

    # --- Case d: delete_source drops doc1 entirely; search no longer finds it ---
    removed = sem.delete_source(source_id_for(doc1))
    assert removed == srcs[source_id_for(doc1)], \
        f"case d: deleted {removed} != expected {srcs[source_id_for(doc1)]}"
    # re-search: doc1 content gone, but doc2 content (a different query) survives
    hits_after = sem.search("bearer token authentication", top_k=5)
    assert not any("bearer token" in (h.get("text", "").lower()) for h in hits_after), \
        f"case d: deleted doc1 content still found: {hits_after}"
    print("case d OK: delete_source drops the whole document as a unit")

    # --- Case e: doc2 survives (delete was scoped to its own source) ---
    hits2 = sem.search("rollback symlink health check", top_k=5)
    assert any(("rollback" in h.get("text", "").lower()) or
               ("symlink" in h.get("text", "").lower()) for h in hits2), \
        f"case e: doc2 content missing after scoped delete: {hits2}"
    srcs_after = {s["source"]: s["chunks"] for s in sem.list_sources()}
    assert source_id_for(doc1) not in srcs_after, "case e: deleted doc still listed"
    assert srcs_after.get(source_id_for(doc2), 0) >= 1, "case e: surviving doc dropped"
    print("case e OK: delete is scoped to its own source; other docs survive")

    # --- Case f: PDF honestly skipped (no dependency => no fake parse) ---
    fake_pdf = _write("report.pdf", "%PDF-1.4 (stub)")
    rpdf = ingest_file(sem, fake_pdf)
    assert rpdf["chunks_added"] == 0 and rpdf["skipped"], \
        f"case f: PDF should be honestly skipped: {rpdf}"
    print(f"case f OK: PDF honestly skipped ({rpdf['skipped']})")

    # --- Case g: HTML parsed to VISIBLE text only; script/style content not stored ---
    html_doc = _write("page.html", (
        "<html><head><title>TitleNoiseZeta</title>"
        "<style>.x{color:red /* StyleNoiseEta */}</style></head>"
        "<body><h1>Quarterly Revenue Heading Theta</h1>"
        "<p>The visible paragraph mentions the keyword beacon Iota.</p>"
        "<script>var hidden='ScriptNoiseKappa';</script></body></html>"
    ))
    rhtml = ingest_file(sem, html_doc)
    assert rhtml["chunks_added"] >= 1, f"case g: HTML not ingested: {rhtml}"
    # visible content found
    hits_html = sem.search("beacon paragraph revenue heading", top_k=5)
    assert any("beacon" in h.get("text", "").lower() for h in hits_html), \
        f"case g: HTML visible text not surfaced: {hits_html}"
    # noise (script/style/title) must NOT have been stored
    noise = sem.search("ScriptNoiseKappa StyleNoiseEta TitleNoiseZeta", top_k=5)
    assert not any(("scriptnoisekappa" in h.get("text", "").lower()) or
                    ("stylenoiseeta" in h.get("text", "").lower()) or
                    ("titlenoisezeta" in h.get("text", "").lower()) for h in noise), \
        f"case g: HTML noise (script/style/title) leaked into storage: {noise}"
    print("case g OK: HTML parsed to visible text only; script/style/title skipped")

    # --- Case h: media honestly skipped via the documented multimodal bridge (H3/H4) ---
    # The pure-stdlib core can't OCR/ASR, so each media type is honestly skipped with a
    # per-modality bridge to the platform layer (image->vision, audio->ASR, video->caption).
    from corpus import multimodal_bridge
    assert "image" in multimodal_bridge("x.png"), "case h: image bridge missing"
    assert "audio" in multimodal_bridge("x.mp3").lower(), "case h: audio bridge missing"
    assert "caption" in multimodal_bridge("x.mp4").lower(), "case h: video bridge missing"
    assert multimodal_bridge("x.md") is None, "case h: non-media should have no bridge"
    _expected_modality = {"photo.png": "image", "clip.mp3": "audio", "movie.mp4": "video"}
    for media, modality in _expected_modality.items():
        rp = ingest_file(sem, _write(media, "stub binary bytes"))
        assert rp["chunks_added"] == 0 and rp["skipped"], \
            f"case h: {media} should be honestly skipped: {rp}"
        assert modality in rp["skipped"].lower(), \
            f"case h: {media} skip should carry its {modality} bridge: {rp}"
        assert "ingest" in rp["skipped"].lower(), \
            f"case h: {media} bridge should route to transcribe-then-ingest: {rp}"
    print("case h OK: image/audio/video honestly skipped via the documented multimodal bridge")

    try:
        shutil.rmtree(SCRATCH)
    except Exception:
        pass  # best-effort cleanup (sandbox trash may intercept on Windows)
    print("CORPUS TEST OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
