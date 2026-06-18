# 회의 파이프라인 평가 하네스

LinkWork의 회의 처리(전사·화자분리·요약) 성능을 **정량 측정**하는 도구. 앱의 SQLite
(`userData/linkwork.db`)를 읽기 전용으로 열어 처리 결과(가설/hypothesis)를 추출하고,
사람이 만든 정답(reference)과 비교해 표준 메트릭(CER·DER·cpWER·LLM-judge)을 계산한다.

> 앱 코드는 전혀 수정하지 않는다. DB만 읽는다.

## 무엇을 측정하나

| 레이어 | 메트릭 | 툴 | 정답 필요 |
|---|---|---|---|
| STT(전사) | **CER**/WER | 내장(또는 jiwer) | ✓ |
| 화자분리 | **DER**/JER + 화자수 정확도 | pyannote.metrics | ✓ (화자수는 ✗) |
| 종단(누가·무엇) | **cpWER**/ORC-WER | meeteval | ✓ |
| AI 요약 | faithfulness·coverage·실행항목·간결성 | claude CLI(LLM-judge) | ✗ |

CER/화자수/요약은 정답 없이도 부분 동작한다. DER·cpWER만 정답 라벨이 필수.

## 설치

```bash
cd scripts/eval
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

요약 평가는 앱과 동일한 `claude` CLI(구독 로그인)를 사용한다 — 추가 과금 없음.

## 사용법

### 1) 회의 목록 보기
```bash
python3 export_meeting.py --list
```

### 2) 정답 라벨링 — 대화형 도구 (권장)
```bash
python3 label.py --meeting 5
```
- 각 세그먼트의 **구간 오디오를 자동 재생**하고, **숫자 키로 화자를 지정**하면 자동 저장.
- 화자분리만 평가하려면 화자(Enter/숫자)만 찍으면 된다. 전사 품질도 보려면 `t`로 텍스트 수정.
- **앞부분만 하고 `q`로 종료해도** 그 구간만 평가된다(부분 라벨링 — `eval_window` 자동 기록, hyp을 같은 창으로 잘라 공정 비교).
- 다시 실행하면 이어서 진행. `--restart`로 처음부터.

키: `Enter`확정 · `1..9`화자 · `n`새화자 · `r`재생 · `t`전사수정 · `x`제외 · `b`이전 · `g N`이동 · `q`저장종료

> 팁: 222개가 부담되면 앞 5분만 라벨하고 `q`. 그 구간 DER/CER이 바로 측정된다.

### (대안) 수동 JSON 편집
```bash
python3 export_meeting.py --meeting 5 --bootstrap-ref   # refs/meeting_5.json 템플릿 생성
```
`refs/meeting_5.json` 의 각 segment `speaker`/`text` 를 정답으로 직접 수정. `start_ms`/`end_ms`
는 대략적이어도 되고(DER collar·cpWER이 시간 오차 흡수), 화자 라벨 문자열은 가설과 달라도 된다(최적 매칭).

### 3) 평가 실행
```bash
python3 run_all.py --meeting 5 --no-summary   # CER/DER/cpWER (빠름)
python3 run_all.py --meeting 5                # + 요약 LLM-judge
python3 run_all.py --all --no-summary         # 모든 회의
```
→ `out/report_meeting_5.{md,json}` 생성, 콘솔 출력.

개별 실행도 가능:
```bash
python3 eval_stt.py --meeting 5
python3 eval_diar.py --meeting 5 --collar 0.25
python3 eval_meeting.py --meeting 5            # cpWER (--orc 로 ORC-WER 추가; 발화 많으면 느림)
python3 eval_summary.py --meeting 5
```

## 회귀 측정 워크플로

파이프라인 파라미터(`threshold`, `compressionRatio`, `initial_prompt` 등)를 바꾼 뒤:
1. 앱에서 해당 회의를 **재처리**(같은 오디오, 변경된 코드)
2. `python3 run_all.py --meeting 4 --no-summary`
3. 이전 `report_meeting_4.json` 과 비교 → 개선/악화 정량 확인

정답(ref)은 한 번 만들면 재사용하므로, 이후 모든 변경을 **동일 기준**으로 비교할 수 있다.

## 디렉토리

```
scripts/eval/
  lib/           db.py(DB읽기) normalize.py(CER) seglst.py(RTTM/SegLST 변환+부분라벨링)
  label.py       대화형 라벨링 도구(구간 재생 + 화자 지정) ← 정답 만들기
  export_meeting.py   DB → 가설 추출 + ref 부트스트랩(대안)
  eval_stt.py / eval_diar.py / eval_meeting.py / eval_summary.py
  run_all.py     통합 러너 + 마크다운 리포트
  refs/          정답 라벨 (gitignore — 회의 내용은 민감 데이터)
  out/           가설·리포트 산출물 (gitignore)
```

## 데이터셋 확장

자체 회의 외에 절대 성능 보정을 원하면 한국어 공개 회의 데이터를 사용한다:
- **AI Hub 한국어 회의 음성**(회의 도메인, 화자/전사 라벨 포함) — 이 앱과 도메인 일치
- **KsponSpeech**(자유발화 2인 대화, CER 벤치마크 표준)

공개셋 오디오를 앱으로 처리한 뒤, 제공된 전사/RTTM을 `refs/` 포맷으로 변환해 동일 하네스로 평가.
```
