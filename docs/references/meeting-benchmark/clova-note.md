# 네이버 클로바노트(CLOVA Note) 벤치마크

- 조사일: 2026-11-26
- 성격: **공개 자료 기반 블랙박스 분석**. 공식 도움말, 네이버 보도자료, NAVER Cloud CLOVA Speech API 문서, 네이버 소속 연구자의 공개 논문, 제3자 리뷰만 썼다. 앱 바이너리 분해, 비공개 API 호출, 약관에 어긋나는 접근은 하지 않았다.
- 표기 규칙: 출처 URL이 붙은 문장은 **사실**이다. `추론` 표시가 붙은 문장은 공개 자료에서 끌어낸 추정이며 네이버가 확인한 내용이 아니다. `미확인` 표시는 이번 조사에서 근거를 찾지 못한 항목이다.
- 한계: 이번 조사에서 클로바노트 앱을 직접 실행하지 않았다. 화면 구조는 도움말 문구와 기사 묘사에서 재구성했다. 공식 도움말은 NAVER WORKS(기업용) 클로바노트 기준이며, 개인용(clovanote.naver.com)은 한도·일부 기능이 다를 수 있다.
- 비교 기준선: LinkWork의 현재 파이프라인은 `docs/MEETING_RECORDING.md` §0, §5-3, §6, §10에 있다.

## 0. 한눈에 보기

| 항목 | 클로바노트 | LinkWork 현재 |
|---|---|---|
| STT | 서버, 자체 엔진 NEST(end-to-end) + 자기지도학습 | 로컬 whisper large-v3-turbo |
| 화자 분리 | 서버, 자체 엔진 WISE. 녹음 **후** "참석자 수"를 묻는다 | 로컬 sherpa-onnx(pyannote-seg-3.0 + CAM++), 녹음 **전** 참석 인원 입력(선택) |
| 같은 사람 재인식 | 기업 플랜: 주소록으로 지정한 구간의 음성을 학습해 다음 회의에서 자동 식별 | 없음. 회의마다 화자를 새로 만든다 |
| 화자 수정 범위 | 이 구간만 / 이 구간부터 / 전체 구간 | 세그먼트 단위 수정, 화자 이름 변경 |
| 요약 | 주요 주제 + 주제별 요약(소제목) + 다음 할 일. 템플릿 선택, 한 노트에 요약 여러 개 | TL;DR · 핵심 포인트 · 결정사항 · 액션아이템 · 다음 단계(고정 5분류) |
| 인식 보조 | 자주 쓰는 단어(키워드 부스팅), 메모 | 용어집(initial_prompt + 후보정), 구성원 |
| 녹음 중 표시 | 북마크, 메모(작성 시각 기록), 하이라이트 | 없음 |

## 1. 한국어 화자 분리

### 1-1. 관찰되는 UX (사실)

