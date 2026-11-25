# Otter.ai 벤치마크 — 화자 식별 · 요약 포맷 · 핵심 기능

- **조사일**: 2026-11-26
- **성격**: 공개 자료 기반 블랙박스 분석. 공식 도움말·블로그·특허·언론·리뷰·소송 보도만 썼다. 앱 바이너리 분해, 계정 로그인 후 관찰, 약관 위반 행위는 하지 않았다.
- **표기 규칙**: 출처 URL이 붙은 문장은 사실이다. **[추론]** 표시가 붙은 문장은 공개 자료에서 유추한 내부 구조이며 확인되지 않았다.
- **조사 한계**
  - Otter 도움말 센터(`help.otter.ai`)는 자동 수집을 403으로 막는다. 도움말 문서의 내용은 **검색 결과에 노출된 발췌**로만 확인했다. 문서 전문과 스크린샷은 보지 못했다.
  - Otter가 실제로 만든 요약 출력의 원문은 공개 자료에서 찾지 못했다(리뷰는 스크린샷만 싣는다). §2의 구조 재현은 필드 이름과 설명을 조합한 **모형**이다.
  - 도움말 문서는 작성 시기가 섞여 있어 서로 어긋나는 서술이 있다(예: 화자 삭제 가능 여부, 실시간 화자 표시). 어긋나는 곳은 본문에 적었다.

우리 기준선은 [MEETING_RECORDING.md](../../MEETING_RECORDING.md) §0·§5-3·§6·§10이다.

---

## 0. 한눈에 보기

| 항목 | Otter.ai | LinkWork 현재 |
|---|---|---|
| STT | 자체 개발·자체 인프라 운영 클라우드 모델 | 로컬 whisper large-v3-turbo |
| 회의 내 화자분리 | 녹음 종료 후 2차 패스로 분리, `Speaker 1…` 부여 | sherpa-onnx(pyannote-seg-3.0 + CAM++), 채널 분리, 2-스테이지 |
| 회의 간 동일인 식별 | **있음** — 태그하면 음성 프로필(speaker enrollment)이 쌓이고 다음 회의부터 자동 라벨 | **없음** — 회의마다 `spk_N`을 새로 만든다 |
| 과거 회의 소급 적용 | Rematch 버튼 | 없음 |
| 화상회의 참석자 이름 활용 | Notetaker 봇이 플랫폼의 참석자 이름으로 라벨 | 없음(봇이 없다). 마이크/시스템 채널 분리만 있다 |
| 요약 구조 | Overview → Action Items → Insights → Outline(+Custom Prompt) | tldr → key_points → decisions → action_items → next_steps |
| 요약 → 전사 연결 | Outline 항목·자동 액션아이템에서 전사 위치로 점프 | 회의 요약에는 없다(면접 요약만 `[mm:ss]` 보유) |
| 템플릿 | 회의 유형별 템플릿, 섹션 on/off, 사용자 질문(Custom Prompt), 자동 적용 규칙 | `kind` 2종(회의/면접) 고정 |
| 회의에 질문 | Otter AI Chat(단일 회의·여러 회의·채널·폴더 범위, 출처 표시) | 없음(회의록 LIKE 검색만) |

---

## 1. 화자 분리 · 화자 식별

### 1-1. 관찰되는 동작

**회의 내 분리**
- 태그된 적 없는 화자는 `Speaker 1`, `Speaker 2`… 또는 `Unknown Speaker`로 표시된다. 한 문단을 태그하면 그 회의에서 같은 `Speaker #`인 문단이 모두 함께 바뀐다. — https://help.otter.ai/hc/en-us/articles/360048465453-Tagging-speaker-names-in-a-conversation
- 화자 식별 처리는 **녹음이 멈추거나 파일 가져오기가 끝난 뒤** 시작한다. — https://help.otter.ai/hc/en-us/articles/37817241040535-Best-Practices-to-Maximize-Speaker-Identification
- 2020년 인터뷰에서 Otter 제품 VP는 "실시간에는 라벨이 보이지 않고, 녹음이 끝난 뒤 한 번 더 패스를 돌려 화자를 가른다"고 설명했다. — https://www.verdict.co.uk/otter-ai-transcription/
- 예외: 화상회의에 Notetaker 봇이 들어가면 **플랫폼이 주는 참석자 이름**으로 실시간 라벨을 붙인다(도움말은 Zoom을 예로 든다). 최신 도움말은 "화상회의 플랫폼이 제공한 참석자 이름 또는 수동 태그"를 라벨 근거로 든다. — https://help.otter.ai/hc/en-us/articles/360048465453-Tagging-speaker-names-in-a-conversation , https://help.otter.ai/hc/en-us/articles/21665587209367-Speaker-Identification-Overview

**회의 간 동일인 식별(음성 프로필)**
- 화자를 태그하면 그 사람의 **음성 프로필**이 만들어지고, 이후 회의에서 수동 태그가 줄어든다. — https://help.otter.ai/hc/en-us/articles/360048465453-Tagging-speaker-names-in-a-conversation
- 도움말은 저장된 음성 데이터를 **speaker enrollment**라고 부른다. — https://help.otter.ai/hc/en-us/articles/40643231903639-Disable-Speaker-Learning
- 필요한 샘플 양: 공식 수치는 없다. "화자마다 태그된 문단 **몇 개**만으로 학습한다"는 서술만 있다. — https://help.otter.ai/hc/en-us/articles/37817241040535-Best-Practices-to-Maximize-Speaker-Identification
- 본인 목소리는 **voice training**(본인 음성 등록)으로 따로 학습시킬 수 있고, 그러면 전사에 본인 이름이 자동으로 붙는다. — https://help.otter.ai/hc/en-us/articles/37817241040535-Best-Practices-to-Maximize-Speaker-Identification
- 2018년 출시 때부터 같은 설명이 있다: diarization으로 화자를 나누고, 사람마다 voice print를 만들어 이후 식별에 쓴다. 사용자가 할 일은 녹음 버튼뿐이다. — https://techcrunch.com/2018/02/26/otters-new-app-lets-you-record-transcribe-search-and-share-your-voice-conversations
- 2020년 인터뷰: `Speaker 1`을 눌러 이름을 입력하면 Otter가 voiceprint를 만들고 대화 전체를 다시 라벨링하며, 이후 통화에서 그 목소리를 알아본다. — https://www.verdict.co.uk/otter-ai-transcription/

