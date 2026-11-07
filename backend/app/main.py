from __future__ import annotations

import asyncio
import csv
import io
import json
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import config, dataset, db, evaluator, scoring

_bg: set[asyncio.Task] = set()


def spawn(coro) -> None:
    t = asyncio.create_task(coro)
    _bg.add(t)
    t.add_done_callback(_bg.discard)


@asynccontextmanager
async def lifespan(_: FastAPI):
    await db.connect()
    # Evaluations interrupted by a restart are marked as errors so they can be re-run.
    async with db.pool.acquire() as conn:
        await conn.execute("UPDATE evaluations SET status='error', error='interrupted by restart' "
                           "WHERE status IN ('pending','running')")
        await conn.execute("UPDATE batches SET status='finished', finished_at=now() WHERE status='running'")
    yield
    await db.close()


app = FastAPI(title="CQA — Conversation Quality Analytics", lifespan=lifespan)


@app.exception_handler(dataset.DatasetError)
async def _dataset_err(_: Request, e: dataset.DatasetError):
    return JSONResponse({"detail": str(e)}, status_code=400)


def not_found(what: str):
    raise HTTPException(404, f"{what} не найден")


# ------------------------------------------------------------------ meta ----
@app.get("/api/health")
async def health():
    async with db.pool.acquire() as conn:
        await conn.fetchval("SELECT 1")
    return {"ok": True}


def user_email(request: Request) -> str | None:
    """Signed-in user from the Google gate. nginx overwrites X-Auth-Email, so it cannot be forged from outside."""
    return (request.headers.get("x-auth-email") or "").strip() or None


@app.get("/api/me")
async def me(request: Request):
    return {"email": user_email(request)}


@app.get("/api/meta")
async def meta():
    return {
        "provider": config.effective_provider(),
        "model": config.GEMINI_MODEL if config.effective_provider() == "gemini" else "mock-heuristic",
        "dataset_api_configured": bool(config.DATASET_API_URL),
        "price_input_per_m": config.PRICE_INPUT_PER_M,
        "price_output_per_m": config.PRICE_OUTPUT_PER_M,
    }


# --------------------------------------------------------------- datasets ----
class ImportReq(BaseModel):
    group_id: str = Field(min_length=1)
    api_url: str | None = None


async def upsert(group: str, records: list[dict]) -> int:
    async with db.pool.acquire() as conn:
        async with conn.transaction():
            for r in records:
                await conn.execute(
                    """INSERT INTO conversations (id, dataset_group, channel, language, transcript, audio_url, raw)
                       VALUES ($1,$2,$3,$4,$5,$6,$7)
                       ON CONFLICT (id) DO UPDATE SET dataset_group=EXCLUDED.dataset_group, channel=EXCLUDED.channel,
                         language=EXCLUDED.language, transcript=EXCLUDED.transcript, audio_url=EXCLUDED.audio_url,
                         raw=EXCLUDED.raw, imported_at=now()""",
                    r["id"], group, r["channel"], r["language"], r["transcript"], r["audio_url"], r["raw"])
    return len(records)


@app.post("/api/datasets/import")
async def import_group(req: ImportReq):
    group, records = await dataset.fetch_group(req.group_id.strip(), req.api_url)
    n = await upsert(group, records)
    return {"group": group, "imported": n}


@app.post("/api/datasets/upload")
async def upload(request: Request, group: str | None = None):
    try:
        payload = json.loads(await request.body())
    except ValueError:
        raise HTTPException(400, "Файл не является корректным JSON")
    g, records = dataset.extract_records(payload, default_group=group or "UPLOAD")
    if group:
        g = group
    n = await upsert(g, records)
    return {"group": g, "imported": n}


@app.get("/api/groups")
async def groups():
    async with db.pool.acquire() as conn:
        rows = await conn.fetch("SELECT dataset_group AS id, count(*) AS count FROM conversations "
                                "GROUP BY 1 ORDER BY max(imported_at) DESC")
    return db.recs(rows)


