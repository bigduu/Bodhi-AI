#!/usr/bin/env python3
"""Restore only authenticated v31 Linux output and its staging, without building."""
import pathlib
import shutil
import stat
import sys
import zipfile

PREFIX = "Bodhi-AI/Bodhi-AI/product/"
CACHE = "src-tauri/.bamboo-sidecar-cache/842267d5a1e35c0aab84f89a85831d4df6d84a6297a1fcc6967a9de0b47ce732/"
TARGET = "target/x86_64-unknown-linux-gnu/release/"
TREES = (
    "src-tauri/browser-runtime/", "src-tauri/binaries/", ".lotus-dist/", ".bodhi-frontend/",
    "node_modules/@bigduu/lotus-next/", CACHE + "browser-host/",
)
FILES = {
    "scripts/frontend-package-lock.json", "scripts/bamboo-sidecar-lock.json",
    "scripts/browser-runtime.lock.json", "src-tauri/tauri.conf.json", CACHE + "bamboo-sidecars-v2.json",
    TARGET + "bodhi",
    TARGET + "bundle/appimage/Bodhi AI_2026.10.31_amd64.AppImage",
    TARGET + "bundle/deb/Bodhi AI_2026.10.31_amd64.deb",
    TARGET + "bundle/rpm/Bodhi AI-2026.10.31-1.x86_64.rpm",
}
LOCKS = {"scripts/frontend-package-lock.json", "scripts/bamboo-sidecar-lock.json",
         "scripts/browser-runtime.lock.json", "src-tauri/tauri.conf.json"}


def restore(archive, product):
    root = pathlib.Path(product).resolve()
    assert root.is_dir() and not root.is_symlink()
    seen, restored, total = set(), set(), 0
    with zipfile.ZipFile(archive) as saved:
        for entry in saved.infolist():
            name = entry.filename
            assert name.startswith(PREFIX) and "\\" not in name and ":" not in name
            rel = name[len(PREFIX):]
            parts = pathlib.PurePosixPath(rel).parts
            assert parts and all(part not in (".", "..") for part in parts)
            assert rel not in seen, "Duplicate preserved path"
            seen.add(rel)
            allowed = (rel in FILES or any(rel.startswith(prefix) for prefix in TREES)
                       or rel.startswith(TARGET + "bundle/") or rel.startswith(TARGET + "bodhi"))
            assert allowed, "Unexpected preserved path: " + rel
            mode = entry.external_attr >> 16
            assert not stat.S_ISLNK(mode), "Preserved links are not accepted"
            assert not mode & 0o7000, "Special permission bits are not accepted"
            total += entry.file_size
            assert entry.file_size <= 4 * 1024 ** 3 and total <= 8 * 1024 ** 3
            selected = rel in FILES or any(rel.startswith(prefix) for prefix in TREES)
            if not selected:
                continue
            target = root.joinpath(*parts)
            if entry.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            if rel in LOCKS:
                assert target.is_file() and saved.read(entry) == target.read_bytes(), "Preserved lock or version differs: " + rel
                assert stat.S_IMODE(target.stat().st_mode) == stat.S_IMODE(mode), "Preserved lock mode differs: " + rel
            else:
                assert stat.S_ISREG(mode), "Preserved output must be a regular file: " + rel
                target.parent.mkdir(parents=True, exist_ok=True)
                with saved.open(entry) as source, target.open("xb") as destination:
                    shutil.copyfileobj(source, destination)
                target.chmod(stat.S_IMODE(mode))
            restored.add(rel)
    required = FILES | {"src-tauri/browser-runtime/receipt.json", ".bodhi-frontend/receipt.json"}
    for name in required:
        assert name in restored and (root / name).is_file(), "Missing original preserved file: " + name
    print(f"Inspected {len(seen)} preserved entries; restored {len(restored)} without compilation")


if __name__ == "__main__":
    assert len(sys.argv) == 3
    restore(sys.argv[1], sys.argv[2])
