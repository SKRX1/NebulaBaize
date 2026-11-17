"""Corpus ingest layer: learn reference documents so they can be retrieved later.

Pure standard library. This is the "feed it a batch of reference docs -> it learns them ->
retrieves them while working -> user decides which to drop" loop. Ingest parses a document
into text, splits it into chunks, and stores each chunk in semantic memory tagged with
meta.source == the document id. Deleting one document is then a single delete_source call.

Supported without third-party deps:
  - plain text: .txt .md .markdown .csv .tsv .json (read as-is)
  - .docx / .pptx / .xlsx: text extracted from the OOXML zip parts (stdlib zipfile + regex)
  - .html / .htm: visible text extracted via stdlib html.parser (skips script/style/head)
  - .pdf: NOT parsed without a dependency (honest skip -> return a clear message), matching
    the project's pure-stdlib principle; convert to text/markdown first, then ingest.

Media (image / audio / video) is NOT parsed in pure stdlib — OCR/ASR need a model or engine,
which the project keeps OUT of the self-contained core. The honest path is: transcribe media
to text first (via the platform multimodal layer), save it as .txt/.md, then ingest that. This
layer is text-in / text-search by nature, so anything must become text before it can be learned.

Chunking splits on blank-line paragraph boundaries and groups up to `chunk_chars` chars so a
long document becomes several searchable, source-tagged rows (delete-as-a-unit via source).
"""
from __future__ import annotations

import json
import os
import re
import zipfile
from html.parser import HTMLParser

TEXT_EXT = {".txt", ".md", ".markdown", ".csv", ".tsv", ".text"}
OOXML_EXT = {".docx": "word/document.xml", ".pptx": "ppt/slides", ".xlsx": "xl/"}
HTML_EXT = {".html", ".htm"}
# Media the pure-stdlib core won't parse (needs a model/engine to become text first).
MEDIA_EXT = {
    ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".tiff", ".tif", ".svg",  # image
    ".mp3", ".wav", ".m4a", ".flac", ".ogg", ".aac",                            # audio
    ".mp4", ".mov", ".avi", ".mkv", ".webm",                                    # video
}

_TAG = re.compile(r"<[^>]+>")
_WS = re.compile(r"[ \t]+")

