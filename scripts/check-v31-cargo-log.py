#!/usr/bin/env python3
"""Check observed Windows Cargo versions against the frozen source lock."""
import pathlib
import re
import sys
import tomllib


def check(lockfile, logfile):
    lock = tomllib.loads(pathlib.Path(lockfile).read_text(encoding="utf8"))
    accepted = {(entry["name"], entry["version"]) for entry in lock["package"]}
    plain = re.sub(r"\x1b\[[0-9;]*m", "", pathlib.Path(logfile).read_text(encoding="utf8"))
    assert not re.search(r"\bLocking\s+\d+\s+packages?", plain), "Original Cargo resolution changed the lock"
    found = set(re.findall(r"\b(?:Compiling|Fresh)\s+([A-Za-z0-9_-]+)\s+v([0-9][0-9A-Za-z.+-]*)", plain))
    assert len(found) >= 100 and ("bodhi", "2026.10.31") in found, "Incomplete original Cargo execution log"
    unknown = sorted(found - accepted)
    assert not unknown, f"Original Cargo packages absent from the frozen lock: {unknown}"
    print(f"Verified {len(found)} observed Cargo package versions against the frozen lock")


if __name__ == "__main__":
    assert len(sys.argv) == 3
    check(sys.argv[1], sys.argv[2])