# ----------------------------------------------------------- conversations ----
@app.get("/api/conversations")
async def list_conversations(group: str | None = None, checklist_id: int | None = None):
    async with db.pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT c.id, c.dataset_group, c.channel, c.language, c.audio_url,
                      jsonb_array_length(c.transcript) AS messages,
                      e.id AS eval_id, e.status, e.total, e.final_total, e.critical, e.checklist_id,
                      e.final_score->>'critical' AS final_critical, e.error,
                      (SELECT count(*) FROM appeals a WHERE a.evaluation_id=e.id AND a.status='open') AS open_appeals,
                      (SELECT count(*) FROM appeals a WHERE a.evaluation_id=e.id) AS appeals
               FROM conversations c
               LEFT JOIN LATERAL (
                   SELECT * FROM evaluations e WHERE e.conversation_id=c.id
                     AND ($2::int IS NULL OR e.checklist_id=$2) ORDER BY e.id DESC LIMIT 1) e ON true
               WHERE ($1::text IS NULL OR c.dataset_group=$1)
               ORDER BY c.id""", group, checklist_id)
    return db.recs(rows)


@app.get("/api/conversations/{cid}")
async def get_conversation(cid: str):
    async with db.pool.acquire() as conn:
        c = await conn.fetchrow("SELECT id, dataset_group, channel, language, transcript, audio_url, imported_at "
                                "FROM conversations WHERE id=$1", cid)
        if not c:
            not_found("Диалог")
        evs = await conn.fetch(
            """SELECT e.id, e.checklist_id, k.name AS checklist_name, k.version AS checklist_version, e.status,
                      e.total, e.final_total, e.critical, e.model, e.created_at, e.error
               FROM evaluations e JOIN checklists k ON k.id=e.checklist_id
               WHERE e.conversation_id=$1 ORDER BY e.id DESC""", cid)
    return {**db.rec(c), "evaluations": db.recs(evs)}


# -------------------------------------------------------------- checklists ----
class ChecklistIn(BaseModel):
    config: dict[str, Any]
    note: str | None = None
    activate: bool = True


def validate_checklist(cfg: dict) -> dict:
    if not cfg.get("name"):
        raise HTTPException(400, "Укажите название чек-листа")
    crits = cfg.get("criteria")
    if not isinstance(crits, list) or not crits:
        raise HTTPException(400, "Нужен хотя бы один критерий")
    ids = set()
    sections = {s["id"] for s in cfg.get("sections") or []}
    for c in crits:
        if not c.get("id") or c["id"] in ids:
            raise HTTPException(400, f"Пустой или повторяющийся id критерия: {c.get('id')!r}")
        ids.add(c["id"])
        if not c.get("title"):
            raise HTTPException(400, f"Критерий {c['id']}: нет названия")
        if c.get("type") not in ("binary", "scale", "critical"):
            raise HTTPException(400, f"Критерий {c['id']}: неизвестный тип {c.get('type')!r}")
        c["weight"] = 0 if c["type"] == "critical" else float(c.get("weight") or 0)
        if c["weight"] < 0:
            raise HTTPException(400, f"Критерий {c['id']}: вес не может быть отрицательным")
        c["na_allowed"] = bool(c.get("na_allowed"))
        if c["type"] == "scale":
            sc = c.get("scale") or []
            try:
                vals = [float(s["value"]) for s in sc]
            except (KeyError, TypeError, ValueError):
                raise HTTPException(400, f"Критерий {c['id']}: некорректная шкала")
            if len(vals) < 2 or len(set(vals)) != len(vals) or max(vals) <= 0:
                raise HTTPException(400, f"Критерий {c['id']}: шкала должна иметь ≥2 разных ступеней и максимум > 0")
            c["scale"] = sorted(({"value": float(s["value"]) if float(s["value"]) % 1 else int(float(s["value"])),
                                  "description": s.get("description", "")} for s in sc), key=lambda s: -s["value"])
        else:
            c.pop("scale", None)
        if sections and c.get("section") and c["section"] not in sections:
            raise HTTPException(400, f"Критерий {c['id']}: неизвестная секция {c['section']!r}")
    cfg["rounding"] = int(cfg.get("rounding", 2))
    return cfg


@app.get("/api/checklists")
async def list_checklists():
    async with db.pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT k.id, k.name, k.version, k.is_active, k.note, k.created_at,
                      jsonb_array_length(k.config->'criteria') AS criteria_count,
                      (SELECT count(*) FROM evaluations e WHERE e.checklist_id=k.id) AS evaluations
               FROM checklists k ORDER BY k.id DESC""")
    return db.recs(rows)


