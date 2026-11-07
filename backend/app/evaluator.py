from __future__ import annotations

import asyncio
import time

from . import config, db, llm, scoring, version


def _cost(usage: dict) -> float:
    return round(usage.get("input_tokens", 0) / 1e6 * config.PRICE_INPUT_PER_M
                 + usage.get("output_tokens", 0) / 1e6 * config.PRICE_OUTPUT_PER_M, 6)


def build_criteria(cfg: dict, conv: dict, model_out: dict) -> list[dict]:
    """Merge raw model output with checklist config; validate answers and evidence."""
    n = len(conv["transcript"])
    by_id = {str(x.get("criterion_id")): x for x in model_out.get("criteria") or []}
    rows = []
    for c in cfg["criteria"]:
        x = by_id.get(c["id"], {})
        answer, warn = scoring.normalize_answer(c, x.get("answer"))
        if not x:
            warn = "Модель не вернула ответ по критерию"
        ev = sorted({int(i) for i in (x.get("evidence") or []) if isinstance(i, (int, float)) and 1 <= int(i) <= n})
        cf, ct = x.get("checked_from"), x.get("checked_to")
        checked = None
        if isinstance(cf, int) and isinstance(ct, int) and 1 <= cf <= n:
            checked = [cf, max(cf, min(ct, n))]
        rows.append({
            "criterion_id": c["id"],
            "answer": answer,
            "explanation": x.get("explanation") or "",
            "analysis": x.get("analysis") or "",
            "evidence": ev,
            "checked_range": checked,
            "na_reason": x.get("na_reason") if answer == scoring.NA else None,
            "warning": warn,
        })
    return rows


def answers_of(criteria: list[dict]) -> dict:
    return {r["criterion_id"]: r["answer"] for r in criteria}


async def run(evaluation_id: int) -> None:
    async with db.pool.acquire() as conn:
        ev = await conn.fetchrow("SELECT * FROM evaluations WHERE id=$1", evaluation_id)
        conv = db.rec(await conn.fetchrow("SELECT * FROM conversations WHERE id=$1", ev["conversation_id"]))
        cl = await conn.fetchrow("SELECT * FROM checklists WHERE id=$1", ev["checklist_id"])
        await conn.execute("UPDATE evaluations SET status='running' WHERE id=$1", evaluation_id)
    cfg = cl["config"]
    t0 = time.monotonic()
    try:
        out, usage, model = await llm.evaluate(cfg, conv)
        criteria = build_criteria(cfg, conv, out)
        score = scoring.compute(cfg, answers_of(criteria))
    except Exception as e:  # noqa: BLE001 — surfaced to the UI
        async with db.pool.acquire() as conn:
            await conn.execute(
                "UPDATE evaluations SET status='error', error=$2, finished_at=now(), duration_ms=$3 WHERE id=$1",
                evaluation_id, str(e)[:2000], int((time.monotonic() - t0) * 1000))
        return
    async with db.pool.acquire() as conn:
        await conn.execute(
            """UPDATE evaluations SET status='done', provider=$2, model=$3, criteria=$4, score=$5, total=$6,
                   critical=$7, final_criteria=$4, final_score=$5, final_total=$6, summary=$8, usage=$9,
                   cost_usd=$10, duration_ms=$11, finished_at=now(), error=NULL, pipeline=$12
               WHERE id=$1""",
            evaluation_id, config.effective_provider(), model, criteria, score, score["total"],
            score["critical"], out.get("summary") or "", usage, _cost(usage),
            int((time.monotonic() - t0) * 1000), version.pipeline())


async def create(conversation_id: str, checklist_id: int, batch_id: int | None = None) -> int:
    async with db.pool.acquire() as conn:
        return await conn.fetchval(
            "INSERT INTO evaluations (conversation_id, checklist_id, batch_id) VALUES ($1,$2,$3) RETURNING id",
            conversation_id, checklist_id, batch_id)


_sem: asyncio.Semaphore | None = None


def sem() -> asyncio.Semaphore:
    global _sem
    if _sem is None:
        _sem = asyncio.Semaphore(config.BATCH_CONCURRENCY)
    return _sem


async def run_batch(batch_id: int, eval_ids: list[int]) -> None:
    async def one(eid: int):
        async with sem():
            await run(eid)
        async with db.pool.acquire() as conn:
            st = await conn.fetchval("SELECT status FROM evaluations WHERE id=$1", eid)
            col = "done" if st == "done" else "failed"
            await conn.execute(f"UPDATE batches SET {col}={col}+1 WHERE id=$1", batch_id)

    await asyncio.gather(*(one(e) for e in eval_ids))
    async with db.pool.acquire() as conn:
        await conn.execute("UPDATE batches SET status='finished', finished_at=now() WHERE id=$1", batch_id)


def recompute_final(cfg: dict, final_criteria: list[dict]) -> dict:
    return scoring.compute(cfg, answers_of(final_criteria))
