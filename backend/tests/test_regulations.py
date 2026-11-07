import io
import zipfile

import pytest

from app.regulation_text import (
    RegulationError,
    clause_index,
    extract_text,
    recheck_quotes,
    render_regulations,
    split_clauses,
    verify_findings,
)

REGULATION = """# Регламент поддержки

## 2. Сроки ответа
2.1 Срок ответа на письменное обращение — до 3 рабочих дней.
Срок считается с момента регистрации обращения.

2.2. Если вопрос передан в профильный отдел, оператор называет срок до 3 рабочих дней
и не обещает ответ в тот же день.

## Консультации
Оператор не предлагает платные или частные консультации.
- Нарушение считается грубым.
"""


def test_numbered_points_and_paragraphs_become_clauses_under_their_section():
    clauses = split_clauses(REGULATION)
    assert [c["ref"] for c in clauses] == ["п. 2.1", "п. 2.2", "абз. 1"]
    assert [c["n"] for c in clauses] == [1, 2, 3]
    assert clauses[0]["section"] == "2. Сроки ответа"
    # A continuation line joins its point; a number inside a sentence does not start a new one.
    assert clauses[0]["text"].endswith("с момента регистрации обращения.")
    assert "и не обещает ответ в тот же день." in clauses[1]["text"]
    assert clauses[2]["section"] == "Консультации"
    assert clauses[2]["text"] == "Оператор не предлагает платные или частные консультации. Нарушение считается грубым."


def test_a_line_starting_with_a_plain_number_is_not_a_clause_number():
    clauses = split_clauses("3 рабочих дня — срок рассмотрения.\n4) Вывод средств — 1 рабочий день.")
    assert [c["ref"] for c in clauses] == ["абз. 1", "п. 4"]


def test_text_files_in_utf8_and_cp1251_are_read():
    assert extract_text("a.txt", "Срок — 3 дня".encode("utf-8")) == "Срок — 3 дня"
    assert extract_text("a.md", "Срок 3 дня".encode("cp1251")) == "Срок 3 дня"


def test_docx_paragraphs_are_read():
    xml = (
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
        "<w:p><w:r><w:t>1.1 Срок ответа</w:t></w:r><w:r><w:t xml:space=\"preserve\"> — 3 рабочих дня.</w:t></w:r></w:p>"
        "<w:p><w:r><w:t>1.2 Комиссия 0,1%.</w:t></w:r></w:p>"
        "</w:body></w:document>"
    )
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as archive:
        archive.writestr("word/document.xml", xml)
    text = extract_text("reg.docx", buf.getvalue())
    assert [c["text"] for c in split_clauses(text)] == ["1.1 Срок ответа — 3 рабочих дня.", "1.2 Комиссия 0,1%."]


def _pdf(text: str) -> bytes:
    stream = f"BT /F1 12 Tf 72 720 Td ({text}) Tj ET".encode()
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % i + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    out += b"".join(b"%010d 00000 n \n" % o for o in offsets)
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, xref)
    return bytes(out)


def test_pdf_text_layer_is_read():
    assert "Response time is 3 business days" in extract_text("reg.pdf", _pdf("2.1 Response time is 3 business days"))


@pytest.mark.parametrize("name,data", [
    ("reg.xlsx", b"x"),
    ("reg.txt", b""),
    ("reg.txt", b"   \n  "),
    ("reg.pdf", b"not a pdf"),
    ("reg.docx", b"not a zip"),
])
def test_unusable_files_are_rejected_with_a_message(name, data):
    with pytest.raises(RegulationError) as err:
        extract_text(name, data)
    assert str(err.value)


REGS = [{"id": 7, "title": "Регламент поддержки", "clauses": split_clauses(REGULATION)}]
TRANSCRIPT = [
    {"speaker": "client", "text": "Когда будет ответ?"},
    {"speaker": "operator", "text": "Профильный отдел ответит вам сегодня до 00:00."},
    {"speaker": "system", "text": "Клиент находится на удержании"},
    {"speaker": "operator", "text": "Коллеги, ответ за сутки успеем?"},
    {"speaker": "system", "text": "Клиент больше не находится на удержании"},
    {"speaker": "operator", "text": "Комиссия за вывод — 0 тенге."},
]


def test_prompt_lists_every_clause_with_its_key():
    text = render_regulations(REGS)
    assert "[R7-1] (п. 2.1, 2. Сроки ответа) 2.1 Срок ответа" in text
    assert "[R7-3] (абз. 1, Консультации)" in text


