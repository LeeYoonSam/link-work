// 녹음 오디오(webm/opus)를 whisper.cpp 입력 포맷인 16kHz mono 16-bit WAV로 변환한다.
// Chromium 내장 디코더(Web Audio)를 사용하므로 ffmpeg 등 외부 의존성이 필요 없다.

const TARGET_SAMPLE_RATE = 16000

/**
 * webm/opus 등 Blob → { 16kHz mono WAV ArrayBuffer, durationMs }
 * 디코드/리샘플은 Web Audio로 처리한다. 호출 실패 시 throw (호출측이 원본 저장으로 폴백).
 */
export async function blobToWav16kMono(
  blob: Blob
): Promise<{ wav: ArrayBuffer; durationMs: number }> {
  const arrayBuf = await blob.arrayBuffer()

  // 1) 디코드
  const decodeCtx = new AudioContext()
  let audioBuffer: AudioBuffer
  try {
    audioBuffer = await decodeCtx.decodeAudioData(arrayBuf.slice(0))
  } finally {
    await decodeCtx.close()
  }

  // 2) 16kHz mono로 리샘플
  const frames = Math.max(1, Math.ceil(audioBuffer.duration * TARGET_SAMPLE_RATE))
  const offline = new OfflineAudioContext(1, frames, TARGET_SAMPLE_RATE)
  const src = offline.createBufferSource()
  src.buffer = audioBuffer
  src.connect(offline.destination)
  src.start()
  const rendered = await offline.startRendering()
  const mono = rendered.getChannelData(0)

  // 3) Float32 → Int16 PCM + WAV 컨테이너
  return {
    wav: encodeWav16(mono, TARGET_SAMPLE_RATE),
    durationMs: Math.round(audioBuffer.duration * 1000)
  }
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