**참석자 수 입력은 녹음이 끝난 뒤에 받는다.**
- 녹음 종료(또는 파일 업로드) 직후 "'음성 종류'와 '참석자 수'를 선택합니다" 단계가 있고, 그 뒤에 텍스트 변환이 시작된다. 모바일·PC 공통이다. (https://help.worksmobile.com/ko/use-guides/clovanote/create/note/)
- 제3자 기사도 같은 흐름을 적는다: "녹음을 마친 뒤 음성 종류와 참석자 수를 입력하면 발화자를 자동으로 분류". (https://designcompass.org/2023/11/20/clovanote-release/)
- PC에서 파일 여러 개를 한 번에 올리면 음성 종류와 참석자 수는 기본값으로 처리된다. (같은 도움말)
- 참석자 수 선택지의 구체적인 값(1명, 2명, …, 자동 여부)과 음성 종류 목록은 공개 문서에서 확인하지 못했다. `미확인`
- 변환이 끝난 노트에서 참석자 수를 바꿔 화자 분리만 다시 돌리는 기능은 도움말에 없다. `미확인`

**화자 이름 지정과 일괄 변경.**
- 화자는 처음에 "참석자 n"이라는 임시 이름으로 표시된다. (https://help.worksmobile.com/ko/use-guides/clovanote/view/speaker-identification/)
- 화자를 클릭(모바일은 길게 누름)하고 "참석자 변경"을 고른 뒤, 이름을 직접 입력하거나 이미 추가된 참석자 중에서 고르거나 주소록에서 구성원을 고른다. 그다음 **적용 구간**을 고른다. (https://help.worksmobile.com/ko/use-guides/clovanote/manage-share/edit/)
  - **이 구간만**: 선택한 구간만 새 참석자로 바꾼다.
  - **이 구간부터**: 해당 지점부터 노트 끝까지 그 화자가 말한 구간을 바꾼다.
  - **전체 구간**: 그 화자가 말한 모든 구간을 바꾼다.
- 이 세 범위가 화자 오분류 수정의 핵심이다. "전체 구간"은 이름 일괄 변경, "이 구간만"은 한 발화의 귀속 오류 수정, "이 구간부터"는 **중간에 한 화자가 두 사람으로 뭉쳐진 경우**(앞부분은 A, 어느 시점부터 B)의 수정에 쓴다. `추론`(용도 해석)
- 편집 결과는 노트를 공유받은 사람에게도 보인다. (같은 도움말)

**같은 사람을 다음 회의에서 다시 알아보는 기능("화자 자동 식별").**
- Business, Business Plus, Enterprise 플랜 전용이고 관리자가 켜야 한다. (https://help.worksmobile.com/ko/use-guides/clovanote/view/speaker-identification/)
- 사용자가 음성 블록에서 주소록으로 참석자를 지정하면 "해당 구간의 음성 데이터가 저장되어 AI 식별 학습에 활용"된다. 한 번 지정한 사람은 이후 회의에서 같은 인물로 자동 인식된다. 지정한 사람이 많을수록 정확도가 올라간다고 안내한다. (같은 도움말)
- 자동 식별된 블록에는 AI 아이콘이 붙는다. 사용자가 그 블록의 참석자를 바꾸면 "해당 구간의 기존 음성 매칭 데이터가 삭제되고, 새로운 참석자 정보로 다시 학습"한다. (같은 도움말)
- 지정하면 프로필 이미지와 이름이 주소록의 실제 값으로 바뀐다. (같은 도움말)
- 앱 2.5.1(2024-12-19)에서 주소록 연동이 들어왔다. (https://apps.apple.com/kr/app/id1530010245)

**보조 화면.**
- 참석자 대화 비율("점유율"): 화자별 발화 점유율을 보여 준다. 화자 이름을 실제 이름으로 고친 뒤 보라고 안내한다. (https://help.worksmobile.com/ko/use-guides/clovanote/view/talk-ratio/)
- 네이버는 앱 설명에서 참석자 목소리 구분 결과를 "초안으로 활용"하라고 적는다. 정확도 수치는 공개하지 않는다. (https://apps.apple.com/kr/app/id1530010245)

### 1-2. 공개된 기술 (사실)

- 2020년 출시 보도자료: 클로바노트는 CLOVA Speech의 두 엔진을 쓴다. 긴 문장 인식에 특화한 **NEST**(Neural End-to-end Speech Transcriber)와 참석자 목소리 차이를 구분하는 **WISE**(Who Is Speaking). (https://navercorp.com/media/pressReleasesDetail?seq=30289)
- 2021년 보도자료: HyperCLOVA의 자기지도학습으로 NEST 정확도를 30% 높였고, WISE와 관련 연구를 Interspeech 2021에서 발표했다. (https://www.navercorp.com/en/media/pressReleasesDetail?seq=30622)
- 같은 엔진을 외부에 파는 CLOVA Speech 장문 인식 API의 화자 인식 인터페이스(2021-04-08 추가):
  - 요청에 `diarization.enable`(기본 true), `speakerCountMin`, `speakerCountMax`가 있다. 응답 예시의 값은 `-1`(미지정)이다. (https://api.ncloud-docs.com/docs/ai-application-service-clovaspeech-longsentence-local , https://api.ncloud-docs.com/docs/en/ai-clovaspeech-longsentence-releasenote)
  - 응답 세그먼트는 `diarization.label`(엔진이 낸 화자 번호)과 `speaker.label`/`speaker.name`/`speaker.edited`(사용자가 바꾼 화자)를 **따로** 가진다. 단어 단위 정렬(`words`: 시작·끝·텍스트)과 세그먼트 `confidence`도 준다. (같은 문서)
  - 그 밖에 키워드 부스팅(`boostings`, 최대 1,000개, 가중치 1~5, `출력 표기|발음` 형식), 금칙어, 노이즈 필터링(기본 켬), 이벤트 탐지(sed)가 있다. (같은 문서)
- 네이버(Clova) 소속 저자의 화자 분리 논문. 서비스에 그대로 들어갔다는 공식 확인은 없지만, 2021년 보도자료가 "WISE 관련 연구"로 가리키는 계열이다.

| 논문 | 핵심 | 출처 |
|---|---|---|
| Adapting Speaker Embeddings for Speaker Diarisation (Kwon, Jung, Heo 외, Interspeech 2021 제출) | 화자 **검증용** 임베딩을 분리용으로 고친다: 차원 축소, attention 기반 임베딩 집계, 비음성 클러스터링. DER 평균 25.07% 상대 개선 | https://arxiv.org/abs/2104.02879 |
| Multi-scale speaker embedding-based graph attention networks for speaker diarisation (Kwon, Heo, Jung 외) | 기준선 파이프라인이 자세히 나온다: CRNN VAD → 0.5초/1.0초/1.5초 3개 스케일 슬라이딩 윈도 → 256차원 임베딩(VoxSRC 2020 시스템 변형) → 스케일별 코사인 유사도를 합친 affinity 행렬 → **spectral clustering**. 제안은 스케일 결합을 GAT로 학습하는 것. DIHARD I/II/III, VoxConverse에서 평가 | https://ar5iv.labs.arxiv.org/html/2110.03361 |
| High-resolution embedding extractor for speaker diarisation (Heo, Kwon 외, ICASSP 제출) | 한 윈도 안에 화자가 2명 이상 섞이는 문제를 푼다. 윈도당 임베딩 1개가 아니라 프레임 해상도의 임베딩 여러 개를 뽑는다(self-attention enhancer). 인공 혼합 데이터로 학습. 평가 5종 중 4종에서 10% 이상 개선 | https://arxiv.org/abs/2211.04060 |
| Who Spoke When in Multi-Conversation: Target Speaker Tagging Task and Benchmark (Lee, Heo, Kwon 외, 2026-06) | 긴 녹음 + **사전 등록 화자**가 주어졌을 때 등록 화자의 발화만 라벨링하고 모르는 화자는 거부하는 과제(TST). 20~60분 세션 300개, 등록 화자 150명 이상의 벤치마크 공개. 분리 지표만 최적화해서는 TST 성능이 보장되지 않고, 과분할(over-clustering)과 짧은 발화 보정이 도움이 된다고 보고(제3자 요약 기준) | https://arxiv.org/abs/2606.14091 |

### 1-3. 내부 구조 추론

아래는 전부 `추론`이다.

1. **클러스터링 기반 파이프라인이다(순수 EEND가 아니다).** 근거: ① API가 화자 수의 최소·최대를 임의 정수로 받는다. EEND 계열은 출력 화자 수 상한이 모델에 고정되지만, 클러스터링은 군집 수를 범위로 제한하기 쉽다. ② 공개 논문 4편이 모두 "임베딩 추출 → affinity → 클러스터링" 구조의 부품을 개선한다. ③ 1회 최대 360분 녹음을 받는다(https://help.worksmobile.com/ko/use-guides/clovanote/create/note/). 전체 길이에 self-attention을 거는 방식은 이 길이에서 메모리가 맞지 않는다.
2. **"참석자 수"는 클러스터 수 제약으로 들어간다.** 앱이 녹음 뒤에 참석자 수를 묻고, API에 같은 의미의 파라미터가 있다. 사용자가 고른 값이 `speakerCountMin = speakerCountMax = N` 또는 좁은 범위로 전달될 가능성이 높다. 화자 수 추정은 클러스터링에서 가장 틀리기 쉬운 단계라서, 그 단계를 사용자 입력으로 대체한 설계다.
3. **긴 오디오는 짧은 윈도 임베딩의 전역 클러스터링으로 처리한다.** 0.5~1.5초 윈도를 0.16~0.25초 간격으로 밀면 60분 녹음에서 임베딩이 1만 개를 넘는다. affinity 행렬을 직접 다루는 spectral clustering은 이 규모에서 무겁기 때문에, 서비스에서는 차원 축소(논문 1)나 사전 군집 같은 축약 단계를 둘 가능성이 높다.
4. **짧은 윈도 + 다중 스케일이 한국어 대면 회의의 짧은 맞장구("네", "아 그렇죠")를 잡는 수단이다.** 1.5초 단일 윈도는 화자 정체성에는 안정적이지만 0.5초짜리 응답을 앞사람에게 붙인다. 논문 2·3이 정확히 이 문제(윈도 안 화자 교대)를 겨냥한다.
5. **세션 간 재인식은 사용자별 음성 프로필(임베딩 집합)과 클러스터 대표 임베딩의 비교다.** 도움말의 "해당 구간의 음성 데이터가 저장", "기존 음성 매칭 데이터가 삭제되고 다시 학습"이라는 문구는 구간 단위 등록·삭제가 되는 임베딩 갤러리 구조와 맞는다. 모델을 사용자마다 재학습하는 것이 아니라 등록 임베딩을 더하고 빼는 방식일 것이다. 2026년 TST 논문이 이 기능의 연구판으로 보인다.
6. **엔진 라벨과 사용자 라벨을 분리 저장한다.** API 응답의 `diarization.label` 대 `speaker.*` 구조가 그대로 앱 데이터 모델일 것이다. 원래 라벨을 지우지 않으므로 "전체 구간" 변경을 되돌리거나 재처리 뒤 수동 수정을 다시 입힐 수 있다.

### 1-4. 대면 회의 · 단일 마이크 성능에 대한 공개 정보

- 네이버가 공개한 화자 분리 정확도 수치는 없다. 앱 설명은 "초안으로 활용"을 권한다. (https://apps.apple.com/kr/app/id1530010245)
- 도움말은 녹음할 때 "말하는 사람에게 가까이 마이크를 둡니다"라고만 안내한다. PC 웹 녹음은 마이크로 들어온 소리만 받고 브라우저에서 나는 소리(화상회의)는 인식하지 않는다. 화상회의는 별도 봇이 참여해 녹음한다. (https://help.worksmobile.com/ko/use-guides/clovanote/create/note/)
- 제3자 4주 비교(회의 40건, 한국어 32건): 한국어 회의의 발화자 구분이 "체감 90% 이상", 자유 토론형 회의에서 요약 누락 약 20%. 측정 방법이 없는 체감 수치다. (https://smarttechnote.com/ai-meeting-notes-review/)
- 논문 쪽 수치(연구 시스템, 영어 중심 공개 데이터): DIHARD I~III에서 DER 17~20%, VoxConverse 12.78%. 오류 대부분이 화자 혼동(speaker confusion)이다. 원거리·다자 대화에서는 최상급 연구 시스템도 화자 혼동이 10% 안팎 남는다는 뜻이다. (https://ar5iv.labs.arxiv.org/html/2110.03361)
- 한 마이크에 두 목소리가 동시에 들어오면 하나의 파형이 되므로 겹침 구간은 어느 서비스든 약하다는 것이 업계 공통 서술이다. (https://www.plaud.ai/blogs/articles/how-to-transcribe-meetings-with-speaker-labels — 하드웨어 판매사의 주장이므로 참고만 한다)

### 1-5. LinkWork에 주는 시사점

현재 LinkWork의 문제는 "같은 사람인지 인식"이다. 클로바노트가 이 문제를 푸는 방식은 모델 성능만이 아니라 **세 가지 설계**다.

1. **화자 수를 추정하지 않고 묻는다.** LinkWork 실측에서 자동 추정은 원시 화자 23~97명을 낸 뒤 정제한다(`docs/MEETING_RECORDING.md` §5-3). 클로바노트는 이 단계를 사용자 입력으로 건너뛴다. LinkWork도 참석 인원 입력이 있지만 녹음 전이고 선택 사항이다. 녹음 종료 시점에 "몇 명이었나"를 한 번 더 묻고, 상세 화면에서 인원을 바꿔 화자 분리만 다시 돌리는 경로를 주 흐름으로 올리는 것이 가장 싼 개선이다.
2. **사람 단위 음성 프로필을 쌓는다.** LinkWork에는 이미 화자별 CAM++ centroid를 구하는 코드(`src/main/services/diarization/worker.ts`, `src/main/services/diarization/embedding-merge.ts`)와 구성원 테이블(`src/main/services/recognition-aids.ts`)이 있다. 사용자가 화자에 구성원 이름을 지정하는 순간 그 화자의 centroid를 구성원에 저장하고, 다음 회의의 클러스터 centroid와 코사인 유사도로 맞추면 클로바노트의 "화자 자동 식별"과 같은 구조가 된다. 음성 데이터가 기기 밖으로 나가지 않는다는 점은 LinkWork 쪽이 유리하다.
3. **수정 범위를 세 단계로 준다.** "이 구간부터"는 한 클러스터에 두 사람이 섞인 경우를 한 번의 조작으로 가른다. LinkWork의 `speaker_corrected` 보존 규칙(`src/main/services/speaker-assign.ts`, `src/main/services/speaker-carryover.ts`)과 충돌하지 않는다.

모델 쪽 시사점(`추론`): LinkWork는 pyannote 세그멘테이션(10초 윈도) 뒤 complete linkage AHC를 쓴다. 네이버 계열은 0.5~1.5초 다중 스케일 임베딩 + spectral clustering이다. 인원이 주어졌을 때 AHC를 임계값 대신 `numClusters`로 자르는 현재 방식은 같은 방향이다. 다만 complete linkage는 한 사람의 목소리가 구간마다 달라질 때(거리·방향 변화가 큰 대면 회의) 그 사람을 여러 군집으로 쪼개기 쉽다. 인원 지정 시에도 centroid 기반 재할당을 한 번 돌리는 방안을 실험할 가치가 있다.

## 2. 요약 포맷("AI 요약")

### 2-1. 확인된 구성 요소 (사실)

- 2022-08 첫 출시: "AI가 대화 주제별로 구간을 나누고, 핵심을 자동으로 요약". HyperCLOVA 언어모델 적용. 당시 월 10회, 한국어만. (https://navercorp.com/media/pressReleasesDetail?seq=30851)
- 2023-11 정식 출시: "AI 요약하기"를 누르면 회의의 **핵심 주제와 주요 사항**을 정리하고 **다음 할 일**을 추천한다. "주요 내용을 소제목과 함께 한눈에" 보는 요약도 준다. (https://www.itworld.co.kr/news/313536)
- 앱 설명의 세 구성 요소 이름: **요약 / 주요 주제 / 다음 할 일**. 세 가지 모두 사용자가 편집할 수 있다. (https://apps.apple.com/kr/app/id1530010245)
- 기사에 실린 실제 예시(고객 만족도 조사 회의): 핵심 주제 = "설문 일정 논의", "설문 내용 피드백 반영" / 다음 할 일 = "설문 문항 작성", "설문 이미지 작업". (https://www.itworld.co.kr/news/313536)
- 제3자 관찰: 요약이 "주요 안건 → 논의 내용 → 다음 할 일" 순서로 정리된다. (https://smarttechnote.com/ai-meeting-notes-review/)
- 현재 도움말(NAVER WORKS):
  - "AI가 회의 내용을 분석해 가장 적합한 구조로 요약". 기본 템플릿 이름은 **Default**다. (https://help.worksmobile.com/ko/use-guides/clovanote/view/ai-summary/)
  - **한 노트에 요약을 여러 개** 추가할 수 있다. `+` → 템플릿 선택 → 요약. 추가한 요약은 별도 탭이 되고, 추가할 때마다 요약 횟수가 차감된다. (같은 도움말)
  - **커스텀 템플릿**(Business 이상): 제목 최대 50자, 내용 최대 2,000자, 최대 10개, 본인에게만 적용. 작성법은 "제목과 각 제목별로 정리할 내용을 순서대로 기재", Markdown `#`, `##`로 제목 계층 지정, 담당자·기한처럼 꼭 필요한 정보는 해당 제목 아래에 구체적으로 적는다. 도움말의 예시 구조는 "결정 사항(합의 사항, 보류 사항) / 발언자별 주요 의견 / 다음 단계(담당자와 기한 포함)". (같은 도움말)
  - 요약 언어는 "요약 언어" 설정을 따른다. (같은 도움말)
  - **자동화**: "녹음 종료 후 자동 AI 요약"을 켤 수 있고, 자동 요약에 쓸 템플릿을 고른다. (https://help.worksmobile.com/ko/use-guides/clovanote/settings/automation/)
- 주요 키워드는 요약과 별개의 영역이다. 제목 아래 "주요 키워드" 영역에 회의에서 많이 언급된 단어가 칩으로 나오고, 누르면 그 단어가 든 음성 기록과 메모를 검색한다. 필요 없는 키워드는 지울 수 있다. 한국어·일본어 노트만 지원. (https://help.worksmobile.com/ko/use-guides/clovanote/view/keyword/)

### 2-2. 출력 구조 재현

아래는 위 사실을 조합해 재구성한 Default 요약의 모양이다. 섹션 이름("주요 주제", "다음 할 일", "요약")과 주제 예시 문구는 출처가 있는 값이고, 요약 본문 문장과 정확한 배치·불릿 기호는 `추론`이다.

```text
[제목 아래]
주요 키워드   설문  고객 만족도  일정  이미지  문항        ← 칩, 누르면 검색

[요약 탭 · Default]
주요 주제
  · 설문 일정 논의
  · 설문 내용 피드백 반영

다음 할 일
  · 설문 문항 작성
  · 설문 이미지 작업

요약
  설문 일정 논의                                          ← 주제별 소제목
    - (이 주제 구간에서 나온 핵심 내용 2~4개 불릿)
  설문 내용 피드백 반영
    - (이 주제 구간에서 나온 핵심 내용 2~4개 불릿)
```

구조상 특징.

- **주제(안건)가 1차 축이다.** 결정·논의·할 일로 먼저 나누지 않고, 대화를 주제 구간으로 자른 뒤 구간마다 소제목과 요약을 붙인다. "주요 주제" 목록은 그 소제목들의 목차 역할을 한다.
- **다음 할 일은 짧은 명사구다.** 기사 예시는 "설문 문항 작성"처럼 담당자·기한 없는 한 줄이다. 담당자·기한이 필요하면 커스텀 템플릿에 직접 요구하라는 것이 도움말의 안내다.
- **타임스탬프 연결**: 2022년 보도자료는 "주제별로 구간을 나눈다"고 적으므로 각 주제 요약은 음성 기록의 시간 구간과 대응한다. 요약 항목을 눌러 그 구간으로 이동하는 동작이 있는지는 공개 문서에서 확인하지 못했다. `미확인`
- **섹션 순서**: 기사·리뷰의 서술 순서는 "핵심 주제 → (논의 내용) → 다음 할 일"이다. 화면에서 다음 할 일이 주제별 요약의 위인지 아래인지는 `미확인`.

### 2-3. 회의 유형별 차이

- 녹음 뒤 고르는 "음성 종류"가 화자 분리·요약에 어떻게 쓰이는지는 공개되지 않았다. `미확인`. 종류에 따라 요약 구조를 달리 잡는 입력으로 쓸 가능성이 있다. `추론`
- 유형별 포맷 차이는 고정 포맷 여러 개가 아니라 **템플릿**으로 푼다. Default는 "AI가 가장 적합한 구조"를 고르고, 정해진 형식이 필요하면 사용자가 제목 골격을 써 넣는다. (https://help.worksmobile.com/ko/use-guides/clovanote/view/ai-summary/)
- 같은 녹음에 서로 다른 템플릿의 요약을 탭으로 나란히 둘 수 있으므로, "임원 보고용 3줄"과 "실무용 상세"를 한 노트에 함께 둔다.

### 2-4. LinkWork 요약과의 차이

| 축 | 클로바노트 | LinkWork (`src/main/services/meeting-summary.ts`) |
|---|---|---|
| 1차 구조 | 주제(안건)별 소제목 + 요약 | 성격별 5분류(tldr, key_points, decisions, action_items, next_steps) |
| 긴 회의 | 주제 구간마다 요약하므로 길이에 비례해 늘어난다 | 80,000자 초과 시 균등 샘플링 발췌본 하나를 요약한다 |
| 할 일 | 다음 할 일(명사구) | action_items(담당·기한) → 할 일 등록. LinkWork가 더 구조적이다 |
| 포맷 변경 | 템플릿 10개, 한 노트에 요약 여러 개 | `SummarySpec` 2종(회의·면접) 고정, 회의당 요약 1개 |
| 원문 연결 | 주제 구간 대응(이동 동작은 미확인) | 면접 요약만 `[mm:ss]` 점프. 회의 요약은 타임스탬프 없음 |
| 키워드 | 별도 칩, 검색 연결 | 없음 |

LinkWork에 없는 것은 **주제 축**이다. 5분류는 결정·할 일을 뽑는 데 강하지만, 한 시간짜리 회의에서 "무슨 얘기를 어떤 순서로 했나"를 훑어볼 목차가 없다.

## 3. 기타 핵심 기능

| 기능 | 동작 | 출처 |
|---|---|---|
| 북마크 | 녹음 중 중요한 순간을 표시한다. 북마크한 부분만 모아 보거나 바로 재생한다. 편집 화면에서도 구간에 북마크를 붙인다 | https://apps.apple.com/kr/app/id1530010245 , https://help.worksmobile.com/ko/use-guides/clovanote/manage-share/edit/ |
| 녹음 중 메모 | 녹음하면서 메모를 쓰면 작성 시각이 함께 저장된다. 2020년 보도자료는 메모에서 주요 단어를 뽑아 인식 정확도를 높이는 계획을 밝혔다 | https://navercorp.com/media/pressReleasesDetail?seq=30289 |
| 하이라이트 | 음성 기록의 문장에 형광펜처럼 표시하고 한곳에 모아 본다 | https://designcompass.org/2023/11/20/clovanote-release/ |
| 모아보기 | 북마크·하이라이트·링크를 한 탭에서 본다 | https://designcompass.org/2023/11/20/clovanote-release/ |
| 눈으로 보며 듣기 | 텍스트를 누르면 그 부분의 음성을 재생한다 | https://navercorp.com/media/pressReleasesDetail?seq=30289 |
| 검색 · 단어 바꾸기 | 노트 안 검색, 찾은 단어를 한 번에 치환 | https://apps.apple.com/kr/app/id1530010245 |
| 주요 키워드 | 많이 언급된 단어를 칩으로, 누르면 검색 | https://help.worksmobile.com/ko/use-guides/clovanote/view/keyword/ |
| 자주 쓰는 단어 | 전문 용어를 등록하면 인식률이 오른다. 언어별 최대 1,000개(기업용 도움말). 개인이 등록한 단어와 관리자가 등록한 회사 공용 단어가 나뉜다. PC는 파일 일괄 등록·내려받기 지원. 개인용은 200개라는 기사도 있다 | https://help.worksmobile.com/ko/use-guides/clovanote/settings/usedword/ , https://v.daum.net/v/uF3vfnqFvN |
| 참석자 대화 비율 | 화자별 발화 점유율 | https://help.worksmobile.com/ko/use-guides/clovanote/view/talk-ratio/ |
| 공유 | 링크로 공유, 비밀번호 설정 가능. 편집 내용이 공유받은 사람에게 반영된다 | https://apps.apple.com/kr/app/id1530010245 |
| 내려받기 | 음원·음성 기록·메모를 파일로. 음성 기록은 텍스트, 엑셀, 워드, 한글, SRT | https://navercorp.com/media/pressReleasesDetail?seq=30851 |
| 노트 미리 만들기 | 회의 전에 제목·참석자·메모(주제)를 써 두고, 시작하면 녹음을 붙인다 | https://help.worksmobile.com/ko/use-guides/clovanote/create/note/ |
| 캘린더 연동 | "오늘 일정"에서 바로 녹음. 일정에 화상회의 링크가 있으면 봇이 시작 시각에 참여를 요청한다. 일정 화면의 "노트 보기"로 노트에 연결된다 | https://help.worksmobile.com/ko/use-guides/clovanote/create/note/ |
| 화상회의 봇 | NAVER WORKS, Zoom, Teams, Webex, Google Meet. 한 사용자 동시 2건 | https://help.worksmobile.com/ko/use-guides/clovanote/create/note/ |
| 자동 요약 | 녹음 종료 후 자동으로 AI 요약, 템플릿 지정 | https://help.worksmobile.com/ko/use-guides/clovanote/settings/automation/ |
| 온디바이스 미리보기 | 안드로이드 통화 녹음은 기기 안 인식기로 일부를 미리 보여 준다(서버 전송 없음) | https://navercorp.com/media/pressReleasesDetail?seq=30851 |
| 길이·형식 한도 | 1회 최대 180분(Lite/Team) 또는 360분(Business 이상). PC 업로드 m4a·mp3·aac·wav, 300MB | https://help.worksmobile.com/ko/use-guides/clovanote/create/note/ |

## 4. 비교: 다글로(Daglo)

액션파워의 서비스로, 회의보다 **강의·영상 받아쓰기와 문서화**에 무게가 있다.

- 화자 구분: 매경이코노미 체험기(2025-10)는 3명 이상 한국어 대화의 화자를 정확히 구별했고 영어 대화는 다소 미흡했다고 적는다. 화자 이름은 사용자가 편집한다. (https://v.daum.net/v/uF3vfnqFvN)
- 요약: **20여 가지 양식**으로 목적별 정리를 한다. 요약은 한국어·영어만. 요약·핵심 포인트·키워드·할 일 항목을 만든다. (https://v.daum.net/v/uF3vfnqFvN , https://apps.apple.com/kr/app/id1632867925)
- 부가: 기록에 대한 AI 채팅(여러 모델), 시험 문제 생성, 유튜브 영상 스크립트(최대 2시간), 기록으로 PPT 만들기, 완성 스크립트의 16개 언어 재번역. (같은 출처)
- 한도: 무료 사용자는 하루 3회·월 10시간 받아쓰기(앱 설명 기준). (https://apps.apple.com/kr/app/id1632867925)
- 시사점: 클로바노트의 "템플릿 10개 직접 작성"과 달리 다글로는 **미리 만든 양식 20여 개 중 고르기**다. 개인 앱에는 고르기 방식이 진입 비용이 낮다. 화자 분리 기술에 대한 공개 자료는 찾지 못했다. `미확인`

## 5. 비교: Fireflies.ai

화상회의 봇 중심의 영어권 서비스다.

- 기본 요약(General Summary)의 섹션과 순서: **Meeting Keywords → Meeting Overview → Meeting Notes(구조화 불릿) → Time-stamped Notes(타임스탬프 챕터, 누르면 전사의 해당 위치로 이동) → Action Items(화자별로 묶음)**. (https://guide.fireflies.ai/articles/9547055509-Fireflies-AI-Meeting-Summaries%3A-View%2C-Customise%2C-Expand%2C-Regenerate)
- 요약 길이 Concise/Detailed 전환, 내장 템플릿(1:1, Team Meeting — Progress Review·Challenges·Upcoming Milestones, Standup, BANT, Sales Call), 섹션 단위 켜고 끄기, 전사나 화자 라벨을 고친 뒤 "Regenerate Summary". (같은 문서)
- API 요약 스키마가 요약을 여러 해상도로 동시에 가진다: `gist`(한 문장), `short_summary`(한 문단), `bullet_gist`, `overview`, `outline`(타임스탬프 개요), `notes`, `action_items`, `keywords`, `topics_discussed`, `meeting_type`. (https://docs.fireflies.ai/schema/summary)
- 화자: Zoom·Google Meet은 플랫폼이 주는 참가자 이름으로 라벨을 붙이고, 그 밖에는 Speaker 1, 2로 표시한다. 사후 편집 가능. (https://pipeline.zoominfo.com/sales/fireflies-ai-features)
- 대면·한국어: 제3자 비교에서 노트북 마이크 대면 녹음의 한국어 인식률이 60%대, 한국어 발화자 구분이 불안정했다. (https://smarttechnote.com/ai-meeting-notes-review/)
- 시사점: 화자 이름 문제를 음향 모델이 아니라 **회의 플랫폼 메타데이터**로 푼다. 대면 단일 마이크에는 옮길 수 없다. 가져올 것은 요약의 **다해상도 구조**(한 문장 / 한 문단 / 타임스탬프 개요 / 상세)와 **화자 수정 후 요약 재생성** 흐름이다.

## 6. LinkWork 도입 후보

전제: 로컬 우선, 오프라인 STT, 구독 Claude 요약. 난이도는 상(새 모델·새 파이프라인) / 중(스키마·화면·프롬프트를 함께 변경) / 하(기존 구조 안의 변경).

### 6-1. 화자 분리

| # | 후보 | 기술 방안 | 난이도 | 기대 효과 |
|---|---|---|---|---|
| A1 | 녹음 종료 시 참석 인원 확인 | 종료 직후 "몇 명이었나요" 한 단계를 넣는다(구성원 칩 수로 기본값 제안). 값은 기존 `expected_speakers`에 저장한다. 화면은 `src/renderer/src/components/recording/RecorderControls.tsx` | 하 | 자동 추정의 과분할을 원천 차단한다. 클로바노트 화자 분리 품질의 가장 큰 단일 요인으로 추정 |
| A2 | 구성원 음성 프로필(같은 사람 재인식) | 화자에 구성원을 지정하면 그 화자의 CAM++ centroid를 구성원에 저장한다(새 테이블 또는 `src/main/db/schema.ts`의 구성원 테이블 확장, 구성원당 임베딩 여러 개 유지). 다음 회의의 화자 분리 뒤 클러스터 centroid를 프로필과 코사인 비교해 임계값 이상이면 이름을 자동 지정하고 "자동" 표시를 단다. 사용자가 고치면 해당 임베딩을 지우고 다시 등록한다. centroid 계산은 `src/main/services/diarization/worker.ts`에 이미 있다 | 중 | 사용자 문제 ①의 직접 해법. 반복 참석자의 이름 지정이 사라지고, 프로필이 있는 사람은 군집 병합 판단에도 쓸 수 있다 |
| A3 | 프로필 기반 군집 보정 | A2의 프로필이 있으면 두 클러스터가 같은 프로필에 가장 가까울 때 병합하고, 한 클러스터가 두 프로필에 걸치면 분할 후보로 표시한다. `src/main/services/diarization/embedding-merge.ts`의 병합 계획에 조건을 더한다 | 중 | "같은 사람이 둘로 쪼개짐"을 줄인다. 인원 지정 모드에서 병합을 하지 않는 현재 규칙의 빈틈을 메운다 |
| A4 | 화자 변경 범위 3단계 | 화자 변경 시 "이 구간만 / 이 구간부터 / 전체 구간"을 고른다. "이 구간부터"는 해당 시각 이후 같은 화자 세그먼트를 일괄 변경하고 `speaker_corrected`를 세운다. 화면은 `src/renderer/src/components/recording/SpeakerEditor.tsx` | 하 | 한 클러스터에 두 사람이 섞인 경우를 한 번에 고친다. 수정 비용이 발화 수가 아니라 오류 수에 비례하게 된다 |
| A5 | 엔진 라벨과 사용자 라벨 분리 보존 | 세그먼트에 엔진이 낸 원래 화자 키를 따로 남긴다. 재처리 뒤 승계(`src/main/services/speaker-carryover.ts`)의 근거로 쓰고, 일괄 변경 되돌리기를 지원한다 | 중 | 수동 보정이 재처리에서 사라지는 경우를 줄인다 |
| A6 | 다중 스케일 임베딩 재군집 | pyannote 세그멘테이션이 낸 발화 구간을 0.5초/1.0초/1.5초 윈도로 다시 잘라 CAM++ 임베딩을 뽑고, 코사인 affinity를 합쳐 spectral clustering(인원 지정 시 k 고정)한다. sherpa-onnx의 임베딩 추출기를 직접 호출해야 한다 | 상 | 짧은 맞장구의 귀속과 화자 혼동 개선. 연구 수치상 화자 혼동 10~20% 상대 개선. 처리 시간이 늘어난다 |
| A7 | 참석자 대화 비율 | 화자별 발화 시간 합을 막대로 표시한다. `src/renderer/src/components/recording/SpeakerTimeline.tsx` 옆에 둔다 | 하 | 화자 분리 결과의 이상(한 사람이 80%)을 사용자가 바로 알아챈다 |

### 6-2. 요약

| # | 후보 | 기술 방안 | 난이도 | 기대 효과 |
|---|---|---|---|---|
| B1 | 주제별 요약(목차) 추가 | `MEETING_SPEC` 출력에 `topics: [{title, at, points[]}]`를 더한다. `at`은 면접 요약처럼 전사의 `[mm:ss]`를 그대로 돌려받아 환산한다(`src/main/services/interview-summary.ts`의 타임스탬프 규약 재사용). 화면 `src/renderer/src/components/recording/SummaryPanel.tsx`에서 소제목을 누르면 재생 위치로 이동한다 | 중 | 사용자 문제 ②의 핵심. 긴 회의를 주제 순서로 훑고 원문으로 뛰어든다. 클로바노트·Fireflies 공통 구조 |
| B2 | 요약 템플릿 | `src/main/services/summary-spec.ts`에 사용자 템플릿 스펙을 더한다. 사용자가 Markdown 제목 골격(제목 50자, 본문 2,000자 수준 제한)을 쓰면 그 골격을 채운 Markdown을 받는다. 기본 양식 몇 개(주간 회의, 1:1, 의사결정, 브레인스토밍)를 미리 넣는다 | 중 | 회의 유형별 포맷 요구를 코드 변경 없이 수용한다 |
| B3 | 회의당 요약 여러 개 | 요약을 회의와 1:1에서 1:N으로 바꾼다(템플릿별 행). 탭으로 전환한다. `src/main/services/meeting-notes.ts`의 내보내기는 선택한 요약을 쓴다 | 중 | 같은 녹음을 보고용·실무용으로 따로 정리한다. 구독 Claude라 횟수 차감 부담이 없다 |
| B4 | 다해상도 요약 | 한 번의 호출에서 한 문장 / 한 문단 / 주제 목차 / 상세를 함께 받는다. 한 문장은 회의록 목록과 오늘 화면에, 상세는 문서에 쓴다 | 하 | 목록에서 회의를 구별하기 쉬워진다 |
| B5 | 주요 키워드 칩 | 요약 출력에 `keywords[]`(5~10개)를 더하거나 전사의 명사 빈도로 뽑는다. 누르면 전사 검색을 연다. 용어집에 없는 키워드는 "용어집에 추가" 동작을 준다 | 하 | 검색 진입점. 용어집 보강 경로가 생긴다 |
| B6 | 긴 회의 구간 요약 | 80,000자 초과 시 균등 샘플링 대신 시간 구간별로 먼저 요약하고 합친다(map-reduce). B1의 주제 구간과 같이 쓴다 | 중 | 긴 회의 후반 누락 방지 |
| B7 | 화자 수정 후 요약 재생성 안내 | 화자 이름·귀속을 고친 뒤 요약이 옛 이름을 쓰고 있으면 "요약 다시 만들기"를 권한다 | 하 | 담당자 표기가 수정과 어긋나는 문제 방지 |
| B8 | 녹음 종료 후 자동 요약 설정 | 설정에 "전사 완료 후 자동 요약"과 기본 템플릿을 둔다 | 하 | 조작 단계 감소 |

### 6-3. 기타

| # | 후보 | 기술 방안 | 난이도 | 기대 효과 |
|---|---|---|---|---|
| C1 | 녹음 중 북마크 | 녹음 화면 버튼·단축키로 현재 경과 시각을 저장한다(새 테이블). 무음 컷편집 뒤에는 기존 타임라인 재매핑과 같은 방식으로 시각을 옮긴다. 상세 화면에서 북마크만 모아 보고 재생한다 | 중 | 회의 중 "여기 중요"를 한 번의 조작으로 남긴다. 요약 프롬프트에 북마크 시각을 넘겨 그 주변을 우선 반영하게 할 수 있다 |
| C2 | 녹음 중 메모 | 메모에 작성 시각을 붙여 저장한다. 메모의 단어를 whisper initial_prompt 용어 후보(`src/main/services/stt/initial-prompt.ts`)와 요약의 참고 정보 블록에 넣는다 | 중 | 사용자가 직접 쓴 고유명사가 인식과 요약에 반영된다. 클로바노트가 2020년에 밝힌 방향과 같다 |
| C3 | 문장 하이라이트 | 전사 세그먼트에 표시 플래그를 두고 모아보기에 넣는다 | 하 | 회의 후 정리 보조 |
| C4 | 검색 후 단어 일괄 바꾸기 | 회의 안 검색 결과를 한 번에 치환하고 `text_corrected`를 세운다. 치환 쌍을 용어집 별칭으로 등록할지 묻는다(`src/main/services/stt/glossary-correct.ts`가 다음 회의부터 자동 적용) | 하 | 반복 오인식 수정이 다음 회의에 이어진다 |
| C5 | 노트 미리 만들기 + 캘린더 연결 | 캘린더 일정에서 제목·참석자를 채운 녹음 준비 상태를 만든다. 일정 참석자와 구성원을 맞춰 참석 인원 기본값(A1)과 프로필 후보(A2)를 좁힌다 | 중 | 인원·이름 입력이 자동이 되고, 프로필 대조 대상이 줄어 오인식이 감소한다 |
| C6 | SRT·문서 내보내기 | 전사를 SRT로 내보낸다. Markdown 내보내기는 이미 있다 | 하 | 영상 자막 용도 |
| C7 | 단어 단위 타임스탬프로 화자 귀속 | whisper의 토큰 타임스탬프로 단어마다 화자를 귀속하고 화자가 바뀌는 지점에서 세그먼트를 자른다. 현재는 30자 분할 세그먼트 단위 귀속이다 | 중 | 한 세그먼트 안의 화자 교대(맞장구)를 살린다. CLOVA Speech API가 단어 정렬을 기본 출력하는 이유로 추정 |

### 6-4. 권장 순서

1. **A1 + A4 + A7** (모두 "하"): 화자 수를 묻고, 틀린 것을 싸게 고치고, 이상을 눈에 보이게 한다.
2. **A2**: 구성원 음성 프로필. 사용자 문제 ①에 대한 클로바노트 방식의 핵심이며, LinkWork는 필요한 부품(CAM++ centroid, 구성원 테이블, 화자 편집 화면)을 이미 갖고 있다.
3. **B1 + B5 + B4**: 요약에 주제 축과 키워드를 더한다. 기존 5분류는 유지한다.
4. **B2 + B3**: 템플릿과 요약 여러 개.
5. **C1 + C2**: 녹음 중 북마크·메모.
6. **A3, A6, C7**: 측정 가능한 평가 세트(화자 라벨이 있는 한국어 대면 녹음)를 먼저 만든 뒤에 진행한다. 지금은 정답 화자 수조차 확인할 수 없어(`docs/MEETING_RECORDING.md` §5-3 실측 주석) 모델 변경의 효과를 판정할 수 없다.

## 7. 출처 목록

- 네이버 보도자료 2020-11 출시(NEST·WISE): https://navercorp.com/media/pressReleasesDetail?seq=30289
- 네이버 보도자료 2021-11(100만 사용자, Interspeech 2021): https://www.navercorp.com/en/media/pressReleasesDetail?seq=30622
- 네이버 보도자료 2022-08(AI 요약, 점유율): https://navercorp.com/media/pressReleasesDetail?seq=30851
- ITWorld 2023-11 정식 출시 기사: https://www.itworld.co.kr/news/313536
- 디자인 나침반 2023-11 정식 출시 글: https://designcompass.org/2023/11/20/clovanote-release/
- 도움말 새 노트 생성: https://help.worksmobile.com/ko/use-guides/clovanote/create/note/
- 도움말 노트 편집: https://help.worksmobile.com/ko/use-guides/clovanote/manage-share/edit/
- 도움말 화자 자동 식별: https://help.worksmobile.com/ko/use-guides/clovanote/view/speaker-identification/
- 도움말 AI 요약: https://help.worksmobile.com/ko/use-guides/clovanote/view/ai-summary/
- 도움말 주요 키워드: https://help.worksmobile.com/ko/use-guides/clovanote/view/keyword/
- 도움말 참석자 대화 비율: https://help.worksmobile.com/ko/use-guides/clovanote/view/talk-ratio/
- 도움말 자주 쓰는 단어: https://help.worksmobile.com/ko/use-guides/clovanote/settings/usedword/
- 도움말 자동화 설정: https://help.worksmobile.com/ko/use-guides/clovanote/settings/automation/
- 앱스토어 클로바노트: https://apps.apple.com/kr/app/id1530010245
- CLOVA Speech 장문 인식 API(로컬 파일): https://api.ncloud-docs.com/docs/ai-application-service-clovaspeech-longsentence-local
- CLOVA Speech 릴리스 노트: https://api.ncloud-docs.com/docs/en/ai-clovaspeech-longsentence-releasenote
- 논문 Adapting Speaker Embeddings for Speaker Diarisation: https://arxiv.org/abs/2104.02879
- 논문 Multi-scale speaker embedding-based GAT: https://ar5iv.labs.arxiv.org/html/2110.03361
- 논문 High-resolution embedding extractor: https://arxiv.org/abs/2211.04060
- 논문 Target Speaker Tagging: https://arxiv.org/abs/2606.14091
- 클로바노트 vs Fireflies 4주 비교: https://smarttechnote.com/ai-meeting-notes-review/
- 매경이코노미 음성인식 앱 체험기(2025-10): https://v.daum.net/v/uF3vfnqFvN
- 앱스토어 다글로: https://apps.apple.com/kr/app/id1632867925
- Fireflies 요약 도움말: https://guide.fireflies.ai/articles/9547055509-Fireflies-AI-Meeting-Summaries%3A-View%2C-Customise%2C-Expand%2C-Regenerate
- Fireflies API 요약 스키마: https://docs.fireflies.ai/schema/summary
- Fireflies 기능 개요(ZoomInfo): https://pipeline.zoominfo.com/sales/fireflies-ai-features