def test_only_operator_quotes_and_real_clauses_survive():
    clauses = clause_index(REGS)
    items = [
        {"turn": 2, "quote": "ответит вам сегодня до 00:00", "promise": "ответ сегодня", "topic": "срок",
         "verdict": "conflicts", "clause": "R7-2", "clause_quote": "не обещает ответ в тот же день", "explanation": "x"},
        # Same promise twice is kept once.
        {"turn": 2, "quote": "ответит вам сегодня", "promise": "Ответ сегодня", "topic": "срок",
         "verdict": "conflicts", "clause": "[R7-2]", "clause_quote": None, "explanation": "x"},
        {"turn": 1, "quote": "Когда будет ответ?", "promise": "-", "topic": "срок",
         "verdict": "matches", "clause": "R7-1", "explanation": "client message"},
        {"turn": 4, "quote": "ответ за сутки успеем?", "promise": "сутки", "topic": "срок",
         "verdict": "conflicts", "clause": "R7-1", "explanation": "said on hold"},
        {"turn": 6, "quote": "Комиссия за вывод — 0 тенге.", "promise": "вывод бесплатно", "topic": "деньги",
         "verdict": "conflicts", "clause": "R7-99", "explanation": "invented clause"},
        {"turn": 6, "quote": "Комиссия за вывод — 0 тенге.", "promise": "вывод бесплатно", "topic": "unknown",
         "verdict": "not_covered", "clause": None, "explanation": "нет пункта"},
        {"turn": 6, "quote": "Комиссия 5%", "promise": "-", "topic": "деньги", "verdict": "not_covered", "explanation": "bad quote"},
        {"turn": 2, "quote": "сегодня до 00:00", "promise": "-", "topic": "срок", "verdict": "maybe", "explanation": "bad verdict"},
        "garbage",
    ]
    findings, dropped = verify_findings(items, TRANSCRIPT, clauses)
    assert [(f["turn"], f["verdict"]) for f in findings] == [(2, "conflicts"), (6, "not_covered")]
    assert dropped == 6
    first, second = findings
    assert first["clause"]["ref"] == "п. 2.2" and first["clause"]["regulation_title"] == "Регламент поддержки"
    assert first["clause_quote"] == "не обещает ответ в тот же день"
    assert second["clause"] is None and second["topic"] == "другое"


def test_one_message_and_clause_give_one_finding_with_the_stricter_verdict():
    base = {"turn": 2, "quote": "Профильный отдел ответит", "topic": "срок", "clause": "R7-2", "explanation": "x"}
    findings, dropped = verify_findings(
        [
            {**base, "verdict": "matches", "promise": "вопрос передан в отдел"},
            {**base, "verdict": "conflicts", "promise": "ответ сегодня", "explanation": "срок твёрже регламента"},
            {**base, "verdict": "not_covered", "clause": None, "promise": "до 00:00"},
        ],
        TRANSCRIPT, clause_index(REGS),
    )
    assert dropped == 0
    assert [(f["verdict"], f["promise"]) for f in findings] == [
        ("conflicts", "ответ сегодня; вопрос передан в отдел"),
        ("not_covered", "до 00:00"),
    ]
    assert findings[0]["explanation"] == "срок твёрже регламента"


def test_a_clause_quote_not_in_the_clause_is_not_shown():
    findings, _ = verify_findings(
        [{"turn": 2, "quote": "сегодня до 00:00", "promise": "сегодня", "topic": "срок", "verdict": "conflicts",
          "clause": "R7-1", "clause_quote": "ответ в течение часа", "explanation": "x"}],
        TRANSCRIPT, clause_index(REGS),
    )
    assert findings[0]["clause_quote"] is None
    assert findings[0]["clause"]["text"].startswith("2.1 Срок ответа")


def test_a_reimported_transcript_marks_old_quotes():
    findings, _ = verify_findings(
        [{"turn": 2, "quote": "сегодня до 00:00", "promise": "сегодня", "topic": "срок", "verdict": "conflicts",
          "clause": "R7-2", "explanation": "x"}],
        TRANSCRIPT, clause_index(REGS),
    )
    assert recheck_quotes(findings, TRANSCRIPT)[0]["quote_issue"] is None
    changed = [*TRANSCRIPT[:1], {"speaker": "operator", "text": "Ответим в течение трёх рабочих дней."}]
    assert recheck_quotes(findings, changed)[0]["quote_issue"]