**Rematch(소급 재매칭)**
- 프로필이 생긴 뒤 **옛 회의**를 열어 Rematch를 누르면 계정·워크스페이스의 최신 화자 데이터로 `Speaker #` 라벨을 다시 붙인다. 등록되지 않은 화자는 그대로 `Speaker #`로 남는다. — https://help.otter.ai/hc/en-us/articles/21665876084119-Rematch-a-speaker

**교정 UX**
- 문단 단위로 화자 라벨을 고친다. 공식 권고는 두 가지다. ① 틀린 라벨을 고친다. ② **한 문단에 한 화자의 음성만** 들어가게 한다 — 한 문단에 여러 화자가 섞이면 이후 식별 정확도가 떨어진다. — https://help.otter.ai/hc/en-us/articles/37817241040535-Best-Practices-to-Maximize-Speaker-Identification
- 같은 사람에게는 회의마다 **같은 이름**을 써야 enrollment 매칭이 정확해진다. — 같은 문서
- Untag 문서가 따로 있다(전문 미확인). — https://help.otter.ai/hc/en-us/articles/21666115098519-Untag-a-speaker
- **Speaker Management**(점진 배포): 화자 **병합·이름 변경**이 과거·미래 회의 전체에 적용된다. 요약·아웃라인·AI Chat·검색에는 곧바로 반영되지 않을 수 있다. **숨기기**(hide)는 되돌릴 수 없고, 태그 메뉴에서 그 프로필을 빼지만 기존 태그는 그대로 둔다. — https://help.otter.ai/hc/en-us/articles/40586357592471-Speaker-Management
  - 어긋남: 옛 태깅 문서는 "화자를 삭제할 수 없다"고 적는다. 지금은 삭제 대신 숨기기가 있다.
- 태그·전사 수정 뒤에도 **기본 요약은 재생성되지 않는다**. 도움말은 Otter Chat으로 새 요약을 만들라고 안내한다. — https://help.otter.ai/hc/en-us/articles/5093228433687-Conversation-Page-Overview

**워크스페이스 공유와 끄기**
- 워크스페이스 구성원의 화자 프로필은 워크스페이스 안에서 공유돼, 다른 구성원의 회의에서도 그 사람이 태그된다. 공유 화자는 태그 팝업에 나오지만 내가 이름 변경·병합·숨기기를 할 수 없다(내가 소유한 화자만 관리). — https://help.otter.ai/hc/en-us/articles/21665587209367-Speaker-Identification-Overview , https://help.otter.ai/hc/en-us/articles/40586357592471-Speaker-Management
- Enterprise 관리자는 **Disable Speaker Learning**으로 자동 enrollment를 끌 수 있다. 끄면 enrollment를 새로 만들지 않고, 기존 enrollment는 새 녹음에 쓰지 않는다(삭제는 보존 정책을 따로 설정해야 한다). 이 상태의 수동 라벨은 **텍스트 태그**로만 저장돼 다른 회의의 식별에 쓰이지 않는다. — https://help.otter.ai/hc/en-us/articles/40643231903639-Disable-Speaker-Learning

**알려진 약점(리뷰)**
- 2인 통화에 이름 없는 세 번째 화자가 생긴다. 같은 두 사람의 두 통화 중 하나는 이름이 붙고 하나는 `Speaker 1/2`로 나온다. 발언이 다른 사람에게 귀속된다. — https://tldv.io/blog/otter-ai-review/
- 여러 명이 한 장치로 녹음한 회의, 겹침 발화, 전화 참석자에서 자주 틀린다. — https://www.g2.com/products/otter-ai/reviews
- 겹침 발화가 화자 구분을 어렵게 한다는 점은 Otter도 인정한다. — https://help.otter.ai/hc/en-us/articles/37817241040535-Best-Practices-to-Maximize-Speaker-Identification
- 정확도 수치(85–95% 등)는 제3자 사이트의 출처 없는 주장뿐이라 신뢰하지 않는다.

**법적 맥락**
- 2025년 8–9월에 제기된 집단소송이 *In re Otter.AI Privacy Litigation*(N.D. Cal.)으로 병합됐다. 원고는 Notetaker가 녹음한 화자마다 voiceprint를 만들어 저장하고, 이후 회의에서 같은 사람을 식별하는 데 쓴다고 주장한다. 보도에 따르면 법원은 2026년 8월 일부 청구를 기각하면서도 일리노이 생체정보법(BIPA) 청구는 유지했고, 화자 태깅 기능이 voiceprint 수집을 수반한다고 볼 여지가 있다고 판단했다. — https://www.sheppard.com/insights/blogs/when-ai-takes-notes-court-allows-privacy-claims-against-otterai-to-proceed , https://idtechwire.com/otter-ai-must-face-voiceprint-claims-under-illinois-biometric-law/ , https://news.bloomberglaw.com/artificial-intelligence/otter-ai-hit-with-bipa-class-suit-over-voice-print-collection
- 시사점: 음성 임베딩은 생체정보로 취급된다. LinkWork가 같은 기능을 넣으면 **로컬 저장·명시적 동의·삭제 기능**이 필수다.

### 1-2. 특허에서 확인되는 구조

US 10,978,073 B1 "Systems and methods for processing and presenting conversations" (AISense → Otter.ai, 2018-07-05 출원) — https://patents.google.com/patent/US10978073B1/en

