// 열린 화면이 다른 경로의 변경을 반영하게 한다.
// 구독 대상은 ai:dataChanged, assistant:changed, 창 focus 다.
// App 메인 창이 installDataSync 를 1번 설치한다. 화면별 개별 구독을 두지 않는다.
// 이유: 같은 이벤트로 load 가 2번 돈다.
import { useProjectStore } from './projectStore'
import { useTodoStore } from './todoStore'
import { useMemoStore } from './memoStore'
import { useVariableStore } from './variableStore'
import { useDocumentStore } from './documentStore'
import { useAssistantStore } from './assistantStore'
import { useMorningSyncStore } from './morningSyncStore'

// focus 재로드 최소 간격이다
export const FOCUS_RELOAD_MS = 30_000

// 배경 갱신이다. 실패해도 throw 하지 않는다.
// entity 는 ai:dataChanged 가 보내는 값이다. 모르는 값이면 아무것도 하지 않는다
export async function refreshEntity(entity: string): Promise<void> {
  const jobs: Promise<unknown>[] = []
  const add = (job: () => Promise<unknown> | unknown): void => {
    try {
      jobs.push(Promise.resolve(job()))
    } catch (e) {
      jobs.push(Promise.reject(e))
    }
  }

  if (entity === 'project') {
    const projectStore = useProjectStore.getState()
    add(() => projectStore.fetchProjects(undefined, { silent: true }))
    // 상세 화면이 실제로 열려 있을 때만 상세를 다시 읽는다. 태스크 수정을 반영한다.
    // currentProject 는 목록으로 나가도 남는다. 그래서 projectView 로 한 번 더 거른다
    if (projectStore.projectView === 'detail' && projectStore.currentProject) {
      const id = projectStore.currentProject.id
      add(() => projectStore.fetchProject(id))
    }
  } else if (entity === 'todo') {
    const todoStore = useTodoStore.getState()
    add(() => todoStore.fetchTodos({ silent: true }))
    add(() => todoStore.fetchActiveTodos({ silent: true }))
    add(() => todoStore.fetchTags())
    // 원본 완료로 완료 목록이 바뀐다. 완료 목록이 열려 있을 때만 다시 읽는다
    if (todoStore.showCompleted) add(() => todoStore.fetchCompletedTodos())
  } else if (entity === 'memo') {
    const memoStore = useMemoStore.getState()
    add(() => memoStore.fetchMemos())
    add(() => memoStore.fetchCategories())
    // 홈의 중요 메모 섹션이 이 목록을 그린다
    add(() => memoStore.fetchImportantMemos())
  } else if (entity === 'variable') {
    add(() => useVariableStore.getState().fetchVariables())
  } else if (entity === 'document') {
    // 문서 목록 store 는 전체 목록과 프로젝트별 목록이 같이 쓴다.
    // 프로젝트 상세가 열려 있으면 그 프로젝트 문서만 다시 읽는다
    const projectStore = useProjectStore.getState()
    const documentStore = useDocumentStore.getState()
    if (projectStore.projectView === 'detail' && projectStore.currentProject) {
      const id = projectStore.currentProject.id
      add(() => documentStore.fetchDocuments(id))
    } else {
      add(() => documentStore.fetchAllDocuments())
    }
  } else if (entity === 'sync_status') {
    // 아침 자동 동기화가 끝났다. 배지·상태 줄과 오늘 화면 변경 내역을 다시 읽는다
    add(() => useMorningSyncStore.getState().load())
    add(() => useAssistantStore.getState().load())
  }

  await Promise.allSettled(jobs)
}

// focus 때 다시 읽는다. 오늘 화면은 열려 있을 때만 다시 읽는다.
// 이유: getToday 는 수집을 부를 수 있어 목록 조회보다 무겁다
async function reloadOnFocus(): Promise<void> {
  const view = useProjectStore.getState().view
  const jobs: Promise<void>[] = [
    refreshEntity('project'),
    refreshEntity('todo'),
    useMorningSyncStore
      .getState()
      .load()
      .catch(() => undefined)
  ]
  if (view === 'today') {
    jobs.push(
      useAssistantStore
        .getState()
        .load()
        .catch(() => undefined)
    )
    // 홈의 중요 메모 섹션을 다시 읽는다
    jobs.push(
      Promise.resolve()
        .then(() => useMemoStore.getState().fetchImportantMemos())
        .catch(() => undefined)
    )
  }
  await Promise.allSettled(jobs)
}

export interface DataSyncDeps {
  now?: () => number
  target?: Pick<Window, 'addEventListener' | 'removeEventListener'>
}

// 구독을 설치하고 해제 함수를 돌려준다
export function installDataSync(deps: DataSyncDeps = {}): () => void {
  const now = deps.now ?? Date.now
  const g = globalThis as { window?: Window }
  const target = deps.target ?? g.window
  const api = g.window?.api
  const offs: (() => void)[] = []

  const ai = api?.ai
  if (ai && typeof ai.onDataChanged === 'function') {
    offs.push(
      ai.onDataChanged((data) => {
        if (data && typeof data.entity === 'string') void refreshEntity(data.entity)
      })
    )
  }

  // reason 과 무관하게 다시 읽는다. 'meeting' 도 같다 (부록 I.10.3)
  const assistant = api?.assistant
  if (assistant && typeof assistant.onChanged === 'function') {
    offs.push(
      assistant.onChanged(() => {
        void useAssistantStore
          .getState()
          .load()
          .catch(() => undefined)
      })
    )
  }

  // 설치 시각을 마지막 재로드로 본다. 이유: 화면들이 마운트할 때 이미 읽었다
  let lastReload = now()
  const onFocus = (): void => {
    const t = now()
    if (t - lastReload < FOCUS_RELOAD_MS) return
    lastReload = t
    void reloadOnFocus()
  }
  if (target) {
    target.addEventListener('focus', onFocus)
    offs.push(() => target.removeEventListener('focus', onFocus))
  }

  // 사이드바 배지를 첫 화면부터 보여 준다
  void useMorningSyncStore
    .getState()
    .load()
    .catch(() => undefined)

  return () => {
    for (const off of offs.splice(0)) {
      try {
        off()
      } catch {
        // 해제 실패는 무시한다. 창이 닫히면 구독도 사라진다
      }
    }
  }
}
