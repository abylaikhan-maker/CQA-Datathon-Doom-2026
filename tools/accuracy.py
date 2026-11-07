#!/usr/bin/env python3
"""Compare the latest model evaluations with a hand-labelled ground truth.

    python3 tools/accuracy.py --gt ../CQA-Datathon-Doom-2026/abylaikhan/ground_truth.json
    python3 tools/accuracy.py --gt gt.json --checklist 2 --show c02,c07   # list mismatches
    python3 tools/accuracy.py --gt gt.json --json run.json                 # save metrics for comparison

Uses the original model answers (before appeals). The GT total is computed with the
app's own scoring.py, so the score error reflects answer errors, not arithmetic.
Ground truth format: {"labels": {conversation_id: {"c01": "yes", "c04": "15", ...}}}
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from app import scoring  # noqa: E402


def norm(v) -> str:
    if v is None:
        return "na"
    if isinstance(v, (int, float)):
        return str(int(v)) if float(v).is_integer() else str(v)
    s = str(v).strip().lower()
    try:
        f = float(s)
        return str(int(f)) if f.is_integer() else s
    except ValueError:
        return s


def get(api: str, path: str):
    with urllib.request.urlopen(api.rstrip("/") + path, timeout=60) as r:
        return json.load(r)


def gt_answers(cfg: dict, labels: dict) -> dict:
    out = {}
    for c in cfg["criteria"]:
        v = labels.get(c["id"])
        if v is None:
            continue
        out[c["id"]] = scoring.NA if v == "na" else (float(v) if c["type"] == "scale" else v)
    return out


def pct(a: int, b: int) -> str:
    return f"{100 * a / b:5.1f}% ({a}/{b})" if b else "    -"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="http://localhost:8091")
    ap.add_argument("--gt", required=True)
    ap.add_argument("--group", default="DEV")
    ap.add_argument("--checklist", type=int, help="checklist id (default: active)")
    ap.add_argument("--show", default="", help="criteria to list mismatches for, e.g. c02,c07 or 'all'")
    ap.add_argument("--json", help="write metrics to this file")
    a = ap.parse_args()

    gt = json.load(open(a.gt))["labels"]
    kid = a.checklist or get(a.api, "/api/checklists/active")["id"]
    convs = [c for c in get(a.api, f"/api/conversations?group={a.group}&checklist_id={kid}")
             if c["id"] in gt and c.get("status") == "done"]
    with ThreadPoolExecutor(8) as ex:
        evals = list(ex.map(lambda c: get(a.api, f"/api/evaluations/{c['eval_id']}"), convs))
    if not evals:
        print("Нет завершённых оценок для диалогов из эталона.")
        return 1
    cfg = evals[0]["checklist"]
    crit_ids = [c["id"] for c in cfg["criteria"] if c["id"] in next(iter(gt.values()))]

    hit = defaultdict(int); tot = defaultdict(int)
    hit_sure = defaultdict(int); tot_sure = defaultdict(int)
    grp_hit = defaultdict(int); grp_tot = defaultdict(int)
    confusion = defaultdict(lambda: defaultdict(int))
    mism = []
    score_err = []
    crit_flag = [0, 0]
    show = set(crit_ids) if a.show == "all" else {s.strip() for s in a.show.split(",") if s.strip()}

    for conv, ev in zip(convs, evals):
        lab = gt[conv["id"]]
        unsure = set(lab.get("_uncertain", []))
        model = {r["criterion_id"]: r for r in ev["criteria"]}
        groups = [f"lang:{conv['language']}", f"channel:{conv['channel']}"]
        for cid in crit_ids:
            g, m = norm(lab[cid]), norm(model.get(cid, {}).get("answer"))
            ok = g == m
            hit[cid] += ok; tot[cid] += 1
            if cid not in unsure:
                hit_sure[cid] += ok; tot_sure[cid] += 1
            for k in groups:
                grp_hit[k] += ok; grp_tot[k] += 1
            confusion[cid][(g, m)] += 1
            if not ok:
                mism.append((cid, conv["id"], g, m, cid in unsure, model.get(cid, {}).get("explanation", "")))
        g_score = scoring.compute(cfg, gt_answers(cfg, lab))
        if g_score["total"] is not None and ev["total"] is not None:
            score_err.append((abs(g_score["total"] - float(ev["total"])), conv["id"], g_score["total"], float(ev["total"])))
        crit_flag[0] += bool(g_score["critical"]) == bool(ev["critical"]); crit_flag[1] += 1

    all_hit, all_tot = sum(hit.values()), sum(tot.values())
    print(f"Чек-лист #{kid} v{evals[0]['checklist_version']} · модель {evals[0]['model']} · диалогов {len(evals)}")
    print(f"\nСовпадение по всем ответам: {pct(all_hit, all_tot)}   без спорных: "
          f"{pct(sum(hit_sure.values()), sum(tot_sure.values()))}")
    if score_err:
        mae = sum(e[0] for e in score_err) / len(score_err)
        within5 = sum(e[0] <= 5 for e in score_err)
        print(f"Итоговый балл: MAE {mae:.2f} · |Δ|≤5: {pct(within5, len(score_err))}")
    print(f"Флаг грубой ошибки: {pct(*crit_flag)}")

    print("\nПо критериям               все            без спорных    частые ошибки (эталон→модель)")
    for cid in crit_ids:
        title = next(c["title"] for c in cfg["criteria"] if c["id"] == cid)[:22]
        errs = sorted(((n, k) for k, n in confusion[cid].items() if k[0] != k[1]), reverse=True)[:3]
        errs_s = ", ".join(f"{g}→{m}×{n}" for n, (g, m) in errs)
        print(f"  {cid} {title:22} {pct(hit[cid], tot[cid]):15} {pct(hit_sure[cid], tot_sure[cid]):15} {errs_s}")

    print("\nПо группам")
    for k in sorted(grp_tot):
        print(f"  {k:22} {pct(grp_hit[k], grp_tot[k])}")

    worst = sorted(score_err, reverse=True)[:8]
    print("\nСамые большие расхождения итога: " + ", ".join(f"{c} {g:.1f}→{m:.1f}" for _, c, g, m in worst if _ > 0))

    if show:
        print("\nРасхождения:")
        for cid, conv_id, g, m, unsure, expl in sorted(mism):
            if cid in show:
                print(f"  {cid} {conv_id:10} эталон={g:3} модель={m:3}{' (спорно)' if unsure else ''}  {expl[:160]}")

    if a.json:
        json.dump({
            "checklist_id": kid, "model": evals[0]["model"], "n": len(evals),
            "accuracy": all_hit / all_tot,
            "accuracy_sure": sum(hit_sure.values()) / max(1, sum(tot_sure.values())),
            "per_criterion": {c: hit[c] / tot[c] for c in crit_ids},
            "mae_total": sum(e[0] for e in score_err) / max(1, len(score_err)),
            "critical_acc": crit_flag[0] / crit_flag[1],
            "mismatches": [{"criterion": c, "id": i, "gt": g, "model": m} for c, i, g, m, *_ in mism],
        }, open(a.json, "w"), ensure_ascii=False, indent=1)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