1. 오디오를 **화자 변경 또는 자연스러운 휴지**에서 잘라, 세그먼트 하나가 한 화자의 발화가 되게 한다.
2. 라벨을 정하기 전에 세그먼트를 "같은 화자" **세그먼트 집합**으로 묶는다. 집합에 라벨을 주면 그 집합의 모든 세그먼트에 적용된다. → 1-1의 "한 문단을 태그하면 같은 `Speaker #` 전체가 바뀐다"와 일치한다.
3. 화자 라벨은 세그먼트 음성의 voiceprint를 화자 라벨에 대응하는 **기준(reference) voiceprint**와 맞춰서 정한다.
4. 새 voiceprint를 자동으로 찾았으나 사용자가 이름을 주지 않았으면 unknown 화자로 둔다(이름 없음, 자리표시 사진).
5. 자동으로 붙인 라벨은 사람이 고칠 수 있다.

특허 본문에는 클러스터링 알고리즘, 임계값, 사용자 태그가 기준 voiceprint로 바뀌는 절차가 없다.

Otter.ai 명의의 US 12,456,465 B2(2025-10-28 등록, 2021-03 출원의 계속출원)는 실시간 동기화 텍스트에 화자 라벨을 자동으로 붙이는 내용이라고 검색 결과에 요약돼 있다(전문 미확인). — https://patentsgazette.uspto.gov/week43/OG/html/1539-4/US12456465-20251028.html

### 1-3. 추정 파이프라인 [추론]

```
녹음 종료
 └─ (1) 화자 변경 지점 분할 → 세그먼트
 └─ (2) 세그먼트별 화자 임베딩 추출
 └─ (3) 회의 내 클러스터링 → 세그먼트 집합(= Speaker #)
 └─ (4) 집합의 대표 임베딩 ↔ 계정·워크스페이스 enrollment 갤러리 매칭
        ├─ 유사도 ≥ 임계값 → 이름 자동 라벨
        └─ 미만 → Speaker # 유지 (open-set)
 └─ (5) 사용자 태그 → 그 문단들의 음성으로 enrollment 생성·갱신
 └─ (6) Rematch = 저장된 집합 임베딩에 대해 (4)만 다시 실행
```

근거와 추론을 나눠 적는다.

- **(1)–(3) 분할 후 묶기**: 특허가 직접 서술한다. 임베딩 모델 종류(x-vector·ECAPA 계열 등)는 공개되지 않았다. **[추론]**
- **(4) open-set 매칭**: "등록되지 않은 화자는 `Speaker #`로 남는다"는 Rematch 문서의 서술에서, 가장 가까운 화자를 무조건 고르는 방식이 아니라 **임계값 미만이면 거절**하는 방식임을 알 수 있다. 임계값 수치는 공개되지 않았다. **[추론]**
- **(5) 문단 단위 enrollment**: "한 문단에 한 화자만", "태그된 문단 몇 개로 학습"이라는 권고에서, 태그한 문단의 오디오 구간이 그대로 등록 표본이 된다고 본다. 문단에 다른 사람이 섞이면 프로필이 오염된다는 경고가 이를 뒷받침한다. 한 사람에 표본을 여러 개 두는지, 평균 하나를 두는지는 알 수 없다. **[추론]**
- **(5) 이름이 키**: "같은 이름을 일관되게 써야 enrollment 매칭이 정확하다"는 권고와 병합 기능의 존재에서, enrollment가 **화자 엔티티(이름) 단위**로 쌓이고 이름을 다르게 쓰면 프로필이 쪼개진다고 본다. **[추론]**
- **(6) Rematch가 수동인 이유**: 프로필이 생길 때마다 과거 회의 전체를 다시 매칭하면 비용이 크고, 사용자가 손으로 고친 라벨을 덮을 위험이 있다. 그래서 회의 단위의 수동 버튼으로 둔 것으로 본다. **[추론]**
- **참석자 이름 우선**: 봇이 들어간 회의에서는 플랫폼의 발화자 신호(누가 말하는 중인지)와 참석자 이름이 음성 매칭보다 신뢰도가 높다. 이 이름 붙은 구간이 enrollment의 **자동 공급원**으로 쓰일 가능성이 높다 — 소송의 주장("Zoom 참석자 이름으로 태그해 화자 식별 프로필을 만든다")과 맞는다. **[추론]**
- **실시간 표시가 약한 이유**: 클러스터링은 회의 전체를 봐야 안정적이다. 그래서 봇이 없는 녹음은 종료 후 2차 패스에서만 라벨이 붙는다. **[추론]**

### 1-4. LinkWork에 주는 교훈

1. Otter도 **회의 내 분리 자체는 자주 틀린다**. 체감 품질을 만드는 것은 분리 알고리즘이 아니라 ① 사람 단위 음성 프로필 ② 한 번 고치면 다음 회의에 반영되는 루프 ③ Rematch다.
2. 우리 구조에는 이미 재료가 있다. `src/main/services/diarization/worker.ts`의 `refineByCentroid`가 화자별 CAM++ centroid를 계산하지만 **병합 판단에만 쓰고 버린다**. 이 centroid를 저장하면 회의 간 식별의 절반이 끝난다.
3. 등록 표본의 순도가 정확도를 정한다. Otter의 "한 문단 한 화자" 권고는 우리 쪽에서 `speaker_corrected=1` 세그먼트와 채널 분리로 확정된 마이크(L) 구간을 우선 표본으로 쓰라는 뜻으로 옮길 수 있다.
4. 마이크 채널(L)은 항상 "나"다. 본인 voice training은 우리에게 **등록 절차 없이** 얻어진다.

---

## 2. 요약 포맷

### 2-1. Summary 탭의 섹션

요약은 대화 화면의 **Summary 탭**에 있고 Transcript 탭과 나란히 있다. 녹음이 끝난 뒤 채워진다. — https://help.otter.ai/hc/en-us/articles/5093228433687-Conversation-Page-Overview , https://help.otter.ai/hc/en-us/articles/21695002816535-Learn-about-the-new-Conversation-page-layout

내보내기 대화상자와 템플릿 설정에 나오는 섹션은 다음 순서다. — https://help.otter.ai/hc/en-us/articles/39503855767191-Export-Summary , https://help.otter.ai/hc/en-us/articles/31402572907415-Custom-Meeting-Type-Templates