@app.get("/api/checklists/active")
async def active_checklist():
    async with db.pool.acquire() as conn:
        r = await conn.fetchrow("SELECT * FROM checklists WHERE is_active ORDER BY id DESC LIMIT 1")
    return db.rec(r) or not_found("Активный чек-лист")


@app.get("/api/checklists/{kid}")
async def get_checklist(kid: int):
    async with db.pool.acquire() as conn:
        r = await conn.fetchrow("SELECT * FROM checklists WHERE id=$1", kid)
    return db.rec(r) or not_found("Чек-лист")


@app.post("/api/checklists")
async def save_checklist(body: ChecklistIn):
    cfg = validate_checklist(body.config)
    async with db.pool.acquire() as conn:
        async with conn.transaction():
            ver = await conn.fetchval("SELECT coalesce(max(version),0)+1 FROM checklists WHERE name=$1", cfg["name"])
            if body.activate:
                await conn.execute("UPDATE checklists SET is_active=false")
            r = await conn.fetchrow(
                "INSERT INTO checklists (name, version, config, is_active, note) VALUES ($1,$2,$3,$4,$5) RETURNING *",
                cfg["name"], ver, cfg, body.activate, body.note)
    return db.rec(r)


@app.post("/api/checklists/{kid}/activate")
async def activate_checklist(kid: int):
    async with db.pool.acquire() as conn:
        async with conn.transaction():
            if not await conn.fetchval("SELECT 1 FROM checklists WHERE id=$1", kid):
                not_found("Чек-лист")
            await conn.execute("UPDATE checklists SET is_active=(id=$1)", kid)
    return {"ok": True}


# ------------------------------------------------------------- evaluations ----
class EvalReq(BaseModel):
    conversation_id: str
    checklist_id: int | None = None


async def resolve_checklist(conn, kid: int | None) -> int:
    if kid:
        if not await conn.fetchval("SELECT 1 FROM checklists WHERE id=$1", kid):
            not_found("Чек-лист")
        return kid
    kid = await conn.fetchval("SELECT id FROM checklists WHERE is_active ORDER BY id DESC LIMIT 1")
    if not kid:
        not_found("Активный чек-лист")
    return kid


@app.post("/api/evaluations")
async def create_evaluation(req: EvalReq):
    async with db.pool.acquire() as conn:
        if not await conn.fetchval("SELECT 1 FROM conversations WHERE id=$1", req.conversation_id):
            not_found("Диалог")
        kid = await resolve_checklist(conn, req.checklist_id)
    eid = await evaluator.create(req.conversation_id, kid)
    async with evaluator.sem():
        await evaluator.run(eid)
    return await get_evaluation(eid)


@app.get("/api/evaluations/{eid}")
async def get_evaluation(eid: int):
    async with db.pool.acquire() as conn:
        e = await conn.fetchrow(
            """SELECT e.*, k.name AS checklist_name, k.version AS checklist_version, k.config AS checklist
               FROM evaluations e JOIN checklists k ON k.id=e.checklist_id WHERE e.id=$1""", eid)
        if not e:
            not_found("Оценка")
        appeals = await conn.fetch("SELECT * FROM appeals WHERE evaluation_id=$1 ORDER BY id", eid)
    return {**db.rec(e), "appeals": db.recs(appeals)}


