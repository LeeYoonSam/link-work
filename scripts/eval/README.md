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

옵션:
- `--prefill HYP_JSON`: 화자 미리 채우기를 DB 대신 가설 파일로 한다(예: `out/hyp/hyp_53_campplus.json`, 아래 화자 임베딩 모델 비교의 `--dump-hyp` 산출물). 새로 시작할 때(진행분이 없거나 `--restart`)만 적용된다. 세그먼트 경계·전사는 DB 것을 쓰고, 화자만 그 파일에서 시간이 가장 많이 겹치는(없으면 가장 가까운) 세그먼트의 speaker 로 채운다.
- `--minutes N`: 이번 실행의 시작 위치(이어서 할 때는 저장된 위치)부터 N분 뒤에 시작하는 세그먼트에 닿으면 멈추고 저장한다. `eval_window`는 라벨한(확정한) 세그먼트 범위로 기록된다.

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

### 화자 임베딩 모델 비교 (CAM++ 교체 검토)

앱 기본 모델(CAM++)·임계값은 바꾸지 않는다. 후보 모델을 앱과 같은 Electron 런타임·같은 cli(`out/main/diarization-cli.js`)로 돌려 비교만 한다. 오디오는 로컬에서만 처리한다.

**1) 후보 모델 내려받기** — sherpa-onnx GitHub 릴리스 `speaker-recongition-models`(태그 철자 그대로)에서 받아 `scripts/eval/models/`에 둔다. 이 폴더는 gitignore 대상이다(내려받는 데이터, 커밋하지 않는다).
```bash
mkdir -p models && cd models
curl -LO https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2netv2_sv_zh-cn_16k-common.onnx
curl -LO https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_resnet34_LM.onnx
shasum -a 256 -c checksum.txt   # checksum.txt 에 받은 파일의 SHA-256 을 적어 둔다
```
CAM++(`campplus`)는 앱이 쓰는 `<userData>/models/sherpa-embedding.onnx`를 그대로 쓴다.

**2) 벤치 실행** — `diar_bench.py`가 회의마다 `node scripts/diar-regress.mjs --only <ids> --model <path> --tag <name> --dump-hyp out/hyp --chunk 200`을 부르고 결과를 모은다. `--chunk N`(기본 200, 0이면 나누지 않음)은 창 임베딩을 N개씩 cli 자식 프로세스로 나눠 뽑는다. sherpa-onnx-node가 창마다 네이티브 메모리를 돌려주지 않아 ERes2NetV2(약 8MB/창) 같은 큰 모델이 긴 회의에서 메모리 부족으로 죽기 때문이다. 모든 모델에 같게 적용하고, 임베딩 값은 나누지 않을 때와 같다. 처리 시간에는 자식 기동·모델 로드가 더해진다.
앱도 같은 이유로 창 300개마다 embed 워커를 새로 띄운다. 앱 경로의 메모리 상한은 `npm run check:diar-mem`(`scripts/diar-mem.mjs`, 회의 51, 프로세스 트리 최대 RSS 2,048MB 이하)으로 확인한다([docs/MEETING_RECORDING.md](../../docs/MEETING_RECORDING.md) §5-3).
```bash
python3 diar_bench.py --models campplus,eres2netv2,wespeaker_r34lm \
    --meetings 53,50,51,44,40,45,46 --mode label-free          # 정답 없이
python3 diar_bench.py --mode label-free,auto,oracle            # refs/ 가 있으면 DER 도
```
→ `out/diar_bench.md`, `out/diar_bench.json`(라벨 불일치 구간 목록은 json 의 `label_free.disagreement.<id>.mismatches`), 가설은 `out/hyp/hyp_<id>_<tag>.json`·`stats_<id>_<tag>.json`.

| 모드 | 측정 |
|---|---|
| `label-free` | (a) 1on1(53·50·40·45·46) 최종 화자 수가 2명 (b) 회의 50 목소리를 프로필로 회의 53 두 화자를 대조한 매칭·교차 코사인과 margin (c) 회의 51 처리 시간(≤180초)·최대 창(≤2.25초) (d) CAM++ 대비 세그먼트 라벨 불일치율(헝가리안 매칭 후) |
| `auto` | 자동 화자 수 가설의 DER/JER(`refs/meeting_<id>.json`이 있는 회의, collar 0.25) |
| `oracle` | ref 화자 수를 `--num`으로 고정해 다시 돌린 가설의 DER/JER |

탈락 조건: 1on1에서 2명이 아닌 회의가 2건 이상, 회의 51 처리 180초 초과, 크래시(cli 실패로 가설 없음). 모델 파일이 없으면 그 모델만 `missing`으로 건너뛴다.

개별 도구:
- `node scripts/diar-regress.mjs --only 53 --model <onnx> --tag <name> [--num N] --dump-hyp out/hyp` — 기본 모델이 아니면 회의 간 목소리 매칭 단언은 참고로만 출력하고 판정에서 뺀다. `--dump-hyp`이면 기대값이 없는 회의(예: 44)도 화자 수 단언 없이 돈다. 앱 쪽 계약은 [docs/MEETING_RECORDING.md](../../docs/MEETING_RECORDING.md) §5-3.
- `python3 eval_diar.py --meeting 53 --hyp out/hyp/hyp_53_eres2netv2.json` — 기본 가설(`out/meeting_<id>/hyp.json`) 대신 이 파일로 DER 을 잰다.