| 순서 | 섹션 | 내용 | API·웹훅 필드 |
|---|---|---|---|
| 1 | **Overview** | 회의 전체를 압축한 짧은 요약 | `abstract_summary` (문자열) |
| 2 | **Action Items** | 자동 추출 + 수동 추가. 대화 내용을 근거로 담당자를 자동 지정. 자동 생성 항목에는 "View in transcript" 아이콘이 있어 근거 위치로 간다(수동 항목에는 없다) | `action_items` |
| 3 | **Insights** | 템플릿이 정한 짧은 주제 + 근거 불릿(예: 고객 반론, 다음 단계) | `insights` |
| 4 | **Outline** | 주제별 구조화 목록. 항목을 누르면 전사의 그 위치로 가고 거기서 재생할 수 있다 | `outline` |
| 5 | **Custom Prompt** | 템플릿에 미리 넣은 질문("고객이 원한 것은?", "어떤 결정이 났나?")의 답 | (웹훅 문서는 `outline`을 "custom topics or questions"로 설명) |

필드 이름 출처: https://help.otter.ai/hc/en-us/articles/35634832371735-Workspace-Webhooks , https://help.otter.ai/hc/en-us/articles/36130822688279-Otter-ai-Public-API

보조 사실:
- 긴 대화는 **챕터**로 나뉘고 챕터마다 설명형 제목이 붙는다. 제목은 사용자가 고칠 수 있다. 요약의 주제를 누르면 전사의 해당 시점으로 간다. — https://otter.ai/blog/ai-to-summarize-transcripts
- Outline은 2022년 "Automatic Outline"으로 처음 나왔고, 같은 때 액션아이템·결정·핵심 순간을 모으는 "Meeting Gems" 패널이 함께 나왔다. — https://techcrunch.com/2022/03/29/otter-ai-meeting-summary-feature
- 액션아이템의 담당자 지정은 리뷰마다 평가가 갈린다. "언급됐을 때만 담당자가 붙는다", "사람에게 배정하려면 수동 검토가 필요하다"는 평이 있다. — https://www.happyscribe.com/blog/otter-ai-review
- 나에게 배정된 항목은 회의를 가로질러 모아 보는 전역 Action Items 화면에 나온다(제3자 서술). — https://thegoldsuite.com/post/how-to-use-otterai-to-transcribe-and-summarise-client-meetings
- **요약 메일**: 캘린더 초대 참석자에게 회의 종료 후 2시간 안에 Meeting Summary 메일이 간다. 액션아이템이 없고 대화가 500단어 이하면 보내지 않는다. — https://help.otter.ai/hc/en-us/articles/9156381229079-Meeting-Summary-Overview
- **재생성 정책**: 템플릿을 바꾸면 Summary 탭이 재생성되고 이전 내용은 저장되지 않는다. 전사 수정·화자 태그만으로는 재생성되지 않는다. — https://help.otter.ai/hc/en-us/articles/31402572907415-Custom-Meeting-Type-Templates , https://help.otter.ai/hc/en-us/articles/5093228433687-Conversation-Page-Overview

### 2-2. 구조 재현 (모형)

아래는 **실제 Otter 출력이 아니다**. 2-1의 섹션·필드·동작 서술을 조합해 만든 모형이며, 문장은 지어낸 예시다. `↗`는 전사 위치로 가는 링크를 뜻한다. 불릿 깊이와 타임스탬프 표기 여부는 확인하지 못했다.

```
[Summary 탭]

Overview
  결제 SDK 교체 일정을 검토했다. 팀은 12월 2주차 배포를 목표로 정했고,
  iOS 심사 기간이 가장 큰 위험으로 꼽혔다. QA 범위는 다음 회의에서 확정한다.

Action Items
  ☐ 결제 SDK 마이그레이션 가이드 초안 작성        @민수   ↗
  ☐ iOS 심사 예상 기간을 애플 담당자에게 확인      @지영   ↗
  ☐ (수동 추가) 다음 회의 일정 잡기                @나

Insights                         ← 템플릿이 정한 주제
  위험 요소
    • iOS 심사가 2주를 넘으면 배포일이 밀린다
  결정 사항
    • 구버전 SDK는 한 릴리스 동안 병행한다

Outline                          ← 챕터(주제) 순서 = 시간 순서
  결제 SDK 교체 배경                               ↗
    • 현 SDK 지원 종료가 내년 1월이다
    • 대체 후보 두 개를 비교했다
  일정과 위험                                      ↗
    • 12월 2주차 배포 목표
    • iOS 심사 기간이 변수다
  QA 범위                                          ↗
    • 회귀 테스트 범위는 다음 회의에서 정한다

Custom Prompt                    ← 템플릿에 넣은 질문
  Q. 어떤 결정이 났나?
  A. 12월 2주차 배포, 구버전 SDK 한 릴리스 병행.
```

읽을 점:
- **Overview는 문단**이고 Outline이 **시간순 주제 목록**이다. 우리 `key_points`는 시간·주제 구조가 없는 평면 배열이다.
- **결정사항은 기본 섹션이 아니다**. Insights 또는 Custom Prompt에 템플릿이 넣어야 나온다. 우리는 `decisions`가 고정 섹션이라 이 점은 우리가 더 낫다.
- **근거 링크**가 Outline과 자동 액션아이템에 모두 달린다. 요약을 믿을지 확인하는 비용이 낮다.

### 2-3. 템플릿(회의 유형)

