"""Company regulation files: text extraction, clause splitting and checks of model findings.

Pure functions with no database or network access, so they can be unit tested directly.
"""

from __future__ import annotations

import io
import re
import zipfile
from pathlib import Path
from unicodedata import normalize
from xml.etree import ElementTree

from . import evaluator, prompt

MAX_FILE_BYTES = 10 * 1024 * 1024
MAX_DOCX_XML_BYTES = 20 * 1024 * 1024
MAX_CLAUSE_CHARS = 2000
# All regulations go into every check prompt, so their total size is capped.
MAX_PROMPT_CHARS = 150_000
EXTENSIONS = (".pdf", ".docx", ".txt", ".md", ".markdown")
VERDICTS = ("matches", "conflicts", "not_covered")
TOPICS = ("срок", "деньги", "условие", "порядок действий", "другое")

_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
# "2.1", "2.1." , "4)", "п. 3.2" at the start of a line. A bare "3 рабочих дня" is not a clause number.
_NUMBERED = re.compile(r"^\s*(?:п\.\s*|пункт\s+)?(\d{1,3}(?:\.\d{1,3})+\.?|\d{1,3}[.)])\s+(?=\S)", re.IGNORECASE)
_HEADING = re.compile(r"^\s*#{1,6}\s+(.+?)\s*#*\s*$")
_SECTION = re.compile(r"^\s*(?:раздел|глава|статья)\s+\d+[.:]?\s*.*$", re.IGNORECASE)


class RegulationError(ValueError):
    """A file that cannot be used as a regulation; the message is shown to the user."""


def extract_text(filename: str, data: bytes) -> str:
    """Plain text of an uploaded regulation file, by its extension."""
    ext = Path(filename).suffix.lower()
    if ext not in EXTENSIONS:
        raise RegulationError("Поддерживаются файлы PDF, DOCX, TXT и Markdown.")
    if not data:
        raise RegulationError("Файл пустой.")
    if len(data) > MAX_FILE_BYTES:
        raise RegulationError("Файл больше 10 МБ.")
    if ext == ".pdf":
        text = _pdf_text(data)
    elif ext == ".docx":
        text = _docx_text(data)
    else:
        text = _plain_text(data)
    text = normalize("NFC", text).replace("\r\n", "\n").replace("\r", "\n").replace(" ", " ")
    if not text.strip():
        raise RegulationError("В файле не нашлось текста. Если это скан, загрузите версию с текстовым слоем.")
    return text


def _pdf_text(data: bytes) -> str:
    from pypdf import PdfReader
    from pypdf.errors import PdfReadError

    try:
        reader = PdfReader(io.BytesIO(data))
        return "\n".join(page.extract_text() or "" for page in reader.pages)
    except (PdfReadError, ValueError, KeyError, TypeError) as exc:
        raise RegulationError("Не удалось прочитать PDF.") from exc


def _docx_text(data: bytes) -> str:
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            info = archive.getinfo("word/document.xml")
            if info.file_size > MAX_DOCX_XML_BYTES:
                raise RegulationError("Документ DOCX слишком большой.")
            root = ElementTree.fromstring(archive.read(info))
    except (zipfile.BadZipFile, KeyError, ElementTree.ParseError) as exc:
        raise RegulationError("Не удалось прочитать DOCX.") from exc
    lines = []
    for para in root.iter(f"{_W}p"):
        parts = []
        for node in para.iter():
            if node.tag == f"{_W}t" and node.text:
                parts.append(node.text)
            elif node.tag == f"{_W}tab":
                parts.append("\t")
            elif node.tag in (f"{_W}br", f"{_W}cr"):
                parts.append("\n")
        lines.append("".join(parts))
    return "\n".join(lines)


