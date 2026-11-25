"""SQLite 읽기 — LinkWork 앱의 회의 파이프라인 결과(가설/hypothesis)를 로드한다.

앱은 모든 결과를 userData/linkwork.db 에 절대 ms 타임스탬프로 저장하므로,
평가 하네스는 이 DB를 읽기 전용으로 열어 hypothesis를 추출한다(앱 변경 0).
"""
from __future__ import annotations

import json
import os
import sqlite3
from dataclasses import dataclass, field
from typing import Any, Optional


def default_db_path() -> str:
    """macOS 기준 LinkWork userData DB 경로. 환경변수 LINKWORK_DB로 재정의 가능."""
    env = os.environ.get("LINKWORK_DB")
    if env:
        return os.path.expanduser(env)
    return os.path.expanduser(
        "~/Library/Application Support/LinkWork/linkwork.db"
    )


def connect(db_path: Optional[str] = None) -> sqlite3.Connection:
    path = db_path or default_db_path()
    if not os.path.exists(path):
        raise FileNotFoundError(
            f"DB를 찾을 수 없습니다: {path}\n"
            "앱을 한 번 실행했는지, 또는 LINKWORK_DB 환경변수를 확인하세요."
        )
    # 읽기 전용 + WAL 동시접근 안전. uri 모드로 immutable 대신 ro 사용(앱이 켜져 있어도 읽기 가능).
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


@dataclass
class Segment:
    start_ms: int
    end_ms: int
    speaker: str          # 평가용 화자 라벨 (display_name > label > speaker_key)
    speaker_key: str      # 엔진 원본 키 (spk_0/mic/system)
    text: str
    confidence: Optional[float] = None


@dataclass
class Meeting:
    id: int
    title: str
    source: str
    duration_ms: int
    language: str
    status: str
    expected_speakers: Optional[int]
    audio_path: Optional[str]
    segments: list[Segment] = field(default_factory=list)
    speaker_count: int = 0


def list_meetings(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT id, title, source, duration_ms, status, expected_speakers, audio_path "
        "FROM meetings ORDER BY id"
    ).fetchall()
    return [dict(r) for r in rows]


def load_meeting(conn: sqlite3.Connection, meeting_id: int) -> Meeting:
    m = conn.execute(
        "SELECT id, title, source, duration_ms, language, status, expected_speakers, audio_path "
        "FROM meetings WHERE id = ?",
        (meeting_id,),
    ).fetchone()
    if m is None:
        raise ValueError(f"meeting {meeting_id} 가 DB에 없습니다.")

    seg_rows = conn.execute(
        """
        SELECT s.start_ms, s.end_ms, s.text, s.confidence,
               sp.speaker_key, sp.label, sp.display_name
        FROM meeting_segments s
        LEFT JOIN meeting_speakers sp ON s.speaker_id = sp.id
        WHERE s.meeting_id = ?
        ORDER BY s.start_ms, s.sort_order
        """,
        (meeting_id,),
    ).fetchall()

    segments: list[Segment] = []
    for r in seg_rows:
        text = (r["text"] or "").strip()
        if not text:
            continue
        speaker = r["display_name"] or r["label"] or r["speaker_key"] or "spk_0"
        segments.append(
            Segment(
                start_ms=int(r["start_ms"]),
                end_ms=int(r["end_ms"]),
                speaker=str(speaker),
                speaker_key=str(r["speaker_key"] or "spk_0"),
                text=text,
                confidence=r["confidence"],
            )
        )

    speaker_count = (
        conn.execute(
            "SELECT COUNT(*) FROM meeting_speakers WHERE meeting_id = ?", (meeting_id,)
        ).fetchone()[0]
    )

    return Meeting(
        id=int(m["id"]),
        title=str(m["title"]),
        source=str(m["source"]),
        duration_ms=int(m["duration_ms"] or 0),
        language=str(m["language"] or "ko"),
        status=str(m["status"]),
        expected_speakers=m["expected_speakers"],
        audio_path=m["audio_path"],
        segments=segments,
        speaker_count=int(speaker_count),
    )


# 요약 JSON 컬럼. 옛 DB 에는 topics·open_questions·keywords 컬럼이 없을 수 있다.
_SUMMARY_JSON_COLUMNS = (
    "keywords", "topics", "decisions", "action_items", "open_questions",
    "key_points", "next_steps",
)


def _summary_columns(conn: sqlite3.Connection) -> set[str]:
    return {r[1] for r in conn.execute("PRAGMA table_info(meeting_summaries)").fetchall()}


def _text_items(value: Any) -> list[dict[str, Any]]:
    """decisions·open_questions 정규화. 옛 요약의 문자열과 새 요약의 {text, at_ms} 를 모두 받는다."""
    items: list[dict[str, Any]] = []
    for v in value if isinstance(value, list) else []:
        if isinstance(v, str):
            text, at_ms = v, None
        elif isinstance(v, dict):
            text, at_ms = v.get("text"), v.get("at_ms")
        else:
            continue
        if isinstance(text, str) and text.strip():
            items.append({"text": text.strip(),
                          "at_ms": at_ms if isinstance(at_ms, (int, float)) else None})
    return items


def load_summary(conn: sqlite3.Connection, meeting_id: int) -> Optional[dict[str, Any]]:
    cols = [c for c in _SUMMARY_JSON_COLUMNS if c in _summary_columns(conn)]
    r = conn.execute(
        f"SELECT tldr, model{''.join(', ' + c for c in cols)} "
        "FROM meeting_summaries WHERE meeting_id = ?",
        (meeting_id,),
    ).fetchone()
    if r is None:
        return None

    def _j(name: str) -> Any:
        v = r[name] if name in cols else None
        if not v:
            return []
        try:
            parsed = json.loads(v)
        except (json.JSONDecodeError, TypeError):
            return []
        return parsed if isinstance(parsed, list) else []

    return {
        "tldr": r["tldr"] or "",
        "keywords": [k for k in _j("keywords") if isinstance(k, str)],
        "topics": [t for t in _j("topics") if isinstance(t, dict)],
        "decisions": _text_items(_j("decisions")),
        "action_items": [a for a in _j("action_items") if isinstance(a, dict)],
        "open_questions": _text_items(_j("open_questions")),
        "key_points": _j("key_points"),
        "next_steps": _j("next_steps"),
        "model": r["model"],
    }
