#!/usr/bin/env python3
"""통합 평가 러너 — 한 회의(또는 전체)에 대해 STT/화자분리/종단/요약을 모두 평가하고
마크다운 + JSON 리포트를 생성한다.

흐름:
  1. DB에서 hyp 익스포트 (refs가 없어도 hyp는 항상 추출)
  2. ref가 있으면 CER/DER/cpWER 평가, 없으면 해당 항목 '미라벨' 표시
  3. 요약은 ref 없이도 LLM-judge로 평가(faithfulness 등)
  4. out/report_meeting_<id>.md, out/report_meeting_<id>.json 저장

사용법:
    python3 run_all.py --meeting 4
    python3 run_all.py --all                 # DB의 모든 회의
    python3 run_all.py --meeting 4 --no-summary   # LLM 호출 생략(빠름)
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Optional

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from lib import db, seglst  # noqa: E402
import eval_stt
import eval_diar
import eval_meeting
import eval_summary

HERE = os.path.dirname(os.path.abspath(__file__))
REFS_DIR = os.path.join(HERE, "refs")
OUT_DIR = os.path.join(HERE, "out")


def _ref_path(mid: int) -> str:
    return os.path.join(REFS_DIR, f"meeting_{mid}.json")


def run_meeting(conn, mid: int, *, do_summary: bool, model: str) -> dict[str, Any]:
    meeting = db.load_meeting(conn, mid)
    hyp_doc = seglst.from_meeting(meeting)

    out_dir = os.path.join(OUT_DIR, f"meeting_{mid}")
    os.makedirs(out_dir, exist_ok=True)
    seglst.save(hyp_doc, os.path.join(out_dir, "hyp.json"))
    seglst.write_derived(hyp_doc, out_dir, "hyp")

    report: dict[str, Any] = {
        "meeting_id": mid,
        "title": meeting.title,
        "source": meeting.source,
        "duration_min": round(meeting.duration_ms / 60000.0, 1),
        "expected_speakers": meeting.expected_speakers,
        "hyp_segments": len(hyp_doc.segments),
        "hyp_speakers": hyp_doc.num_speakers,
        "has_ref": os.path.exists(_ref_path(mid)),
        "stt": None,
        "diarization": None,
        "meeting_e2e": None,
        "summary": None,
    }

    if report["has_ref"]:
        ref_doc = seglst.load(_ref_path(mid))
        # 부분 라벨링이면 ref의 eval_window로 hyp을 잘라 공정 비교.
        hyp_eval = seglst.apply_window(ref_doc, hyp_doc)
        report["partial_window"] = ref_doc.eval_window
        report["stt"] = eval_stt.evaluate(ref_doc, hyp_eval)
        report["diarization"] = eval_diar.evaluate(ref_doc, hyp_eval)
        # word 레벨 cpWER(안정·빠름). ORC는 발화 수가 많으면 hang하므로 evaluate가 자동 가드.
        report["meeting_e2e"] = eval_meeting.evaluate(ref_doc, hyp_eval, char_level=False)

    if do_summary:
        report["summary"] = eval_summary.evaluate(mid, model=model)

    return report


def _fmt_pct(v: Optional[float]) -> str:
    return f"{v:.2f}%" if isinstance(v, (int, float)) else "—"


def to_markdown(report: dict[str, Any]) -> str:
    L = []
    L.append(f"# 회의 평가 리포트 — meeting {report['meeting_id']}: {report['title']}\n")
    L.append(f"- 소스: `{report['source']}` · 길이: {report['duration_min']}분 · "
             f"지정 참석자: {report['expected_speakers']}")
    L.append(f"- 가설: 세그먼트 {report['hyp_segments']}개 · 화자 {report['hyp_speakers']}명")
    L.append(f"- 정답(ref) 라벨: {'있음 ✓' if report['has_ref'] else '없음 ✗ (CER/DER/cpWER 측정 불가)'}\n")

    if report["stt"]:
        s = report["stt"]
        L.append("## STT (전사)")
        L.append(f"- **CER**: {_fmt_pct(s['cer_percent'])} (공백제외) · "
                 f"{_fmt_pct(s['cer_with_space_percent'])} (공백포함)")
        L.append(f"- WER: {_fmt_pct(s['wer_percent'])} · ref {s['ref_chars']}자 / {s['ref_words']}어절\n")

    if report["diarization"]:
        d = report["diarization"]
        L.append("## 화자 분리")
        verdict = "일치 ✓" if d["speaker_count_correct"] else f"{d['speaker_count_diff']:+d} ✗"
        L.append(f"- 화자 수: 정답 {d['ref_speakers']} / 가설 {d['hyp_speakers']} → {verdict}")
        if d["der_percent"] is not None:
            c = d["components"]
            L.append(f"- **DER**: {_fmt_pct(d['der_percent'])} "
                     f"(FA {c['false_alarm_percent']:.1f} / Miss {c['missed_percent']:.1f} / "
                     f"Conf {c['confusion_percent']:.1f})")
            L.append(f"- JER: {_fmt_pct(d['jer_percent'])}\n")
        else:
            L.append(f"- DER/JER: 건너뜀 ({d['metrics_engine']})\n")

    if report["meeting_e2e"]:
        e = report["meeting_e2e"]
        L.append("## 종단 (화자귀속 포함)")
        if e["cp_wer_percent"] is not None:
            if e["orc_wer_percent"] is not None:
                L.append(f"- **cpWER**({e['level']}): {_fmt_pct(e['cp_wer_percent'])} · "
                         f"ORC-WER: {_fmt_pct(e['orc_wer_percent'])} · "
                         f"귀속 갭: {_fmt_pct(e['attribution_gap_percent'])}\n")
            else:
                L.append(f"- **cpWER**({e['level']}): {_fmt_pct(e['cp_wer_percent'])} "
                         f"· ORC-WER: — ({e.get('orc_note', 'n/a')})\n")
        else:
            L.append(f"- 건너뜀 ({e['metrics_engine']})\n")

    if report["summary"]:
        su = report["summary"]
        L.append("## AI 요약")
        sc = su.get("scores")
        if sc:
            f = sc.get("faithfulness", {})
            c = sc.get("coverage", {})
            L.append(f"- **faithfulness**: {f.get('score')}/5 (환각 {len(f.get('hallucinations', []))}건) · "
                     f"coverage: {c.get('score')}/5 (누락 {len(c.get('missing', []))}건)")
            L.append(f"- action_item: {sc.get('action_item_quality', {}).get('score')}/5 · "
                     f"conciseness: {sc.get('conciseness', {}).get('score')}/5 · "
                     f"**overall: {sc.get('overall')}/5**")
            if f.get("hallucinations"):
                L.append("- 환각 목록:")
                for h in f["hallucinations"][:8]:
                    L.append(f"    - {h}")
            if c.get("missing"):
                L.append("- 누락 목록:")
                for m in c["missing"][:8]:
                    L.append(f"    - {m}")
            L.append("")
        else:
            L.append(f"- 건너뜀 ({su.get('engine')})\n")

    return "\n".join(L)


def main() -> int:
    ap = argparse.ArgumentParser(description="회의 파이프라인 통합 평가")
    ap.add_argument("--meeting", type=int, help="평가할 meeting id")
    ap.add_argument("--all", action="store_true", help="DB의 모든 회의 평가")
    ap.add_argument("--no-summary", action="store_true", help="LLM 요약 평가 생략(빠름)")
    ap.add_argument("--model", default="claude-sonnet-5")
    ap.add_argument("--db")
    args = ap.parse_args()

    if not args.meeting and not args.all:
        ap.error("--meeting 또는 --all 이 필요합니다.")

    conn = db.connect(args.db)
    try:
        ids = ([m["id"] for m in db.list_meetings(conn)] if args.all else [args.meeting])
        os.makedirs(OUT_DIR, exist_ok=True)
        for mid in ids:
            report = run_meeting(conn, mid, do_summary=not args.no_summary, model=args.model)
            md = to_markdown(report)
            with open(os.path.join(OUT_DIR, f"report_meeting_{mid}.md"), "w", encoding="utf-8") as f:
                f.write(md)
            with open(os.path.join(OUT_DIR, f"report_meeting_{mid}.json"), "w", encoding="utf-8") as f:
                json.dump(report, f, ensure_ascii=False, indent=2)
            print(md)
            print("\n" + "=" * 72 + "\n")
        print(f"리포트 저장: {OUT_DIR}/report_meeting_*.{{md,json}}")
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