def _plain_text(data: bytes) -> str:
    for encoding in ("utf-8-sig", "cp1251"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise RegulationError("Не удалось определить кодировку текста. Сохраните файл в UTF-8.")


def split_clauses(text: str) -> list[dict]:
    """Numbered points ("2.1 …") become clauses; text without numbering is split by paragraphs.

    Headings ("## Сроки", "Раздел 3 …") are not clauses: they become the section of the clauses below them.
    """
    clauses: list[dict] = []
    section = ""
    current: dict | None = None
    paragraph_no = 0

    def close() -> None:
        nonlocal current
        if current and current["text"].strip():
            current["text"] = " ".join(current["text"].split())[:MAX_CLAUSE_CHARS]
            clauses.append(current)
        current = None

    for raw in text.split("\n"):
        line = raw.strip()
        if not line:
            # A blank line ends a paragraph, but a numbered point may continue after it.
            if current and not current["numbered"]:
                close()
            continue
        heading = _HEADING.match(line)
        if heading or _SECTION.match(line):
            close()
            section = " ".join((heading.group(1) if heading else line).split())
            continue
        numbered = _NUMBERED.match(line)
        if numbered:
            close()
            number = numbered.group(1).rstrip(".)")
            current = {"ref": f"п. {number}", "section": section, "text": line, "numbered": True}
            continue
        if current is None:
            paragraph_no += 1
            current = {"ref": f"абз. {paragraph_no}", "section": section, "text": line, "numbered": False}
        else:
            current["text"] += " " + line.lstrip("-*•· ")
    close()
    return [{"n": i, "ref": c["ref"], "section": c["section"], "text": c["text"]} for i, c in enumerate(clauses, start=1)]


def clause_key(regulation_id: int, n: int) -> str:
    return f"R{regulation_id}-{n}"


def render_regulations(regulations: list[dict]) -> str:
    """Regulations as numbered clauses with stable keys the model must cite, e.g. [R3-12]."""
    out = ["РЕГЛАМЕНТЫ КОМПАНИИ"]
    for reg in regulations:
        out.append("")
        out.append(f"Документ «{reg['title']}»")
        for clause in reg["clauses"]:
            where = f"{clause['ref']}, {clause['section']}" if clause["section"] else clause["ref"]
            out.append(f"[{clause_key(reg['id'], clause['n'])}] ({where}) {clause['text']}")
    return "\n".join(out)


def prompt_size(regulations: list[dict]) -> int:
    return sum(len(c["text"]) for reg in regulations for c in reg["clauses"])


def clause_index(regulations: list[dict]) -> dict[str, dict]:
    return {
        clause_key(reg["id"], c["n"]): {
            "key": clause_key(reg["id"], c["n"]),
            "regulation_id": reg["id"],
            "regulation_title": reg["title"],
            "ref": c["ref"],
            "section": c["section"],
            "text": c["text"],
        }
        for reg in regulations
        for c in reg["clauses"]
    }


def _norm(text: str) -> str:
    return " ".join(normalize("NFC", text).split()).casefold()


def verify_findings(items: list, transcript: list[dict], clauses: dict[str, dict]) -> tuple[list[dict], int]:
    """Keeps findings that quote a real operator message and, unless not covered, cite a real clause.

    Returns (findings, dropped). A clause quote that is not found in the clause is replaced by
    the whole clause text, so what is shown always comes from the uploaded file.
    """
    flags = prompt.annotate(transcript)
    # One finding per operator message and clause (or per message for "not covered"): the model
    # sometimes splits one sentence into several promises about the same clause.
    kept: dict[tuple, dict] = {}
    dropped = 0
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict):
            dropped += 1
            continue
        quote = evaluator.verify_evidence([item], transcript)[0]
        turn = quote["turn"]
        verdict = item.get("verdict")
        operator = (
            quote["issue"] is None
            and str(transcript[turn - 1].get("speaker", "")).lower() == "operator"
            and not flags[turn - 1]["internal"]
        )
        if not operator or verdict not in VERDICTS:
            dropped += 1
            continue
        clause = None
        clause_quote = None
        if verdict != "not_covered":
            clause = clauses.get(str(item.get("clause") or "").strip().strip("[]"))
            if clause is None:
                dropped += 1
                continue
            cited = item.get("clause_quote")
            if isinstance(cited, str) and cited.strip() and _norm(cited) in _norm(clause["text"]):
                clause_quote = " ".join(cited.split())
        promise = " ".join(str(item.get("promise") or "").split())
        topic = item.get("topic")
        finding = {
            "turn": turn,
            "quote": quote["quote"],
            "promise": promise,
            "topic": topic if topic in TOPICS else "другое",
            "verdict": verdict,
            "clause": clause,
            "clause_quote": clause_quote,
            "explanation": " ".join(str(item.get("explanation") or "").split()),
        }
        key = (turn, clause["key"] if clause else None)
        prev = kept.get(key)
        if prev is None:
            kept[key] = finding
            continue
        # The stricter verdict leads (conflicts > not covered > matches); promises are combined.
        lead, other = (finding, prev) if _SEVERITY[verdict] > _SEVERITY[prev["verdict"]] else (prev, finding)
        promises = [p for p in (lead["promise"], other["promise"]) if p]
        if len(promises) == 2 and promises[1].casefold() in promises[0].casefold():
            promises = promises[:1]
        kept[key] = {**lead, "promise": "; ".join(promises)}
    findings = sorted(kept.values(), key=lambda f: (f["turn"], VERDICTS.index(f["verdict"])))
    return findings, dropped


_SEVERITY = {"matches": 0, "not_covered": 1, "conflicts": 2}


def recheck_quotes(findings: list[dict], transcript: list[dict]) -> list[dict]:
    """Marks findings whose operator quote no longer matches the stored transcript (re-import)."""
    checked = evaluator.verify_evidence(findings, transcript)
    return [{**f, "quote_issue": c["issue"]} for f, c in zip(findings, checked)]
