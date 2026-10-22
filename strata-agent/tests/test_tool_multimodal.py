"""Regression test for the streaming multimodal tool-result fix (2026-10-20).

Root cause of the "星云说自己不支持多模态" report: the streaming Loop B
(http_server._agent_stream) stored structured tool results (with images) as the
raw dict, which the upstream engine rejects as a non-list tool content
(frontend._has_image requires a list; chat_template raises 'Unexpected content
type' on a mapping). The image was silently dropped, so a multimodal model
concluded it had no vision — even though the engine advertises
input_modalities ["text","image"] and config/models.json sets vision:true.

Loop A (loop.py:_tool_content) already converts to OpenAI multimodal parts; this
test pins the SAME conversion in the streaming path via _build_tool_content so
the regression cannot silently return.
"""
import json
import os
import sys

_RUNTIME = os.path.join(os.path.dirname(__file__), "..", "runtime")
if _RUNTIME not in sys.path:
    sys.path.insert(0, _RUNTIME)

from http_server import _build_tool_content


def _img(data="QUJD", mime="image/png"):
    return {"type": "image", "data": data, "mimeType": mime}


def test_plain_string_passes_through():
    assert _build_tool_content("hello world") == "hello world"


def test_plain_string_capped():
    cap = lambda s: s[:5]
    assert _build_tool_content("hello world", cap) == "hello"


def test_image_result_becomes_parts_list():
    result = {"text": "screenshot taken", "images": [_img("QUJD")]}
    out = _build_tool_content(result)
    assert isinstance(out, list), f"image result must become a list of parts, got {type(out)}"
    types = [p["type"] for p in out]
    assert types == ["text", "image_url"], f"expected text+image_url, got {types}"
    assert out[0]["text"] == "screenshot taken"
    url = out[1]["image_url"]["url"]
    assert url.startswith("data:image/png;base64,QUJD"), f"bad data uri: {url}"


def test_image_result_caps_text():
    result = {"text": "a very long screenshot description", "images": [_img("Wg==")]}
    cap = lambda s: s[:7]
    out = _build_tool_content(result, cap)
    assert isinstance(out, list)
    assert out[0]["text"] == "a very ", f"text should be capped, got {out[0]['text']!r}"
    assert out[1]["image_url"]["url"].startswith("data:image/png;base64,Wg==")


def test_image_only_result_text_part_omitted():
    result = {"text": "", "images": [_img("QUJD", "image/jpeg")]}
    out = _build_tool_content(result)
    assert isinstance(out, list)
    assert len(out) == 1, f"empty text should drop the text part, got {out}"
    assert out[0]["type"] == "image_url"
    assert out[0]["image_url"]["url"].startswith("data:image/jpeg;base64,QUJD")


def test_image_free_dict_preserved_with_capped_text():
    # Historical behaviour: a dict without images is kept as a dict with capped text.
    result = {"text": "plain structured", "other": 1}
    cap = lambda s: s[:5]
    out = _build_tool_content(result, cap)
    assert isinstance(out, dict), f"image-free dict must stay a dict, got {type(out)}"
    assert out["text"] == "plain"
    assert out["other"] == 1


def test_output_is_json_serializable():
    # Session persistence serializes `messages`; a list of parts must round-trip.
    result = {"text": "x", "images": [_img("QUJD")]}
    out = _build_tool_content(result)
    json.dumps(out)  # must not raise


if __name__ == "__main__":
    test_plain_string_passes_through()
    test_plain_string_capped()
    test_image_result_becomes_parts_list()
    test_image_result_caps_text()
    test_image_only_result_text_part_omitted()
    test_image_free_dict_preserved_with_capped_text()
    test_output_is_json_serializable()
    print("ALL PASSED")
