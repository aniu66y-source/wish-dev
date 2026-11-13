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


class PublishBoundaryTest(unittest.TestCase):
    """Logs, caches, archives and unknown types must never be packaged."""

    def with_root(self, files):
        tmp = tempfile.TemporaryDirectory(dir=os.environ.get("WISH_DEV_RUNTIME_ROOT"))
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        for name, body in files.items():
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(body, encoding="utf-8", newline="\n")
        original = skill.ROOT
        skill.ROOT = root
        self.addCleanup(setattr, skill, "ROOT", original)
        return root

    def packaged(self, files):
        root = self.with_root(files)
        return sorted(path.relative_to(root).as_posix() for path in skill.resources())

    def test_log_file_blocks_packaging(self):
        with self.assertRaises(ValueError) as caught:
            self.packaged({"SKILL.md": "x", "references/guide.md": "x",
                           "references/debug.log": "x"})
        self.assertIn("references/debug.log", str(caught.exception))

    def test_archive_and_unknown_types_are_blocked(self):
        with self.assertRaises(ValueError) as caught:
            self.packaged({"SKILL.md": "x", "references/old.zip": "x",
                           "references/raw.dat": "x"})
        message = str(caught.exception)
        self.assertIn("references/old.zip", message)
        self.assertIn("references/raw.dat", message)

    def test_cache_directories_are_ignored_and_assets_kept(self):
        files = {
            "SKILL.md": "x",
            "references/guide.md": "x",
            "scripts/run.mjs": "x",
            "assets/logo.png": "x",
            "references/__pycache__/cached.cpython-313.pyc": "x",
        }
        self.assertEqual(self.packaged(files),
                         ["SKILL.md", "assets/logo.png", "references/guide.md", "scripts/run.mjs"])

    def test_dot_files_are_rejected_instead_of_silently_dropped(self):
        with self.assertRaises(ValueError) as caught:
            self.packaged({"SKILL.md": "x", "scripts/.hidden": "x"})
        self.assertIn("scripts/.hidden", str(caught.exception))


class FrontmatterSyntaxTest(unittest.TestCase):
    """A missing field must not pass just because a few regexes still match."""

    HEAD = ('---\nname: wish-dev\ndescription: 用于测试的前置元数据\n'
            'license: "Proprietary"\ncompatibility: "host"\nmetadata:\n  version: "1.0.0"\n')

    def manifest_root(self, body):
        tmp = tempfile.TemporaryDirectory(dir=os.environ.get("WISH_DEV_RUNTIME_ROOT"))
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        (root / "SKILL.md").write_text(body, encoding="utf-8", newline="\n")
        original = skill.ROOT
        skill.ROOT = root
        self.addCleanup(setattr, skill, "ROOT", original)
        return root

    def validated(self, body):
        root = self.manifest_root(body)
        return skill.validate([root / "SKILL.md"])

    def test_supported_frontmatter_is_accepted(self):
        result = self.validated(self.HEAD + "---\n\n# skill\n")
        self.assertEqual(result["name"], "wish-dev")
        self.assertEqual(result["version"], "1.0.0")

    def test_unclosed_flow_collection_is_rejected(self):
        with self.assertRaises(ValueError) as caught:
            self.validated(self.HEAD + "broken: [\n---\n")
        self.assertIn("unsupported YAML syntax", str(caught.exception))

    def test_duplicate_name_is_rejected(self):
        with self.assertRaises(ValueError) as caught:
            self.validated('---\nname: wish-dev\nname: wish-dev\ndescription: y\n'
                           'metadata:\n  version: "1.0.0"\n---\n')
        self.assertIn("duplicate key", str(caught.exception))

    def test_duplicate_version_is_rejected(self):
        with self.assertRaises(ValueError) as caught:
            self.validated('---\nname: wish-dev\ndescription: y\nmetadata:\n'
                           '  version: "1.0.0"\n  version: "1.0.1"\n---\n')
        self.assertIn("duplicate key", str(caught.exception))

    def test_version_must_be_nested_under_metadata(self):
        with self.assertRaises(ValueError) as caught:
            self.validated('---\nname: wish-dev\ndescription: y\nversion: "1.0.0"\n'
                           'metadata:\n  language: zh\n---\n')
        self.assertIn("nested under metadata", str(caught.exception))

    def test_unquoted_version_is_rejected(self):
        with self.assertRaises(ValueError) as caught:
            self.validated('---\nname: wish-dev\ndescription: y\nmetadata:\n'
                           '  version: 1.0.0\n---\n')
        self.assertIn("must be quoted", str(caught.exception))

    def test_unclosed_quote_and_tab_are_rejected(self):
        with self.assertRaises(ValueError):
            self.validated(self.HEAD + 'broken: "oops\n---\n')
        with self.assertRaises(ValueError):
            self.validated('---\nname: wish-dev\ndescription:\ty\n---\n')


    def test_ambiguous_plain_scalars_are_rejected(self):
        for value in ('hello: world', '- item', 'true', 'null', '123', '1.5', '~', '#comment'):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    self.validated('---\nname: wish-dev\ndescription: ' + value
                                   + '\nmetadata:\n  version: "1.0.0"\n---\n')

    def test_unknown_escape_in_double_quotes_is_rejected(self):
        with self.assertRaises(ValueError) as caught:
            self.validated('---\nname: wish-dev\ndescription: "bad\\q"\n'
                           'metadata:\n  version: "1.0.0"\n---\n')
        self.assertIn('escape', str(caught.exception).lower())

    def test_dangling_escape_is_rejected(self):
        with self.assertRaises(ValueError):
            self.validated('---\nname: wish-dev\ndescription: "ends with \\"\n'
                           'metadata:\n  version: "1.0.0"\n---\n')

    def test_quoted_values_with_colons_and_escapes_are_accepted(self):
        for value in ('"hello: world"', '"line\\nbreak"', "'it''s fine'", "'a: b'"):
            with self.subTest(value=value):
                result = self.validated('---\nname: wish-dev\ndescription: ' + value
                                        + '\nmetadata:\n  version: "1.0.0"\n---\n')
                self.assertEqual(result['name'], 'wish-dev')

    def test_typed_plain_version_is_rejected_as_ambiguous(self):
        with self.assertRaises(ValueError) as caught:
            self.validated('---\nname: wish-dev\ndescription: y\nmetadata:\n  version: true\n---\n')
        self.assertIn('non-string YAML type', str(caught.exception))


