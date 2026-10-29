#!/usr/bin/env python3
"""Restore only the preserved v31 Windows staging files, without building."""
import pathlib
import shutil
import stat
import sys
import zipfile

PREFIX = "Bodhi-AI/Bodhi-AI/product/"
CACHE = "src-tauri/.bamboo-sidecar-cache/842267d5a1e35c0aab84f89a85831d4df6d84a6297a1fcc6967a9de0b47ce732/"
TREES = (
    "target/x86_64-pc-windows-msvc/release/bundle/",
    "src-tauri/browser-runtime/", "src-tauri/binaries/", ".lotus-dist/", ".bodhi-frontend/",
    "node_modules/@bigduu/lotus-next/", CACHE + "browser-host/",
)
FILES = {
    "scripts/frontend-package-lock.json", "scripts/bamboo-sidecar-lock.json",
    "scripts/browser-runtime.lock.json", "src-tauri/tauri.conf.json", CACHE + "bamboo-sidecars-v2.json",
}


def restore(archive, product):
    root = pathlib.Path(product).resolve()
    assert root.is_dir() and not root.is_symlink()
    seen, total = set(), 0
    with zipfile.ZipFile(archive) as saved:
        for entry in saved.infolist():
            name = entry.filename
            assert name.startswith(PREFIX) and "\\" not in name and ":" not in name
            rel = name[len(PREFIX):]
            parts = pathlib.PurePosixPath(rel).parts
            assert parts and all(part not in (".", "..") for part in parts)
            assert rel not in seen, "Duplicate preserved path"
            seen.add(rel)
            allowed = rel in FILES or any(rel.startswith(prefix) for prefix in TREES) or rel.startswith("target/x86_64-pc-windows-msvc/release/bodhi")
            assert allowed, "Unexpected preserved path: " + rel
            mode = entry.external_attr >> 16
            assert not stat.S_ISLNK(mode), "Preserved links are not accepted"
            total += entry.file_size
            assert entry.file_size <= 4 * 1024 ** 3 and total <= 8 * 1024 ** 3
            target = root.joinpath(*parts)
            if entry.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            if rel in {"scripts/frontend-package-lock.json", "scripts/bamboo-sidecar-lock.json",
                       "scripts/browser-runtime.lock.json", "src-tauri/tauri.conf.json"}:
                assert target.is_file() and saved.read(entry) == target.read_bytes(), "Preserved lock or version differs: " + rel
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with saved.open(entry) as source, target.open("xb") as destination:
                shutil.copyfileobj(source, destination)
    required = ["target/x86_64-pc-windows-msvc/release/bundle/nsis/Bodhi AI_2026.10.31_x64-setup.exe",
                "target/x86_64-pc-windows-msvc/release/bodhi.exe", "src-tauri/browser-runtime/receipt.json",
                ".bodhi-frontend/receipt.json", CACHE + "bamboo-sidecars-v2.json"]
    for name in required:
        assert name in seen and (root / name).is_file(), "Missing original preserved file: " + name
    print(f"Restored {len(seen)} authenticated archive entries without compilation")


if __name__ == "__main__":
    assert len(sys.argv) == 3
    restore(sys.argv[1], sys.argv[2])
