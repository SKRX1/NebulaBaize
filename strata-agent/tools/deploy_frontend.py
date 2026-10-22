"""Deploy the workspace frontend to a Strata serve/web/ target.

Usage:
    python deploy_frontend.py                    # deploy to default target
    python deploy_frontend.py "E:\\path\\to\\Strata-main\\serve\\web"   # custom target

Copies all files from <workspace>/serve/web/ to the target.
Uses /MIR semantics: adds new, updates changed, removes extras in target.
The source is the authoritative copy (see RULES.md).
"""
import shutil, sys, hashlib
from pathlib import Path

SOURCE = Path(__file__).resolve().parent.parent / "serve" / "web"
DEFAULT_TARGET = Path(r"E:\Program Files\Strata-main\serve\web")
# Directories in source to exclude from mirroring
EXCLUDE_DIRS = {"fonts_backup"}


def md5(p: Path) -> str:
    return hashlib.md5(p.read_bytes()).hexdigest()


def deploy(src: Path, dst: Path) -> int:
    if not src.exists():
        print(f"[FAIL] source not found: {src}")
        return 1
    if not dst.exists():
        print(f"[FAIL] target not found: {dst}")
        return 1

    # Gather source file list
    src_files = set()
    for f in src.rglob("*"):
        if f.is_file():
            rel = f.relative_to(src)
            if any(part in EXCLUDE_DIRS for part in rel.parts[:-1]):
                continue
            src_files.add(str(rel).lower())

    # Mirror: copy new + update changed
    copied = 0
    for rel in sorted(src_files):
        s = src / rel
        d = dst / rel
        d.parent.mkdir(parents=True, exist_ok=True)
        if d.exists() and md5(s) == md5(d):
            continue
        shutil.copy2(s, d)
        print(f"  [COPY] {rel}")
        copied += 1

    # Remove extras in target (things not in source)
    removed = 0
    for f in dst.rglob("*"):
        if f.is_file():
            rel = str(f.relative_to(dst)).lower()
            if rel not in src_files:
                f.unlink()
                print(f"  [DEL ] {f.relative_to(dst)}")
                removed += 1

    print(f"\nDeployed: {copied} copied, {removed} removed, "
          f"{len(src_files) - copied} unchanged.")
    return 0


if __name__ == "__main__":
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_TARGET
    print(f"Source: {SOURCE}")
    print(f"Target: {target}")
    print()
    sys.exit(deploy(SOURCE, target))
