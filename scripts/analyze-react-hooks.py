#!/usr/bin/env python3
"""
React Hook Analyzer & State Architecture Assessment Tool
---------------------------------------------------------
Author: OpenWind Architectural Audit
Purpose:
  1. Scan all files in the repository for React hooks (useState, useRef, useEffect, etc.).
  2. Detect state management anti-patterns (form explosion, raw server state, prop-to-state sync, etc.).
  3. Generate statistics and categorize files by refactoring priority.
  4. Produce a detailed diagnostic report in JSON and Markdown formats.
"""

import os
import re
import json
import argparse
from pathlib import Path
from collections import defaultdict
from typing import Dict, List, Any, Optional

# Directories to skip
IGNORE_DIRS = {
    "node_modules",
    ".git",
    "dist",
    "build",
    ".turbo",
    ".next",
    "coverage",
    ".cache",
    ".system_generated",
}

# File extensions to scan
EXTENSIONS = {".tsx", ".jsx", ".ts", ".js"}

# Regex patterns
HOOK_CALL_PATTERN = re.compile(r"\b(use[A-Z][a-zA-Z0-9_]*)\s*(?:<[^;()]*>)?\s*\(")
USE_STATE_VAR_PATTERN = re.compile(
    r"(?:const|let)\s*\[\s*([a-zA-Z0-9_]+)\s*,\s*([a-zA-Z0-9_]+)\s*\]\s*=\s*useState"
)
USE_REF_VAR_PATTERN = re.compile(
    r"(?:const|let)\s*([a-zA-Z0-9_]+)\s*=\s*useRef"
)

# Anti-pattern detection regexes
FETCH_PATTERN = re.compile(r"\b(fetchWithAuth|fetch|axios)\b")
MODAL_STATE_PATTERN = re.compile(r"\b(show[A-Z]\w*|modalOpen|[a-zA-Z0-9_]*Modal|[a-zA-Z0-9_]*Open|confirm[A-Z]\w*)\b")

def is_test_file(path: str) -> bool:
    return any(p in path for p in [".test.", ".spec.", "__tests__", "testing-library"])

def detect_anti_patterns(content: str, state_vars: List[str], hook_counts: Dict[str, int]) -> List[str]:
    patterns = []
    
    # 1. Raw Server State via useState + useEffect
    has_fetch = bool(FETCH_PATTERN.search(content))
    server_flags = [v for v in state_vars if v.lower() in ("loading", "error", "saving", "submitting", "refreshing", "data")]
    if has_fetch and len(server_flags) >= 2:
        patterns.append(f"Raw Server State ({len(server_flags)} flags: {', '.join(server_flags[:4])})")

    # 2. Form State Explosion
    form_like_vars = [v for v in state_vars if any(k in v.lower() for k in ("name", "title", "desc", "email", "input", "value", "form", "date", "text", "query", "team", "role", "type", "scope"))]
    if len(form_like_vars) >= 5:
        patterns.append(f"Form Field Explosion ({len(form_like_vars)} scalar states)")

    # 3. Modal / Dialog Sprawl in Parent
    modal_vars = [v for v in state_vars if MODAL_STATE_PATTERN.search(v)]
    if len(modal_vars) >= 3:
        patterns.append(f"Modal Sprawl ({len(modal_vars)} dialog states)")

    # 4. Filter / Search Sprawl
    filter_vars = [v for v in state_vars if "filter" in v.lower() or "search" in v.lower() or "sort" in v.lower()]
    if len(filter_vars) >= 3:
        patterns.append(f"Filter/Search Sprawl ({len(filter_vars)} filter states)")

    # 5. Heavy useState Reliance vs Few Derived States
    use_state_c = hook_counts.get("useState", 0)
    use_memo_c = hook_counts.get("useMemo", 0)
    if use_state_c >= 10 and use_memo_c <= 1:
        patterns.append(f"Over-reliance on useState vs Derived State ({use_state_c} states vs {use_memo_c} memos)")

    # 6. Monolithic Hook Count (>30 hooks)
    total_h = sum(hook_counts.values())
    if total_h >= 30:
        patterns.append(f"God Component ({total_h} total hooks)")

    return patterns

