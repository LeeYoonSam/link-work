"""한국어 텍스트 정규화 + CER/WER 계산.

CER 비교 전 정규화는 필수다. 정규화를 안 하면 구두점/공백 차이만으로 오류율이
부풀려진다. 한국어는 어절 경계가 모호해 CER(문자 오류율)을 1차 지표로 쓴다.

jiwer가 설치돼 있으면 사용하고, 없으면 표준 라이브러리만으로 동작하는 자체
Levenshtein 구현으로 폴백한다 → 최소한 STT 평가는 의존성 없이 즉시 가능.
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

# 구두점/특수문자 (전사 비교에서 제거)
_PUNCT_RE = re.compile(r"[\s.,!?…·~\"'`()\[\]{}\-–—:;/\\|<>@#$%^&*+=_]+")
# whisper/사람 전사에 섞이는 비언어 표기 (괄호 안 묘사 등)
_BRACKET_NOISE_RE = re.compile(r"\([^)]*\)|\[[^\]]*\]|（[^）]*）")


def normalize_text(text: str, *, keep_space: bool = False) -> str:
    """비교용 정규화.

    - NFKC 유니코드 정규화(전각→반각 등)
    - 괄호 안 비언어 묘사 제거
    - 소문자화(영문 혼용 대비)
    - 구두점 제거. keep_space=False면 공백도 제거(문자 단위 CER 표준).
    """
    if not text:
        return ""
    t = unicodedata.normalize("NFKC", text)
    t = _BRACKET_NOISE_RE.sub(" ", t)
    t = t.lower()
    if keep_space:
        # 구두점만 공백으로, 공백은 단일화
        t = _PUNCT_RE.sub(" ", t)
        t = re.sub(r"\s+", " ", t).strip()
    else:
        t = _PUNCT_RE.sub("", t)
    return t


def _levenshtein(ref: list[str], hyp: list[str]) -> int:
    """편집 거리(치환/삽입/삭제 비용 1). 2-row DP로 메모리 O(min(len))."""
    if len(ref) < len(hyp):
        ref, hyp = hyp, ref
    prev = list(range(len(hyp) + 1))
    for i, rc in enumerate(ref, 1):
        cur = [i] + [0] * len(hyp)
        for j, hc in enumerate(hyp, 1):
            cost = 0 if rc == hc else 1
            cur[j] = min(
                prev[j] + 1,        # 삭제
                cur[j - 1] + 1,     # 삽입
                prev[j - 1] + cost,  # 치환/일치
            )
        prev = cur
    return prev[-1]


@dataclass
class ErrorRate:
    rate: float          # 0..1
    errors: int
    ref_len: int

    @property
    def percent(self) -> float:
        return round(self.rate * 100, 2)


def _has_jiwer() -> bool:
    try:
        import jiwer  # noqa: F401
        return True
    except ImportError:
        return False


def cer(reference: str, hypothesis: str, *, keep_space: bool = False) -> ErrorRate:
    """문자 오류율(Character Error Rate)."""
    ref = normalize_text(reference, keep_space=keep_space)
    hyp = normalize_text(hypothesis, keep_space=keep_space)
    ref_chars = list(ref)
    hyp_chars = list(hyp)
    if not ref_chars:
        return ErrorRate(rate=0.0 if not hyp_chars else 1.0, errors=len(hyp_chars), ref_len=0)
    dist = _levenshtein(ref_chars, hyp_chars)
    return ErrorRate(rate=dist / len(ref_chars), errors=dist, ref_len=len(ref_chars))


def wer(reference: str, hypothesis: str) -> ErrorRate:
    """어절(공백 단위) 오류율. 한국어에서는 보조 지표."""
    ref = normalize_text(reference, keep_space=True).split()
    hyp = normalize_text(hypothesis, keep_space=True).split()
    if not ref:
        return ErrorRate(rate=0.0 if not hyp else 1.0, errors=len(hyp), ref_len=0)
    dist = _levenshtein(ref, hyp)
    return ErrorRate(rate=dist / len(ref), errors=dist, ref_len=len(ref))