- 기본 제공: Team Meetings, Sales Calls, 1:1s. 직접 만들 수도 있다. — https://otter.ai/blog/otter-meeting-types-get-smarter-tailored-summaries-for-every-meeting
- 블로그는 영업 회의·1:1·팀 싱크·후보자 면접 맥락을 고르면 그 맥락에 맞는 정보를 강조한다고 설명한다. — https://otter.ai/blog/ai-to-summarize-transcripts
- 템플릿이 정하는 것: Overview·Action Items·Insights·Outline 섹션의 표시 여부, Insights 주제, 사용자 질문(Custom Prompt). — https://help.otter.ai/hc/en-us/articles/31402572907415-Custom-Meeting-Type-Templates
- **자동 적용 규칙**: 캘린더 일정 제목·참석자·키워드로 템플릿을 고르고, 회의 시작 전에 적용한다. 결과를 채널이나 CRM으로 보내는 후속 규칙도 걸 수 있다. — https://otter.ai/blog/otter-meeting-types-get-smarter-tailored-summaries-for-every-meeting
- 범위: 워크스페이스 템플릿(관리자만 생성)과 개인 템플릿이 있다. — https://help.otter.ai/hc/en-us/articles/31402572907415-Custom-Meeting-Type-Templates
- 플랜별 개수 제한(Basic 5개, Pro 15개)은 제3자 요약이라 확인이 필요하다. — https://pipeline.zoominfo.com/sales/otter-ai-features

### 2-4. 추정 생성 방식 [추론]

- 섹션이 API에서 `abstract_summary`·`action_items`·`insights`·`outline`의 **독립 필드**로 나오고 템플릿으로 섹션을 켜고 끌 수 있다. 섹션마다 따로 생성(또는 한 번의 구조화 출력)한 뒤 조립하는 방식으로 본다.
- Outline·액션아이템의 전사 링크는 모델이 **근거 세그먼트 식별자나 시각**을 함께 내도록 하고, 화면이 그것을 링크로 그리는 방식으로 본다. 수동으로 추가한 액션아이템에 링크가 없다는 사실이 이를 뒷받침한다.
- 전사·화자 수정이 요약에 반영되지 않는 것은 요약이 종료 시점의 전사로 **한 번 생성돼 저장**되기 때문으로 본다.

---

## 3. 기타 핵심 기능

| 기능 | 관찰 내용 | 출처 |
|---|---|---|
| 실시간 전사 | 회의 중 전사가 흐르고, 문장이 끝나면 앞 단어를 고쳐 쓴다. 화면 위 오버레이는 없다 | https://tldv.io/blog/otter-ai-review/ |
| 실시간 요약(Outline) | 녹음 중에도 Outline이 갱신돼 늦게 들어온 사람이 주제를 훑는다 | https://help.otter.ai/hc/en-us/articles/5093228433687-Conversation-Page-Overview |
| Otter AI Chat — 단일 회의 | 회의 중·후에 질문한다. "Catch me up" 같은 추천 프롬프트, 후속 메일 초안 작성 | https://help.otter.ai/hc/en-us/articles/15113481068055-Chat-in-a-conversation , https://tldv.io/blog/otter-ai-review/ |
| Otter AI Chat — 회의 간 | 계정의 모든 대화(공유받은 것 포함)를 대상으로 답한다. 날짜 범위로 좁히거나 대화·채널·폴더를 컨텍스트로 지정한다. 답마다 "view sources"로 출처를 보여 주고 화자·시각이 붙는다. 질문 이력을 보관한다 | https://help.otter.ai/hc/en-us/articles/19890167963159-Otter-AI-Chat , https://help.otter.ai/hc/en-us/articles/26467932629783-Otter-Chat-Select-specific-Channels-Conversations-or-Folders-for-queries , https://otter.ai/blog/ai-to-summarize-transcripts |
| Chat / Work 모드 | Chat은 질문·요약, Work는 Jira 티켓 생성 같은 작업 수행 | https://help.otter.ai/hc/en-us/articles/19682180167575-Otter-AI-Chat-Overview |
| 채널 | 회의와 비동기 대화를 묶는 공간. 채널에 공유된 회의 전체를 대상으로 요약·액션아이템을 뽑는다 | https://help.otter.ai/hc/en-us/articles/360049379794-Channels-Overview , https://help.otter.ai/hc/en-us/articles/22110856698903-Chat-in-Channels |
| 검색 | 전사 본문·메타데이터 키워드 검색. 일치 구간 강조, 재생 막대에 일치 시각 표시 | https://patents.google.com/patent/US10978073B1/en |
| 하이라이트·댓글·이미지 | 전사 구간에 하이라이트·댓글·이미지를 붙인다 | https://help.otter.ai/hc/en-us/articles/5093228433687-Conversation-Page-Overview |
| 슬라이드 캡처 | 화상회의에서 공유된 슬라이드를 자동으로 잡아 노트에 넣는다 | https://help.otter.ai/hc/en-us/articles/360049722894-Otter-Quick-Start-Guide |
| 키워드 | 대화의 요약 키워드 목록. 누르면 그 위치로 간다(초기에는 워드 클라우드) | https://help.otter.ai/hc/en-us/articles/5093228433687-Conversation-Page-Overview , https://www.verdict.co.uk/otter-ai-transcription/ |
| 발화 비중 | 화자별 발화 시간과 비율(%) | https://help.otter.ai/hc/en-us/articles/5093228433687-Conversation-Page-Overview |
| 재생 동기화 | 재생 위치의 단어를 강조하고, 단어를 누르면 그 시점부터 재생한다 | https://patents.google.com/patent/US10978073B1/en |
| 캘린더 연동 | 캘린더를 연결하면 Notetaker가 Zoom·Teams·Meet에 자동으로 들어간다. 데스크톱 앱은 봇 없이 녹음한다 | https://help.otter.ai/hc/en-us/articles/360049722894-Otter-Quick-Start-Guide , https://techcrunch.com/2025/10/07/how-otter-ais-ceo-is-pushing-the-company-to-be-more-than-just-a-meeting-scribe |
| 공유 | 링크·메일 공유, 참석자 자동 요약 메일, 워크스페이스·채널 공유 | https://help.otter.ai/hc/en-us/articles/9156381229079-Meeting-Summary-Overview |
| 내보내기 | 요약을 섹션 단위로 골라 내보낸다. 전사는 TXT·SRT·PDF. OneDrive 내보내기 | https://help.otter.ai/hc/en-us/articles/39503855767191-Export-Summary , https://help.otter.ai/hc/en-us/articles/42474585463959-Export-to-Microsoft-OneDrive |
| 사용자 어휘 | 설정에서 고유명사·용어를 등록한다 | https://www.verdict.co.uk/otter-ai-transcription/ |
| 연동·API | 워크스페이스 웹훅, Public API(Enterprise), MCP 서버, Jira·HubSpot·Salesforce 연동 | https://help.otter.ai/hc/en-us/articles/35634832371735-Workspace-Webhooks , https://help.otter.ai/hc/en-us/articles/36130822688279-Otter-ai-Public-API , https://techcrunch.com/2025/10/07/how-otter-ais-ceo-is-pushing-the-company-to-be-more-than-just-a-meeting-scribe |
| 전사 언어 | 2026-11에 27개 언어로 확장을 발표했다(13개 즉시, 14개 예정). 한국어 포함 여부는 확인하지 못했다. 과거 리뷰는 영어·스페인어·프랑스어만 되고 언어를 수동으로 골라야 하며, 미지원 언어가 들어오면 전사와 요약이 환각을 낸다고 보고했다 | https://help.otter.ai/hc/en-us/articles/360047247414-Supported-Languages , https://tldv.io/blog/otter-ai-review/ |