class TextResourceValidationTest(unittest.TestCase):
    """Suffix case must not change which checks a resource receives."""

    HEAD = ('---\nname: wish-dev\ndescription: 用于测试的前置元数据\n'
            'license: "Proprietary"\ncompatibility: "host"\nmetadata:\n  version: "1.0.0"\n---\n')

    def validate_with(self, files):
        tmp = tempfile.TemporaryDirectory(dir=os.environ.get("WISH_DEV_RUNTIME_ROOT"))
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        (root / "SKILL.md").write_text(self.HEAD, encoding="utf-8", newline="\n")
        for name, body in files.items():
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(body)
        original = skill.ROOT
        skill.ROOT = root
        self.addCleanup(setattr, skill, "ROOT", original)
        return skill.validate([root / "SKILL.md"] + [root / name for name in files])

    def test_uppercase_markdown_is_still_text_checked(self):
        with self.assertRaises(ValueError) as caught:
            self.validate_with({"references/Guide.MD": b"# Guide\r\n"})
        self.assertIn("CRLF", str(caught.exception))

    def test_uppercase_python_is_still_parsed(self):
        with self.assertRaises(SyntaxError):
            self.validate_with({"scripts/bad.PY": b"def f(:\n"})

    def test_svg_line_endings_are_checked(self):
        with self.assertRaises(ValueError) as caught:
            self.validate_with({"assets/logo.svg": b"<svg>\r\n</svg>\r\n"})
        self.assertIn("CRLF", str(caught.exception))

    def test_example_and_scheme_links_are_not_packaged_references(self):
        body = ("[mail](mailto:a@b.c)\n\n[up](#top)\n\n```\n[x](scripts/none.mjs)\n"
                "[g](guide.md)\n```\n\n[guide](guide.md)\n")
        result = self.validate_with({"references/notes.md": body.encode(),
                                     "references/guide.md": b"# g\n"})
        # The broken example is ignored; a fenced reference to a packaged file still counts.
        self.assertEqual(result["internal_links_checked"], 2)

    def test_missing_relative_link_is_still_rejected(self):
        with self.assertRaises(ValueError) as caught:
            self.validate_with({"references/notes.md": b"[gone](scripts/none.mjs)\n"})
        self.assertIn("Missing packaged reference", str(caught.exception))


class VersionDriftTest(unittest.TestCase):
    """Every advertised current version is compared, not only the first line."""

    def drift_for(self, readme_lines):
        tmp = tempfile.TemporaryDirectory(dir=os.environ.get("WISH_DEV_RUNTIME_ROOT"))
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        (root / "SKILL.md").write_text('---\nname: wish-dev\ndescription: y\n'
                                       'metadata:\n  version: "1.2.3"\n---\n',
                                       encoding="utf-8", newline="\n")
        (root / "CHANGELOG.md").write_text("# 变更\n\n## 1.2.3\n",
                                           encoding="utf-8", newline="\n")
        (root / "README.md").write_text("\n".join(readme_lines) + "\n",
                                        encoding="utf-8", newline="\n")
        original = skill.ROOT
        skill.ROOT = root
        self.addCleanup(setattr, skill, "ROOT", original)
        return skill.version_drift()

    def test_matching_current_version_has_no_drift(self):
        self.assertEqual(self.drift_for(["- 当前版本：**1.2.3**"]), [])

    def test_a_second_stale_current_version_is_drift(self):
        issues = self.drift_for(["- 当前版本：**1.2.3**",
                                 "| 正式版 | 当前正式版为 **1.1.0** |"])
        self.assertTrue(any("1.1.0" in issue for issue in issues), issues)

    def test_a_readme_without_a_current_version_is_reported(self):
        self.assertTrue(any("未写出" in issue
                            for issue in self.drift_for(["# 项目"])))


if __name__ == "__main__":
    unittest.main()
