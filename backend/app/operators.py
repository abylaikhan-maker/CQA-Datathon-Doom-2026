"""Who handled a conversation and when.

The organizer records carry neither an operator nor a date, so both are derived:
- operator: an explicit field of the source record (operator, agent, …) if present,
  otherwise the name the operator introduced themself with («меня зовут Алина»,
  «менің атым Ермек», «my name is Daniyar»). A masked name («[Имя скрыто]») stays unknown.
- started_at: a date field of the source record if present, otherwise NULL (callers fall back
  to the import time).
"""
from __future__ import annotations

import re
from datetime import datetime, timezone

OPERATOR_KEYS = ("operator", "operator_name", "agent", "agent_name", "employee", "employee_name",
                 "operator_id", "agent_id")
DATE_KEYS = ("started_at", "start_time", "start", "date", "datetime", "conversation_date", "created_at",
             "createdon", "timestamp")

_NAME = r"([A-ZА-ЯЁӘҒҚҢӨҰҮҺІ][a-zа-яёәғқңөұүһі]+(?:-[A-ZА-ЯЁ][a-zа-яё]+)?)"
_INTRO = [
    re.compile(r"меня\s+зовут\s*,?\s*" + _NAME),
    re.compile(r"Меня\s+зовут\s*,?\s*" + _NAME),
    re.compile(r"[Мм]енің\s+атым\s*,?\s*" + _NAME),
    re.compile(r"[Mm]y\s+name\s+is\s+" + _NAME),
    re.compile(r"\b[Tt]his\s+is\s+" + _NAME + r"\s+(?:from|speaking)"),
]
# Words that follow «меня зовут» in speech-to-text noise but are not names.
_NOT_NAMES = {"Компания", "Фридом", "Freedom", "Здравствуйте", "Да", "Оператор", "Вас", "Как"}


def _clean(v) -> str | None:
    if v is None:
        return None
    if isinstance(v, dict):
        v = v.get("name") or v.get("full_name") or v.get("id")
    s = str(v).strip()
    return s[:80] or None


def detect_operator(raw: dict | None, transcript: list[dict]) -> str | None:
    raw = raw or {}
    for k in OPERATOR_KEYS:
        name = _clean(raw.get(k))
        if name:
            return name
    seen = 0
    for m in transcript or []:
        if m.get("speaker") != "operator":
            continue
        seen += 1
        text = m.get("text") or ""
        for rx in _INTRO:
            hit = rx.search(text)
            if hit and hit.group(1) not in _NOT_NAMES:
                return hit.group(1)
        if seen >= 3:  # operators introduce themselves at the start
            break
    return None


def detect_started_at(raw: dict | None) -> datetime | None:
    raw = raw or {}
    for k in DATE_KEYS:
        v = raw.get(k)
        if not v:
            continue
        s = str(v).strip()
        if re.fullmatch(r"\d{1,2}:\d{2}(:\d{2})?", s):  # a clock time, not a date
            continue
        for fmt in (None, "%d.%m.%Y %H:%M:%S", "%d.%m.%Y %H:%M", "%d.%m.%Y", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
            try:
                d = datetime.fromisoformat(s.replace("Z", "+00:00")) if fmt is None else datetime.strptime(s, fmt)
            except ValueError:
                continue
            return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    return None


async def backfill(conn) -> None:
    """Fill operator / started_at for every conversation (cheap; re-run on each start)."""
    rows = await conn.fetch("SELECT id, raw, transcript, operator, started_at FROM conversations")
    upd = []
    for r in rows:
        op, st = detect_operator(r["raw"], r["transcript"]), detect_started_at(r["raw"])
        if op != r["operator"] or st != r["started_at"]:
            upd.append((r["id"], op, st))
    if upd:
        await conn.executemany("UPDATE conversations SET operator=$2, started_at=$3 WHERE id=$1", upd)