리뷰에 나온 약점: 봇이 빈 회의에 남아 10분간 무음을 녹음한다. 무료 플랜은 회의당 30분으로 제한된다. 클립·릴 기능이 없다. — https://tldv.io/blog/otter-ai-review/

---

## 4. LinkWork 도입 후보

전제: 로컬 우선, Claude 구독 요약, 오프라인 STT. 난이도는 상/중/하.

### 4-1. 화자 식별

| # | 기능 | 기술 방안 | 난이도 | 기대 효과 |
|---|---|---|---|---|
| S1 | **사람 단위 음성 프로필 저장** | `src/main/services/diarization/worker.ts`의 `refineByCentroid`가 구하는 화자별 CAM++ centroid를 버리지 않고 반환한다. 새 테이블(구성원 id, 임베딩 BLOB, 표본 길이, 출처 회의)을 `src/main/db/schema.ts`에 둔다. 구성원 엔티티는 기존 `meeting_members`를 쓴다(§12). 인원 지정 모드에서도 centroid를 계산해야 한다(지금은 자동 추정 모드에서만 계산) | 중 | 회의 간 동일인 식별의 토대. 사용자의 핵심 불만을 직접 겨냥 |
| S2 | **태그 → enrollment** | `SpeakerEditor.tsx`에서 화자에 구성원 이름을 지정하면 그 화자의 centroid를 구성원 프로필에 추가한다. 한 사람에 표본을 여러 개(예: 최근 N개) 두고 매칭 때 최대 유사도를 쓴다 — 마이크·회의실에 따라 음색이 달라지기 때문이다. 표본은 누적 발화가 충분한(예: 10초 이상) 화자만 받는다 | 중 | Otter의 "태그하면 다음부터 자동 인식"과 같은 루프 |
| S3 | **새 회의 자동 매칭(open-set)** | 화자분리 뒤 각 화자 centroid와 프로필의 코사인 유사도를 구한다. 임계값 이상이고 2위와의 차이가 충분할 때만 이름을 붙인다. 한 프로필은 회의 안에서 한 화자에만 배정한다(헝가리안 또는 탐욕 배정). 임계값은 실녹음으로 보정한다 — 앱의 centroid 병합 기준이 0.8(`MERGE_COS_THRESHOLD`)이므로 그 부근에서 시작한다. 미달이면 `spk_N`을 유지한다 | 중 | 자동 라벨. 오인식보다 미인식이 낫다는 Otter의 open-set 방식을 따른다 |
| S4 | **"추정" 표시와 한 번에 확정** | 자동 매칭된 이름에 유사도 등급과 "추정" 배지를 달고, 확정·거절 버튼을 둔다. 확정하면 S2 표본으로 들어가고, 거절하면 그 회의의 그 화자를 해당 프로필의 음성 예시에서 뺀다 | 하 | 틀린 자동 라벨이 프로필을 오염시키는 것을 막는다. Otter에 없는 개선점 |
| S5 | **Rematch(옛 회의 소급)** | 회의마다 화자 centroid를 `meeting_speakers`에 저장해 두면 오디오를 다시 처리하지 않고 S3만 다시 돌릴 수 있다. 상세 화면에 "화자 다시 맞추기" 버튼을 둔다. `speaker_corrected=1` 세그먼트와 사용자가 직접 지정한 이름은 덮지 않는다(§5-4의 보존 규칙과 같다) | 중 | 프로필이 쌓일수록 과거 회의록 품질도 오른다 |
| S6 | **"나" 자동 등록** | 마이크 채널(L)의 발화는 항상 본인이다. 채널 분리·2-스테이지 경로에서 L 채널 임베딩을 본인 프로필에 자동으로 넣는다. 스피커폰 하나로 녹음한 회의(시스템 오디오 없음)에서도 본인이 자동으로 잡힌다 | 하 | 등록 절차 없는 본인 식별 |
| S7 | **enrollment로 클러스터링 보조** | 참석자를 미리 지정한 회의(`meeting_attendees`)에서는 참석자 프로필을 seed로 써서, 세그먼트 임베딩을 가장 가까운 프로필에 먼저 배정하고 남는 것만 클러스터링한다. 과분할(실측 원시 23–97명)과 "같은 사람이 둘로 갈림" 문제를 직접 줄인다 | 상 | 회의 **내** 일관성 개선. sherpa의 내장 클러스터링을 우회해 세그먼트 임베딩을 직접 다뤄야 하므로 `worker.ts` 구조 변경이 크다 |
| S8 | **화자 관리 화면** | 구성원별 프로필 표본 목록, 표본 삭제, 구성원 병합(프로필·과거 회의 이름을 함께 합침), "음성 학습 끄기" 전역 스위치. `RecognitionAidsPanel.tsx`의 구성원 탭을 확장한다 | 중 | 오염된 프로필 복구 수단. 생체정보 통제권 |
| S9 | **동의·보관 고지** | 음성 프로필은 로컬 SQLite에만 두고 백업 대상에 넣을지를 정한다(`docs/DATA_BACKUP.md` 갱신). 녹음 시작 화면의 동의 고지에 "음성 특징 저장" 문구를 더한다 | 하 | Otter의 BIPA 소송이 보여 준 위험을 피한다 |
| S10 | **교정 단위 개선** | Otter의 "한 문단 한 화자" 원칙을 따른다. 세그먼트 중간에서 화자를 나누는 **분할** 조작을 넣고, 분할·수정된 세그먼트만 enrollment 표본으로 인정한다 | 중 | 표본 순도 확보 |

