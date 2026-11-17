"""Which GPUs the config names, and whether naming several of them is a layer split.

Split out of serve/server.py (refactor plan-B block 9, 2026-11-17): two functions that share
one concept -- turning the config's "gpu" key into the nvidia-smi-numbered card list, and then
deciding whether several such cards mean a layer split (vs. the later card being a --peer-device
expert tier, which the engine refuses beside --layer-split, #665).  layer_split_of calls
gpu_list, which moves with it, so the pair closes only over builtins -- AST proved no
engine/session state and no lazy first-party import.  server.py re-imports the names unchanged,
so every call site (engine_args / hip_env_guard / the launch print / the Monitor indices) stays
untouched.

This is an equivalence move, not a rewrite: the function bodies are byte-for-byte the originals --
they are extracted from server.py here rather than re-typed.
"""


def gpu_list(cfg: dict) -> list[int]:
    """The config's "gpu": one card (2), or several for a layer split ([0, 2] or "0,2"), numbered as nvidia-smi
    numbers them; [] when it names none."""
    g = cfg.get("gpu")
    if g is None or g == "":
        return []
    items = g if isinstance(g, (list, tuple)) else str(g).split(",")
    return [int(str(x).strip()) for x in items if str(x).strip() != ""]

def layer_split_of(cfg: dict) -> bool:
    """Several GPUs in the config are a layer split, unless the args put the later card(s) to another use: with
    --peer-device the second card is an expert-cache tier, and the engine refuses that beside --layer-split (#665)."""
    return len(gpu_list(cfg)) > 1 and "--peer-device" not in cfg["args"]
