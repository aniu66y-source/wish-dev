"""Regression tests for tools/package_skill.py (stdlib unittest, no deps)."""
import contextlib
import io
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

    def test_blocked_directory_names_as_files_are_refused_not_dropped(self):
        for name in ("references/dist", "references/.git"):
            with self.subTest(name=name):
                with self.assertRaises(ValueError) as caught:
                    self.packaged({"SKILL.md": "x", name: "x"})
                self.assertIn(name, str(caught.exception))

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

    def test_link_title_and_angle_brackets_resolve_to_the_packaged_file(self):
        body = ('[a](<guide.md>)\n'
                '[b](guide.md "说明")\n'
                "[c](<guide.md> 'note')\n")
        result = self.validate_with({"references/notes.md": body.encode(),
                                     "references/guide.md": b"# g\n"})
        self.assertEqual(result["internal_links_checked"], 3)

    def test_title_outside_brackets_and_tab_separated_title_resolve(self):
        body = ('[a](<guide.md> "outer title")\n'
                '[b](guide.md\t"tab title")\n')
        result = self.validate_with({"references/notes.md": body.encode(),
                                     "references/guide.md": b"# g\n"})
        self.assertEqual(result["internal_links_checked"], 2)

    def test_text_inside_angle_brackets_is_the_entire_destination(self):
        # Quotes inside <...> are path characters, NOT a Markdown title. The old
        # positive fixture wrongly accepted guide.md as a prefix of a missing file.
        for target in ('guide.md "inner title"', 'guide.md missing.md'):
            with self.subTest(target=target):
                with self.assertRaisesRegex(ValueError, "Missing packaged reference"):
                    self.validate_with({"references/notes.md":
                                        ('[a](<' + target + '>)\n').encode(),
                                        "references/guide.md": b"# prefix\n"})

    def test_angle_destination_preserves_spaces_and_quotes(self):
        cases = [('guide notes.md', 'guide notes.md'),
                 ("guide 'notes'.md", "guide 'notes'.md")]
        # Single quotes are legal Windows filename characters; double quotes are
        # tested above as a missing whole target (Windows cannot create that file).
        for target, filename in cases:
            with self.subTest(target=target):
                result = self.validate_with({"references/notes.md":
                                             ('[x](<' + target + '>)').encode(),
                                             "references/" + filename: b"# good\n"})
                self.assertEqual(result["internal_links_checked"], 1)

    def test_balanced_parentheses_and_markdown_escapes(self):
        cases = [('guide(v1).md', 'guide(v1).md'),
                 ('guide(a(b(c))).md', 'guide(a(b(c))).md'),
                 (r'guide\(v1\).md', 'guide(v1).md'),
                 (r'guide\#name.md', 'guide')]
        # A literal # must be URL encoded to remain part of a URL path; a
        # Markdown backslash removes markup escaping, not URL fragment semantics.
        for target, filename in cases:
            with self.subTest(target=target):
                result = self.validate_with({"references/notes.md":
                                             ('[x](' + target + ')').encode(),
                                             "references/" + filename: b"# good\n"})
                self.assertEqual(result["internal_links_checked"], 1)

    def test_balanced_target_cannot_pass_by_existing_prefix(self):
        with self.assertRaisesRegex(ValueError, "Missing packaged reference"):
            self.validate_with({"references/notes.md": b"[x](guide.md(v1).md)",
                                "references/guide.md(v1": b"# wrong prefix\n"})

    def test_url_decoding_happens_once_before_resolving(self):
        cases = [('guide%20notes.md', 'guide notes.md'),
                 ('%67uide.md', 'guide.md'),
                 ('guide%23notes.md', 'guide#notes.md'),
                 ('guide%25notes.md', 'guide%notes.md'),
                 ('%2567uide.md', '%67uide.md')]
        for target, filename in cases:
            with self.subTest(target=target):
                result = self.validate_with({"references/notes.md":
                                             ('[x](' + target + ')').encode(),
                                             "references/" + filename: b"# good\n"})
                self.assertEqual(result["internal_links_checked"], 1)

    def test_encoded_literal_cannot_substitute_for_decoded_target(self):
        with self.assertRaisesRegex(ValueError, "Missing packaged reference"):
            self.validate_with({"references/notes.md": b"[x](%67uide.md)",
                                "references/%67uide.md": b"# wrong\n"})

    def test_encoded_parent_segments_cannot_escape_the_skill(self):
        with self.assertRaisesRegex(ValueError, "Reference leaves skill"):
            self.validate_with({"references/notes.md":
                                b"[x](%2e%2e/%2e%2e/secret.md)",
                                "references/%2e%2e/%2e%2e/secret.md": b"# literal\n"})

    def test_reference_style_links_are_explicitly_refused(self):
        for body in ('[x][missing]\n\n[missing]: absent.md',
                     '[x][]', '[x][missing]', '[id]: absent.md',
                     '[x]\n\n[id]: guide.md',
                     '[x][id]\n\n[id]: guide.md'):
            with self.subTest(body=body):
                with self.assertRaisesRegex(ValueError, "reference-style"):
                    self.validate_with({"references/notes.md": body.encode(),
                                        "references/guide.md": b"# good\n"})

    def test_malformed_links_never_count_as_valid_prefixes(self):
        for target in ('<guide.md', 'guide.md "unterminated',
                       'guide.md unexpected', '<guide.md>junk',
                       'guide.md(v1', '<guide.md "title"> "open'):
            with self.subTest(target=target):
                with self.assertRaises(ValueError):
                    self.validate_with({"references/notes.md":
                                        ('[x](' + target + ')').encode(),
                                        "references/guide.md": b"# prefix\n"})

    def test_example_semantics_and_escaped_link_openers_are_preserved(self):
        body = ('<!-- [x](guide(v1).md) [x](missing.md) -->\n'
                '```\n[x](guide%20notes.md) [x](missing.md)\n```\n'
                r'\[x](missing.md)' + '\n' + r'[x]\(missing.md)' + '\n')
        result = self.validate_with({"references/notes.md": body.encode(),
                                     "references/guide(v1).md": b"# good\n",
                                     "references/guide notes.md": b"# good\n"})
        self.assertEqual(result["internal_links_checked"], 2)

    def test_inline_code_references_are_examples_not_unsupported_prose(self):
        body = ('`[id]: missing.md` and ``[x][id]``; [ordinary] text.\n'
                '`[x](guide.md)` `[x](missing.md)`\n')
        result = self.validate_with({"references/notes.md": body.encode(),
                                     "references/guide.md": b"# good\n"})
        self.assertEqual(result["internal_links_checked"], 1)

    def test_inline_code_can_wrap_within_one_paragraph(self):
        body = b"`sample\n[x](missing.md) [x](guide.md) [x][id]`\n"
        result = self.validate_with({"references/notes.md": body,
                                     "references/guide.md": b"# good\n"})
        self.assertEqual(result["internal_links_checked"], 1)

    def test_only_ordered_one_interrupts_a_multiline_code_paragraph(self):
        for marker in ("2.", "2)"):
            with self.subTest(continuation=marker):
                body = ("`sample\n" + marker + " not-an-interruption\n"
                        "[x](missing.md) [x](guide.md) [x][id]`\n")
                result = self.validate_with({"references/notes.md": body.encode(),
                                             "references/guide.md": b"# good\n"})
                self.assertEqual(result["internal_links_checked"], 1)
        for marker in ("1.", "1)"):
            for link in ("[x](missing.md)", "[x][id]"):
                with self.subTest(interruption=marker, link=link):
                    body = "`sample\n" + marker + " new-list\n" + link + "`\n"
                    with self.assertRaises(ValueError):
                        self.validate_with({"references/notes.md": body.encode()})

    def test_indented_code_keeps_example_counting_semantics(self):
        for indent in ("    ", "\t"):
            with self.subTest(indent=indent):
                body = (indent + "[x][id]\n" + indent + "[x](missing.md)\n"
                        + indent + "[x](guide.md)\n")
                result = self.validate_with({"references/notes.md": body.encode(),
                                             "references/guide.md": b"# good\n"})
                self.assertEqual(result["internal_links_checked"], 1)

    def test_fence_closer_requires_only_trailing_whitespace(self):
        for fence in ("```", "~~~"):
            with self.subTest(fence=fence):
                body = (fence + "\n" + fence + "not-a-close\n[x][id]\n"
                        "[x](missing.md) [x](guide.md)\n" + fence + "\n")
                result = self.validate_with({"references/notes.md": body.encode(),
                                             "references/guide.md": b"# good\n"})
                self.assertEqual(result["internal_links_checked"], 1)

    def test_midparagraph_bracket_colon_is_ordinary_text(self):
        result = self.validate_with({"references/notes.md":
                                     b"Status [ok]: proceed with next step.\n"})
        self.assertEqual(result["internal_links_checked"], 0)

    def test_code_boundaries_do_not_mask_real_prose_links(self):
        for body in ("Paragraph\n    [x](missing.md)\n",
                     "```\nexample\n```  \n[x][id]\n",
                     "~~~\nexample\n~~~~\t\n[x][id]\n",
                     "   [id]: missing.md\n",
                     "`unclosed\n\n[x](missing.md)\n\n`another paragraph",
                     "`unclosed\n\n[x][id]\n\n`another paragraph",
                     "`unclosed\n# Heading\n[x](missing.md)\n`next",
                     "`unclosed\n- list\n[x](missing.md)\n`next",
                     "`unclosed\n> quote\n[x](missing.md)\n`next",
                     "`unclosed\n---\n[x](missing.md)\n`next",
                     "`unclosed\n===\n[x](missing.md)\n`next"):
            with self.subTest(body=body):
                with self.assertRaises(ValueError):
                    self.validate_with({"references/notes.md": body.encode()})

    def test_invalid_encoded_example_target_is_not_counted_or_fatal(self):
        body = b"<!-- [x](%ff.md) [x](%00.md) -->\n```\n[x](%ff.md)\n```\n"
        result = self.validate_with({"references/notes.md": body})
        self.assertEqual(result["internal_links_checked"], 0)

    def test_invalid_encoded_prose_target_is_fatal(self):
        with self.assertRaisesRegex(ValueError, "Invalid link destination"):
            self.validate_with({"references/notes.md": b"[x](%ff.md)\n"})

    def test_missing_link_with_inner_title_is_still_rejected(self):
        with self.assertRaises(ValueError) as caught:
            self.validate_with({"references/notes.md":
                                b'[gone](<missing.md "t">)\n',
                                "references/guide.md": b"# g\n"})
        self.assertIn("Missing packaged reference", str(caught.exception))

    def test_missing_relative_link_is_still_rejected(self):
        with self.assertRaises(ValueError) as caught:
            self.validate_with({"references/notes.md": b"[gone](scripts/none.mjs)\n"})
        self.assertIn("Missing packaged reference", str(caught.exception))

    def test_missing_link_error_keeps_original_target(self):
        with self.assertRaises(ValueError) as caught:
            self.validate_with({"references/notes.md":
                                b'[gone](missing.md "t")\n'})
        message = str(caught.exception)
        self.assertIn("Missing packaged reference", message)
        self.assertIn('missing.md "t"', message)


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

    def test_single_quoted_version_is_not_reported_missing(self):
        tmp = tempfile.TemporaryDirectory(dir=os.environ.get("WISH_DEV_RUNTIME_ROOT"))
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        (root / "SKILL.md").write_text("---\nname: wish-dev\ndescription: y\n"
                                        "metadata:\n  version: '1.2.3'\n---\n",
                                        encoding="utf-8", newline="\n")
        (root / "CHANGELOG.md").write_text("# 变更\n\n## 1.2.3\n",
                                           encoding="utf-8", newline="\n")
        (root / "README.md").write_text("- 当前版本：**1.2.3**\n",
                                        encoding="utf-8", newline="\n")
        original = skill.ROOT
        skill.ROOT = root
        self.addCleanup(setattr, skill, "ROOT", original)
        self.assertEqual(skill.version_drift(), [])

    def test_another_mapping_version_before_metadata_is_not_drift(self):
        self.drift_for(["当前版本 1.2.3"])
        path = skill.ROOT / "SKILL.md"
        body = path.read_text(encoding="utf-8").replace(
            "metadata:", 'other:\n  version: "9.9.9"\nmetadata:')
        path.write_text(body, encoding="utf-8", newline="\n")
        self.assertEqual(skill.validate([path])["version"], "1.2.3")
        self.assertEqual(skill.version_drift(), [])

    def test_a_second_stale_current_version_is_drift(self):
        issues = self.drift_for(["- 当前版本：**1.2.3**",
                                 "| 正式版 | 当前正式版为 **1.1.0** |"])
        self.assertTrue(any("1.1.0" in issue for issue in issues), issues)

    def test_a_readme_without_a_current_version_is_reported(self):
        self.assertTrue(any("未写出" in issue
                            for issue in self.drift_for(["# 项目"])))

    def test_latest_release_wording_is_checked(self):
        issues = self.drift_for(["- 最新正式版：[1.1.0](https://example.invalid/tag)"])
        self.assertTrue(any("1.1.0" in issue for issue in issues), issues)

    def test_historical_versions_on_the_same_line_are_not_drift(self):
        self.assertEqual(self.drift_for(
            ["- 最新正式版：[1.2.3](https://example.invalid/tag)，上一版 1.1.0"]), [])