우선순위 제안: S1 → S6 → S2·S3 → S4 → S5 순서가 최소 기능 묶음이다. S7은 그 뒤에 회의 내 일관성이 여전히 부족할 때 한다.

구현 메모 [추론]: sherpa-onnx에는 화자 임베딩 추출기와 등록·검색·검증용 매니저 API가 있는 것으로 안다. `sherpa-onnx-node` 1.13.3에서 쓸 수 있는지는 확인이 필요하다. 없어도 임베딩 벡터가 손에 있으므로 코사인 유사도 계산은 `src/main/services/diarization/embedding-merge.ts`의 기존 함수를 재사용하면 된다.

### 4-2. 요약 포맷

| # | 기능 | 기술 방안 | 난이도 | 기대 효과 |
|---|---|---|---|---|
| F1 | **Outline(시간순 주제 챕터)** | `src/main/services/meeting-summary.ts`의 스키마에 `outline: {title, at, bullets[]}[]`를 더한다. `at`은 면접 요약과 같은 규약으로 전사의 `[mm:ss]`를 그대로 돌려받아 `parseTimestamp`로 환산한다(§6-2). `SummaryPanel.tsx`에서 챕터 제목을 누르면 `AudioPlayer.tsx`가 그 시점으로 간다 | 중 | 긴 회의를 주제 단위로 훑는다. 요약에서 원문으로 바로 간다 |
| F2 | **액션아이템·결정의 근거 링크** | `action_items`와 `decisions` 항목에 `at`(선택)을 더한다. Otter의 "View in transcript"에 해당한다 | 하 | 요약 검증 비용 감소. 환각 탐지 |
| F3 | **Overview 문단 + 평면 key_points 축소** | `tldr`을 2–4문장 문단으로 유지하고, F1이 들어가면 `key_points`는 Outline과 겹치므로 3–5개 상한을 둔다 | 하 | 중복 제거 |
| F4 | **회의 유형 템플릿** | `SummarySpec`(`src/main/services/summary-spec.ts`)이 이미 종류별 교체 구조다. 템플릿을 "섹션 on/off + Insights 주제 목록 + 사용자 질문 목록"의 데이터로 정의하고 프롬프트를 조립한다. 기본 제공: 팀 회의, 1:1, 스프린트 리뷰, 외부 미팅 | 중 | 회의 종류에 맞는 요약. 면접 스펙처럼 코드를 새로 쓰지 않아도 된다 |
| F5 | **Custom Prompt(고정 질문)** | 템플릿에 질문을 넣으면 `custom_answers: {question, answer, at?}[]`로 답을 받는다. "회의에 없는 내용이면 '언급 없음'"을 강제한다 | 하 | 반복 회의에서 매번 같은 것을 확인하는 수고를 없앤다 |
| F6 | **템플릿 자동 적용** | 캘린더 일정 제목·참석자 규칙으로 녹음 시작 때 템플릿을 미리 고른다. Google Calendar 연동이 이미 있다(`src/main/services/google-calendar.ts`) | 중 | 선택 단계 제거 |
| F7 | **교정 후 재요약 안내** | 화자 이름·전사를 고친 뒤 요약이 낡았음을 배지로 알리고 "요약 다시 만들기"를 권한다(§13의 재생성 경로 사용). Otter는 기본 요약을 재생성하지 못한다 | 하 | Otter보다 나은 일관성 |
| F8 | **섹션 선택 내보내기** | `src/main/services/meeting-notes.ts`의 `buildMeetingNoteMarkdown`에 섹션 선택 옵션을 준다(요약만, 액션아이템만, 전사 제외) | 하 | 공유용 문서를 바로 만든다 |

### 4-3. 기타 기능

| # | 기능 | 기술 방안 | 난이도 | 기대 효과 |
|---|---|---|---|---|
| X1 | **회의에 질문(단일 회의)** | 전사를 컨텍스트로 Claude `query()`를 부른다(요약과 같은 구독 경로, 도구 없음). 답에 `[mm:ss]` 인용을 강제하고 누르면 재생한다 | 중 | 요약에 없는 세부를 바로 찾는다 |
| X2 | **회의 간 질문** | 기존 AI 대화에 회의 검색·열람 도구를 더한다(`src/main/services/ai-tools.ts`). 먼저 SQLite FTS5로 후보 세그먼트를 찾고 Claude가 읽는다. 임베딩 검색은 그다음 단계다 | 상 | "지난달 그 건 누가 뭐라고 했지"에 답한다. Otter의 간판 기능 |
| X3 | **전문 검색 강화** | 회의록의 LIKE 검색(§10)을 FTS5로 바꾸고, 결과에 일치 세그먼트와 시각을 보여 주며 누르면 그 시점에서 재생한다 | 중 | 검색 속도·정확도, 결과에서 바로 재생 |
| X4 | **발화 비중** | `meeting_segments`의 화자별 시간 합으로 비율 막대를 그린다. `SpeakerTimeline.tsx` 옆에 둔다 | 하 | 회의 균형 확인. 화자분리 오류도 눈에 띈다(예: 1% 화자) |
| X5 | **키워드 칩** | 요약 스키마에 `keywords[]`를 더하고, 칩을 누르면 전사 내 검색으로 이어진다 | 하 | 빠른 탐색 |
| X6 | **하이라이트·메모** | 세그먼트에 하이라이트 플래그와 메모를 단다. 요약 프롬프트에 "사용자가 표시한 구간"으로 넣어 요약이 그 구간을 반드시 다루게 한다 | 중 | 사용자가 중요하다고 본 것을 요약에 반영 |
| X7 | **녹음 중 북마크** | 녹음 중 단축키로 시각을 찍는다. 처리 뒤 가장 가까운 세그먼트에 붙인다 | 하 | 회의 중 "여기 중요" 표시 |
| X8 | **캘린더 일정 → 녹음 준비** | 일정 제목·참석자로 회의 제목과 `meeting_attendees`를 미리 채운다. 참석자가 채워지면 S7·`expected_speakers`에 바로 쓰인다 | 중 | 입력 수고 제거, 화자분리 정확도에 간접 기여 |
| X9 | **실시간 전사** | whisper 스트리밍을 로컬에서 돌린다. large-v3-turbo로는 지연·발열 부담이 크다 | 상 | 효과에 비해 비용이 크다. 보류 권장 |
| X10 | **요약 공유** | 요약 Markdown을 Slack·Notion으로 보낸다(기존 연동 활용) | 중 | 회의 뒤 공유 자동화 |

