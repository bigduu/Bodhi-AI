#!/usr/bin/env python3
"""Stage the immutable, prebuilt Lotus package without installing its dependencies."""

import base64
import hashlib
import os
import pathlib
import shutil
import sys
import tarfile

EXPECTED = "ta0Vuvz6b1mPru8pvx5v+jv7Ih8XaqEwlg7atxfsw7YGypJ2Y3O1vFj4pgox/LDG238s4nFwUUsB6E7mCm6gRw=="


def stage(archive, destination):
    archive = pathlib.Path(archive)
    destination = pathlib.Path(destination)
    assert archive.is_file() and not archive.is_symlink()
    assert base64.b64encode(hashlib.sha512(archive.read_bytes()).digest()).decode() == EXPECTED, "Pinned npm archive differs"
    assert not destination.exists(), "Refusing to replace an installed package"
    destination.mkdir(parents=True)
    seen = set()
    total = 0
    with tarfile.open(archive, "r:gz") as package:
        for item in package:
            parts = pathlib.PurePosixPath(item.name).parts
            assert len(parts) > 1 and parts[0] == "package" and all(part not in (".", "..") for part in parts)
            assert item.isfile() or item.isdir(), "Package links and special files are forbidden"
            relative = pathlib.PurePosixPath(*parts[1:])
            assert str(relative) not in seen, "Duplicate package entry"
            seen.add(str(relative))
            target = destination.joinpath(*relative.parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            if item.isdir():
                target.mkdir(exist_ok=True)
            else:
                total += item.size
                assert 0 <= item.size <= 64 * 1024 * 1024 and total <= 128 * 1024 * 1024
                with package.extractfile(item) as source, target.open("xb") as output:
                    shutil.copyfileobj(source, output)
    assert (destination / "package.json").is_file() and (destination / "dist" / "index.html").is_file()
    print("Verified and staged the original Lotus package without dependency resolution")


if __name__ == "__main__":
    assert len(sys.argv) == 3
    stage(sys.argv[1], sys.argv[2])
