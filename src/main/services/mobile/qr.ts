// 페어링 URL 의 QR 을 SVG data URL 로 만든다(qrcode-generator, 의존성 없음).
import qrcode from 'qrcode-generator'

export function qrSvgDataUrl(text: string): string {
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  const svg = qr.createSvgTag({ cellSize: 6, margin: 4, scalable: true })
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}
