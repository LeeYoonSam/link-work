/**
 * 날짜 기반 프로젝트 진행 단계 계산 — 단일 출처.
 *
 * main(project.ipc·AI 도구·트레이 위젯)과 renderer(폼 미리보기)가 같은 규칙을 써야
 * "어디서 보든 같은 상태"가 성립한다. 렌더러가 main을 import할 수 없어 로직이 세 벌로
 * 갈라졌던 자리다 — projectOrder.ts와 같이 렌더러에 두고 main이 가져다 쓴다.
 * 렌더러 전용 API를 쓰지 말 것(main 프로세스에서도 로드된다).
 */

export interface ProjectDateFields {
  dev_start_date: string
  dev_end_date: string
  qa_start_date: string
  qa_end_date: string
  deploy_date: string
}

/**
 * 날짜만 보고 상태를 정한다. 여기서 나올 수 있는 값은 scheduled·development·qa_pending·
 * qa·deploy_pending·deploy·completed 일곱 가지다.
 *
 * 'on_hold'(중단)와 'cancelled'는 **절대 반환하지 않는다** — 사람이 status_manual=1로
 * 고정할 때만 들어가는 수동 전용 상태이고, applyProjectAutoStatus가 수동 상태를 덮어쓰지
 * 않으므로 중단해 둔 프로젝트가 날짜 때문에 슬그머니 진행 중으로 되살아나지 않는다.
 *
 * @param today 기준일(YYYY-MM-DD). 생략하면 오늘(UTC). 테스트가 시점을 고정하려고 넣는다.
 */
export function calculateProjectStatus(
  p: ProjectDateFields,
  today: string = new Date().toISOString().split('T')[0]
): string {
  if (today < p.dev_start_date) return 'scheduled'
  if (today > p.deploy_date) return 'completed'
  if (today === p.deploy_date) return 'deploy'
  if (today >= p.qa_start_date && today <= p.qa_end_date) return 'qa'
  // QA 종료 ~ 배포일 사이의 공백 구간(예: QA 26일 종료, 배포 30일)은 배포대기 상태.
  if (today > p.qa_end_date) return 'deploy_pending'
  // 개발 종료 ~ QA 시작 사이의 공백 구간(예: 개발 24일 종료, QA 26일 시작)은 QA대기 상태.
  if (today > p.dev_end_date) return 'qa_pending'
  return 'development'
}
