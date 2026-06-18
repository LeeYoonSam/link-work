#!/usr/bin/env python3
"""STT(전사) 품질 평가 — CER / WER.

ref(정답)와 hyp(가설)의 전체 전사 텍스트를 정규화 후 비교한다.
한국어이므로 CER(문자 오류율)이 주지표, WER은 보조.
의존성 없이 동작(표준 라이브러리 Levenshtein). jiwer 설치 시 그것을 사용.

단독 실행:
    python3 eval_stt.py --meeting 4
"""
from __future__ import annotations

import argparse
import os
import sys
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from lib import normalize, seglst  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))


def evaluate(ref_doc: seglst.EvalDoc, hyp_doc: seglst.EvalDoc) -> dict[str, Any]:
    ref_text = seglst.full_text(ref_doc)
    hyp_text = seglst.full_text(hyp_doc)

    cer_nospace = normalize.cer(ref_text, hyp_text, keep_space=False)
    cer_space = normalize.cer(ref_text, hyp_text, keep_space=True)
    w = normalize.wer(ref_text, hyp_text)

    return {
        "ref_chars": cer_nospace.ref_len,
        "hyp_chars": len(normalize.normalize_text(hyp_text)),
        "cer_percent": cer_nospace.percent,           # 공백 제외 (표준)
        "cer_with_space_percent": cer_space.percent,  # 공백 포함
        "wer_percent": w.percent,
        "cer_errors": cer_nospace.errors,
        "wer_errors": w.errors,
        "ref_words": w.ref_len,
        "engine": "jiwer" if normalize._has_jiwer() else "builtin-levenshtein",
    }


def _load_pair(meeting_id: int) -> tuple[seglst.EvalDoc, seglst.EvalDoc]:
    ref_path = os.path.join(HERE, "refs", f"meeting_{meeting_id}.json")
    hyp_path = os.path.join(HERE, "out", f"meeting_{meeting_id}", "hyp.json")
    if not os.path.exists(ref_path):
        raise FileNotFoundError(f"ref 없음: {ref_path} (export_meeting.py --bootstrap-ref 후 라벨링 필요)")
    if not os.path.exists(hyp_path):
        raise FileNotFoundError(f"hyp 없음: {hyp_path} (export_meeting.py --meeting {meeting_id} 먼저 실행)")
    ref = seglst.load(ref_path)
    return ref, seglst.apply_window(ref, seglst.load(hyp_path))


def main() -> int:
    ap = argparse.ArgumentParser(description="STT CER/WER 평가")
    ap.add_argument("--meeting", type=int, required=True)
    args = ap.parse_args()

    ref_doc, hyp_doc = _load_pair(args.meeting)
    res = evaluate(ref_doc, hyp_doc)
    print(f"[STT] meeting {args.meeting}  (engine={res['engine']})")
    print(f"  CER (공백제외) : {res['cer_percent']:.2f}%  ({res['cer_errors']}/{res['ref_chars']} chars)")
    print(f"  CER (공백포함) : {res['cer_with_space_percent']:.2f}%")
    print(f"  WER            : {res['wer_percent']:.2f}%  ({res['wer_errors']}/{res['ref_words']} words)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
