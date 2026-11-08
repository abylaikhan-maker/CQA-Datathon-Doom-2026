"""Load demo appeals (samples/demo_appeals.json) into a running CQA instance through its API.

Each appeal is filed against the latest evaluation of the conversation with the given checklist,
then decided (change / confirm) unless marked "open". Changed decisions are also saved as control
examples for «Проверка правила». Already appealed criteria are skipped, so the script can be re-run.

usage: python tools/load_demo_appeals.py http://127.0.0.1:8090 [checklist_id] [appeals.json]
"""
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

BASE = sys.argv[1].rstrip("/")
DEFAULT = Path(__file__).resolve().parent.parent / "samples" / "demo_appeals.json"
DATA = json.loads(Path(sys.argv[3] if len(sys.argv) > 3 else DEFAULT).read_text())


def call(method, path, body=None):
    req = urllib.request.Request(BASE + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read() or "null")
    except urllib.error.HTTPError as e:
        raise SystemExit(f"{method} {path}: {e.code} {e.read().decode()[:300]}")


kid = int(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2] else next(c["id"] for c in call("GET", "/api/checklists") if c["is_active"])
made = []
for a in DATA["appeals"]:
    conv = call("GET", f"/api/conversations/{a['conversation_id']}")
    ev = next((e for e in conv["evaluations"] if e["checklist_id"] == kid and e["status"] == "done"), None)
    if not ev:
        print("skip (no evaluation):", a["conversation_id"]); continue
    full = call("GET", f"/api/evaluations/{ev['id']}")
    if any(x["criterion_id"] == a["criterion_id"] for x in full["appeals"]):
        print("skip (already appealed):", a["conversation_id"], a["criterion_id"]); continue
    ap = call("POST", "/api/appeals", {"evaluation_id": ev["id"], "criterion_id": a["criterion_id"],
                                       "comment": a["comment"], "author": DATA["author"]})
    status = "open"
    if not a.get("open"):
        body = {"decision": a["decision"], "reason": a["reason"], "reviewer": DATA["reviewer"]}
        if a["decision"] == "change":
            body["new_answer"] = a["new_answer"]
        status = call("POST", f"/api/appeals/{ap['id']}/decision", body)["status"]
        if a["decision"] == "change":
            call("POST", f"/api/checklists/{kid}/rule-examples", {
                "criterion_id": a["criterion_id"], "conversation_id": a["conversation_id"],
                "expected_answer": a["new_answer"], "source_appeal_id": ap["id"]})
    made.append((ap["id"], a["conversation_id"], a["criterion_id"], status))
    print(f"#{ap['id']} {a['conversation_id']} {a['criterion_id']}: {status}")
print(f"done: {len(made)} appeals")
