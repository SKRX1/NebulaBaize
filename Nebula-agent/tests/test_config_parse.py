"""Direct unit tests for the two config-parsing modules, both of which had NO co-located
test (their boundaries are exactly the kind a silent config typo would slip past an e2e):

  runtime/config_loader - the stdlib fallback YAML/JSON loader used by approval.yaml,
                         sandbox.yaml and skills/*.yaml. Tested through the PURE built-in
                         parser (_minimal_yaml / _scalar / _strip_comment) so the result is
                         deterministic whether or not PyYAML happens to be installed here,
                         plus the load_config dispatch (missing file -> {}, JSON native).
  serve/runconfig       - the #564 Settings view of strata-<model>.json: per-key check(),
                         value_of() read across three storage shapes (plain key / a sampling
                         or mcp block / an --arg flag in args), apply()'s atomic all-or-
                         nothing edit + deep-copy isolation, view(), and save()/load() round
                         trip with the .bak kept.

Pure stdlib, deterministic; tempfile-backed for the file round trip. Self-run main() so it
plugs straight into tools/run_tests.py (exit 0 == green).
"""
import json
import os
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "runtime"))

from runtime import config_loader as CL   # noqa: E402
from serve import runconfig as RC         # noqa: E402


# ============================================================ config_loader ====
def test_cl_scalar_types():
    # _scalar maps the scalar tokens the project's configs actually use, in priority order:
    # a fully-quoted string wins (even "5" stays a string), then null/bool, then a JSON-safe
    # flow collection, then int, then float, else bare text.
    assert CL._scalar('"hello"') == "hello"
    assert CL._scalar("'sq'") == "sq"
    assert CL._scalar('"5"') == "5"                       # quoted number stays a string
    assert CL._scalar("null") is None and CL._scalar("~") is None
    assert CL._scalar("true") is True and CL._scalar("False") is False
    assert CL._scalar("42") == 42                          # int wins before float
    assert CL._scalar("3.14") == 3.14
    assert CL._scalar('[1, 2]') == [1, 2]                 # flow seq -> json.loads
    assert CL._scalar('{"a": 1}') == {"a": 1}
    assert CL._scalar("plain text") == "plain text"       # unmatched -> verbatim
    assert CL._scalar("  padded  ") == "padded"
    print("CL._scalar: quoted/null/bool/int/float/flow/bare all correct, quotes win")


def test_cl_strip_comment():
    # A trailing # is a comment, but a # INSIDE quotes is literal text (a key or a path
    # value must never be truncated at a stray '#').
    assert CL._strip_comment("key: value  # trailing") == "key: value  "
    assert CL._strip_comment("url: \"http://x#frag\" # note") == "url: \"http://x#frag\" "
    assert CL._strip_comment("key: 'a#b'") == "key: 'a#b'"
    assert CL._strip_comment("# whole line is a comment") == ""
    print("CL._strip_comment: trailing # stripped, # inside quotes kept verbatim")


