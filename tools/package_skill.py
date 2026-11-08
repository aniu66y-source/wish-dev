#!/usr/bin/env python3
"""Validate repository skill resources and optionally build a clean portable ZIP."""
import argparse
import ast
import hashlib
import json
from pathlib import Path
import re
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]
RESOURCE_DIRS = ("references", "scripts", "assets")
EXCLUDED = {"__pycache__"}
TEXT_SUFFIXES = {".md", ".py", ".json", ".yaml", ".yml", ".txt", ".js", ".mjs"}


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


def skill_quality(manifest):
    """Lightweight, non-blocking quality read on SKILL.md (completeness/examples/
    conciseness/crossPlatform/license). Mirrors a _scores.json style report
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
    weak = [k for k, v in dims.items() if v == "WEAK"]
    verdict = "PASS" if not weak else f"{len(weak)} WEAK dimension(s)"
    return {"lines": lines, "example_blocks": examples, "description_chars": desc_chars,
            "dimensions": dims, "verdict": verdict, "issues": issues}


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
    for path in files:
        if not path.resolve().is_relative_to(ROOT.resolve()):
            raise ValueError("Resource leaves repository: " + str(path))
        if path.suffix in TEXT_SUFFIXES:
            source = path.read_text(encoding="utf-8")
            if "\ufffd" in source:
                raise ValueError("Unicode replacement character in " + str(path))
            if path.suffix == ".py":
                ast.parse(source, filename=str(path))
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
    return {"archive": str(output), "bytes": output.stat().st_size,
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
    except (OSError, ValueError, SyntaxError, zipfile.BadZipFile) as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
