#!/usr/bin/env python3
"""Stage the selected npm package without resolving shell dependencies again."""
import base64
import hashlib
import json
import os
import pathlib
import re
import shutil
import sys
import tarfile


def stage(root, pack_json, package, version):
    root = pathlib.Path(root).resolve()
    assert root.is_dir() and package == "@bigduu/lotus-next"
    lock = json.loads((root / "scripts/frontend-package-lock.json").read_text())
    assert (lock["packageName"], lock["packageVersion"]) == (package, version)
    records = json.loads(pathlib.Path(pack_json).read_text())
    assert isinstance(records, list) and len(records) == 1
    record = records[0]
    assert (record["name"], record["version"]) == (package, version)
    filename = record["filename"]
    assert re.fullmatch(r"[a-zA-Z0-9._-]+\.tgz", filename)
    archive = pathlib.Path(pack_json).parent / filename
    assert archive.is_file() and not archive.is_symlink()
    assert archive.stat().st_size == record["size"] and 0 < record["size"] <= 128 * 1024 ** 2
    content = archive.read_bytes()
    integrity = "sha512-" + base64.b64encode(hashlib.sha512(content).digest()).decode()
    assert integrity == record["integrity"] and hashlib.sha1(content).hexdigest() == record["shasum"]
    destination = root / "node_modules/@bigduu/lotus-next"
    assert not destination.exists() and not destination.is_symlink()
    destination.mkdir(parents=True)
    seen, total = set(), 0
    with tarfile.open(archive, "r:gz") as tar:
        for item in tar:
            assert "\\" not in item.name and ":" not in item.name and not any(ord(c) < 32 for c in item.name)
            parts = pathlib.PurePosixPath(item.name).parts
            assert len(parts) > 1 and parts[0] == "package" and all(part not in (".", "..") for part in parts)
            assert item.isfile() or item.isdir(), "Package links and special files are forbidden"
            relative = pathlib.PurePosixPath(*parts[1:])
            assert str(relative) not in seen and len(seen) < 10000
            seen.add(str(relative))
            target = destination.joinpath(*relative.parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            if item.isdir():
                target.mkdir(exist_ok=True)
            else:
                total += item.size
                assert 0 <= item.size <= 64 * 1024 ** 2 and total <= 128 * 1024 ** 2
                with tar.extractfile(item) as source, target.open("xb") as output:
                    shutil.copyfileobj(source, output)
    pkg = json.loads((destination / "package.json").read_text())
    assert (pkg["name"], pkg["version"]) == (package, version)
    assert (destination / "dist/index.html").is_file()
    print(f"Staged {package}@{version}; npm archive {integrity}")


if __name__ == "__main__":
    assert len(sys.argv) == 2
    stage(os.environ["SOURCE_ROOT"], sys.argv[1], os.environ["LOTUS_PACKAGE_NAME"], os.environ["LOTUS_VERSION"])