def test_cl_minimal_yaml_shapes():
    # The built-in parser must handle exactly the constructs the configs use: nested maps by
    # 2-space indent, block sequences (incl. an item that is itself a mapping with deeper
    # keys), inline mappings on a list item, and flow collections.
    text = (
        "# top comment\n"
        "name: approval\n"
        "enabled: true\n"
        "limit: 5\n"
        "ratio: 0.4\n"
        "list_key: [1, 2, 3]\n"
        "nested:\n"
        "  a: 1\n"
        "  b:\n"
        "    deep: yes\n"
        "items:\n"
        "  - name: first\n"
        "    mode: auto\n"
        "  - second\n"
    )
    got = CL._minimal_yaml(text)
    assert got["name"] == "approval" and got["enabled"] is True, got
    assert got["limit"] == 5 and got["ratio"] == 0.4, got
    assert got["list_key"] == [1, 2, 3], got                          # flow collection
    # LOAD-BEARING quirk (worth locking): the built-in parser recognises ONLY true/false/
    # null/~ as bool/None -- it does NOT map the YAML aliases yes/no/on/off (those stay
    # literal strings). This is the exact gap vs real PyYAML, which WOULD turn `yes` into
    # True; the stdlib fallback is intentionally minimal (see the module docstring). Locking
    # it here means a future "make it parse yes" edit is a deliberate, tested change.
    assert got["nested"] == {"a": 1, "b": {"deep": "yes"}}, got       # 'yes' stays a string in the builtin parser
    # LOAD-BEARING: a sequence whose first item is an inline mapping must absorb the deeper
    # keys into that one entry; a second bare item is a scalar. This is the shape schedule /
    # skill configs use and is the exact thing a naive parser gets wrong.
    assert got["items"] == [{"name": "first", "mode": "auto"}, "second"], got
    print("CL._minimal_yaml: nested map + flow seq + inline-mapping seq all correct")


def test_cl_empty_and_load_config():
    assert CL._minimal_yaml("") == {}
    assert CL._minimal_yaml("# only a comment\n\n   \n") == {}
    # load_config dispatch, independent of whether PyYAML is installed:
    assert CL.load_config("") == {}                                  # empty path -> {}
    assert CL.load_config(os.path.join(ROOT, "__no_such_config__.yaml")) == {}
    d = tempfile.mkdtemp(prefix="cl_")
    jp = os.path.join(d, "c.json")
    with open(jp, "w", encoding="utf-8") as f:
        f.write('{"a": 1, "b": [true, null]}')
    assert CL.load_config(jp) == {"a": 1, "b": [True, None]}        # leading '{' -> native JSON
    yp = os.path.join(d, "c.yaml")
    with open(yp, "w", encoding="utf-8") as f:
        f.write("name: sandbox\nmax: 3\n")
    got = CL.load_config(yp)                                         # not JSON -> yaml path (lib or builtin)
    assert isinstance(got, dict) and got.get("name") == "sandbox" and got.get("max") == 3, got
    print("CL.load_config: empty/missing->{}, JSON native, yaml parsed (both lib paths agree)")


# ================================================================ runconfig ====
def test_rc_check_every_kind():
    # check() validates a single value against that key's declared kind; it returns the value
    # to STORE (None = remove the key). Each branch + its boundary is asserted, because a
    # silent slip here lets a bad number reach the engine.
    cfg = {}
    assert RC.check("fit_max_tokens", True, cfg) is True
    # LOAD-BEARING: a bool key rejects a non-bool (a string "true" is NOT a bool).
    raised = 0
    for bad in ("yes", 1, 0):
        try:
            RC.check("fit_max_tokens", bad, cfg); raised += 1
        except ValueError:
            pass
    assert raised == 0, "all three non-bools must raise, none returned cleanly"

    assert RC.check("reasoning_budget_tokens", 256, cfg) == 256      # int>=0
    for bad in (-1, 1.5, "5", True):
        try:
            RC.check("reasoning_budget_tokens", bad, cfg)
            raise AssertionError("int>=0 accepted %r" % (bad,))
        except ValueError:
            pass
    assert RC.check("idle_unload_s", 0, cfg) == 0                   # num>=0 allows 0
    try:
        RC.check("idle_unload_s", -0.1, cfg); raise AssertionError("num>=0 accepted negative")
    except ValueError:
        pass

    assert RC.check("anthropic_thinking", "model", cfg) == "model"  # enum: in the set
    try:
        RC.check("anthropic_thinking", "nope", cfg); raise AssertionError("enum accepted off-set")
    except ValueError:
        pass

    # names: a comma string is split+trimmed to a list; an all-empty result -> None (removes key)
    assert RC.check("aliases", "a, b ,c", cfg) == ["a", "b", "c"]
    assert RC.check("aliases", ["ok"], cfg) == ["ok"]
    assert RC.check("aliases", " , ", cfg) is None
    try:
        RC.check("aliases", ["  ", "x"], cfg); raise AssertionError("names accepted a blank entry")
    except ValueError:
        pass

    # a sampling key honours its own range rule, coercing to float
    assert RC.check("sampling.temperature", 0.5, cfg) == 0.5
    assert RC.check("sampling.top_p", 0.9, cfg) == 0.9              # 0<x<=1
    for bad in (0, 1.1):
        try:
            RC.check("sampling.top_p", bad, cfg); raise AssertionError("top_p accepted %r" % (bad,))
        except ValueError:
            pass
    assert RC.check("sampling.top_k", 40, cfg) == 40                # 1..64
    for bad in (0, 65):
        try:
            RC.check("sampling.top_k", bad, cfg); raise AssertionError("top_k accepted %r" % (bad,))
        except ValueError:
            pass

    # an "arg" kind is an integer flag value
    assert RC.check("vram_reserve_mib", 700, cfg) == 700
    try:
        RC.check("vram_reserve_mib", 7.5, cfg); raise AssertionError("arg accepted a float")
    except ValueError:
        pass

    # an unknown key cannot be changed here at all
    try:
        RC.check("not_a_setting", 1, cfg); raise AssertionError("unknown key accepted")
    except ValueError:
        pass
    print("RC.check: bool/int/num/enum/names/sampling-ranges/arg all enforced; boundaries + unknown raise")