**3) 정답 라벨** — 현행 가설로 화자를 미리 채우고 라벨한다. 회의 53은 전체, 50과 44는 앞 10분, 51은 중간 10분이다.
```bash
python3 label.py --meeting 53 --prefill out/hyp/hyp_53_campplus.json
python3 label.py --meeting 50 --prefill out/hyp/hyp_50_campplus.json --minutes 10
python3 label.py --meeting 44 --prefill out/hyp/hyp_44_campplus.json --minutes 10
python3 label.py --meeting 51 --prefill out/hyp/hyp_51_campplus.json   # g N 으로 중간 지점 세그먼트로 이동 → q
python3 label.py --meeting 51 --minutes 10                            # 저장된 위치에서 10분
```
- 한 세그먼트에 두 사람의 말이 섞였으면 `x`(정답에서 제외)를 누른다.
- 라벨 단위는 DB 세그먼트다. 세그먼트 안에서 화자가 바뀌는 것은 정답에 담기지 않는다(앱도 세그먼트 단위로 귀속하므로 같은 한계다).

**교체 판정 기준** — 모두 충족해야 교체를 검토한다(근거는 [docs/references/meeting-benchmark/decisions.md](../../docs/references/meeting-benchmark/decisions.md) #15):
- 4개 회의(53·50·44·51)의 가중 평균 oracle DER이 CAM++보다 절대 3%p 이상 좋다.
- 어느 회의도 oracle DER이 2%p 넘게 나빠지지 않는다.
- auto DER이 나빠지지 않는다.
- 1on1 5건이 모두 2명으로 나뉜다.
- 회의 51 처리 시간이 180초 이하이고 크래시가 0건이다.

교체하면 구성원 목소리 표본의 모델 id 가 달라져 기존 표본과 비교하지 않으므로, 재등록 안내와 재동의가 필요하다.

### 요약 형식
`eval_summary.py`는 `meeting_summaries`의 키워드·TL;DR·결정사항·액션아이템·미결 질문·주제별 요약(옛 요약은 핵심 포인트·다음 단계)을
앱 회의록 Markdown과 같은 순서로 직렬화해 채점에 넘긴다. 시각(`at_ms`·`start_ms`)이 있으면 `[mm:ss]`로 붙인다.
`decisions`는 옛 요약의 문자열 배열과 새 요약의 `{text, at_ms}` 배열을 모두 읽는다. `topics`·`open_questions`·`keywords`
컬럼이 없는 옛 DB도 그대로 읽는다(빈 배열).

요약 형식(템플릿)은 요약할 때 정해진다. 수동 고정(`manual`) → 사용자 제목 정규식(`title`) → 같은 요약 호출에서 모델이 선택(`auto`) 순이고,
결과는 `meeting_summaries.template_id`(실제로 쓴 형식)·`template_source`·`template_reason`(선택 이유)에 남는다.
`eval_summary.py`는 이 세 컬럼을 채점에 쓰지 않는다. 형식별로 비교하려면 `sqlite3 -readonly`로 세 컬럼을 함께 읽어 회의를 나눈다.
규칙은 [docs/MEETING_RECORDING.md](../../docs/MEETING_RECORDING.md) §6-1.

요약 프롬프트의 출력 형식(주제 수·포인트 수·키워드 수·시각이 전사 줄에 있는지·기본 화자 라벨 담당자)은 앱 쪽 실측 테스트로 확인한다:
```bash
LINKWORK_LIVE_SUMMARY_ID=52 npx vitest run src/main/services/meeting-summary.live.test.ts
```
환경변수가 없으면 건너뛴다. DB는 `sqlite3 -readonly`로 읽고, 응답 본문은 저장하지 않고 개수·비율만 출력한다.

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
  label.py       대화형 라벨링 도구(구간 재생 + 화자 지정, --prefill·--minutes) ← 정답 만들기
  diar_bench.py  화자 임베딩 모델 비교 벤치(라벨 없는 지표 + auto/oracle DER)
  export_meeting.py   DB → 가설 추출 + ref 부트스트랩(대안)
  eval_stt.py / eval_diar.py / eval_meeting.py / eval_summary.py
  run_all.py     통합 러너 + 마크다운 리포트
  refs/          정답 라벨 (gitignore — 회의 내용은 민감 데이터)
  out/           가설·리포트 산출물 (gitignore)
  models/        후보 화자 임베딩 모델 + checksum.txt (gitignore)
```

## 데이터셋 확장

자체 회의 외에 절대 성능 보정을 원하면 한국어 공개 회의 데이터를 사용한다:
- **AI Hub 한국어 회의 음성**(회의 도메인, 화자/전사 라벨 포함) — 이 앱과 도메인 일치
- **KsponSpeech**(자유발화 2인 대화, CER 벤치마크 표준)

공개셋 오디오를 앱으로 처리한 뒤, 제공된 전사/RTTM을 `refs/` 포맷으로 변환해 동일 하네스로 평가.
```
