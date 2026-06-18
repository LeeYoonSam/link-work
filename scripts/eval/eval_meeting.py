#!/usr/bin/env python3
"""화자귀속 종단 평가 — cpWER / ORC-WER (MeetEval).

"누가 무엇을 말했나"의 통합 품질. STT와 화자분리를 합쳐서 평가한다.
  - cpWER: 화자 라벨을 최적 순열 매칭 후 WER. 화자+텍스트 통합 정확도.
  - ORC-WER: 화자 라벨 무시, 발화-스트림 최적 배정 WER (STT-only 상한).
cpWER - ORC-WER 차이가 곧 '화자 귀속으로 인한 추가 오류'다.

한국어는 어절 토큰화가 모호하므로 문자 단위로도 본다(--char):
텍스트를 문자 사이 공백으로 분해해 cpWER을 문자 기준(≈cpCER)으로 계산.

pyannote와 달리 MeetEval은 SegLST(dict 리스트)를 직접 받는다.
미설치 시 건너뜀. 설치: pip install meeteval

단독 실행:
    python3 eval_meeting.py --meeting 4 [--char]
"""
from __future__ import annotations

import argparse
import os
import sys
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from lib import normalize, seglst  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))


def _has_meeteval() -> bool:
    try:
        import meeteval  # noqa: F401
        return True
    except ImportError:
        return False


def _normalize_seglst(rows: list[dict[str, Any]], *, char_level: bool) -> list[dict[str, Any]]:
    """words 필드를 정규화. char_level이면 문자를 공백으로 분해(문자 단위 WER)."""
    out = []
    for r in rows:
        text = normalize.normalize_text(r.get("words", ""), keep_space=True)
        if char_level:
            text = " ".join(ch for ch in text.replace(" ", ""))
        nr = dict(r)
        nr["words"] = text
        out.append(nr)
    return out


# ORC-WER은 발화 수가 많으면(수백 개) 배정 탐색이 매우 느려/메모리 폭발하므로
# 이 임계값을 넘으면 기본적으로 건너뛴다(--orc로 강제 가능).
ORC_SEGMENT_LIMIT = 120


def evaluate(
    ref_doc: seglst.EvalDoc,
    hyp_doc: seglst.EvalDoc,
    *,
    char_level: bool = False,
    compute_orc: bool = False,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "cp_wer_percent": None,
        "orc_wer_percent": None,
        "attribution_gap_percent": None,
        "level": "char" if char_level else "word",
        "metrics_engine": None,
        "orc_note": None,
    }
    if not _has_meeteval():
        result["metrics_engine"] = "missing (pip install meeteval)"
        return result

    from meeteval.io.seglst import SegLST
    from meeteval.wer import cp_word_error_rate, orc_word_error_rate

    ref = SegLST.new(_normalize_seglst(seglst.to_seglst(ref_doc), char_level=char_level))
    hyp = SegLST.new(_normalize_seglst(seglst.to_seglst(hyp_doc), char_level=char_level))

    cp = cp_word_error_rate(ref, hyp)
    result["metrics_engine"] = "meeteval"
    result["cp_wer_percent"] = round(cp.error_rate * 100, 2) if cp.error_rate is not None else None
    result["cp_detail"] = {
        "errors": cp.errors, "length": cp.length,
        "insertions": cp.insertions, "deletions": cp.deletions,
        "substitutions": cp.substitutions,
    }

    # ORC-WER: 대용량(많은 발화 × char 토큰화)에서 hang/메모리 위험 → 가드.
    n_seg = max(len(ref_doc.segments), len(hyp_doc.segments))
    if not compute_orc:
        result["orc_note"] = "skipped (--orc 로 활성화)"
    elif char_level:
        result["orc_note"] = "skipped (char 레벨 ORC는 메모리 위험 — word 레벨에서만)"
    elif n_seg > ORC_SEGMENT_LIMIT:
        result["orc_note"] = f"skipped (발화 {n_seg}개 > {ORC_SEGMENT_LIMIT} 한도)"
    else:
        orc = orc_word_error_rate(ref, hyp)
        result["orc_wer_percent"] = (
            round(orc.error_rate * 100, 2) if orc.error_rate is not None else None
        )
        if result["cp_wer_percent"] is not None and result["orc_wer_percent"] is not None:
            result["attribution_gap_percent"] = round(
                result["cp_wer_percent"] - result["orc_wer_percent"], 2
            )
    return result


def _load_pair(meeting_id: int) -> tuple[seglst.EvalDoc, seglst.EvalDoc]:
    ref_path = os.path.join(HERE, "refs", f"meeting_{meeting_id}.json")
    hyp_path = os.path.join(HERE, "out", f"meeting_{meeting_id}", "hyp.json")
    if not os.path.exists(ref_path):
        raise FileNotFoundError(f"ref 없음: {ref_path}")
    if not os.path.exists(hyp_path):
        raise FileNotFoundError(f"hyp 없음: {hyp_path}")
    ref = seglst.load(ref_path)
    return ref, seglst.apply_window(ref, seglst.load(hyp_path))


def main() -> int:
    ap = argparse.ArgumentParser(description="화자귀속 종단 cpWER/ORC-WER 평가")
    ap.add_argument("--meeting", type=int, required=True)
    ap.add_argument("--char", action="store_true",
                    help="문자 단위 토큰화(메모리 주의 · ORC 자동 비활성)")
    ap.add_argument("--orc", action="store_true",
                    help="ORC-WER도 계산(발화 많으면 매우 느림)")
    args = ap.parse_args()

    ref_doc, hyp_doc = _load_pair(args.meeting)
    res = evaluate(ref_doc, hyp_doc, char_level=args.char, compute_orc=args.orc)
    print(f"[Meeting end-to-end] meeting {args.meeting}  (level={res['level']})")
    if res["cp_wer_percent"] is None:
        print(f"  건너뜀 — {res['metrics_engine']}")
        return 0
    print(f"  cpWER  : {res['cp_wer_percent']:.2f}%   (화자귀속 포함 종단 오류)")
    if res["orc_wer_percent"] is not None:
        print(f"  ORC-WER: {res['orc_wer_percent']:.2f}%   (화자무시 = STT 상한)")
        print(f"  귀속 갭: {res['attribution_gap_percent']:.2f}%p  (화자분리가 추가한 오류)")
    else:
        print(f"  ORC-WER: — ({res['orc_note']})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