class BatchReq(BaseModel):
    group: str | None = None
    checklist_id: int | None = None
    conversation_ids: list[str] | None = None
    only_missing: bool = True


@app.post("/api/batches")
async def create_batch(req: BatchReq):
    async with db.pool.acquire() as conn:
        kid = await resolve_checklist(conn, req.checklist_id)
        ids = await conn.fetch(
            """SELECT c.id FROM conversations c
               WHERE ($1::text IS NULL OR c.dataset_group=$1)
                 AND ($2::text[] IS NULL OR c.id = ANY($2))
                 AND (NOT $3 OR NOT EXISTS (SELECT 1 FROM evaluations e WHERE e.conversation_id=c.id
                                            AND e.checklist_id=$4 AND e.status IN ('done','running','pending')))
               ORDER BY c.id""", req.group, req.conversation_ids, req.only_missing, kid)
        ids = [r["id"] for r in ids]
        bid = await conn.fetchval("INSERT INTO batches (dataset_group, checklist_id, total) VALUES ($1,$2,$3) RETURNING id",
                                  req.group, kid, len(ids))
    eids = [await evaluator.create(cid, kid, bid) for cid in ids]
    if eids:
        spawn(evaluator.run_batch(bid, eids))
    else:
        async with db.pool.acquire() as conn:
            await conn.execute("UPDATE batches SET status='finished', finished_at=now() WHERE id=$1", bid)
    return await get_batch(bid)


@app.get("/api/batches")
async def list_batches():
    async with db.pool.acquire() as conn:
        return db.recs(await conn.fetch("SELECT * FROM batches ORDER BY id DESC LIMIT 20"))


@app.get("/api/batches/{bid}")
async def get_batch(bid: int):
    async with db.pool.acquire() as conn:
        b = await conn.fetchrow(
            """SELECT b.*, (SELECT coalesce(sum(cost_usd),0) FROM evaluations e WHERE e.batch_id=b.id) AS cost_usd
               FROM batches b WHERE b.id=$1""", bid)
    return db.rec(b) or not_found("Пакет")


# ----------------------------------------------------------------- appeals ----
class AppealIn(BaseModel):
    evaluation_id: int
    criterion_id: str
    comment: str = Field(min_length=1)
    author: str | None = None


class DecisionIn(BaseModel):
    decision: str  # confirm | change
    new_answer: Any = None
    reason: str = Field(min_length=1)
    reviewer: str | None = None


@app.post("/api/appeals")
async def create_appeal(body: AppealIn, request: Request):
    author = user_email(request) or body.author
    async with db.pool.acquire() as conn:
        e = await conn.fetchrow("SELECT * FROM evaluations WHERE id=$1", body.evaluation_id)
        if not e or e["status"] != "done":
            raise HTTPException(400, "Оценка не найдена или не завершена")
        crit = next((c for c in e["final_criteria"] if c["criterion_id"] == body.criterion_id), None)
        if not crit:
            not_found("Критерий")
        if await conn.fetchval("SELECT 1 FROM appeals WHERE evaluation_id=$1 AND criterion_id=$2 AND status='open'",
                               body.evaluation_id, body.criterion_id):
            raise HTTPException(400, "По этому критерию уже есть открытая апелляция")
        r = await conn.fetchrow(
            """INSERT INTO appeals (evaluation_id, criterion_id, comment, author, original_answer, total_before)
               VALUES ($1,$2,$3,$4,$5,$6) RETURNING *""",
            body.evaluation_id, body.criterion_id, body.comment, author, crit["answer"], e["final_total"])
    return db.rec(r)


