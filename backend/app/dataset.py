"""Import conversations from the organizer API or from an uploaded JSON."""
from __future__ import annotations

import json
from urllib.parse import urlencode, urlparse, parse_qsl, urlunparse

import httpx

from . import config


class DatasetError(Exception):
    pass


def build_url(group_id: str, base: str | None = None) -> str:
    base = (base or config.DATASET_API_URL).strip()
    if not base:
        raise DatasetError("DATASET_API_URL не задан. Укажите адрес API в .env или в форме импорта.")
    if "{group_id}" in base:
        return base.replace("{group_id}", group_id)
    p = urlparse(base)
    q = [(k, v) for k, v in parse_qsl(p.query, keep_blank_values=True) if k != "group_id"]
    q.append(("group_id", group_id))
    return urlunparse(p._replace(query=urlencode(q)))


async def fetch_group(group_id: str, base: str | None = None) -> tuple[str, list[dict]]:
    url = build_url(group_id, base)
    async with httpx.AsyncClient(timeout=60, follow_redirects=True) as c:
        r = await c.get(url)
    if r.status_code != 200:
        raise DatasetError(f"API вернул HTTP {r.status_code}: {r.text[:300]}")
    try:
        payload = r.json()
    except ValueError as e:
        raise DatasetError(f"API вернул не JSON: {r.text[:300]}") from e
    return extract_records(payload, default_group=group_id)


def extract_records(payload, default_group: str = "UPLOAD") -> tuple[str, list[dict]]:
    """Accepts the full API envelope, its `data`, a list of records or a single record."""
    group = default_group
    if isinstance(payload, dict) and "isSuccess" in payload:
        if not payload.get("isSuccess"):
            raise DatasetError(f"API: isSuccess=false, error={payload.get('error')!r}")
        payload = payload.get("data") or {}
    if isinstance(payload, dict) and "records" in payload:
        group = payload.get("dataset_group_id") or group
        records = payload["records"]
    elif isinstance(payload, list):
        records = payload
    elif isinstance(payload, dict) and "transcript" in payload:
        records = [payload]
    else:
        raise DatasetError("Не удалось найти записи: ожидается data.records, массив записей или одна запись")
    out = []
    for i, r in enumerate(records):
        if isinstance(r, dict) and isinstance(r.get("transcript"), str):
            try:
                r = {**r, "transcript": json.loads(r["transcript"])}
            except ValueError:
                pass
        if not isinstance(r, dict) or not isinstance(r.get("transcript"), list):
            raise DatasetError(f"Запись #{i + 1}: нет массива transcript")
        cid = str(r.get("conversation_id") or f"{group.lower()}-{i + 1:03d}")
        transcript = [
            {"timestamp": str(m.get("timestamp", "")), "speaker": str(m.get("speaker", "")).lower(),
             "text": str(m.get("text", ""))}
            for m in r["transcript"] if isinstance(m, dict)
        ]
        out.append({
            "id": cid,
            "channel": r.get("channel"),
            "language": (r.get("language") or "").upper() or None,
            "transcript": transcript,
            "audio_url": r.get("audio_url") or None,
            "raw": r,
        })
    return str(group), out
