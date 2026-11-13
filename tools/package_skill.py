#!/usr/bin/env python3
"""Validate repository skill resources and optionally build a clean portable ZIP."""
import argparse
import ast
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import zipfile
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[1]
RESOURCE_DIRS = ("references", "scripts", "assets")
# Publish boundary: only known text/asset types are packaged. Anything else inside a
# resource directory is a hard error instead of a silent drop, so a stray log, cache,
# archive or editor backup cannot ride along and cannot be forgotten quietly either.
PUBLISH_SUFFIXES = {".md", ".py", ".mjs", ".js", ".json", ".yaml", ".yml", ".txt",
                    ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico"}
BLOCKED_DIRS = {"__pycache__", "node_modules", "dist", "packages", ".git", ".venv",
                ".pytest_cache", ".ruff_cache"}
BLOCKED_SUFFIXES = {".pyc", ".pyo", ".log", ".tmp", ".temp", ".bak", ".swp", ".swo",
                    ".zip", ".tar", ".gz", ".map", ".cache", ".sqlite", ".db", ".env"}
TEXT_SUFFIXES = {".md", ".py", ".json", ".yaml", ".yml", ".txt", ".js", ".mjs", ".svg"}
# Contract anchors: the load-bearing rules a later edit must not silently drop.
# A missing anchor fails validation: a skill that silently lost a hard rule is not
# shippable, so this gates the exit code instead of only weakening a quality report.
CONTRACT_ANCHORS = {
    "SKILL.md": (r"^## 主对话边界", r"^## 交工标准", r"check-plan\.mjs", r"禁止调用\*\*任何团队",
                 r"^### 宿主每轮动作硬规则", r"^\*\*领导层执行白名单\*\*",
                 r"每任务修复预算默认 3 次", r"^\*\*指令优先级\*\*",
                 r"^\*\*上下文隔离\*\*", r"执行期静默（P0）"),
    "references/workflow.md": (r"^## 子智能体任务下发契约", r"^## 子智能体任务交付契约",
                               r"下发块用下方 12 项", r"运行模式：按宿主能力选择",
                               r"review-material\.mjs", r"^- 执行期静默：随块告知子智能体",
                               r"执行期间保持静默"),
    "references/plan-contract.md": (r"^## 账本落盘硬门禁", r"从文件开头 40 行内开始",
                                    r"起始行起的 15 行内（含起始行）齐备", r"context_id",
                                    r"^## 写入权限（三类）", r"^## 评审材料与基线"),
    "references/continuation.md": (r"对账本身保持极简",),
}


def resources():
    """Publishable resources: SKILL.md plus allowlisted files under the resource dirs.

    The boundary is name/suffix based. It keeps logs, caches, temp files and archives
    out, but it cannot recognise every credential or diagnostic blob; the manual diff
    review in README/AGENTS still applies.
    """
    result = [ROOT / "SKILL.md"]
    rejected = []
    for name in RESOURCE_DIRS:
        directory = ROOT / name
        if not directory.is_dir():
            continue
        for path in directory.rglob("*"):
            if not path.is_file():
                continue
            parts = path.relative_to(ROOT).parts
            # Directory names compare case-insensitively: the same tree arrives from hosts
            # whose filesystem (or the maintainer's hands) spells NODE_MODULES differently.
            # The filename itself is never a blocked directory: a file named like one
            # (references/dist) falls to the suffix rule below and is refused, not dropped.
            if any(part.lower() in BLOCKED_DIRS for part in parts[:-1]):
                continue
            # Hidden resource files are refused instead of dropped: a silently skipped
            # file is a file the package does not contain and nobody notices.
            if any(part.startswith(".") for part in parts):
                rejected.append(path.relative_to(ROOT).as_posix())
                continue
            suffix = path.suffix.lower()
            if suffix in BLOCKED_SUFFIXES or suffix not in PUBLISH_SUFFIXES:
                rejected.append(path.relative_to(ROOT).as_posix())
                continue
            result.append(path)
    if rejected:
        raise ValueError(
            "Refusing to package non-publishable files (logs, caches, temp files, archives "
            "and unknown types are never resources): " + ", ".join(sorted(rejected)))
    return sorted(result)


def contract_gaps():
    """Anchors (multiline regex, heading-anchored where it matters) gone from source.

    Substring presence was too weak: moving a rule elsewhere kept the gate green.
    Any gap (missing anchor, missing file, or an invalid anchor regex) now blocks the
    gate: main() exits 1, so a silently dropped hard rule cannot leave the check green."""
    gaps = []
    for name, anchors in CONTRACT_ANCHORS.items():
        path = ROOT / name
        source = path.read_text(encoding="utf-8") if path.is_file() else ""
        for anchor in anchors:
            try:
                present = re.search(anchor, source, re.M)
            except re.error as error:
                gaps.append(f"{name} 锚点正则无效「{anchor}」: {error}")
                continue
            if not present:
                gaps.append(name + ' 缺少锚点「' + anchor + '」')
    return gaps


def version_drift():
    """SKILL.md / CHANGELOG.md / README.md must advertise the same version.

    Drift is reported as WEAK, never as a non-zero exit: the gate exists to flag
    the mismatch, and a missing changelog line should not break local checks."""
    issues = []
    manifest = (ROOT / "SKILL.md").read_text(encoding="utf-8")
    front = re.match(r"\A---\r?\n(.*?)\r?\n---(?:\r?\n|$)", manifest, re.S)
    try:
        data = parse_frontmatter(front[1]) if front else {}
    except ValueError as error:
        return ["SKILL.md frontmatter invalid: " + str(error)]
    metadata = data.get("metadata")
    version = metadata.get("version") if isinstance(metadata, dict) else None
    if not isinstance(version, str):
        return ["SKILL.md version missing"]
    changelog = ROOT / "CHANGELOG.md"
    if changelog.is_file():
        heading = re.search(r"^## (\d+\.\d+\.\d+)", changelog.read_text(encoding="utf-8"), re.M)
        if not heading:
            issues.append("CHANGELOG.md 缺少 `## x.y.z` 版本标题")
        elif heading[1] != version:
            issues.append(f"CHANGELOG.md 顶部为 {heading[1]}，SKILL.md 为 {version}")
    else:
        issues.append("CHANGELOG.md 缺失")
    readme = ROOT / "README.md"
    if readme.is_file():
        # Every "current version" line is checked, not just the first one: a second
        # stale mention (install table, release note) is drift the gate must see.
        advertised = []
        for line in readme.read_text(encoding="utf-8").splitlines():
            # "当前…" and "最新…" both advertise the shipped version; a bare 最新 mention
            # used to slip past the gate because only 当前 was recognised.
            if not re.search(r"(?:当前|最新)(?:正式版|版本|发布版|发布版本)", line):
                continue
            # Only the first version on an advertised line is the claim. Later versions on
            # the same line are release history and must not read as drift.
            found = re.search(r"(?<![\d.])(\d+\.\d+\.\d+)(?![\d.])", line)
            if found:
                advertised.append(found[1])
        if not advertised:
            issues.append("README.md 未写出当前版本号")
        for found in sorted(set(advertised)):
            if found != version:
                issues.append(f"README.md 写作 {found}，SKILL.md 为 {version}")
    return issues


def skill_quality(manifest):
    """Lightweight, non-blocking quality read (completeness/examples/conciseness/
    crossPlatform/license/contracts/versions). Mirrors a _scores.json style report
    without the A/B impact harness: it only reports, never gates the exit code."""
    lines = manifest.count("\n") + 1
    examples = len(re.findall(r"(?m)^[~`]{3,}", manifest)) // 2
    desc = re.search(r"^description:\s*(.+)$", manifest, re.M)
    desc_chars = len(desc[1]) if desc else 0
    dims, issues = {}, []
    dims["completeness"] = "PASS" if lines >= 40 else "WEAK"
    if dims["completeness"] == "WEAK":
        issues.append({"severity": "MEDIUM", "category": "completeness",
                       "detail": f"SKILL.md only {lines} lines; expected a full flow"})
    dims["examples"] = "PASS" if examples >= 1 else "WEAK"
    if dims["examples"] == "WEAK":
        issues.append({"severity": "MEDIUM", "category": "examples",
                       "detail": "no fenced example block found in SKILL.md"})
    if desc_chars == 0:
        dims["conciseness"] = "WEAK"
        issues.append({"severity": "HIGH", "category": "conciseness",
                      "detail": "frontmatter description missing"})
    elif desc_chars > 200:
        dims["conciseness"] = "WEAK"
        issues.append({"severity": "LOW", "category": "conciseness",
                       "detail": f"description is {desc_chars} chars; keep it scannable (<200)"})
    else:
        dims["conciseness"] = "PASS"
    dims["crossPlatform"] = "PASS" if re.search(r"(?m)^compatibility:", manifest) else "WEAK"
    dims["license"] = "PASS" if re.search(r"(?m)^license:", manifest) else "WEAK"
    gaps = contract_gaps()
    dims["contracts"] = "PASS" if not gaps else "WEAK"
    if gaps:
        issues.append({"severity": "HIGH", "category": "contracts",
                       "detail": "; ".join(gaps)})
    drift = version_drift()
    dims["versions"] = "PASS" if not drift else "WEAK"
    if drift:
        issues.append({"severity": "MEDIUM", "category": "versions",
                       "detail": "; ".join(drift)})
    weak = [k for k, v in dims.items() if v == "WEAK"]
    verdict = "PASS" if not weak else f"{len(weak)} WEAK dimension(s)"
    return {"lines": lines, "example_blocks": examples, "description_chars": desc_chars,
            "dimensions": dims, "contract_gaps": gaps, "version_drift": drift,
            "verdict": verdict, "issues": issues}


def js_syntax(path):
    """Syntax-check a JS/ESM resource with `node --check`.

    Returns True when checked, False when Node is unavailable (check skipped
    and reported, so --check stays usable without Node); a real syntax error
    raises and blocks the exit code, like the ast.parse check for .py.
    """
    node = shutil.which("node")
    if node is None:
        return False
    try:
        proc = subprocess.run([node, "--check", str(path)],
                              capture_output=True, text=True, timeout=30)
    except subprocess.TimeoutExpired:
        raise ValueError("JS syntax check timed out in " + str(path))
    if proc.returncode != 0:
        lines = [l for l in (proc.stderr or proc.stdout).splitlines() if l.strip()]
        summary = next((l for l in lines if "Error" in l), lines[0] if lines else "")
        raise ValueError("JS syntax error in " + str(path) + " (node --check): " + summary)
    return True


class Scalar(str):
    """A frontmatter scalar that remembers whether the source value was quoted."""

    def __new__(cls, value, quoted):
        scalar = str.__new__(cls, value)
        scalar.quoted = quoted
        return scalar


# Plain values YAML would type as null/bool/number. String fields must be quoted so the
# validator and the host agree on the type instead of silently disagreeing.
TYPED_PLAIN = re.compile(
    r"^(?:~|null|Null|NULL|true|True|TRUE|false|False|FALSE|yes|Yes|YES|no|No|NO"
    r"|on|On|ON|off|Off|OFF|[-+]?(?:0|[1-9][0-9_]*)(?:\.[0-9_]*)?(?:[eE][-+]?[0-9]+)?"
    r"|0x[0-9a-fA-F_]+|0o[0-7_]+|[-+]?\.(?:inf|Inf|INF|nan|NaN|NAN))$")

DOUBLE_QUOTE_ESCAPES = {
    "\\": "\\",
    '"': '"',
    "/": "/",
    "n": "\n",
    "t": "\t",
    "r": "\r",
    "b": "\b",
    "f": "\f",
}


def _double_quoted(body, number):
    out = []
    index = 0
    while index < len(body):
        char = body[index]
        if char == '"':
            raise ValueError(f"frontmatter line {number}: unescaped double quote inside a quoted value")
        if char == "\\":
            if index + 1 >= len(body):
                raise ValueError(f"frontmatter line {number}: value ends with a dangling escape")
            nxt = body[index + 1]
            if nxt not in DOUBLE_QUOTE_ESCAPES:
                raise ValueError(f"frontmatter line {number}: unsupported escape \\{nxt}")
            out.append(DOUBLE_QUOTE_ESCAPES[nxt])
            index += 2
            continue
        out.append(char)
        index += 1
    return Scalar("".join(out), True)


def _single_quoted(body, number):
    out = []
    index = 0
    while index < len(body):
        if body[index] == "'":
            if index + 1 < len(body) and body[index + 1] == "'":
                out.append("'")
                index += 2
                continue
            raise ValueError(f"frontmatter line {number}: unescaped single quote inside a quoted value")
        out.append(body[index])
        index += 1
    return Scalar("".join(out), True)


def _frontmatter_scalar(value, number):
    if value.startswith('"'):
        if len(value) < 2 or not value.endswith('"'):
            raise ValueError(f"frontmatter line {number}: unterminated double-quoted value")
        return _double_quoted(value[1:-1], number)
    if value.startswith("'"):
        if len(value) < 2 or not value.endswith("'"):
            raise ValueError(f"frontmatter line {number}: unterminated single-quoted value")
        return _single_quoted(value[1:-1], number)
    first = value[0]
    if first in "[{|>&*!@%`":
        raise ValueError(
            f"frontmatter line {number}: unsupported YAML syntax {first!r}; "
            "only plain or quoted single-line scalars are supported")
    if first in "-?:" or first == "#":
        raise ValueError(
            f"frontmatter line {number}: a plain scalar cannot start with {first!r}; quote the value")
    if ": " in value or value.endswith(":"):
        raise ValueError(
            f"frontmatter line {number}: an unquoted ': ' is ambiguous in YAML; quote the value")
    if " #" in value:
        raise ValueError(f"frontmatter line {number}: inline comments are not supported")
    if TYPED_PLAIN.match(value):
        raise ValueError(
            f"frontmatter line {number}: {value!r} would be read as a non-string YAML type; quote it")
    return Scalar(value, False)


def parse_frontmatter(body):
    """Parse the minimal YAML subset this repository's SKILL.md uses.

    Supported: top-level `key: value`, one nested block under a top-level key indented by
    two spaces, blank lines and full-line `#` comments, plain or quoted single-line
    scalars. Rejected on purpose (no third-party dependency, and accepting input this
    parser cannot verify would be worse than refusing it): tabs, deeper nesting,
    sequences, flow collections, anchors/aliases, block scalars, unclosed quoting,
    inline comments and duplicate keys.
    """
    data = {}
    parent_key = None
    for number, raw in enumerate(body.split("\n"), 1):
        if "\t" in raw:
            raise ValueError(f"frontmatter line {number}: tabs are not supported")
        line = raw.rstrip()
        if not line.strip() or line.strip().startswith("#"):
            continue
        indent = len(line) - len(line.lstrip(" "))
        if indent not in (0, 2):
            raise ValueError("frontmatter line "
                             f"{number}: only a top level and one 2-space nested block are supported")
        key, separator, value = line.strip().partition(":")
        key = key.strip()
        value = value.strip()
        if not separator or not re.fullmatch(r"[A-Za-z0-9_-]+", key):
            raise ValueError(f"frontmatter line {number}: expected `key: value`")
        if indent == 0:
            if key in data:
                raise ValueError(f"frontmatter line {number}: duplicate key {key!r}")
            if value:
                data[key] = _frontmatter_scalar(value, number)
                parent_key = None
            else:
                data[key] = {}
                parent_key = key
            continue
        if parent_key is None:
            raise ValueError(f"frontmatter line {number}: nested key {key!r} has no parent mapping")
        if not value:
            raise ValueError(f"frontmatter line {number}: nesting deeper than one level is not supported")
        block = data[parent_key]
        if key in block:
            raise ValueError(f"frontmatter line {number}: duplicate key {parent_key}.{key}")
        block[key] = _frontmatter_scalar(value, number)
    return data


def masked_markdown(source):
    """Blank comments, fenced/indented blocks and inline code before checking links.

    Examples inside a fence and references inside an invisible comment are not links the
    package must contain; requiring them made a documented sample fail the gate."""
    def blank(match):
        return re.sub(r"[^\n]", " ", match.group(0))
    source = re.sub(r"<!--[\s\S]*?-->", blank, source)
    lines = source.split("\n")
    fence, paragraph, indented = None, False, False
    for index, line in enumerate(lines):
        marker = re.match(r"^ {0,3}(`{3,}|~{3,})(.*)$", line)
        if fence is not None:
            # A closer has only whitespace after a same-character, long-enough run.
            if (marker and marker[1][0] == fence[0] and len(marker[1]) >= len(fence)
                    and not marker[2].strip(" \t")):
                fence = None
            lines[index] = " " * len(line)
            paragraph = False
        elif not line.strip():
            paragraph = False
        elif len(line.expandtabs(4)) - len(line.expandtabs(4).lstrip(" ")) >= 4 and (
                indented or not paragraph):
            # Indented code cannot interrupt a paragraph, unlike fenced code.
            lines[index] = " " * len(line)
            indented = True
        elif marker and (marker[1][0] != "`" or "`" not in marker[2]):
            fence = marker[1]
            lines[index] = " " * len(line)
            paragraph, indented = False, False
        else:
            paragraph, indented = True, False
    source = "\n".join(lines)
    # Exact-length backtick runs delimit inline code; escaped openers stay prose.
    index = 0
    while index < len(source):
        escaped = _markdown_escape(source, index)
        if escaped:
            _, index = escaped
            continue
        if source[index] == "`":
            run = re.match(r"`+", source[index:])[0]
            # Inline spans cannot cross blank lines or a new Markdown block.
            rest = source[index + len(run):]
            boundary = re.search(
                r"\n[ \t]*\n|\n(?= {0,3}(?:#{1,6}(?:[ \t]|$)|>|[-+*][ \t]|1[.)][ \t]"
                r"|[-=]+[ \t]*(?:\n|$)|(?:-[ \t]*){3,}(?:\n|$)"
                r"|(?:\*[ \t]*){3,}(?:\n|$)|(?:_[ \t]*){3,}(?:\n|$)))",
                rest)
            if boundary:
                rest = rest[:boundary.start()]
            end = re.search(r"(?<!`)" + run + r"(?!`)", rest)
            if end:
                stop = index + len(run) + end.end()
                source = (source[:index] + re.sub(r"[^\n]", " ", source[index:stop])
                          + source[stop:])
                index = stop
                continue
            index += len(run)
            continue
        index += 1
    return source


MARKDOWN_PUNCTUATION = r"!\"#$%&'()*+,-./:;<=>?@[\]^_`{|}~"


def _markdown_escape(source, index):
    """Return an escaped ASCII punctuation character and the next offset, if any."""
    if (source[index] == "\\" and index + 1 < len(source)
            and source[index + 1] in MARKDOWN_PUNCTUATION):
        return source[index + 1], index + 2
    return None


def _link_space(source, index):
    start = index
    while index < len(source) and source[index] in " \t\n":
        index += 1
    if source[start:index].count("\n") > 1:
        raise ValueError("blank lines in link targets are unsupported")
    return index


def _link_destination(source, index):
    """Scan an angle destination whole, or a bare destination with balanced parens."""
    angle = index < len(source) and source[index] == "<"
    if angle:
        index += 1
    out, depth = [], 0
    while index < len(source):
        escaped = _markdown_escape(source, index)
        if escaped:
            char, index = escaped
            out.append(char)
            continue
        char = source[index]
        if angle:
            if char == ">":
                return "".join(out), index + 1
            if char in "<\n\r":
                raise ValueError("unclosed or nested angle destination")
        else:
            if char in " \t\n" or (char == ")" and depth == 0):
                break
            if ord(char) < 32 or ord(char) == 127:
                raise ValueError("control character in link destination")
            if char == "(":
                depth += 1
            elif char == ")":
                depth -= 1
        out.append(char)
        index += 1
    if angle or depth:
        raise ValueError("unclosed angle destination or unbalanced parentheses")
    return "".join(out), index


def _inline_link(source, opening):
    """Parse destination plus an optional OUTSIDE title, returning the closing offset."""
    index = _link_space(source, opening + 1)
    target, index = _link_destination(source, index)
    destination_end = index
    index = _link_space(source, index)
    if index < len(source) and source[index] != ")":
        if index == destination_end or source[index] not in "\"'(":
            raise ValueError("expected whitespace-separated quoted or parenthesized title")
        opener = source[index]
        closer = ")" if opener == "(" else opener
        index += 1
        while index < len(source):
            escaped = _markdown_escape(source, index)
            if escaped:
                _, index = escaped
                continue
            if source[index] == closer:
                break
            if opener == "(" and source[index] == "(":
                raise ValueError("unescaped parenthesis in link title")
            if source[index] == "\n":
                # A title may wrap, but never cross a blank line.
                index = _link_space(source, index)
                continue
            index += 1
        else:
            raise ValueError("unclosed link title")
        index = _link_space(source, index + 1)
    if index >= len(source) or source[index] != ")":
        raise ValueError("unclosed inline link")
    return target, source[opening + 1:index].strip(), index + 1


def markdown_links(source):
    """Yield (destination, original target, example) for inline links/images.

    This is a deliberately small scanner, not a full Markdown renderer. Reference
    definitions and explicit full/collapsed uses are refused in prose; a standalone
    [label] without a definition remains ordinary text. Code/comments retain the
    historical count-only-if-packaged policy. Escaped openers are not links.
    """
    masked = masked_markdown(source)
    stack, index = [], 0
    while index < len(source):
        escaped = _markdown_escape(source, index)
        if escaped:
            _, index = escaped
            continue
        char = source[index]
        if char == "[":
            stack.append(index)
        elif char == "]" and stack:
            start = stack.pop()
            example = masked[start] == " "
            nxt = source[index + 1:index + 2]
            line_start = source.rfind("\n", 0, start) + 1
            definition = nxt == ":" and re.fullmatch(r" {0,3}", source[line_start:start])
            if nxt == "[" or definition:
                if not example:
                    raise ValueError("Unsupported reference-style link; use an inline destination")
            elif nxt == "(":
                try:
                    target, raw, end = _inline_link(source, index + 1)
                except ValueError as error:
                    if not example:
                        raise ValueError("Malformed Markdown link: " + str(error)) from error
                else:
                    yield target, raw, example
                    index = end
                    continue
        index += 1


def validate(files):
    manifest = (ROOT / "SKILL.md").read_text(encoding="utf-8")
    front = re.match(r"\A---\r?\n(.*?)\r?\n---(?:\r?\n|$)", manifest, re.S)
    if not front:
        raise ValueError("SKILL.md must begin with closed YAML frontmatter")
    data = parse_frontmatter(front[1])
    name = data.get("name")
    if (not isinstance(name, str) or len(name) > 64
            or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", name)):
        raise ValueError("Invalid skill name")
    if "version" in data:
        raise ValueError("version must be nested under metadata, not a top-level key")
    metadata = data.get("metadata")
    if not isinstance(metadata, dict):
        raise ValueError("metadata must be a mapping containing version")
    version = metadata.get("version")
    if not isinstance(version, str) or not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise ValueError('Expected metadata.version in x.y.z format, e.g. version: "1.0.0"')
    if not getattr(version, "quoted", False):
        raise ValueError('metadata.version must be quoted, e.g. version: "1.0.0"')
    description = data.get("description")
    if not isinstance(description, str) or not 1 <= len(description) <= 1024:
        raise ValueError("Invalid skill description")
    for key in ("license", "compatibility"):
        if key in data and not isinstance(data[key], str):
            raise ValueError(f"{key} must be a top-level single-line value")
    packaged = {p.resolve() for p in files}
    link_count = 0
    js_checked = js_skipped = 0
    for path in files:
        if not path.resolve().is_relative_to(ROOT.resolve()):
            raise ValueError("Resource leaves repository: " + str(path))
        suffix = path.suffix.lower()
        if suffix in TEXT_SUFFIXES:
            source = path.read_bytes()
            if b"\r\n" in source:
                raise ValueError("CRLF line endings in " + str(path) + "; convert to LF")
            source = source.decode("utf-8")
            if "\ufffd" in source:
                raise ValueError("Unicode replacement character in " + str(path))
            if suffix == ".py":
                ast.parse(source, filename=str(path))
            if suffix in {".js", ".mjs"}:
                if js_syntax(path):
                    js_checked += 1
                else:
                    js_skipped += 1
            if suffix == ".md":
                # Comments and fenced blocks may hold examples with deliberately broken
                # links: there a reference is counted when it resolves to a packaged file
                # and never reported missing. Prose links are checked strictly.
                for target, raw_target, example in markdown_links(source):
                    # Classify URI syntax before decoding. An encoded # belongs to the
                    # filename; an encoded scheme must never bypass local containment.
                    if target.startswith("#") or re.match(r"[A-Za-z][A-Za-z0-9+.-]*:", target):
                        continue
                    target = target.split("#", 1)[0]
                    if not target:
                        continue
                    try:
                        target = unquote(target, encoding="utf-8", errors="strict")
                        resolved = (path.parent / target).resolve()
                    except (ValueError, OSError) as error:
                        if example:
                            continue
                        raise ValueError("Invalid link destination: " + raw_target) from error
                    detail = "{} (original link target: {})".format(target, raw_target)
                    if not resolved.is_relative_to(ROOT.resolve()):
                        if example:
                            continue
                        raise ValueError("Reference leaves skill: " + detail)
                    if resolved not in packaged:
                        if example:
                            continue
                        raise ValueError("Missing packaged reference: " + detail)
                    link_count += 1
    return {"name": str(name), "version": str(version),
            "file_count": len(files), "internal_links_checked": link_count,
            "js_syntax_checked": js_checked, "js_syntax_skipped": js_skipped,
            "skill_quality": skill_quality(manifest)}


def package(files, metadata, output):
    output = output.expanduser().resolve()
    if output in {p.resolve() for p in files} or output.suffix.lower() != ".zip":
        raise ValueError("Output must be a .zip outside skill resources")
    if any(output.is_relative_to((ROOT / d).resolve()) for d in RESOURCE_DIRS):
        raise ValueError("Do not write archives inside resource directories")
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in files:
            archive.write(path, metadata["name"] + "/" + path.relative_to(ROOT).as_posix())
    with zipfile.ZipFile(output) as archive:
        if archive.testzip() is not None:
            raise ValueError("ZIP CRC verification failed")
        for path in files:
            member = metadata["name"] + "/" + path.relative_to(ROOT).as_posix()
            if archive.read(member) != path.read_bytes():
                raise ValueError("ZIP member differs from source: " + member)
    # Emit the release triple next to the archive: zip + manifest.json + .sha256.
    # Only file names are reported, so a manifest shipped as a public asset never
    # leaks the maintainer's machine layout.
    archive_name = output.name
    sha256 = hashlib.sha256(output.read_bytes()).hexdigest()
    checksum = output.with_name(archive_name + ".sha256")
    checksum.write_text(f"{sha256}  {archive_name}\n", encoding="utf-8", newline="\n")
    manifest = output.with_name(output.stem + ".manifest.json")
    manifest.write_text(json.dumps({
        "name": metadata["name"],
        "version": metadata["version"],
        "archive": archive_name,
        "bytes": output.stat().st_size,
        "sha256": sha256,
        "files": [metadata["name"] + "/" + path.relative_to(ROOT).as_posix()
                  for path in files],
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    return {"archive": archive_name, "bytes": output.stat().st_size, "sha256": sha256,
            "manifest": manifest.name, "checksum": checksum.name}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Validate without building")
    parser.add_argument("--output", type=Path, default=None,
                        help="ZIP path; defaults to packages/wish-dev-<version>.zip")
    args = parser.parse_args()
    try:
        files = resources()
        result = validate(files)
        # Contract anchors gate the exit code: a silently dropped hard rule must stop the
        # check and the package, not merely weaken a quality dimension.
        gaps = result["skill_quality"]["contract_gaps"]
        if gaps:
            raise ValueError("契约锚点缺失（契约硬规则被删改）：" + "; ".join(gaps))
        if not args.check:
            target = args.output or ROOT / "packages" / ("wish-dev-" + result["version"] + ".zip")
            result.update(package(files, result, target))
        print(json.dumps(result, ensure_ascii=True, indent=2))
        return 0
    except (OSError, ValueError, SyntaxError, zipfile.BadZipFile, re.error) as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
