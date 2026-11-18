import RecognitionAidsPanel from '../../recording/RecognitionAidsPanel'
import { Card } from '../../ui'

// 설정 > 회의 녹음. 녹음 화면의 용어집·구성원 패널을 그대로 넣는다(녹음 화면에도 남아 있다).
export default function RecordingSection(): React.ReactNode {
  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-500">
        용어집과 구성원은 이 Mac 에만 저장되며 전사 힌트, 전사 후 표기 교정, AI 요약에 쓰입니다. 녹음
        화면에서도 같은 목록을 고칠 수 있습니다.
      </p>
      <Card padding="none">
        <RecognitionAidsPanel />
      </Card>
    </div>
  )
}
