"""Spike: summarize a graphify graph.json — node/edge counts, source files by directory, relations."""
import collections
import json
import sys

g = json.load(open(sys.argv[1], encoding="utf-8"))
nodes, links = g["nodes"], g["links"]
print("built_at_commit", g.get("built_at_commit"))
print("nodes", len(nodes), "edges", len(links))
files = {n.get("source_file") for n in nodes if n.get("source_file")}
print("source files", len(files))
by_dir = collections.Counter()
by_ext = collections.Counter()
for f in files:
    parts = f.replace("\\", "/").split("/")
    top = "/".join(parts[:2]) if parts[0] in ("Assets",) else parts[0]
    if len(parts) > 2 and parts[0] == "Assets" and parts[1].startswith("_D2M"):
        top = "/".join(parts[:3])
    by_dir[top] += 1
    by_ext[f.rsplit(".", 1)[-1].lower()] += 1
print("\nfiles by directory:")
for k, v in by_dir.most_common(40):
    print(f"  {v:5} {k}")
print("\nfiles by extension:", by_ext.most_common(12))
rel = collections.Counter(l.get("relation") for l in links)
print("\nrelations:", rel.most_common(15))
conf = collections.Counter(l.get("confidence") for l in links)
print("confidence:", conf.most_common())
