import base64
import hashlib
import importlib.util
import io
import pathlib
import tarfile
import tempfile
import unittest

module_path = pathlib.Path(__file__).with_name("stage-v20261031-lotus.py")
spec = importlib.util.spec_from_file_location("stage_v31", module_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class StageTest(unittest.TestCase):
    def archive(self, root, extra=None):
        path = root / "package.tgz"
        with tarfile.open(path, "w:gz") as archive:
            for name, data in [("package/package.json", b"{}"), ("package/dist/index.html", b"ok")]:
                info = tarfile.TarInfo(name)
                info.size = len(data)
                archive.addfile(info, io.BytesIO(data))
            if extra:
                archive.addfile(extra)
        module.EXPECTED = base64.b64encode(hashlib.sha512(path.read_bytes()).digest()).decode()
        return path

    def test_extract_and_reject_replacement(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            archive = self.archive(root)
            module.stage(archive, root / "dest")
            self.assertEqual((root / "dest/dist/index.html").read_text(), "ok")
            with self.assertRaises(AssertionError):
                module.stage(archive, root / "dest")

    def test_reject_traversal_symlink_and_digest_change(self):
        for name, kind in [("package/../escape", tarfile.DIRTYPE), ("package/link", tarfile.SYMTYPE)]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as tmp:
                root = pathlib.Path(tmp)
                entry = tarfile.TarInfo(name)
                entry.type = kind
                entry.linkname = "outside"
                archive = self.archive(root, entry)
                with self.assertRaises(AssertionError):
                    module.stage(archive, root / "dest")
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            archive = self.archive(root)
            module.EXPECTED = "incorrect"
            with self.assertRaises(AssertionError):
                module.stage(archive, root / "dest")


if __name__ == "__main__":
    unittest.main()
