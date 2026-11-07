#!/usr/bin/env python3
"""Compare LLMs (external APIs and local Ollama models) on the CQA evaluation task.

Every model gets exactly the production prompt (backend/app/prompt.py) and response schema
(backend/app/llm.py); answers go through the same normalisation (evaluator.build_criteria),
scoring (scoring.py) and accuracy metrics (accuracy.py) as the app. Nothing is written to the app.

    # inside a python container with network access to the app and providers:
    python3 tools/model_bench.py --api http://127.0.0.1:8090 --group DEV \
        --ids p1-ru-004,p1-kz-007 --models gemini:gemini-3.8-flash,claude:claude-haiku-5-5,ollama:qwen3:14b

Results are cached in --out/<model>/<conversation>.json (re-runs skip finished pairs), and a summary
(summary.json + summary.md) is written for every model against the latest ground truth of the group.
Keys come from the environment: GEMINI_API_KEY, ANTHROPIC_API_KEY; Ollama from OLLAMA_URL.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import random
import re
import sys
import time
import urllib.request
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from app import accuracy, scoring  # noqa: E402
from app.evaluator import answers_of, build_criteria  # noqa: E402
from app.llm import RESPONSE_SCHEMA  # noqa: E402
from app.prompt import SYSTEM_PROMPT, build_user_prompt  # noqa: E402

# USD per 1M tokens (input, output incl. thinking). Sources: Gemini API pricing page and the
# Anthropic model table, checked 2026-11-07. Local models cost nothing per call.
PRICES = {
    "gemini-2.5-flash": (0.30, 2.50),
    "gemini-2.5-flash-lite": (0.10, 0.40),
    "gemini-2.5-pro": (1.25, 10.00),
    "gemini-3.5-flash-lite": (0.30, 2.50),
    "gemini-3.1-flash-lite": (0.25, 1.50),
    "gemini-3-flash-preview": (0.50, 3.00),
    "gemini-3.6-flash": (0.75, 3.75),
    "gemini-3.8-flash": (0.75, 3.75),
    "gemini-3.1-pro-preview": (2.00, 12.00),
    "gemini-4-argon": (2.00, 10.00),
    "claude-haiku-5-5": (0.10, 0.50),
    "claude-sonnet-5-5": (2.00, 10.00),
    "claude-opus-5-5": (4.00, 20.00),
}
CONCURRENCY = {"gemini": 6, "claude": 4, "claudecode": 3, "ollama": 1}
PROMPT_VERSION = hashlib.sha1((SYSTEM_PROMPT + json.dumps(RESPONSE_SCHEMA, sort_keys=True)).encode()).hexdigest()[:10]


# ------------------------------------------------------------------ schema ----
def to_json_schema(s: dict) -> dict:
    """Gemini OpenAPI-style schema -> plain JSON Schema (lowercase types, closed objects, no nullables)."""
    t = s["type"].lower()
    out: dict = {"type": t}
    if t == "object":
        out["properties"] = {k: to_json_schema(v) for k, v in s["properties"].items()}
        out["required"] = list(s.get("required", []))
        out["additionalProperties"] = False
    elif t == "array":
        out["items"] = to_json_schema(s["items"])
    return out


JSON_SCHEMA = to_json_schema(RESPONSE_SCHEMA)


def parse_json(text: str) -> dict:
    text = re.sub(r"<think>.*?</think>", "", text or "", flags=re.S).strip()
    m = re.search(r"\{.*\}", text, re.S)
    return json.loads(m.group(0) if m else text)


# --------------------------------------------------------------- providers ----
class CallError(Exception):
    pass


async def call_gemini(http: httpx.AsyncClient, model: str, user: str) -> tuple[dict, dict]:
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    body = {
        "systemInstruction": {"parts": [{"text": SYSTEM_PROMPT}]},
        "contents": [{"role": "user", "parts": [{"text": user}]}],
        "generationConfig": {"temperature": 0, "responseMimeType": "application/json",
                             "responseSchema": RESPONSE_SCHEMA},
    }
    headers = {"x-goog-api-key": os.environ["GEMINI_API_KEY"]}
    last = ""
    for attempt in range(6):
        try:
            r = await http.post(url, json=body, headers=headers, timeout=300)
        except httpx.HTTPError as e:
            last = f"network: {e}"
        else:
            if r.status_code == 200:
                data = r.json()
                try:
                    parts = data["candidates"][0]["content"]["parts"]
                    text = "".join(p.get("text", "") for p in parts if not p.get("thought"))
                    um = data.get("usageMetadata", {})
                    usage = {"input_tokens": um.get("promptTokenCount", 0),
                             "output_tokens": um.get("candidatesTokenCount", 0) + um.get("thoughtsTokenCount", 0)}
                    return parse_json(text), usage
                except (KeyError, IndexError, ValueError) as e:
                    last = f"bad response: {e}: {json.dumps(data)[:300]}"
            else:
                last = f"HTTP {r.status_code}: {r.text[:300]}"
                if r.status_code not in (429, 500, 502, 503, 504):
                    break
        await asyncio.sleep(min(2 ** attempt + random.random(), 30))
    raise CallError(last)


_anthropic = None


async def call_claude(model: str, user: str) -> tuple[dict, dict]:
    global _anthropic
    import anthropic  # imported lazily: only needed when a Claude model is benchmarked

    if _anthropic is None:
        _anthropic = anthropic.AsyncAnthropic(max_retries=6, timeout=600)
    try:
        resp = await _anthropic.messages.create(
            model=model,
            max_tokens=16000,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user}],
            # Same effort for every Claude model so the comparison is about the model, not the setting.
            output_config={"effort": "medium", "format": {"type": "json_schema", "schema": JSON_SCHEMA}},
        )
    except anthropic.RateLimitError as e:
        raise CallError(f"rate limit: {e}") from e
    except anthropic.APIStatusError as e:
        raise CallError(f"HTTP {e.status_code}: {e.message}") from e
    except anthropic.APIConnectionError as e:
        raise CallError(f"network: {e}") from e
    if resp.stop_reason == "refusal":
        raise CallError(f"refusal: {getattr(resp, 'stop_details', None)}")
    if resp.stop_reason == "max_tokens":
        raise CallError("max_tokens reached")
    text = next((b.text for b in resp.content if b.type == "text"), "")
    usage = {"input_tokens": resp.usage.input_tokens, "output_tokens": resp.usage.output_tokens}
    return parse_json(text), usage


async def call_claudecode(model: str, user: str) -> tuple[dict, dict]:
    """Claude through the signed-in Claude Code CLI (headless `claude -p`), e.g. on a Team subscription.

    For offline benchmarking only: no API key, usage counts against the subscription limits. Tools,
    MCP servers, settings and CLAUDE.md are switched off so the model sees only our prompt.
    """
    cmd = [os.environ.get("CLAUDE_BIN", "claude"), "-p", "--model", model, "--system-prompt", SYSTEM_PROMPT,
           "--json-schema", json.dumps(JSON_SCHEMA), "--tools", "", "--strict-mcp-config",
           "--setting-sources", "", "--no-session-persistence", "--effort", "medium", "--output-format", "json"]
    for attempt in range(3):
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            cwd=os.environ.get("CLAUDECODE_CWD", "/tmp"))
        out, err = await asyncio.wait_for(proc.communicate(user.encode()), timeout=900)
        try:
            data = json.loads(out)
        except ValueError:
            data = {"is_error": True, "result": (out or err).decode(errors="replace")[:300]}
        if not data.get("is_error") and isinstance(data.get("structured_output"), dict):
            u = data.get("usage") or {}
            usage = {"input_tokens": u.get("input_tokens", 0) + u.get("cache_creation_input_tokens", 0)
                     + u.get("cache_read_input_tokens", 0), "output_tokens": u.get("output_tokens", 0),
                     "api_equivalent_usd": data.get("total_cost_usd")}
            return data["structured_output"], usage
        last = str(data.get("result") or data)[:300]
        await asyncio.sleep(20 * (attempt + 1))
    raise CallError(f"claude code: {last}")


async def call_ollama(http: httpx.AsyncClient, model: str, user: str) -> tuple[dict, dict]:
    body = {
        "model": model,
        "messages": [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": user}],
        "format": JSON_SCHEMA,
        "stream": False,
        "think": False,  # thinking would multiply generation time on a T4; structured output is enforced anyway
        "options": {"temperature": 0, "num_ctx": 16384, "num_predict": 6000},
        "keep_alive": "15m",
    }
    url = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/") + "/api/chat"
    try:
        r = await http.post(url, json=body, timeout=1800)
    except httpx.HTTPError as e:
        raise CallError(f"network: {e}") from e
    if r.status_code != 200:
        # Models without a thinking switch reject "think"; retry once without it.
        if "think" in r.text.lower():
            body.pop("think")
            r = await http.post(url, json=body, timeout=1800)
        if r.status_code != 200:
            raise CallError(f"HTTP {r.status_code}: {r.text[:300]}")
    data = r.json()
    try:
        parsed = parse_json(data["message"]["content"])
    except (KeyError, ValueError) as e:
        raise CallError(f"bad JSON: {e}: {data.get('message', {}).get('content', '')[:300]}") from e
    usage = {"input_tokens": data.get("prompt_eval_count", 0), "output_tokens": data.get("eval_count", 0)}
    return parsed, usage


# --------------------------------------------------------------------- run ----
def get(api: str, path: str):
    with urllib.request.urlopen(api.rstrip("/") + path, timeout=120) as r:
        return json.load(r)


def safe(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", name)


async def run_model(spec: str, convs: list[dict], cfg: dict, out: Path, http: httpx.AsyncClient) -> None:
    provider, model = spec.split(":", 1)
    d = out / safe(spec)
    d.mkdir(parents=True, exist_ok=True)
    sem = asyncio.Semaphore(CONCURRENCY.get(provider, 2))
    done = 0

    async def one(conv: dict) -> None:
        nonlocal done
        f = d / f"{conv['id']}.json"
        if f.exists():
            prev = json.loads(f.read_text())
            if prev.get("prompt_version") == PROMPT_VERSION and prev.get("status") == "done":
                done += 1
                return
        async with sem:
            user = build_user_prompt(cfg, conv)
            t0 = time.monotonic()
            rec = {"model": spec, "conversation_id": conv["id"], "prompt_version": PROMPT_VERSION}
            try:
                if provider == "gemini":
                    parsed, usage = await call_gemini(http, model, user)
                elif provider == "claude":
                    parsed, usage = await call_claude(model, user)
                elif provider == "ollama":
                    parsed, usage = await call_ollama(http, model, user)
                elif provider == "claudecode":
                    parsed, usage = await call_claudecode(model, user)
                else:
                    raise CallError(f"unknown provider {provider}")
                crit = build_criteria(cfg, conv, parsed)
                score = scoring.compute(cfg, answers_of(crit))
                pin, pout = PRICES.get(model, (0.0, 0.0))
                rec.update(status="done", criteria=crit, total=score["total"], critical=score["critical"],
                           usage=usage, cost_usd=usage["input_tokens"] / 1e6 * pin + usage["output_tokens"] / 1e6 * pout,
                           missing=sum(1 for c in crit if c.get("warning") == "Модель не вернула ответ по критерию"))
            except (CallError, KeyError, ValueError, TypeError) as e:
                rec.update(status="error", error=str(e)[:1000])
            rec["duration_s"] = round(time.monotonic() - t0, 2)
            f.write_text(json.dumps(rec, ensure_ascii=False, indent=1))
            done += 1
            print(f"  [{spec}] {done}/{len(convs)} {conv['id']} {rec['status']} {rec['duration_s']}s"
                  + (f" {rec.get('error', '')[:120]}" if rec["status"] != "done" else f" total={rec['total']}"),
                  flush=True)

    await asyncio.gather(*(one(c) for c in convs))


def summarize(specs: list[str], convs: list[dict], cfg: dict, labels: dict, out: Path, subsets: dict) -> dict:
    by_id = {c["id"]: c for c in convs}
    report = {"prompt_version": PROMPT_VERSION, "models": []}
    for spec in specs:
        d = out / safe(spec)
        recs = [json.loads(f.read_text()) for f in sorted(d.glob("*.json"))] if d.exists() else []
        recs = [r for r in recs if r["conversation_id"] in by_id and r.get("prompt_version") == PROMPT_VERSION]
        ok = [r for r in recs if r["status"] == "done"]
        row = {"model": spec, "n": len(recs), "ok": len(ok), "errors": len(recs) - len(ok),
               "missing_answers": sum(r.get("missing", 0) for r in ok),
               "avg_cost_usd": round(sum(r["cost_usd"] for r in ok) / len(ok), 5) if ok else None,
               "avg_s": round(sum(r["duration_s"] for r in ok) / len(ok), 1) if ok else None,
               "subsets": {}}
        for name, ids in subsets.items():
            rows = [{"id": r["conversation_id"], "language": by_id[r["conversation_id"]]["language"],
                     "channel": by_id[r["conversation_id"]]["channel"], "eval_id": None,
                     "criteria": r["criteria"], "total": r["total"], "critical": r["critical"]}
                    for r in ok if r["conversation_id"] in ids]
            lab = {k: v for k, v in labels.items() if k in ids}
            if rows and lab:
                m = accuracy.compute(cfg, lab, rows)
                row["subsets"][name] = {k: m.get(k) for k in ("n_conversations", "n_answers", "accuracy", "accuracy_sure",
                                                               "mae_total", "within5", "critical_accuracy")}
                row["subsets"][name]["criteria"] = {c["criterion_id"]: c["accuracy"] for c in m["criteria"]}
                row["subsets"][name]["groups"] = {g["key"]: g["accuracy"] for g in m["groups"]}
        report["models"].append(row)
    return report


def write_md(report: dict, out: Path, subsets: list[str]) -> None:
    lines = [f"# CQA model benchmark (prompt {report['prompt_version']})", ""]
    for name in subsets:
        lines += [f"## {name}", "", "| model | dialogs | accuracy | sure | MAE total | |Δ|≤5 | critical | $/eval | s/eval |",
                  "|---|---|---|---|---|---|---|---|---|"]
        rows = [r for r in report["models"] if name in r["subsets"]]
        rows.sort(key=lambda r: -(r["subsets"][name]["accuracy"] or 0))
        for r in rows:
            s = r["subsets"][name]
            lines.append(f"| {r['model']} | {s['n_conversations']} | {s['accuracy']} | {s['accuracy_sure']} | {s['mae_total']} | "
                         f"{s['within5']} | {s['critical_accuracy']} | {r['avg_cost_usd']} | {r['avg_s']} |")
        lines.append("")
    (out / "summary.md").write_text("\n".join(lines))


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="http://127.0.0.1:8090")
    ap.add_argument("--group", default="DEV")
    ap.add_argument("--ids", help="comma-separated conversation ids (default: whole group)")
    ap.add_argument("--models", required=True, help="comma-separated provider:model specs")
    ap.add_argument("--checklist", type=int, help="checklist id (default: active)")
    ap.add_argument("--gt", help="local ground-truth JSON (default: latest version stored in the app)")
    ap.add_argument("--verified-only", action="store_true", help="add a subset of human-verified dialogs (_meta.verified)")
    ap.add_argument("--out", default="bench_results")
    ap.add_argument("--summary-only", action="store_true")
    a = ap.parse_args()

    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    cl = get(a.api, f"/api/checklists/{a.checklist}") if a.checklist else get(a.api, "/api/checklists/active")
    cfg = cl["config"]
    rows = get(a.api, f"/api/conversations?group={a.group}")
    ids = a.ids.split(",") if a.ids else [r["id"] for r in rows]
    convs = [get(a.api, f"/api/conversations/{i}") for i in ids]

    if a.gt:
        gt = json.loads(Path(a.gt).read_text())
    else:
        versions = [g for g in get(a.api, "/api/ground-truth") if g["dataset_group"] == a.group]
        latest = max(versions, key=lambda g: g["version"]) if versions else None
        gt = get(a.api, f"/api/ground-truth/{latest['id']}") if latest else {}
    labels = accuracy.labels_of(gt)
    meta = gt.get("meta") or {k: v for k, v in gt.items() if k.startswith("_")}
    verified = set(((meta.get("_meta") or meta).get("verified") or {}).keys()) if isinstance(meta, dict) else set()
    print(f"checklist v{cl['version']} · {len(convs)} dialogs · {len(labels)} labels · verified {len(verified)}"
          f" · prompt {PROMPT_VERSION}", flush=True)

    specs = [s.strip() for s in a.models.split(",") if s.strip()]
    if not a.summary_only:
        async with httpx.AsyncClient() as http:
            # Local models run one after another (one GPU); API models run concurrently with them.
            local = [s for s in specs if s.startswith("ollama:")]
            remote = [s for s in specs if not s.startswith("ollama:")]

            async def locals_seq():
                for s in local:
                    await run_model(s, convs, cfg, out, http)

            await asyncio.gather(locals_seq(), *(run_model(s, convs, cfg, out, http) for s in remote))

    subsets = {"all": {c["id"] for c in convs}}
    if verified:
        subsets["verified"] = {c["id"] for c in convs} & verified
    for lang in ("RU", "KZ", "EN"):
        subsets[lang] = {c["id"] for c in convs if c.get("language") == lang}
    report = summarize(specs, convs, cfg, labels, out, subsets)
    report.update(group=a.group, checklist_version=cl["version"], n_dialogs=len(convs), n_verified=len(verified))
    (out / "summary.json").write_text(json.dumps(report, ensure_ascii=False, indent=1))
    write_md(report, out, list(subsets))
    print((out / "summary.md").read_text())
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
