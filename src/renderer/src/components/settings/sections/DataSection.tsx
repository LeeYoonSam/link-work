import { useState } from 'react'
import BackupModal from '../../layout/BackupModal'
import { Card, button } from '../../ui'

// 설정 > 데이터. 백업·복원 모달을 수정 없이 띄운다 (docs/DATA_BACKUP.md).
export default function DataSection(): React.ReactNode {
  const [open, setOpen] = useState(false)
  return (
    <div className="space-y-3">
      <Card padding="sm" className="space-y-2">
        <h4 className="text-sm font-semibold text-gray-900">백업과 복원</h4>
        <p className="text-xs text-gray-600">
          LinkWork 데이터를 .zip 파일 하나로 내보내고, 새 PC 에서 그 파일로 복원합니다. 토큰 같은 비밀값은
          백업에 넣지 않으니 복원한 뒤 설정 &gt; 연동에서 다시 연결하세요.
        </p>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={`px-3 py-1.5 text-xs ${button.primary}`}
        >
          백업·복원 열기
        </button>
      </Card>
      {open ? <BackupModal onClose={() => setOpen(false)} /> : null}
    </div>
  )
}