### 4-4. 하지 않을 것

- **회의 봇**: 화상회의에 봇을 넣어 참석자 이름을 얻는 방식은 로컬 개인 앱의 범위를 벗어나고, 동의 문제가 크다. 대신 캘린더 참석자(X8)와 음성 프로필(S1–S5)로 같은 효과를 낸다.
- **워크스페이스 공유 프로필**: 음성 프로필을 여러 사용자가 공유하는 구조는 단일 사용자 앱에 필요 없다.
- **자동 요약 메일 발송**: 참석자에게 자동으로 보내는 동작은 Otter 리뷰에서 반감이 가장 큰 부분이다.

---

## 5. 출처 목록

**공식 도움말(검색 발췌로 확인)**
- https://help.otter.ai/hc/en-us/articles/360048465453-Tagging-speaker-names-in-a-conversation
- https://help.otter.ai/hc/en-us/articles/21665587209367-Speaker-Identification-Overview
- https://help.otter.ai/hc/en-us/articles/21665876084119-Rematch-a-speaker
- https://help.otter.ai/hc/en-us/articles/21666115098519-Untag-a-speaker
- https://help.otter.ai/hc/en-us/articles/40586357592471-Speaker-Management
- https://help.otter.ai/hc/en-us/articles/40643231903639-Disable-Speaker-Learning
- https://help.otter.ai/hc/en-us/articles/37817241040535-Best-Practices-to-Maximize-Speaker-Identification
- https://help.otter.ai/hc/en-us/articles/9156381229079-Meeting-Summary-Overview
- https://help.otter.ai/hc/en-us/articles/5093228433687-Conversation-Page-Overview
- https://help.otter.ai/hc/en-us/articles/21695002816535-Learn-about-the-new-Conversation-page-layout
- https://help.otter.ai/hc/en-us/articles/31402572907415-Custom-Meeting-Type-Templates
- https://help.otter.ai/hc/en-us/articles/39503855767191-Export-Summary
- https://help.otter.ai/hc/en-us/articles/35634832371735-Workspace-Webhooks
- https://help.otter.ai/hc/en-us/articles/36130822688279-Otter-ai-Public-API
- https://help.otter.ai/hc/en-us/articles/19682180167575-Otter-AI-Chat-Overview
- https://help.otter.ai/hc/en-us/articles/19890167963159-Otter-AI-Chat
- https://help.otter.ai/hc/en-us/articles/15113481068055-Chat-in-a-conversation
- https://help.otter.ai/hc/en-us/articles/26467932629783-Otter-Chat-Select-specific-Channels-Conversations-or-Folders-for-queries
- https://help.otter.ai/hc/en-us/articles/22110856698903-Chat-in-Channels
- https://help.otter.ai/hc/en-us/articles/360049379794-Channels-Overview
- https://help.otter.ai/hc/en-us/articles/360049722894-Otter-Quick-Start-Guide
- https://help.otter.ai/hc/en-us/articles/360047247414-Supported-Languages

**공식 블로그(본문 확인)**
- https://otter.ai/blog/otter-meeting-types-get-smarter-tailored-summaries-for-every-meeting
- https://otter.ai/blog/ai-to-summarize-transcripts
- https://otter.ai/blog/meeting-notes-template-with-action-items

**특허**
- https://patents.google.com/patent/US10978073B1/en (본문 확인)
- https://patentsgazette.uspto.gov/week43/OG/html/1539-4/US12456465-20251028.html (검색 요약만)

**언론·인터뷰(본문 확인)**
- https://techcrunch.com/2018/02/26/otters-new-app-lets-you-record-transcribe-search-and-share-your-voice-conversations
- https://www.verdict.co.uk/otter-ai-transcription/

**언론·법률(검색 요약만)**
- https://techcrunch.com/2022/03/29/otter-ai-meeting-summary-feature
- https://techcrunch.com/2025/10/07/how-otter-ais-ceo-is-pushing-the-company-to-be-more-than-just-a-meeting-scribe
- https://www.sheppard.com/insights/blogs/when-ai-takes-notes-court-allows-privacy-claims-against-otterai-to-proceed
- https://idtechwire.com/otter-ai-must-face-voiceprint-claims-under-illinois-biometric-law/
- https://news.bloomberglaw.com/artificial-intelligence/otter-ai-hit-with-bipa-class-suit-over-voice-print-collection

**리뷰**
- https://tldv.io/blog/otter-ai-review/ (본문 확인)
- https://theaccessibilityguy.com/how-to-use-otter-ai-summary-and-outline-features/ (본문 확인)
- https://www.happyscribe.com/blog/otter-ai-review (검색 요약만)
- https://www.g2.com/products/otter-ai/reviews (검색 요약만)
- https://thegoldsuite.com/post/how-to-use-otterai-to-transcribe-and-summarise-client-meetings (검색 요약만)
- https://pipeline.zoominfo.com/sales/otter-ai-features (검색 요약만)
