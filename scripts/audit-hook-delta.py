#!/usr/bin/env python3
"""Before/after hook & state audit for admin-ui. Compares base ref vs HEAD per file.
Metrics: useState, useEffect, useMemo, useCallback, useRef, useReducer, hover handlers,
inline style objects, useEffect-with-setState (derived-state smell), useMemo/useCallback
with trivial deps (over-memoization), effects w/o deps array."""
import re, subprocess, sys, json
BASE = sys.argv[1] if len(sys.argv) > 1 else "origin/main"
ROOT = "apps/admin-ui/src"
def git(*a): return subprocess.run(["git", *a], capture_output=True, text=True).stdout
files = [f for f in git("diff", "--name-only", f"{BASE}...HEAD", "--", ROOT).split() if re.search(r"\.tsx?$", f) and ".test." not in f]
PATS = {
 "useState": r"\buseState\b\s*[<(]", "useEffect": r"\buseEffect\s*\(", "useMemo": r"\buseMemo\s*\(",
 "useCallback": r"\buseCallback\s*\(", "useRef": r"\buseRef\b\s*[<(]", "useReducer": r"\buseReducer\b",
 "hoverHandlers": r"onMouse(Enter|Leave)\b", "inlineStyle": r"style=\{\{", "lazy": r"\blazy\s*\(",
 "Suspense": r"<Suspense\b",
}
def count(src):
    c = {k: len(re.findall(p, src)) for k, p in PATS.items()}
    # effect that only sets state (derived-state smell)
    c["effect_setState"] = len(re.findall(r"useEffect\(\s*\(\)\s*=>\s*\{[^{}]*\bset[A-Z]\w*\([^)]*\)[^{}]*\}\s*,", src))
    c["effect_noDeps"] = len(re.findall(r"useEffect\(\s*\(\)\s*=>\s*\{(?:[^{}]|\{[^{}]*\})*\}\s*\)", src))
    c["memo_emptyDeps"] = len(re.findall(r"use(?:Memo|Callback)\([\s\S]{0,400}?,\s*\[\s*\]\s*\)", src))
    c["lines"] = src.count("\n")
    return c
tot_b, tot_a, rows = {}, {}, []
for f in files:
    before = git("show", f"{BASE}:{f}"); after = open(f).read() if __import__("os").path.exists(f) else ""
    b, a = count(before), count(after)
    for k in a: tot_b[k] = tot_b.get(k, 0) + b[k]; tot_a[k] = tot_a.get(k, 0) + a[k]
    rows.append((f.replace(ROOT + "/", ""), b, a))
keys = ["useState","useEffect","effect_setState","effect_noDeps","useMemo","useCallback","memo_emptyDeps","useRef","useReducer","hoverHandlers","inlineStyle","lazy","Suspense","lines"]
print(f"{'file':44}" + "".join(f"{k[:9]:>10}" for k in keys[:11]))
for f, b, a in rows:
    if all(b[k] == a[k] for k in keys): continue
    print(f"{f[:43]:44}" + "".join(f"{b[k]:>4}>{a[k]:<5}" for k in keys[:11]))
print("\nTOTAL (before -> after)")
for k in keys: print(f"  {k:16} {tot_b[k]:>5} -> {tot_a[k]:<5} ({tot_a[k]-tot_b[k]:+d})")
# flags: files where after has hook growth
print("\nFLAGS (hook count grew in file):")
for f, b, a in rows:
    g = {k: a[k]-b[k] for k in ("useState","useEffect","useMemo","useCallback","useRef","useReducer") if a[k] > b[k]}
    if g: print(f"  {f}: {g}")
print("\nLARGEST after (hooks total):")
for f, b, a in sorted(rows, key=lambda r: -sum(r[2][k] for k in ("useState","useEffect","useMemo","useCallback","useRef","useReducer")))[:8]:
    print(f"  {f}: " + ", ".join(f"{k}={a[k]}" for k in ("useState","useEffect","useMemo","useCallback","useRef","useReducer")))
# residual hover JS anywhere in src
print("\nRESIDUAL hover handlers in whole src (non-test):")
print(subprocess.run("grep -rnE 'onMouse(Enter|Leave)' apps/admin-ui/src --include=*.tsx | grep -v test | wc -l", shell=True, capture_output=True, text=True).stdout.strip())