def analyze_file(filepath: Path) -> Optional[Dict[str, Any]]:
    try:
        content = filepath.read_text(encoding="utf-8", errors="ignore")
    except Exception:
        return None

    if "use" not in content:
        return None

    lines = content.splitlines()
    line_count = len(lines)

    # Clean single-line and multi-line comments for hook counting
    clean_lines = []
    in_block = False
    for line in lines:
        stripped = line.strip()
        if in_block:
            if "*/" in stripped:
                in_block = False
            continue
        if stripped.startswith("/*"):
            if "*/" not in stripped:
                in_block = True
            continue
        if stripped.startswith("//"):
            continue
        clean_lines.append(line)

    clean_content = "\n".join(clean_lines)

    hook_matches = HOOK_CALL_PATTERN.findall(clean_content)
    if not hook_matches:
        return None

    hook_counts = defaultdict(int)
    for hook in hook_matches:
        hook_counts[hook] += 1

    state_vars = []
    for match in USE_STATE_VAR_PATTERN.finditer(clean_content):
        state_vars.append(match.group(1))

    ref_vars = []
    for match in USE_REF_VAR_PATTERN.finditer(clean_content):
        ref_vars.append(match.group(1))

    total_hooks = sum(hook_counts.values())
    anti_patterns = detect_anti_patterns(content, state_vars, hook_counts)

    # Calculate refactor urgency score (0 - 100)
    urgency_score = min(100, (
        hook_counts.get("useState", 0) * 1.5 +
        hook_counts.get("useEffect", 0) * 2.0 +
        hook_counts.get("useRef", 0) * 1.0 +
        (line_count / 100) * 1.2 +
        len(anti_patterns) * 8
    ))

    return {
        "path": str(filepath),
        "lines": line_count,
        "is_test": is_test_file(str(filepath)),
        "total_hooks": total_hooks,
        "use_state_count": hook_counts.get("useState", 0),
        "use_ref_count": hook_counts.get("useRef", 0),
        "use_effect_count": hook_counts.get("useEffect", 0),
        "use_memo_count": hook_counts.get("useMemo", 0),
        "use_callback_count": hook_counts.get("useCallback", 0),
        "use_reducer_count": hook_counts.get("useReducer", 0),
        "use_context_count": hook_counts.get("useContext", 0),
        "all_hooks": dict(sorted(hook_counts.items(), key=lambda x: x[1], reverse=True)),
        "state_variables": state_vars,
        "ref_variables": ref_vars,
        "anti_patterns": anti_patterns,
        "urgency_score": round(urgency_score, 1),
    }

def scan_directory(root_dir: Path) -> List[Dict[str, Any]]:
    results = []
    for root, dirs, files in os.walk(root_dir):
        dirs[:] = [d for d in dirs if d not in IGNORE_DIRS]
        for file in files:
            p = Path(root) / file
            if p.suffix in EXTENSIONS:
                data = analyze_file(p)
                if data and data["total_hooks"] > 0:
                    results.append(data)
    return results

def main():
    parser = argparse.ArgumentParser(description="Analyze React Hook usage in OpenWind")
    parser.add_argument("--top", type=int, default=20, help="Number of top files to display in console")
    args = parser.parse_args()

    root_dir = Path(__file__).resolve().parent.parent
    print(f"Scanning codebase for React hooks on current branch at: {root_dir}")
    results = scan_directory(root_dir)

    prod_files = sorted(
        [r for r in results if not r["is_test"]],
        key=lambda x: (x["use_state_count"] + x["use_ref_count"], x["total_hooks"]),
        reverse=True
    )
    test_files = [r for r in results if r["is_test"]]

    total_hooks = sum(f["total_hooks"] for f in prod_files)
    total_state = sum(f["use_state_count"] for f in prod_files)
    total_ref = sum(f["use_ref_count"] for f in prod_files)
    total_effect = sum(f["use_effect_count"] for f in prod_files)

    print(f"\n[Analysis Complete]")
    print(f"Total production files with hooks: {len(prod_files)}")
    print(f"Total production hooks: {total_hooks}")
    print(f"  useState: {total_state} ({total_state/total_hooks*100:.1f}%)")
    print(f"  useEffect: {total_effect} ({total_effect/total_hooks*100:.1f}%)")
    print(f"  useRef: {total_ref} ({total_ref/total_hooks*100:.1f}%)")

    print("\n" + "="*80)
    print("TOP FILES WITH EXCESSIVE HOOKS ON CURRENT BRANCH:")
    print("="*80)
    for i, f in enumerate(prod_files[:args.top], 1):
        rel_path = os.path.relpath(f['path'], root_dir)
        print(f"{i:2d}. {rel_path} ({f['lines']} lines) - useState: {f['use_state_count']}, useRef: {f['use_ref_count']}, useEffect: {f['use_effect_count']} | Total: {f['total_hooks']}")

if __name__ == "__main__":
    main()
