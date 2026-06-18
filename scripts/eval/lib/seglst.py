"""공통 세그먼트 포맷 ↔ RTTM / SegLST / 전체텍스트 변환.

핵심 설계: ref(정답)와 hyp(가설)를 동일한 단일 JSON 포맷으로 표현한다.
이 하나의 라벨링으로 세 가지 평가를 모두 파생한다:
  - 전체 텍스트  → CER/WER (STT 품질)
  - RTTM         → DER/JER (화자분리 품질, pyannote.metrics)
  - SegLST       → cpWER/ORC-WER (화자귀속 종단 품질, MeetEval)

JSON 포맷 (refs/meeting_<id>.json, out/meeting_<id>/hyp.json 공통):
{
  "meeting_id": 4,
  "audio": "4.wav",
  "duration_ms": 1988640,
  "segments": [
    {"start_ms": 0, "end_ms": 3200, "speaker": "이름A", "text": "발화 내용"},
    ...
  ]
}

화자 라벨 문자열은 ref와 hyp가 서로 달라도 된다 — DER은 헝가리안 최적매칭,
cpWER은 화자 순열 최적매칭으로 라벨을 정렬하므로 '이름'과 'spk_0'이 매칭된다.
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from typing import Any

from .db import Meeting, Segment


@dataclass
class EvalDoc:
    meeting_id: int
    audio: str
    duration_ms: int
    segments: list[dict[str, Any]]   # {start_ms, end_ms, speaker, text}
    # 부분 라벨링: [start_ms, end_ms]. ref에만 설정되며, 평가 시 hyp을 이 창으로
    # 잘라 비교한다(앞 5분만 라벨링해도 그 구간만 공정하게 측정). None=전체.
    eval_window: Optional[list[int]] = None

    @property
    def session_id(self) -> str:
        return f"meeting_{self.meeting_id}"

    @property
    def num_speakers(self) -> int:
        return len({s["speaker"] for s in self.segments if s.get("speaker")})


def from_meeting(m: Meeting) -> EvalDoc:
    """앱 DB에서 로드한 Meeting → hypothesis EvalDoc."""
    return EvalDoc(
        meeting_id=m.id,
        audio=m.audio_path or f"{m.id}.wav",
        duration_ms=m.duration_ms,
        segments=[
            {
                "start_ms": s.start_ms,
                "end_ms": s.end_ms,
                "speaker": s.speaker,
                "text": s.text,
            }
            for s in m.segments
        ],
    )


def load(path: str) -> EvalDoc:
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    win = data.get("eval_window")
    return EvalDoc(
        meeting_id=int(data["meeting_id"]),
        audio=data.get("audio", ""),
        duration_ms=int(data.get("duration_ms", 0)),
        segments=list(data.get("segments", [])),
        eval_window=[int(win[0]), int(win[1])] if win else None,
    )


def save(doc: EvalDoc, path: str) -> None:
    data = asdict(doc)
    if data.get("eval_window") is None:
        data.pop("eval_window", None)  # 전체 라벨링이면 필드 생략(깔끔)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def clip(doc: EvalDoc, start_ms: int, end_ms: int) -> EvalDoc:
    """시간창 [start_ms, end_ms]에 겹치는 세그먼트만 남긴 새 EvalDoc."""
    segs = [s for s in doc.segments if s["end_ms"] > start_ms and s["start_ms"] < end_ms]
    return EvalDoc(doc.meeting_id, doc.audio, doc.duration_ms, segs,
                   eval_window=[start_ms, end_ms])


def apply_window(ref_doc: EvalDoc, hyp_doc: EvalDoc) -> EvalDoc:
    """ref에 eval_window가 있으면 hyp을 그 창으로 클리핑해 반환. 없으면 hyp 그대로.

    부분 라벨링에서 ref는 일부 구간만 정답을 갖는데, hyp(전체)와 그대로 비교하면
    라벨 안 한 구간의 hyp 발화가 전부 오류로 잡힌다. 이를 막기 위해 hyp을 ref 창으로 자른다.
    """
    if ref_doc.eval_window is None:
        return hyp_doc
    return clip(hyp_doc, ref_doc.eval_window[0], ref_doc.eval_window[1])


# ── 파생 포맷 ────────────────────────────────────────────────────────────────

def full_text(doc: EvalDoc) -> str:
    """시간순 전체 전사 텍스트 (CER/WER 입력)."""
    segs = sorted(doc.segments, key=lambda s: s["start_ms"])
    return " ".join(s["text"].strip() for s in segs if s.get("text", "").strip())


def to_rttm(doc: EvalDoc) -> str:
    """NIST RTTM (DER 입력). 시간은 초 단위. uri = session_id."""
    lines = []
    for s in sorted(doc.segments, key=lambda x: x["start_ms"]):
        start = s["start_ms"] / 1000.0
        dur = max(0.0, (s["end_ms"] - s["start_ms"]) / 1000.0)
        if dur <= 0:
            continue
        spk = str(s.get("speaker", "spk_0")).replace(" ", "_")
        lines.append(
            f"SPEAKER {doc.session_id} 1 {start:.3f} {dur:.3f} <NA> <NA> {spk} <NA> <NA>"
        )
    return "\n".join(lines) + "\n"


def to_seglst(doc: EvalDoc) -> list[dict[str, Any]]:
    """MeetEval SegLST (cpWER/ORC-WER 입력). 시간은 초 단위."""
    out = []
    for s in sorted(doc.segments, key=lambda x: x["start_ms"]):
        out.append(
            {
                "session_id": doc.session_id,
                "speaker": str(s.get("speaker", "spk_0")),
                "start_time": round(s["start_ms"] / 1000.0, 3),
                "end_time": round(s["end_ms"] / 1000.0, 3),
                "words": s.get("text", "").strip(),
            }
        )
    return out


def write_derived(doc: EvalDoc, out_dir: str, prefix: str) -> dict[str, str]:
    """RTTM / SegLST / transcript 파일을 out_dir에 쓰고 경로를 반환."""
    import os

    os.makedirs(out_dir, exist_ok=True)
    paths = {
        "rttm": os.path.join(out_dir, f"{prefix}.rttm"),
        "seglst": os.path.join(out_dir, f"{prefix}.seglst.json"),
        "transcript": os.path.join(out_dir, f"{prefix}.transcript.txt"),
    }
    with open(paths["rttm"], "w", encoding="utf-8") as f:
        f.write(to_rttm(doc))
    with open(paths["seglst"], "w", encoding="utf-8") as f:
        json.dump(to_seglst(doc), f, ensure_ascii=False, indent=2)
    with open(paths["transcript"], "w", encoding="utf-8") as f:
        f.write(full_text(doc))
    return paths
