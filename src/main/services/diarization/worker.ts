// 화자분리 워커 — utilityProcess 에서 실행한다.
// 창마다 임베딩을 뽑는 동기 CPU 작업이라 메인 프로세스에서 돌리면 회의 길이만큼 UI 가 멈춘다.
// 본체는 embedding-diarizer.ts(runEmbeddingDiarization)이고 여기서는 모듈 로드와 메시지 왕복만 한다.
// main 빌드에 별도 엔트리로 포함된다 (electron.vite.config rollupOptions.input).
import {
  runEmbeddingDiarization,
  type EmbeddingDiarizeRequest,
  type EmbeddingDiarizeResult,
  type SherpaEmbeddingApi
} from './embedding-diarizer'

export type DiarWorkerRequest = EmbeddingDiarizeRequest

/** 워커 응답: 성공 { ok: true, result } / 실패 { ok: false, error } */
export type DiarWorkerResponse = { ok: true; result: EmbeddingDiarizeResult } | { ok: false; error: string }

// utilityProcess 워커에서 electron 이 주입하는 parentPort (필요한 부분만 로컬 정의)
interface ParentPortLike {
  on(event: 'message', listener: (e: { data: DiarWorkerRequest }) => void): void
  postMessage(message: DiarWorkerResponse): void
}
const parentPort = (process as unknown as { parentPort: ParentPortLike }).parentPort

parentPort.on('message', async (e: { data: DiarWorkerRequest }) => {
  try {
    // sherpa-onnx-node 는 external(번들 제외) — 런타임 동적 로드. CJS 모듈이라 default 로 노출될 수 있다.
    // @ts-ignore optional native module — 타입은 SherpaEmbeddingApi 로 로컬 정의
    const mod = (await import('sherpa-onnx-node')) as unknown as { default?: SherpaEmbeddingApi } & SherpaEmbeddingApi
    const sherpa: SherpaEmbeddingApi = mod.default ?? mod
    const result = runEmbeddingDiarization(sherpa, e.data)
    parentPort.postMessage({ ok: true, result })
  } catch (err) {
    parentPort.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) })
  }
})