@app.get("/api/appeals")
async def list_appeals(status: str | None = None):
    async with db.pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT a.*, e.conversation_id, c.language, c.channel, k.config->'criteria' AS criteria
               FROM appeals a JOIN evaluations e ON e.id=a.evaluation_id
               JOIN conversations c ON c.id=e.conversation_id JOIN checklists k ON k.id=e.checklist_id
               WHERE ($1::text IS NULL OR ($1='open' AND a.status='open') OR ($1='resolved' AND a.status<>'open'))
               ORDER BY (a.status='open') DESC, a.id DESC""", status)
    out = []
    for r in db.recs(rows):
        crit = next((c for c in r.pop("criteria") or [] if c["id"] == r["criterion_id"]), {})
        out.append({**r, "criterion_title": crit.get("title"), "criterion_code": crit.get("code")})
    return out


@app.get("/api/appeals/{aid}")
async def get_appeal(aid: int):
    async with db.pool.acquire() as conn:
        a = await conn.fetchrow("SELECT * FROM appeals WHERE id=$1", aid)
        if not a:
            not_found("Апелляция")
    ev = await get_evaluation(a["evaluation_id"])
    async with db.pool.acquire() as conn:
        conv = await conn.fetchrow("SELECT id, channel, language, transcript, audio_url FROM conversations WHERE id=$1",
                                   ev["conversation_id"])
    return {"appeal": db.rec(a), "evaluation": ev, "conversation": db.rec(conv)}


@app.post("/api/appeals/{aid}/decision")
async def decide_appeal(aid: int, body: DecisionIn, request: Request):
    reviewer = user_email(request) or body.reviewer
    if body.decision not in ("confirm", "change"):
        raise HTTPException(400, "decision: confirm | change")
    async with db.pool.acquire() as conn:
        async with conn.transaction():
            a = await conn.fetchrow("SELECT * FROM appeals WHERE id=$1 FOR UPDATE", aid)
            if not a:
                not_found("Апелляция")
            if a["status"] != "open":
                raise HTTPException(400, "Апелляция уже рассмотрена")
            e = await conn.fetchrow(
                "SELECT e.*, k.config AS cfg FROM evaluations e JOIN checklists k ON k.id=e.checklist_id "
                "WHERE e.id=$1 FOR UPDATE OF e", a["evaluation_id"])
            cfg = e["cfg"]
            crit_cfg = next(c for c in cfg["criteria"] if c["id"] == a["criterion_id"])
            final = e["final_criteria"]
            row = next(r for r in final if r["criterion_id"] == a["criterion_id"])
            new_answer = row["answer"]
            if body.decision == "change":
                new_answer, warn = scoring.normalize_answer(crit_cfg, body.new_answer)
                if warn:
                    raise HTTPException(400, f"Некорректный новый ответ: {warn}")
                row["review"] = {"from": row["answer"], "to": new_answer, "reason": body.reason,
                                 "appeal_id": aid, "reviewer": reviewer}
                row["answer"] = new_answer
            else:
                row["review"] = {"confirmed": True, "reason": body.reason, "appeal_id": aid, "reviewer": reviewer}
            score = evaluator.recompute_final(cfg, final)
            await conn.execute("UPDATE evaluations SET final_criteria=$2, final_score=$3, final_total=$4 WHERE id=$1",
                               e["id"], final, score, score["total"])
            r = await conn.fetchrow(
                """UPDATE appeals SET status=$2, new_answer=$3, reason=$4, reviewer=$5, total_after=$6, resolved_at=now()
                   WHERE id=$1 RETURNING *""",
                aid, "changed" if body.decision == "change" else "confirmed", new_answer, body.reason,
                reviewer, score["total"])
    return db.rec(r)


# --------------------------------------------------------- stats & export ----
@app.get("/api/stats")
async def stats(group: str | None = None, checklist_id: int | None = None):
    async with db.pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT DISTINCT ON (e.conversation_id) e.conversation_id, c.language, c.channel, e.final_total,
                      (e.final_score->>'critical')::boolean AS critical, e.final_criteria, e.cost_usd, e.usage,
                      e.duration_ms, e.checklist_id
               FROM evaluations e JOIN conversations c ON c.id=e.conversation_id
               WHERE e.status='done' AND ($1::text IS NULL OR c.dataset_group=$1)
                 AND ($2::int IS NULL OR e.checklist_id=$2)
               ORDER BY e.conversation_id, e.id DESC""", group, checklist_id)
        appeals = await conn.fetchrow(
            "SELECT count(*) FILTER (WHERE status='open') AS open, count(*) FILTER (WHERE status='changed') AS changed,"
            " count(*) FILTER (WHERE status='confirmed') AS confirmed FROM appeals")
    rows = db.recs(rows)
    totals = [float(r["final_total"]) for r in rows if r["final_total"] is not None]

    def avg(xs):
        return round(sum(xs) / len(xs), 2) if xs else None

    by_lang: dict[str, list[float]] = {}
    for r in rows:
        if r["final_total"] is not None:
            by_lang.setdefault(r["language"] or "?", []).append(float(r["final_total"]))
    crit: dict[str, dict[str, int]] = {}
    for r in rows:
        for c in r["final_criteria"] or []:
            a = c["answer"]
            k = "na" if a == "na" else ("yes" if a == "yes" else ("no" if a == "no" else "scale"))
            d = crit.setdefault(c["criterion_id"], {"yes": 0, "no": 0, "na": 0, "scale": 0, "scale_sum": 0})
            d[k] += 1
            if k == "scale":
                d["scale_sum"] += float(a)
    costs = [float(r["cost_usd"]) for r in rows if r["cost_usd"] is not None]
    hist = [0] * 10
    for t in totals:
        hist[min(int(t // 10), 9)] += 1
    return {
        "evaluated": len(rows),
        "avg_total": avg(totals),
        "critical": sum(1 for r in rows if r["critical"]),
        "by_language": {k: {"n": len(v), "avg": avg(v)} for k, v in sorted(by_lang.items())},
        "criteria": crit,
        "histogram": hist,
        "avg_cost_usd": round(sum(costs) / len(costs), 5) if costs else None,
        "avg_duration_ms": avg([r["duration_ms"] for r in rows if r["duration_ms"]]),
        "appeals": db.rec(appeals),
    }


@app.get("/api/export.csv")
async def export_csv(group: str | None = None, checklist_id: int | None = None):
    async with db.pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT DISTINCT ON (e.conversation_id) e.conversation_id, c.dataset_group, c.language, c.channel,
                      e.id AS evaluation_id, e.checklist_id, e.total, e.final_total,
                      (e.final_score->>'critical') AS critical, e.final_criteria
               FROM evaluations e JOIN conversations c ON c.id=e.conversation_id
               WHERE e.status='done' AND ($1::text IS NULL OR c.dataset_group=$1)
                 AND ($2::int IS NULL OR e.checklist_id=$2)
               ORDER BY e.conversation_id, e.id DESC""", group, checklist_id)
    crit_ids: list[str] = []
    for r in rows:
        for c in r["final_criteria"] or []:
            if c["criterion_id"] not in crit_ids:
                crit_ids.append(c["criterion_id"])
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["conversation_id", "group", "language", "channel", "evaluation_id", "checklist_id",
                "total_original", "total_final", "critical", *crit_ids])
    for r in rows:
        ans = {c["criterion_id"]: c["answer"] for c in r["final_criteria"] or []}
        w.writerow([r["conversation_id"], r["dataset_group"], r["language"], r["channel"], r["evaluation_id"],
                    r["checklist_id"], r["total"], r["final_total"], r["critical"], *[ans.get(i, "") for i in crit_ids]])
    return Response(buf.getvalue(), media_type="text/csv; charset=utf-8",
                    headers={"content-disposition": "attachment; filename=cqa_results.csv"})


# ---------------------------------------------------------------- frontend ----
FRONTEND = Path(__file__).resolve().parent.parent / "frontend"
if FRONTEND.exists():
    app.mount("/static", StaticFiles(directory=FRONTEND), name="static")

    @app.get("/")
    async def index():
        return FileResponse(FRONTEND / "index.html", headers={"cache-control": "no-cache"})
