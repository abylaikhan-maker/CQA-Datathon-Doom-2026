from datetime import date

from app import operators, team


def op(text, speaker="operator"):
    return [{"speaker": speaker, "text": text}]


def test_operator_from_introduction():
    assert operators.detect_operator({}, op("Здравствуйте! Меня зовут Айгерим, я помогу вам.")) == "Айгерим"
    assert operators.detect_operator({}, op("Сәлеметсіз бе, менің атым Ғалым. Компания")) == "Ғалым"
    assert operators.detect_operator({}, op("Hello! My name is Daniyar, how can I help?")) == "Daniyar"


def test_operator_masked_or_missing_is_unknown():
    assert operators.detect_operator({}, op("Фридом брокер, меня зовут [Имя скрыто], чем могу помочь?")) is None
    assert operators.detect_operator({}, op("Компания в виду меня зовут Здравствуйте")) is None
    assert operators.detect_operator({}, op("Меня зовут Анна", speaker="client")) is None
    assert operators.detect_operator({}, []) is None


def test_operator_field_wins():
    assert operators.detect_operator({"agent": {"name": "Иванов И."}}, op("Меня зовут Анна")) == "Иванов И."


def test_started_at():
    assert operators.detect_started_at({"date": "2026-11-03T10:00:00Z"}).isoformat() == "2026-11-03T10:00:00+00:00"
    assert operators.detect_started_at({"date": "03.11.2026"}).date() == date(2026, 11, 3)
    assert operators.detect_started_at({"timestamp": "00:05"}) is None
    assert operators.detect_started_at({}) is None


CFG = {"criteria": [
    {"id": "c01", "code": "01", "title": "Контакт", "type": "binary", "weight": 10},
    {"id": "c04", "code": "04", "title": "Консультация", "type": "scale", "weight": 20},
    {"id": "c08", "code": "08", "title": "Грубые", "type": "critical", "weight": 0},
]}


def row(cid, operator, total, c01, c04, crit=False, day=date(2026, 11, 7)):
    return {
        "id": cid, "operator": operator, "eval_id": 1, "final_total": total, "critical": crit, "day": day,
        "language": "RU", "channel": "chat", "appeals": 0, "open_appeals": 0, "changed_appeals": 0,
        "reg_checked": False, "reg_conflicts": 0, "summary": "", "dataset_group": "G", "started_at": None,
        "final_criteria": [],
        "scores": [
            {"criterion_id": "c01", "answer": "yes" if c01 else "no", "points": 10 if c01 else 0, "max_points": 10},
            {"criterion_id": "c04", "answer": c04, "points": c04, "max_points": 20},
            {"criterion_id": "c08", "answer": "yes" if crit else "no", "points": None, "max_points": None},
        ],
    }


def test_aggregate_and_ranking():
    rows = [row("a", "Анна", 100, True, 20), row("b", "Анна", 50, False, 10),
            row("c", "Борис", 100, True, 20, crit=True), row("d", team.NONE, 80, True, 10)]
    a = team.aggregate(rows, CFG)
    assert a["evaluated"] == 4 and a["avg"] == 82.5 and a["critical"] == 1 and a["low"] == 1
    assert a["criteria"]["c01"]["pct"] == 75.0 and a["criteria"]["c01"]["fails"] == 1
    assert a["criteria"]["c08"]["violations"] == 1
    ops = team._operators(rows, CFG, a)
    # Борис has the higher score but a critical violation: ranked below Анна; unknown last.
    assert [o["key"] for o in ops] == ["Анна", "Борис", team.NONE]
    assert ops[0]["weakest"][0]["id"] in ("c01", "c04")


def test_clean_review_drops_unknown_refs():
    out = {"headline": "h", "tone": "weird", "overall": "o", "strengths": [],
           "problems": [{"title": "t", "detail": "d", "severity": "high", "criteria": ["c04", "1", "99"],
                         "operators": ["Анна", "Кто-то"], "dialogs": ["a", "zzz", "a"]}],
           "operators": [{"name": "Кто-то", "assessment": "", "strength": "", "focus": "", "risk": "low"}],
           "recommendations": []}
    r = team._clean_review(out, {"a"}, {"Анна"}, {"01", "04"})
    p = r["problems"][0]
    assert r["tone"] == "attention" and p["dialogs"] == ["a"] and p["operators"] == ["Анна"]
    assert p["criteria"] == ["04", "01"] and r["operators"] == []
