#!/usr/bin/env python3
"""DB의 회의 처리 결과(hypothesis)를 표준 평가 포맷으로 익스포트한다.

사용법:
    python3 export_meeting.py --list                 # DB의 회의 목록
    python3 export_meeting.py --meeting 4            # hyp 추출 → out/meeting_4/
    python3 export_meeting.py --meeting 4 --bootstrap-ref
        # refs/meeting_4.json 이 없으면 hyp를 복사해 ref 템플릿 생성.
        # → 사람이 이 파일의 speaker/text 를 정답으로 수정하면 라벨링 완료.

출력(out/meeting_<id>/):
    hyp.json              가설 EvalDoc (DB 결과 그대로)
    hyp.rttm              화자분리 가설 (DER 입력)
    hyp.seglst.json       화자귀속 가설 (cpWER 입력)
    hyp.transcript.txt    전체 전사 (CER 입력)
"""
from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from lib import db, seglst  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
REFS_DIR = os.path.join(HERE, "refs")
OUT_DIR = os.path.join(HERE, "out")


def cmd_list(conn) -> None:
    meetings = db.list_meetings(conn)
    if not meetings:
        print("DB에 회의가 없습니다.")
        return
    print(f"{'id':>4}  {'source':<10} {'dur(min)':>8}  {'status':<12} {'exp_spk':>7}  title")
    print("-" * 72)
    for m in meetings:
        dur_min = (m["duration_ms"] or 0) / 60000.0
        print(
            f"{m['id']:>4}  {m['source']:<10} {dur_min:>8.1f}  {m['status']:<12} "
            f"{str(m['expected_speakers']):>7}  {m['title']}"
        )


def cmd_export(conn, meeting_id: int, bootstrap_ref: bool) -> None:
    meeting = db.load_meeting(conn, meeting_id)
    doc = seglst.from_meeting(meeting)

    out_dir = os.path.join(OUT_DIR, f"meeting_{meeting_id}")
    os.makedirs(out_dir, exist_ok=True)

    seglst.save(doc, os.path.join(out_dir, "hyp.json"))
    paths = seglst.write_derived(doc, out_dir, "hyp")

    print(f"✓ meeting {meeting_id} '{meeting.title}' 익스포트 완료")
    print(f"  세그먼트 {len(doc.segments)}개 · 가설 화자수 {doc.num_speakers}명 "
          f"(앱 speaker 레코드 {meeting.speaker_count}개) · expected={meeting.expected_speakers}")
    print(f"  → {out_dir}/")
    for k, p in {"hyp.json": os.path.join(out_dir, "hyp.json"), **paths}.items():
        print(f"      {os.path.basename(p)}")

    if bootstrap_ref:
        os.makedirs(REFS_DIR, exist_ok=True)
        ref_path = os.path.join(REFS_DIR, f"meeting_{meeting_id}.json")
        if os.path.exists(ref_path):
            print(f"\n  ⚠ ref가 이미 존재합니다(덮어쓰지 않음): {ref_path}")
        else:
            seglst.save(doc, ref_path)
            print(
                f"\n  ✎ ref 템플릿 생성: {ref_path}\n"
                "    이 파일의 각 segment의 'speaker'(실제 화자)와 'text'(정확한 전사)를\n"
                "    오디오를 들으며 정답으로 수정하세요. 수정 후 run_all.py로 평가합니다.\n"
                "    (start_ms/end_ms는 대략적이어도 DER collar/ cpWER이 흡수합니다)"
            )


def main() -> int:
    ap = argparse.ArgumentParser(description="회의 처리 결과를 평가 포맷으로 익스포트")
    ap.add_argument("--db", help="linkwork.db 경로 (기본: userData)")
    ap.add_argument("--list", action="store_true", help="회의 목록 출력")
    ap.add_argument("--meeting", type=int, help="익스포트할 meeting id")
    ap.add_argument("--bootstrap-ref", action="store_true",
                    help="ref 템플릿을 hyp 복사로 생성(없을 때만)")
    args = ap.parse_args()

    conn = db.connect(args.db)
    try:
        if args.list:
            cmd_list(conn)
            return 0
        if args.meeting is None:
            ap.error("--meeting 또는 --list 가 필요합니다.")
        cmd_export(conn, args.meeting, args.bootstrap_ref)
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
