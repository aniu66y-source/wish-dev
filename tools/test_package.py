"""Regression tests for tools/package_skill.py (stdlib unittest, no deps)."""
import json
import os
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import package_skill as skill


class PackageTripleTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=os.environ.get("WISH_DEV_RUNTIME_ROOT"))
        self.out = Path(self.tmp.name) / "wish-dev-test.zip"

    def tearDown(self):
        self.tmp.cleanup()

    def test_triple_matches_and_stays_lf(self):
        files = skill.resources()
        meta = skill.validate(files)
        result = skill.package(files, meta, self.out)
        manifest = json.loads((self.out.parent / result["manifest"]).read_text(encoding="utf-8"))
        checksum = (self.out.parent / result["checksum"]).read_text(encoding="utf-8")
        self.assertEqual(result["sha256"], manifest["sha256"])
        self.assertIn(result["sha256"], checksum)
        self.assertEqual(len(manifest["files"]), len(files))
        self.assertTrue(all(name.startswith("wish-dev/") for name in manifest["files"]))
        self.assertTrue(all(":" not in name and not name.startswith("/")
                            for name in manifest["files"]))
        with zipfile.ZipFile(self.out) as archive:
            self.assertEqual(sorted(archive.namelist()), sorted(manifest["files"]))
            self.assertNotIn(b"\r\n", archive.read("wish-dev/SKILL.md"))
        for name in (result["manifest"], result["checksum"]):
            self.assertNotIn(b"\r\n", (self.out.parent / name).read_bytes())


class LineEndingTest(unittest.TestCase):
    def test_crlf_resource_is_rejected(self):
        with tempfile.TemporaryDirectory(dir=os.environ.get("WISH_DEV_RUNTIME_ROOT")) as tmp:
            root = Path(tmp)
            manifest = root / "SKILL.md"
            manifest.write_bytes(b"---\r\nname: x\r\ndescription: y\r\n"
                                  b"metadata:\r\n  version: \"1.0.0\"\r\n---\r\n")
            original, skill.ROOT = skill.ROOT, root
            try:
                with self.assertRaises(ValueError) as caught:
                    skill.validate([manifest])
            finally:
                skill.ROOT = original
            self.assertIn("CRLF", str(caught.exception))


class FrontmatterPositionTest(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.multiple(skill, contract_gaps=mock.DEFAULT, version_drift=mock.DEFAULT)
        mocked = patcher.start()
        mocked["contract_gaps"].return_value = []
        mocked["version_drift"].return_value = []
        self.addCleanup(patcher.stop)

    def quality(self, manifest):
        return skill.skill_quality(manifest)["dimensions"]

    def test_top_level_fields_pass(self):
        dims = self.quality('---\nname: x\ndescription: y\nlicense: "Proprietary"\n'
                            'compatibility: "host"\nmetadata:\n  version: "1.0.0"\n---\n')
        self.assertEqual(dims["license"], "PASS")
        self.assertEqual(dims["crossPlatform"], "PASS")

    def test_nested_fields_are_not_top_level(self):
        dims = self.quality('---\nname: x\ndescription: y\nmetadata:\n'
                            '  license: "Proprietary"\n  compatibility: "host"\n---\n')
        self.assertEqual(dims["license"], "WEAK")
        self.assertEqual(dims["crossPlatform"], "WEAK")


if __name__ == "__main__":
    unittest.main()