class ContractAnchorGateTest(unittest.TestCase):
    """A missing P0 contract anchor must fail the gate, not only report WEAK."""

    HEAD = TextResourceValidationTest.HEAD

    def test_a_missing_anchor_fails_validation(self):
        with tempfile.TemporaryDirectory(dir=os.environ.get("WISH_DEV_RUNTIME_ROOT")) as tmp:
            root = Path(tmp)
            (root / "SKILL.md").write_text(self.HEAD, encoding="utf-8", newline="\n")
            original = skill.ROOT
            skill.ROOT = root
            stderr = io.StringIO()
            try:
                with mock.patch.object(skill, "contract_gaps",
                                       return_value=["SKILL.md 缺少锚点「^## 交工标准」"]), \
                     mock.patch.object(sys, "argv", ["package_skill.py", "--check"]), \
                     contextlib.redirect_stderr(stderr):
                    status = skill.main()
            finally:
                skill.ROOT = original
        self.assertEqual(status, 1, "a missing anchor must fail the gate")
        self.assertIn("契约锚点", stderr.getvalue())


class BlockedDirectoryCaseTest(unittest.TestCase):
    def test_a_blocked_directory_is_matched_case_insensitively(self):
        with tempfile.TemporaryDirectory(dir=os.environ.get("WISH_DEV_RUNTIME_ROOT")) as tmp:
            root = Path(tmp)
            (root / "SKILL.md").write_text(TextResourceValidationTest.HEAD,
                                           encoding="utf-8", newline="\n")
            vendored = root / "references" / "NODE_MODULES"
            vendored.mkdir(parents=True)
            (vendored / "bundled.md").write_text("# v\n", encoding="utf-8", newline="\n")
            (root / "references" / "kept.md").write_text("# k\n", encoding="utf-8", newline="\n")
            original = skill.ROOT
            skill.ROOT = root
            try:
                names = [path.relative_to(root).as_posix() for path in skill.resources()]
            finally:
                skill.ROOT = original
        self.assertEqual(sorted(names), ["SKILL.md", "references/kept.md"])


if __name__ == "__main__":
    unittest.main()
