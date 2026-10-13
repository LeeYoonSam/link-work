# 회의록 (Meeting Notes)

## 목적
요약까지 끝난 회의·면접(`meetings.status='summarized'`)을 "회의록" 메뉴에서 문서처럼 목록·검색·열람하고 Markdown으로 내보낸다.
새 테이블은 없다. `meetings` + `meeting_summaries`(1:1) 조인과 `projects`, `meeting_attendees`/`meeting_members`만 읽는다(읽기 전용).

## 파일
- `src/main/services/meeting-notes.ts` — 순수 함수(`buildMeetingNoteMarkdown`, `countActionItems`, `escapeLike`, `parseJsonArray`)
- `src/main/ipc/meeting-notes.ipc.ts` — IPC 핸들러
- `src/renderer/src/types/index.ts` — `MeetingNoteFilter`, `MeetingNoteItem`, `MeetingNotesAPI`
- preload: `window.api.meetingNotes`

## IPC 채널
| 채널 | 입력 | 출력 |
|------|------|------|
| `meetingNotes:list` | `MeetingNoteFilter?` | `MeetingNoteItem[]` (`started_at DESC`) |
| `meetingNotes:markdown` | `id: number` | Markdown 문자열 (회의 없으면 `''`) |

## 필터
- `q`: trim 후 비면 무시. `%`·`_`·`\`는 이스케이프(`ESCAPE '\'`)해 문자 그대로 검색한다.
- `kind`: `'all'`(기본) | `'meeting'` | `'interview'`
- `projectId`: `undefined`=전체, `null`=프로젝트 미지정만, 숫자=해당 프로젝트

## 검색 범위 (부분 일치 LIKE, OR)
`m.title`, `s.tldr`, `s.key_points`, `s.decisions`, `s.action_items`, `s.next_steps`, `s.qa_pairs`, 그리고 전사 `meeting_segments.text`(EXISTS 서브쿼리).
JSON 컬럼은 직렬화 문자열 그대로 검색한다.

## MeetingNoteItem 파생 값
- `key_point_count`, `decision_count`, `action_item_count`: 각 JSON 배열 길이
- `open_action_count`: `action_items` 중 `todo_id`가 없는 개수
- `attendee_names`: 참석자 이름(정렬은 `listAttendees`와 동일)

## Markdown 구조
`# 제목` → 메타 줄(일시·길이·종류·참석자·프로젝트) →
- 회의: `## TL;DR`, `## 핵심 포인트`, `## 결정사항`, `## 액션아이템`(`- [ ]`/`- [x]`=할 일로 옮김, 담당·기한), `## 다음 단계`
- 면접: `## 면접 개요`, `## 질문과 답변`(`### Qn. 질문 [mm:ss]`, 답변 요약, `> 인용`), `## 역량별 근거`, `## 후속 질문`, `## 확인 필요`

마지막 `## 전사`(`[mm:ss] **화자**: 텍스트`). 빈 섹션은 생략한다.
