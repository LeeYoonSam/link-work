import { useEffect, useState } from 'react'
import type { AiBitbucketStatus } from '../../../types'
import { inputClass } from '../ConnectDialog'
import { isCommitEnter } from '../../../utils/imeEnter'

// Bitbucket 카드 안의 '리뷰 요청 워크스페이스'(나에게 온 요청, docs/ASSISTANT.md §11.6).
// 팝업 안에 두면 token 저장 버튼과 헷갈려 저장을 놓친다. 그래서 Jira 기본 프로젝트처럼 카드에 바로 둔다.
// Enter·칸 벗어남·[저장] 중 어느 것으로도 저장한다. 값이 그대로면 저장하지 않는다.

interface BitbucketWorkspaceInputProps {
  status: AiBitbucketStatus | null
  onChanged: () => void
}

export default function BitbucketWorkspaceInput({
  status,
  onChanged
}: BitbucketWorkspaceInputProps): React.ReactNode {
  // 마지막으로 저장된 값. 상태 새로고침(비동기)보다 먼저 바뀌어 Enter 뒤 blur 가 같은 값을 또 저장하지 않게 한다
  const [saved, setSaved] = useState(status?.workspace ?? '')
  const [value, setValue] = useState(saved)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    setValue(status?.workspace ?? '')
    setSaved(status?.workspace ?? '')
  }, [status?.workspace])

  if (status?.connected !== true) return null

  const save = async (): Promise<void> => {
    if (saving || value.trim() === saved) return
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const r = await window.api.ai.bitbucketSetWorkspace(value.trim())
      if (r.success) {
        setValue(r.workspace ?? '')
        setSaved(r.workspace ?? '')
        setNotice(r.workspace ? '저장했습니다. 오늘 화면이 리뷰 요청을 다시 읽습니다.' : '워크스페이스를 지웠습니다.')
        onChanged()
      } else {
        setError(r.error || '워크스페이스를 저장하지 못했습니다')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '워크스페이스를 저장하지 못했습니다')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="border border-gray-200 rounded-lg p-3">
      <p className="text-xs font-medium text-gray-700 mb-1">리뷰 요청 워크스페이스</p>
      <p className="text-[11px] text-gray-500 mb-2">
        이 워크스페이스에서 최근 갱신된 저장소 30개를 훑어, 나를 리뷰어로 둔 열린 PR 을 오늘 화면 '나에게 온 요청'에
        모읍니다. token 에 read:pullrequest 범위가 필요합니다.
      </p>
      <div className="flex gap-2">
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => void save()}
          onKeyDown={(e) => {
            if (isCommitEnter(e)) void save()
          }}
          placeholder="워크스페이스 이름 또는 https://bitbucket.org/이름"
          aria-label="리뷰 요청 워크스페이스"
          disabled={saving}
          className={`${inputClass} flex-1 disabled:bg-gray-50`}
        />
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || value.trim() === saved}
          className="shrink-0 rounded-md bg-gray-100 px-3 text-xs font-medium text-gray-700 hover:bg-gray-200 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? '저장 중…' : '저장'}
        </button>
      </div>
      {error ? <p className="mt-1 text-[11px] text-red-600 break-all">{error}</p> : null}
      {notice && !error ? <p className="mt-1 text-[11px] text-green-700">{notice}</p> : null}
      {!error && !notice && saved === '' ? (
        <p className="mt-1 text-[11px] text-amber-700">정하지 않으면 리뷰 요청을 모으지 않습니다.</p>
      ) : null}
    </div>
  )
}
