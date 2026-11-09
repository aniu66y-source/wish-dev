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

ROOT = Path(__file__).resolve().parents[1]
RESOURCE_DIRS = ("references", "scripts", "assets")
EXCLUDED = {"__pycache__"}
TEXT_SUFFIXES = {".md", ".py", ".json", ".yaml", ".yml", ".txt", ".js", ".mjs"}
# Contract anchors: the load-bearing rules a later edit must not silently drop.
# Missing anchors are reported as WEAK, never as a non-zero exit.
CONTRACT_ANCHORS = {
    "SKILL.md": (r"^## 主对话边界", r"^## 交工标准", r"check-plan\.mjs", r"TeamCreate"),
    "references/workflow.md": (r"^## 子智能体任务下发契约", r"^## 子智能体任务交付契约",
                               r"下发块用下方 12 项", r"run_in_background"),
    "references/plan-contract.md": (r"^## 账本落盘硬门禁", r"context_id"),
}


def resources():
    result = [ROOT / "SKILL.md"]
    for name in RESOURCE_DIRS:
        directory = ROOT / name
        if directory.is_dir():
            result.extend(p for p in directory.rglob("*")
                          if p.is_file() and not any(
                              part.startswith(".") or part in EXCLUDED
                              for part in p.relative_to(ROOT).parts)
                          and p.suffix not in {".pyc", ".pyo"})
    return sorted(result)


def contract_gaps():
    """Anchors (multiline regex, heading-anchored where it matters) gone from source.

    Substring presence was too weak: moving a rule elsewhere kept the gate green.
    A regex miss still only reports WEAK and never changes the exit code."""
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
    match = re.search(r'^  version:\s*"(\d+\.\d+\.\d+)"\s*$', manifest, re.M)
    if not match:
        return ["SKILL.md version missing"]
    version = match[1]
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
        advertised = re.search(r"\*\*(\d+\.\d+\.\d+)\*\*", readme.read_text(encoding="utf-8"))
        if not advertised:
            issues.append("README.md 未写出当前版本号")
        elif advertised[1] != version:
            issues.append(f"README.md 写作 {advertised[1]}，SKILL.md 为 {version}")
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
    dims["crossPlatform"] = "PASS" if re.search(r"(?m)^\s*compatibility:", manifest) else "WEAK"
    dims["license"] = "PASS" if re.search(r"(?m)^\s*license:", manifest) else "WEAK"
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


def validate(files):
    manifest = (ROOT / "SKILL.md").read_text(encoding="utf-8")
    front = re.match(r"\A---\r?\n(.*?)\r?\n---(?:\r?\n|$)", manifest, re.S)
    if not front:
        raise ValueError("SKILL.md must begin with closed YAML frontmatter")
    # Validate this repository's simple single-line metadata, not arbitrary YAML.
    name_match = re.search(r"^name:\s*([a-z0-9]+(?:-[a-z0-9]+)*)\s*$",
                           front[1], re.M)
    version_match = re.search(r'^  version:\s*"(\d+\.\d+\.\d+)"\s*$',
                              front[1], re.M)
    description_match = re.search(r"^description:\s*(.+)$", front[1], re.M)
    if not name_match or len(name_match[1]) > 64:
        raise ValueError("Invalid skill name")
    if not version_match:
        raise ValueError("Expected quoted metadata.version in x.y.z format")
    if not description_match or not 1 <= len(description_match[1]) <= 1024:
        raise ValueError("Invalid skill description")
    packaged = {p.resolve() for p in files}
    link_count = 0
    js_checked = js_skipped = 0
    for path in files:
        if not path.resolve().is_relative_to(ROOT.resolve()):
            raise ValueError("Resource leaves repository: " + str(path))
        if path.suffix in TEXT_SUFFIXES:
            source = path.read_text(encoding="utf-8")
            if "\ufffd" in source:
                raise ValueError("Unicode replacement character in " + str(path))
            if path.suffix == ".py":
                ast.parse(source, filename=str(path))
            if path.suffix in {".js", ".mjs"}:
                if js_syntax(path):
                    js_checked += 1
                else:
                    js_skipped += 1
            if path.suffix == ".md":
                for target in re.findall(r"\]\(([^)]+)\)", source):
                    if "://" in target or target.startswith("#"):
                        continue
                    target = target.split("#", 1)[0]
                    resolved = (path.parent / target).resolve()
                    if not resolved.is_relative_to(ROOT.resolve()):
                        raise ValueError("Reference leaves skill: " + target)
                    if resolved not in packaged:
                        raise ValueError("Missing packaged reference: " + target)
                    link_count += 1
    return {"name": name_match[1], "version": version_match[1],
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
    # Report only the file name: the manifest ships as a public release asset,
    # so a resolved local path would leak the maintainer's machine layout.
    return {"archive": output.name, "bytes": output.stat().st_size,
            "sha256": hashlib.sha256(output.read_bytes()).hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Validate without building")
    parser.add_argument("--output", type=Path, default=ROOT / "packages/wish-dev.zip")
    args = parser.parse_args()
    try:
        files = resources()
        result = validate(files)
        if not args.check:
            result.update(package(files, result, args.output))
        print(json.dumps(result, ensure_ascii=True, indent=2))
        return 0
    except (OSError, ValueError, SyntaxError, zipfile.BadZipFile, re.error) as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
