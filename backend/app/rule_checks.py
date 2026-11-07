"""Saved control examples and isolated comparisons of checklist versions."""
from __future__ import annotations

import asyncio
import json
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from . import config, db, evaluator, llm, scoring

router = APIRouter(prefix="/api/checklists")
MAX_EXAMPLES = 6
_running: set[tuple[int, str]] = set()


class RuleExampleIn(BaseModel):
    criterion_id: str = Field(min_length=1)
    conversation_id: str | None = None
    expected_answer: Any = None
    source_appeal_id: int | None = Field(default=None, gt=0)


class RuleCheckIn(BaseModel):
    baseline_id: int = Field(gt=0)
    criterion_id: str = Field(min_length=1)


async def _checklist(conn, kid: int, criterion_id: str):
    checklist = await conn.fetchrow("SELECT name, config FROM checklists WHERE id=$1", kid)
    if not checklist:
        raise HTTPException(404, "Чек-лист не найден.")
    criterion = next((c for c in checklist["config"]["criteria"] if c["id"] == criterion_id), None)
    if criterion is None:
        raise HTTPException(404, "В этой версии нет выбранного критерия.")
    return checklist, criterion


def _expected_answer(criterion: dict, value: Any):
    if not isinstance(value, (str, int, float, bool)) or not str(value).strip():
        raise HTTPException(400, "Укажите ожидаемый ответ.")
    answer, warning = scoring.normalize_answer(criterion, value)
    if warning:
        raise HTTPException(400, "Ожидаемый ответ недопустим для выбранного критерия.")
    return answer


async def _lock_examples(conn, name: str, criterion_id: str):
    # Serialize count/insert/delete and the final comparison snapshot check.
    key = json.dumps([name, criterion_id])
    await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", key)


async def _examples(conn, name: str, criterion_id: str):
    return await conn.fetch(
        """SELECT e.conversation_id, e.expected_answer, e.source_appeal_id, c.imported_at
           FROM rule_check_examples e JOIN conversations c ON c.id=e.conversation_id
           WHERE e.checklist_name=$1 AND e.criterion_id=$2
           ORDER BY e.conversation_id""", name, criterion_id)


def _example(row) -> dict:
    return {key: row[key] for key in ("conversation_id", "expected_answer", "source_appeal_id")}


def _snapshot(rows) -> list[dict]:
    return [{**_example(row), "imported_at": row["imported_at"].isoformat()} for row in rows]


@router.get("/{kid}/rule-examples")
async def list_rule_examples(kid: int, criterion_id: str):
    async with db.pool.acquire() as conn:
        checklist, _ = await _checklist(conn, kid, criterion_id)
        rows = await _examples(conn, checklist["name"], criterion_id)
    return [_example(row) for row in rows]


@router.post("/{kid}/rule-examples")
async def save_rule_example(kid: int, body: RuleExampleIn):
    async with db.pool.acquire() as conn:
        async with conn.transaction():
            checklist, criterion = await _checklist(conn, kid, body.criterion_id)
            name = checklist["name"]
            cid, value = body.conversation_id, body.expected_answer
            if body.source_appeal_id is not None:
                appeal = await conn.fetchrow(
                    """SELECT a.status, a.criterion_id, a.new_answer, a.original_answer,
                              e.conversation_id, k.name
                       FROM appeals a JOIN evaluations e ON e.id=a.evaluation_id
                       JOIN checklists k ON k.id=e.checklist_id WHERE a.id=$1""", body.source_appeal_id)
                if not appeal or appeal["status"] not in ("confirmed", "changed"):
                    raise HTTPException(400, "Сначала сохраните решение по апелляции.")
                if appeal["criterion_id"] != body.criterion_id or appeal["name"] != name:
                    raise HTTPException(400, "Апелляция относится к другому чек-листу или критерию.")
                cid = appeal["conversation_id"]
                value = appeal["new_answer"]
                if value is None and appeal["status"] == "confirmed":
                    value = appeal["original_answer"]
            if not cid or not await conn.fetchval("SELECT 1 FROM conversations WHERE id=$1", cid):
                raise HTTPException(404, "Диалог не найден.")
            answer = _expected_answer(criterion, value)
            await _lock_examples(conn, name, body.criterion_id)
            rows = await _examples(conn, name, body.criterion_id)
            if len(rows) >= MAX_EXAMPLES and all(row["conversation_id"] != cid for row in rows):
                raise HTTPException(400, f"Для одного критерия можно сохранить до {MAX_EXAMPLES} примеров.")
            saved = await conn.fetchrow(
                """INSERT INTO rule_check_examples
                       (checklist_name, criterion_id, conversation_id, expected_answer, source_appeal_id)
                   VALUES ($1,$2,$3,$4,$5)
                   ON CONFLICT (checklist_name, criterion_id, conversation_id) DO UPDATE
                   SET expected_answer=EXCLUDED.expected_answer, source_appeal_id=EXCLUDED.source_appeal_id
                   RETURNING conversation_id, expected_answer, source_appeal_id""",
                name, body.criterion_id, cid, answer, body.source_appeal_id)
    return _example(saved)


