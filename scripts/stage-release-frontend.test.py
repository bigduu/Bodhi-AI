#!/usr/bin/env python3
import base64
import hashlib
import importlib.util
import io
import json
import pathlib
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("stage_release_frontend", pathlib.Path(__file__).with_name("stage-release-frontend.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class StageTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="bodhi-release-frontend-")
        self.root = pathlib.Path(self.temp.name) / "product"
        (self.root / "scripts").mkdir(parents=True)
        (self.root / "scripts/frontend-package-lock.json").write_text(json.dumps({
            "packageName": "@bigduu/lotus-next", "packageVersion": "2026.10.29"}))
        self.archive = pathlib.Path(self.temp.name) / "frontend.tgz"
        self.pack = pathlib.Path(self.temp.name) / "pack.json"

    def tearDown(self):
        self.temp.cleanup()

    def create(self, extra=None):
        with tarfile.open(self.archive, "w:gz") as tar:
            for name, value in [("package/package.json", b'{"name":"@bigduu/lotus-next","version":"2026.10.29"}'),
                                ("package/dist/index.html", b"<html></html>")]:
                info = tarfile.TarInfo(name); info.size = len(value); tar.addfile(info, io.BytesIO(value))
            if extra:
                info = tarfile.TarInfo(extra); info.size = 1; tar.addfile(info, io.BytesIO(b"x"))
        data = self.archive.read_bytes()
        record = {"name": "@bigduu/lotus-next", "version": "2026.10.29", "filename": self.archive.name,
                  "size": len(data), "shasum": hashlib.sha1(data).hexdigest(),
                  "integrity": "sha512-" + base64.b64encode(hashlib.sha512(data).digest()).decode()}
        self.pack.write_text(json.dumps([record]))

    def stage(self):
        module.stage(self.root, self.pack, "@bigduu/lotus-next", "2026.10.29")

    def test_verified_archive_is_staged(self):
        self.create(); self.stage()
        self.assertEqual((self.root / "node_modules/@bigduu/lotus-next/dist/index.html").read_bytes(), b"<html></html>")

    def test_changed_archive_is_rejected(self):
        self.create(); self.archive.write_bytes(self.archive.read_bytes() + b"changed")
        with self.assertRaises(AssertionError): self.stage()

    def test_traversal_entry_is_rejected(self):
        self.create("package/../../outside")
        with self.assertRaises(AssertionError): self.stage()
        self.assertFalse((self.root / "outside").exists())

    def test_wrong_locked_package_version_is_rejected(self):
        self.create()
        with self.assertRaises(AssertionError): module.stage(self.root, self.pack, "@bigduu/lotus-next", "2026.10.30")


if __name__ == "__main__":
    unittest.main()