def test_rc_lazy_load_conflicts_with_vision():
    # LOAD-BEARING cross-key rule: lazy_load is text-only, so turning it on while the model
    # declares "vision" must refuse (a lazy model could not read the images it claims to).
    assert RC.check("lazy_load", True, {}) is True                  # no vision -> fine
    assert RC.check("lazy_load", False, {"vision": True}) is False  # turning it OFF is always fine
    try:
        RC.check("lazy_load", True, {"vision": True})
        raise AssertionError("lazy_load+vision should be refused")
    except ValueError:
        pass
    print("RC.check lazy_load: refused when model has vision; off/disable always ok")


def test_rc_value_of_three_shapes():
    # value_of reads a key from whichever of the three shapes actually stores it: a plain
    # top-level key, a value inside a "sampling"/"mcp" block, or a value after an "--flag"
    # in the args list. Each must be read correctly, and a missing one must be None (the
    # default applies) -- never a wrong/0 value that would masquerade as an explicit setting.
    cfg = {
        "fit_max_tokens": True,
        "sampling": {"temperature": 0.5, "top_k": 7},
        "mcp": {"max_rounds": 20},
        "args": ["-ngl", "99", "--vram-reserve-mib", "700"],
    }
    assert RC.value_of(cfg, "fit_max_tokens") is True
    assert RC.value_of(cfg, "sampling.temperature") == 0.5
    assert RC.value_of(cfg, "mcp.max_rounds") == 20
    assert RC.value_of(cfg, "vram_reserve_mib") == 700              # from args, str->int
    # absent everywhere -> None
    assert RC.value_of({}, "fit_max_tokens") is None
    assert RC.value_of({}, "sampling.temperature") is None
    assert RC.value_of({"sampling": "notadict"}, "sampling.top_k") is None
    assert RC.value_of({"args": ["--vram-reserve-mib"]}, "vram_reserve_mib") is None  # flag with no value
    print("RC.value_of: plain/sampling-block/mcp-block/args-flag all read; absent -> None")


