// WAV 파일의 정확한 길이를 헤더에서 계산한다.
// renderer의 녹음 타이머/webm 디코더 값은 환경에 따라 부정확할 수 있어(과거 회귀로
// duration_ms가 10배로 저장된 사례 존재), WAV로 저장된 오디오는 파일 자체를 ground
// truth로 삼는다. 우리 encodeWav16이 쓰는 표준 44바이트 PCM 헤더를 가정한다.
import { openSync, readSync, closeSync, statSync } from 'fs'

/**
 * WAV(PCM) 파일의 재생 길이(ms)를 헤더로 계산한다. WAV가 아니거나 읽기 실패 시 null.
 */
export function wavDurationMs(path: string): number | null {
  try {
    const header = Buffer.alloc(44)
    const fd = openSync(path, 'r')
    try {
      readSync(fd, header, 0, 44, 0)
    } finally {
      closeSync(fd)
    }

    // RIFF/WAVE 매직 확인
    if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') {
      return null
    }

    const byteRate = header.readUInt32LE(28) // sampleRate * channels * bitsPerSample/8
    if (!byteRate) return null

    // data 청크 크기(표준 헤더에서 offset 40). 0이거나 비정상이면 파일 크기로 보정.
    let dataSize = header.readUInt32LE(40)
    const fileSize = statSync(path).size
    if (!dataSize || dataSize + 44 > fileSize) {
      dataSize = fileSize - 44
    }
    if (dataSize <= 0) return null

    return Math.round((dataSize / byteRate) * 1000)
  } catch {
    return null
  }
}