@router.delete("/{kid}/rule-examples")
async def remove_rule_example(kid: int, criterion_id: str, conversation_id: str):
    async with db.pool.acquire() as conn:
        async with conn.transaction():
            checklist, _ = await _checklist(conn, kid, criterion_id)
            await _lock_examples(conn, checklist["name"], criterion_id)
            await conn.execute(
                """DELETE FROM rule_check_examples
                   WHERE checklist_name=$1 AND criterion_id=$2 AND conversation_id=$3""",
                checklist["name"], criterion_id, conversation_id)
    return {"ok": True}


@router.get("/{kid}/rule-check")
async def get_rule_check(kid: int, criterion_id: str):
    async with db.pool.acquire() as conn:
        checklist, _ = await _checklist(conn, kid, criterion_id)
        saved = await conn.fetchrow(
            "SELECT snapshot, report FROM rule_check_reports WHERE candidate_id=$1 AND criterion_id=$2",
            kid, criterion_id)
        if saved and saved["snapshot"] == _snapshot(await _examples(conn, checklist["name"], criterion_id)):
            return saved["report"]
    return None


async def _evaluate_criterion(cfg: dict, conv: dict, criterion_id: str):
    async with evaluator.sem():
        raw, _, _ = await llm.evaluate(cfg, conv)
    answers = [row.get("answer") for row in raw["criteria"] if row["criterion_id"] == criterion_id]
    if len(answers) != 1 or answers[0] is None or not str(answers[0]).strip():
        raise ValueError("Модель не вернула однозначный ответ по критерию.")
    row = next(r for r in evaluator.build_criteria(cfg, conv, raw) if r["criterion_id"] == criterion_id)
    if row["warning"]:
        raise ValueError(row["warning"])
    return {"answer": row["answer"], "explanation": row["explanation"], "evidence": row["evidence_quotes"]}


async def _compare_example(example: dict, conv: dict, baseline: dict, candidate: dict, criterion_id: str) -> dict:
    before, after = await asyncio.gather(
        _evaluate_criterion(baseline, conv, criterion_id),
        _evaluate_criterion(candidate, conv, criterion_id),
        return_exceptions=True,
    )
    result = {"conversation_id": example["conversation_id"], "expected_answer": example["expected_answer"]}
    errors = []
    for key, label, item in (("before", "прежней версии", before), ("after", "новой версии", after)):
        if isinstance(item, BaseException):
            errors.append(label)
            item = None
        result[key] = item
    if errors:
        result["error"] = f"Не удалось получить оценку для {' и '.join(errors)}."
    return result


@router.post("/{kid}/rule-check")
async def run_rule_check(kid: int, body: RuleCheckIn):
    criterion_id = body.criterion_id
    key = (kid, criterion_id)
    if key in _running:
        raise HTTPException(409, "Проверка этого правила уже запущена.")
    _running.add(key)
    try:
        async with db.pool.acquire() as conn:
            candidate, candidate_criterion = await _checklist(conn, kid, criterion_id)
            baseline, baseline_criterion = await _checklist(conn, body.baseline_id, criterion_id)
            name = candidate["name"]
            if kid == body.baseline_id or baseline["name"] != name:
                raise HTTPException(400, "Выберите две разные версии одного чек-листа.")
            if baseline_criterion["type"] != candidate_criterion["type"]:
                raise HTTPException(400, "Выберите версии с одинаковым типом ответа по критерию.")
            examples = _snapshot(await _examples(conn, name, criterion_id))
            if not examples:
                raise HTTPException(400, "Добавьте хотя бы один контрольный пример.")
            for example in examples:
                _expected_answer(baseline_criterion, example["expected_answer"])
                _expected_answer(candidate_criterion, example["expected_answer"])
            conversations = await conn.fetch(
                """SELECT id, transcript, language, channel FROM conversations WHERE id=ANY($1::text[])""",
                [row["conversation_id"] for row in examples])
        by_id = {row["id"]: dict(row) for row in conversations}
        if len(by_id) != len(examples):
            raise HTTPException(409, "Список диалогов изменился. Запустите проверку снова.")
        results = await asyncio.gather(*(
            _compare_example(example, by_id[example["conversation_id"]], baseline["config"], candidate["config"], criterion_id)
            for example in examples
        ))
        model = config.GEMINI_MODEL if config.effective_provider() == "gemini" else "mock-heuristic"
        report = {"baseline_id": body.baseline_id, "candidate_id": kid, "model": model, "results": results}
        async with db.pool.acquire() as conn:
            async with conn.transaction():
                await _lock_examples(conn, name, criterion_id)
                if examples != _snapshot(await _examples(conn, name, criterion_id)):
                    raise HTTPException(409, "Контрольные примеры изменились. Запустите проверку снова.")
                await conn.execute(
                    """INSERT INTO rule_check_reports (candidate_id, criterion_id, snapshot, report)
                       VALUES ($1,$2,$3,$4) ON CONFLICT (candidate_id, criterion_id) DO UPDATE
                       SET snapshot=EXCLUDED.snapshot, report=EXCLUDED.report""", kid, criterion_id, examples, report)
        return report
    finally:
        _running.discard(key)
