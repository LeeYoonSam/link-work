#!/usr/bin/env python3
"""AI 요약 품질 평가 — LLM-as-judge (G-Eval 스타일).

전사를 근거로 요약을 4축 채점한다. 요약 평가의 1순위는 faithfulness(사실성):
전사에 없는 내용을 지어내지 않았는가. ROUGE 단독은 의미를 못 잡으므로 LLM-judge를
사용한다(G-Eval이 인간 상관 최고). 단, LLM 단순 판정은 환각 탐지 정확도가 낮으므로
'각 주장의 전사 근거'를 명시적으로 나열하게 해 신뢰도를 높인다.

앱과 동일한 claude CLI(구독 OAuth)를 subprocess로 호출 → 추가 과금 0.
claude 미설치/미로그인 시 graceful degrade(점수 None).

ref 요약(refs/summary_<id>.json)이 있으면 coverage를 정답 대비로도 비교한다(선택).

단독 실행:
    python3 eval_summary.py --meeting 4 [--model claude-sonnet-4-6]
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from typing import Any, Optional

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from lib import db, seglst  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
MAX_TRANSCRIPT_CHARS = 80000  # 앱(meeting-summary.ts)과 동일 가드

JUDGE_SYSTEM = """당신은 엄격한 회의록 요약 평가자입니다.
[전사]를 유일한 근거로 [요약]을 평가합니다. 전사에 없는 내용은 모두 환각입니다.
오직 JSON만 출력하세요(코드펜스 금지)."""

JUDGE_TEMPLATE = """다음 회의 [전사]를 근거로 [요약]을 4개 축으로 평가하세요.
각 점수는 0~5 정수(5=완벽).

평가 축:
1. faithfulness(사실성): 요약의 모든 진술이 전사에 근거하는가. 전사에 없는 내용(환각)을 모두 찾아 나열.
2. coverage(포괄성): 전사의 핵심 논의·결정·할일이 요약에 담겼는가. 누락된 핵심을 나열.
3. action_item_quality(실행항목): 액션아이템이 실제 합의된 할일을 담당자/기한까지 정확히 반영하는가.
4. conciseness(간결성): 군더더기 없이 핵심만 담았는가.

출력 JSON 스키마(이 키만, 정확히):
{{"faithfulness":{{"score":int,"hallucinations":[string],"reason":string}},
"coverage":{{"score":int,"missing":[string],"reason":string}},
"action_item_quality":{{"score":int,"reason":string}},
"conciseness":{{"score":int,"reason":string}},
"overall":int}}

[전사]
{transcript}

