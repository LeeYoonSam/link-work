#!/usr/bin/env python3
"""화자분리 품질 평가 — DER / JER + 화자 수 정확도.

pyannote.metrics 사용(표준). collar 0.25s 관례 적용(경계 모호성 흡수).
DER = (False Alarm + Missed Detection + Speaker Confusion) / 총 발화시간.

pyannote.metrics 미설치 시: 화자 수 정확도만 계산하고 DER/JER은 건너뛴다
(안내 출력). 설치: pip install pyannote.metrics

단독 실행:
    python3 eval_diar.py --meeting 4 [--collar 0.25] [--no-skip-overlap]
"""
from __future__ import annotations

import argparse
import os
import sys
from typing import Any, Optional

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from lib import seglst  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))


def _has_pyannote() -> bool:
    try:
        import pyannote.metrics  # noqa: F401
        import pyannote.core  # noqa: F401
        return True
    except ImportError:
        return False


def _to_annotation(doc: seglst.EvalDoc):
    from pyannote.core import Annotation, Segment

    ann = Annotation(uri=doc.session_id)
    for i, s in enumerate(sorted(doc.segments, key=lambda x: x["start_ms"])):
        start = s["start_ms"] / 1000.0
        end = s["end_ms"] / 1000.0
        if end <= start:
            continue
        ann[Segment(start, end), i] = str(s.get("speaker", "spk_0"))
    return ann


def evaluate(
    ref_doc: seglst.EvalDoc,
    hyp_doc: seglst.EvalDoc,
    *,
    collar: float = 0.25,
    skip_overlap: bool = True,
) -> dict[str, Any]:
    ref_n = ref_doc.num_speakers
    hyp_n = hyp_doc.num_speakers
    result: dict[str, Any] = {
        "ref_speakers": ref_n,
        "hyp_speakers": hyp_n,
        "speaker_count_correct": ref_n == hyp_n,
        "speaker_count_diff": hyp_n - ref_n,
        "der_percent": None,
        "jer_percent": None,
        "components": None,
        "metrics_engine": None,
    }

    if not _has_pyannote():
        result["metrics_engine"] = "missing (pip install pyannote.metrics)"
        return result

    from pyannote.metrics.diarization import (
        DiarizationErrorRate,
        JaccardErrorRate,
    )

    ref = _to_annotation(ref_doc)
    hyp = _to_annotation(hyp_doc)

    der_metric = DiarizationErrorRate(collar=collar, skip_overlap=skip_overlap)
    der = der_metric(ref, hyp, detailed=True)
    total = der.get("total", 0) or 1e-9

    jer_metric = JaccardErrorRate(collar=collar, skip_overlap=skip_overlap)
    jer = jer_metric(ref, hyp)

    result["metrics_engine"] = "pyannote.metrics"
    result["der_percent"] = round(der["diarization error rate"] * 100, 2)
    result["jer_percent"] = round(jer * 100, 2)
    result["components"] = {
        "false_alarm_percent": round(der.get("false alarm", 0) / total * 100, 2),
        "missed_percent": round(der.get("missed detection", 0) / total * 100, 2),
        "confusion_percent": round(der.get("confusion", 0) / total * 100, 2),
        "collar": collar,
        "skip_overlap": skip_overlap,
    }
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
    ap = argparse.ArgumentParser(description="화자분리 DER/JER 평가")
    ap.add_argument("--meeting", type=int, required=True)
    ap.add_argument("--collar", type=float, default=0.25)
    ap.add_argument("--no-skip-overlap", action="store_true",
                    help="겹친 발화 구간도 평가에 포함")
    args = ap.parse_args()

    ref_doc, hyp_doc = _load_pair(args.meeting)
    res = evaluate(ref_doc, hyp_doc, collar=args.collar,
                   skip_overlap=not args.no_skip_overlap)

    count_verdict = "일치" if res["speaker_count_correct"] else f"{res['speaker_count_diff']:+d}"
    print(f"[Diarization] meeting {args.meeting}")
    print(f"  화자 수: 정답 {res['ref_speakers']}명 / 가설 {res['hyp_speakers']}명 → {count_verdict}")
    if res["der_percent"] is None:
        print(f"  DER/JER: 건너뜀 — {res['metrics_engine']}")
    else:
        c = res["components"]
        print(f"  DER: {res['der_percent']:.2f}%  (FA {c['false_alarm_percent']:.1f} / "
              f"Miss {c['missed_percent']:.1f} / Conf {c['confusion_percent']:.1f}, collar={c['collar']})")
        print(f"  JER: {res['jer_percent']:.2f}%")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
