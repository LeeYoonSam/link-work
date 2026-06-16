// 녹음 오디오(webm/opus)를 whisper.cpp 입력 포맷인 16kHz mono 16-bit WAV로 변환한다.
// Chromium 내장 디코더(Web Audio)를 사용하므로 ffmpeg 등 외부 의존성이 필요 없다.
// 전사용 WAV는 mono로 유지하고(엔진 호환), 화자분리용 L(mic)/R(system) 에너지는
// 별도 envelope로 추출해 함께 전달한다. (docs/MEETING_RECORDING.md §화자분리)

const TARGET_SAMPLE_RATE = 16000

// 화자 귀속 해상도. STT segment는 보통 수 초이므로 100ms면 충분하고 데이터도 작다.
const ENERGY_HOP_MS = 100
// L/R이 사실상 동일하면(시스템 오디오 없이 mic을 양 채널에 복제한 경우) 화자분리 의미 없음.
const STEREO_DIFF_THRESHOLD = 0.05

// 채널 에너지 envelope — main의 ChannelEnergy 타입과 형태를 일치시킨다.
export interface ChannelEnergyPayload {
  hopMs: number
  left: number[]
  right: number[]
}

/**
 * webm/opus 등 Blob → { 16kHz mono WAV ArrayBuffer, durationMs, channelEnergy }
 * 디코드/리샘플은 Web Audio로 처리한다. 호출 실패 시 throw (호출측이 원본 저장으로 폴백).
 * channelEnergy는 mic=L/system=R 스테레오가 실제로 분리됐을 때만 반환, 아니면 null.
 */
export async function blobToWav16kMono(
  blob: Blob
): Promise<{ wav: ArrayBuffer; durationMs: number; channelEnergy: ChannelEnergyPayload | null }> {
  const arrayBuf = await blob.arrayBuffer()

  // 1) 디코드
  const decodeCtx = new AudioContext()
  let audioBuffer: AudioBuffer
  try {
    audioBuffer = await decodeCtx.decodeAudioData(arrayBuf.slice(0))
  } finally {
    await decodeCtx.close()
  }

  // 2) 화자분리용 L/R 에너지 envelope 추출 (mono 다운믹스 전, 원본 채널에서)
  const channelEnergy = computeChannelEnergy(audioBuffer)

  // 3) 16kHz mono로 리샘플 (전사용)
  const frames = Math.max(1, Math.ceil(audioBuffer.duration * TARGET_SAMPLE_RATE))
  const offline = new OfflineAudioContext(1, frames, TARGET_SAMPLE_RATE)
  const src = offline.createBufferSource()
  src.buffer = audioBuffer
  src.connect(offline.destination)
  src.start()
  const rendered = await offline.startRendering()
  const mono = rendered.getChannelData(0)

  // 4) Float32 → Int16 PCM + WAV 컨테이너
  return {
    wav: encodeWav16(mono, TARGET_SAMPLE_RATE),
    durationMs: Math.round(audioBuffer.duration * 1000),
    channelEnergy
  }
}

/**
 * 스테레오 audioBuffer(L=mic, R=system)에서 hop 구간별 RMS envelope를 계산한다.
 * - 1채널이거나 L/R이 거의 동일하면(시스템 오디오 미캡처) null 반환 → 단일 화자로 폴백.
 */
function computeChannelEnergy(audioBuffer: AudioBuffer): ChannelEnergyPayload | null {
  if (audioBuffer.numberOfChannels < 2) return null

  const L = audioBuffer.getChannelData(0)
  const R = audioBuffer.getChannelData(1)
  const sr = audioBuffer.sampleRate
  const hop = Math.max(1, Math.round((sr * ENERGY_HOP_MS) / 1000))
  const frameCount = Math.max(1, Math.ceil(L.length / hop))

  const left = new Array<number>(frameCount)
  const right = new Array<number>(frameCount)
  let diffAccum = 0
  let energyAccum = 0

  for (let f = 0; f < frameCount; f++) {
    const start = f * hop
    const end = Math.min(start + hop, L.length)
    let sumL = 0
    let sumR = 0
    for (let i = start; i < end; i++) {
      sumL += L[i] * L[i]
      sumR += R[i] * R[i]
    }
    const n = Math.max(1, end - start)
    const rmsL = Math.sqrt(sumL / n)
    const rmsR = Math.sqrt(sumR / n)
    // 소수 4자리로 양자화해 직렬화 크기를 줄인다.
    left[f] = Math.round(rmsL * 10000) / 10000
    right[f] = Math.round(rmsR * 10000) / 10000
    diffAccum += Math.abs(rmsL - rmsR)
    energyAccum += Math.max(rmsL, rmsR)
  }

  if (energyAccum <= 0) return null
  // L≈R(상대 차이가 임계 미만)이면 채널 분리가 무의미 → null
  if (diffAccum / energyAccum < STEREO_DIFF_THRESHOLD) return null

  return { hopMs: ENERGY_HOP_MS, left, right }
}

function encodeWav16(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const numSamples = samples.length
  const buffer = new ArrayBuffer(44 + numSamples * 2)
  const view = new DataView(buffer)

  const writeStr = (offset: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i))
  }

  // RIFF 헤더
  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + numSamples * 2, true)
  writeStr(8, 'WAVE')
  // fmt 청크 (PCM)
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate (sampleRate * blockAlign)
  view.setUint16(32, 2, true) // block align (mono * 16bit/8)
  view.setUint16(34, 16, true) // bits per sample
  // data 청크
  writeStr(36, 'data')
  view.setUint32(40, numSamples * 2, true)

  let offset = 44
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    offset += 2
  }
  return buffer
}