def test_rc_apply_atomic_and_deepcopy():
    cfg = {"model": "x", "sampling": {"temperature": 0.5}, "args": []}
    before = json.dumps(cfg, sort_keys=True)

    # A normal change lands and reports which keys changed.
    new, changed = RC.apply(cfg, {"fit_max_tokens": True})
    assert changed == ["fit_max_tokens"] and new["fit_max_tokens"] is True, (new, changed)
    # a value that equals the current one is NOT reported as changed (idempotent)
    new2, changed2 = RC.apply({"fit_max_tokens": True}, {"fit_max_tokens": True})
    assert changed2 == [], changed2

    # atomicity: one bad value in the SAME request changes NOTHING (check runs for every key
    # BEFORE any is applied) -> this is the guard against a half-applied settings POST.
    try:
        RC.apply({"fit_max_tokens": False}, {"fit_max_tokens": True, "reasoning_budget_tokens": -9})
        raise AssertionError("a batch with one bad value must not partially apply")
    except ValueError:
        pass
    assert json.dumps(cfg, sort_keys=True) == before, "apply must not mutate the caller's dict"

    # a sampling change writes into the block, and setting it to None removes the sub-key
    new3, _ = RC.apply({}, {"sampling.temperature": 0.8})
    assert new3 == {"sampling": {"temperature": 0.8}}, new3
    new4, _ = RC.apply({"sampling": {"temperature": 0.8}}, {"sampling.temperature": None})
    assert "temperature" not in new4.get("sampling", {}) and "sampling" not in new4, new4  # block emptied -> dropped

    # an arg change appends/edits/removes the flag inside args
    newa, _ = RC.apply({"args": []}, {"vram_reserve_mib": 900})
    assert newa["args"] == ["--vram-reserve-mib", "900"], newa
    newb, _ = RC.apply({"args": ["--vram-reserve-mib", "900"]}, {"vram_reserve_mib": None})
    assert newb["args"] == [], newb
    print("RC.apply: atomic all-or-nothing, no caller mutation, block/arg set+unset correct")


def test_rc_view_and_save_round_trip():
    cfg = {"model": "m", "fit_max_tokens": True, "sampling": {"temperature": 0.5}}
    v = RC.view(cfg, "/tmp/strata-test.json")
    assert v["file"] == "strata-test.json", v
    bykey = {k["key"]: k for k in v["keys"]}
    assert set(bykey) == set(RC.SPEC), "view must list exactly the editable keys"
    assert bykey["fit_max_tokens"]["value"] is True
    assert bykey["sampling.temperature"]["value"] == 0.5
    # enum kinds carry their choices so the UI can render a dropdown
    assert bykey["anthropic_thinking"].get("choices") == ["model", "on_request"], bykey["anthropic_thinking"]

    # save() keeps the prior file as <name>.bak and writes atomically; load() reads it back.
    d = tempfile.mkdtemp(prefix="rc_")
    p = os.path.join(d, "strata-m.json")
    with open(p, "w", encoding="utf-8") as f:
        f.write(json.dumps(cfg))
    bak = RC.save(p, {"model": "m", "fit_max_tokens": False})
    assert os.path.basename(bak) == "strata-m.json.bak" and os.path.isfile(bak), bak
    assert json.loads(open(bak, encoding="utf-8").read()) == cfg, "the .bak must be the PREVIOUS content"
    assert RC.load(p) == {"model": "m", "fit_max_tokens": False}, RC.load(p)
    # load() refuses a non-object JSON (a list/number file is not a config)
    bad = os.path.join(d, "strata-bad.json")
    with open(bad, "w", encoding="utf-8") as f:
        f.write("[1, 2, 3]")
    try:
        RC.load(bad); raise AssertionError("a non-object config must raise")
    except ValueError:
        pass
    print("RC.view lists editable keys (+enum choices); save keeps .bak, load round-trips, non-object raises")


def main():
    test_cl_scalar_types()
    test_cl_strip_comment()
    test_cl_minimal_yaml_shapes()
    test_cl_empty_and_load_config()
    test_rc_check_every_kind()
    test_rc_lazy_load_conflicts_with_vision()
    test_rc_value_of_three_shapes()
    test_rc_apply_atomic_and_deepcopy()
    test_rc_view_and_save_round_trip()
    print("CONFIG-PARSE TEST PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