# --- Multimodal entry (H3/H4): the pure-stdlib core is text-in / text-search by nature. ---
# It cannot OCR an image or transcribe audio/video without a model, so those formats are
# NOT parsed here. They enter through a documented bridge: the platform's multimodal layer
# turns them into TEXT, the agent writes that text to a .txt/.md file, and only then does
# ingest() learn it. This table is the canonical map (image->vision, audio->ASR, video->
# caption) so the entry point is a real contract, not just a comment.
MEDIA_BRIDGE = {
    "image": "vision/OCR: open the image with the multimodal Read, write its content to a .txt/.md, then ingest",
    "audio": "ASR: run AudioTranscribe, save the transcript as .txt/.md, then ingest",
    "video": "caption: extract an on-screen caption/transcript (multimodal skill), save as .txt/.md, then ingest",
}
_EXT_TO_MODALITY = {}
for _i in (".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".tiff", ".tif", ".svg"):
    _EXT_TO_MODALITY[_i] = "image"
for _a in (".mp3", ".wav", ".m4a", ".flac", ".ogg", ".aac"):
    _EXT_TO_MODALITY[_a] = "audio"
for _v in (".mp4", ".mov", ".avi", ".mkv", ".webm"):
    _EXT_TO_MODALITY[_v] = "video"


def multimodal_bridge(path: str) -> str | None:
    """Return the documented bridge for a media file, or None if it is not a media type.

    This is the honest entry: media is not parsed in the pure-stdlib core — it must first
    become text via the platform multimodal layer (vision for images, ASR for audio,
    caption for video), then ingest() learns that text. Returns the recommended step so the
    agent has a single, concrete place to send any given file.
    """
    ext = os.path.splitext(path)[1].lower()
    modality = _EXT_TO_MODALITY.get(ext)
    if modality is None:
        return None
    return f"[{modality}] {MEDIA_BRIDGE[modality]}"


class _HTMLTextExtractor(HTMLParser):
    """Collect visible text from HTML, skipping script/style/head/nav noise."""

    _SKIP = {"script", "style", "head", "title", "meta", "link", "noscript"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self._chunks = []
        self._skip_depth = 0

    def handle_starttag(self, tag, attrs):
        if tag in self._SKIP:
            self._skip_depth += 1

    def handle_endtag(self, tag):
        if tag in self._SKIP and self._skip_depth:
            self._skip_depth -= 1

    def handle_data(self, data):
        if self._skip_depth:
            return
        d = data.strip()
        if d:
            self._chunks.append(d)

    def text(self) -> str:
        return "\n".join(self._chunks)


def _html_text(path: str) -> str | None:
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            p = _HTMLTextExtractor()
            p.feed(f.read())
            return p.text()
    except Exception:
        return None


def extract_text(path: str) -> str | None:
    """Return the plain text of a document, or None if the format needs a dependency."""
    ext = os.path.splitext(path)[1].lower()
    if ext in TEXT_EXT:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return f.read()
    if ext in {".docx", ".pptx", ".xlsx"}:
        return _ooxml_text(path, ext)
    if ext in HTML_EXT:
        return _html_text(path)
    if ext == ".pdf":
        return None  # honest: pure-stdlib cannot parse PDF without a dependency
    if ext in MEDIA_EXT:
        return None  # honest: media needs a model/engine (OCR/ASR) to become text first
    # default: try to read as text (best-effort)
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return f.read()
    except Exception:
        return None


def _ooxml_text(path: str, ext: str) -> str | None:
    """Extract text from Office Open XML (docx/pptx/xlsx) via stdlib zipfile.

    docx -> concatenate <w:t> text runs; pptx -> all slide XML text runs; xlsx -> sharedStrings.
    Tags are stripped so only readable content remains.
    """
    try:
        with zipfile.ZipFile(path) as z:
            names = z.namelist()
            parts = []
            if ext == ".docx":
                parts = [n for n in names if n == "word/document.xml"]
            elif ext == ".pptx":
                parts = [n for n in names if n.startswith("ppt/slides/slide") and n.endswith(".xml")]
            elif ext == ".xlsx":
                parts = [n for n in names if n == "xl/sharedStrings.xml"]
            out = []
            for p in sorted(parts):
                xml = z.read(p).decode("utf-8", "replace")
                # keep only the text between tags, per run
                for m in re.findall(r">([^<>]+)<", xml):
                    m = m.strip()
                    if m:
                        out.append(m)
            return "\n".join(out)
    except Exception:
        return None


def chunk_text(text: str, chunk_chars: int = 800) -> list[str]:
    """Split document text into chunks on paragraph boundaries (blank lines).

    Paragraphs are grouped until a chunk reaches chunk_chars. Returns [] for empty input.
    """
    if not text or not text.strip():
        return []
    # Normalize to LF and split into paragraphs on blank lines.
    norm = text.replace("\r\n", "\n").replace("\r", "\n")
    paras = re.split(r"\n\s*\n", norm)
    paras = [p.strip() for p in paras if p.strip()]
    chunks: list[str] = []
    cur = ""
    for p in paras:
        candidate = (cur + "\n" + p).strip() if cur else p
        if len(candidate) > chunk_chars and cur:
            chunks.append(cur.strip())
            cur = p
        else:
            cur = candidate
    if cur.strip():
        chunks.append(cur.strip())
    return chunks


def source_id_for(path: str) -> str:
    """Stable source id for a document = its basename (so delete_source targets one doc)."""
    return os.path.basename(path)


def ingest_file(semantic, path: str, source: str | None = None, chunk_chars: int = 800) -> dict:
    """Parse, chunk, and store a document in semantic memory under one source id.

    Returns a summary dict {path, source, chunks_added, skipped}. Dedup is handled by the
    semantic layer (re-ingesting the same content merges, not duplicates).
    """
    if not os.path.isfile(path):
        return {"path": path, "source": source or source_id_for(path),
                "chunks_added": 0, "skipped": "file not found"}
    text = extract_text(path)
    src = source or source_id_for(path)
    if text is None:
        ext = os.path.splitext(path)[1].lower()
        if ext in MEDIA_EXT:
            reason = multimodal_bridge(path)  # concrete per-modality entry (image/audio/video)
        elif ext == ".pdf":
            reason = "PDF needs a dependency; convert to text/markdown first"
        else:
            reason = "format needs a dependency; convert to text/markdown first"
        return {"path": path, "source": src, "chunks_added": 0, "skipped": reason}
    chunks = chunk_text(text, chunk_chars)
    if not chunks:
        return {"path": path, "source": src, "chunks_added": 0, "skipped": "no content"}
    added = 0
    for c in chunks:
        semantic.add(c, meta={"source": src, "path": path})
        added += 1
    return {"path": path, "source": src, "chunks_added": added, "skipped": None}
