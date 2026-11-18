import type { JiraConnectionStatus } from '../../types'
import JiraConnectDialog from '../settings/integrations/JiraConnectDialog'

interface JiraSettingsModalProps {
  status: JiraConnectionStatus | null
  onClose: () => void
  /** 저장·해제 후 상위가 연결 상태를 다시 읽도록 알린다 */
  onChanged: () => void
}

// 작업 흐름 중(프로젝트 싱크 모달, 릴리스 화면, 릴리스 노트 카드)에 Jira 연결을 그 자리에서 고치는 얇은 래퍼다.
// 설정 > 연동과 같은 JiraConnectDialog 를 띄운다. 연결돼 있으면 그 안에서 기본 프로젝트(JiraDefaultProjectSelect)도 고른다.
// props 를 예전 그대로 두어 호출부 3곳을 바꾸지 않는다. 이유: 설정 화면으로 이동하면 진행 중인 싱크 미리보기가 닫힌다
export default function JiraSettingsModal({
  status,
  onClose,
  onChanged
}: JiraSettingsModalProps): React.ReactNode {
  return <JiraConnectDialog status={status} onClose={onClose} onChanged={onChanged} />
}
