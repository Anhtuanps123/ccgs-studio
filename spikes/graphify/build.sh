#!/usr/bin/env bash
# Spike (graphify Bước 0): build the code graph of a Unity project OUTSIDE the project.
# - GRAPHIFY_OUT points under ~/.ccgs-studio/projects/<id>/graphify (absolute path).
# - Exclusions go into <out>/.graphify_build.json ("excludes"), which `graphify update`
#   re-applies (graphify 0.9.103 has no --exclude on `update`); nothing is written to the project.
# - GRAPHIFY_BACKEND=none: no LLM. Only `graphify update` (tree-sitter), never `extract`.
# Usage: build.sh <project> <out-dir> <excludes-json-array> [update args...]
set -u
PROJECT="$1"; OUT="$2"; EXCLUDES="$3"; shift 3
mkdir -p "$OUT"
printf '{"excludes": %s, "gitignore": true, "code_only": true}' "$EXCLUDES" > "$OUT/.graphify_build.json"
export GRAPHIFY_OUT="$OUT" GRAPHIFY_BACKEND=none GRAPHIFY_QUERY_LOG_DISABLE=1 GRAPHIFY_NO_TIPS=1 PYTHONIOENCODING=utf-8
cd "$(dirname "$OUT")"   # never run graphify with the project as cwd
start=$(date +%s%N)
graphify update "$PROJECT" "$@"
code=$?
end=$(date +%s%N)
echo "exit=$code ms=$(( (end - start) / 1000000 ))"