[요약]
{summary}
"""


def _find_claude() -> Optional[str]:
    for p in (
        shutil.which("claude"),
        "/opt/homebrew/bin/claude",
        "/usr/local/bin/claude",
        os.path.expanduser("~/.local/bin/claude"),
        os.path.expanduser("~/.claude/local/claude"),
    ):
        if p and os.path.exists(p):
            return p
    return None


def _call_claude(claude: str, model: str, system: str, prompt: str, timeout: int = 300) -> str:
    """claude CLI print 모드 호출 → 응답 텍스트 반환. 빌링 env는 제거(구독 OAuth 사용)."""
    env = {k: v for k, v in os.environ.items()
           if k not in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN",
                        "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX")}
    proc = subprocess.run(
        [claude, "-p", "--output-format", "json",
         "--model", model, "--append-system-prompt", system],
        input=prompt, capture_output=True, text=True, timeout=timeout, env=env,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"claude 호출 실패(code {proc.returncode}): {proc.stderr.strip()[:300]}")
    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return proc.stdout
    # --output-format json 은 CLI 버전에 따라 단일 result 객체 또는
    # 전체 메시지 배열([{type:system}, {type:assistant}, …, {type:result, result}])을 반환한다.
    if isinstance(data, dict):
        return data.get("result", proc.stdout)
    if isinstance(data, list):
        for item in reversed(data):
            if isinstance(item, dict) and item.get("type") == "result" and item.get("result"):
                return item["result"]
        # 폴백: assistant 텍스트 블록 수집
        texts: list[str] = []
        for item in data:
            if isinstance(item, dict) and item.get("type") == "assistant":
                for block in item.get("message", {}).get("content", []):
                    if isinstance(block, dict) and block.get("type") == "text":
                        texts.append(block.get("text", ""))
        return "".join(texts) or proc.stdout
    return proc.stdout


def _extract_json(text: str) -> dict[str, Any]:
    fence = text.find("```")
    if fence != -1:
        end = text.find("```", fence + 3)
        if end != -1:
            inner = text[fence + 3:end]
            inner = inner.split("\n", 1)[-1] if inner.lstrip().startswith("json") else inner
            text = inner
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end != -1 and end > start:
        text = text[start:end + 1]
    return json.loads(text)


def _serialize_summary(summary: dict[str, Any]) -> str:
    parts = [f"TL;DR: {summary.get('tldr', '')}"]
    if summary.get("key_points"):
        parts.append("핵심:\n" + "\n".join(f"- {x}" for x in summary["key_points"]))
    if summary.get("decisions"):
        parts.append("결정:\n" + "\n".join(f"- {x}" for x in summary["decisions"]))
    if summary.get("action_items"):
        ai = []
        for it in summary["action_items"]:
            who = it.get("assignee") or "?"
            due = it.get("due") or "-"
            ai.append(f"- {it.get('text', '')} (담당:{who}, 기한:{due})")
        parts.append("실행항목:\n" + "\n".join(ai))
    if summary.get("next_steps"):
        parts.append("다음단계:\n" + "\n".join(f"- {x}" for x in summary["next_steps"]))
    return "\n\n".join(parts)


def _fit(text: str) -> str:
    if len(text) <= MAX_TRANSCRIPT_CHARS:
        return text
    head = text[: MAX_TRANSCRIPT_CHARS // 2]
    tail = text[-MAX_TRANSCRIPT_CHARS // 2:]
    return head + "\n…(중략)…\n" + tail


def evaluate(meeting_id: int, *, model: str = "claude-sonnet-4-6",
             db_path: Optional[str] = None) -> dict[str, Any]:
    conn = db.connect(db_path)
    try:
        meeting = db.load_meeting(conn, meeting_id)
        summary = db.load_summary(conn, meeting_id)
    finally:
        conn.close()

    result: dict[str, Any] = {"has_summary": summary is not None, "judge_model": model,
                              "scores": None, "engine": None}
    if summary is None:
        result["engine"] = "no summary in DB"
        return result

    claude = _find_claude()
    if not claude:
        result["engine"] = "claude CLI 없음 (요약 평가 건너뜀)"
        return result

    doc = seglst.from_meeting(meeting)
    transcript = _fit(seglst.full_text(doc))
    prompt = JUDGE_TEMPLATE.format(transcript=transcript, summary=_serialize_summary(summary))

    try:
        raw = _call_claude(claude, model, JUDGE_SYSTEM, prompt)
        scores = _extract_json(raw)
        result["scores"] = scores
        result["engine"] = "claude-cli"
    except Exception as e:  # noqa: BLE001 — graceful degrade
        result["engine"] = f"평가 실패: {e}"
    return result


def main() -> int:
    ap = argparse.ArgumentParser(description="AI 요약 LLM-as-judge 평가")
    ap.add_argument("--meeting", type=int, required=True)
    ap.add_argument("--model", default="claude-sonnet-4-6")
    ap.add_argument("--db")
    args = ap.parse_args()

    res = evaluate(args.meeting, model=args.model, db_path=args.db)
    print(f"[Summary] meeting {args.meeting}  (engine={res['engine']})")
    s = res.get("scores")
    if not s:
        return 0
    f = s.get("faithfulness", {})
    c = s.get("coverage", {})
    print(f"  faithfulness : {f.get('score')}/5  환각 {len(f.get('hallucinations', []))}건")
    for h in f.get("hallucinations", [])[:5]:
        print(f"      ⚠ {h}")
    print(f"  coverage     : {c.get('score')}/5  누락 {len(c.get('missing', []))}건")
    for mtxt in c.get("missing", [])[:5]:
        print(f"      ↳ {mtxt}")
    print(f"  action_item  : {s.get('action_item_quality', {}).get('score')}/5")
    print(f"  conciseness  : {s.get('conciseness', {}).get('score')}/5")
    print(f"  overall      : {s.get('overall')}/5")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
