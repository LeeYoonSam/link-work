import { BrowserWindow, dialog, ipcMain } from 'electron'
import { writeFile } from 'fs/promises'

export function registerExportIpc(): void {
  // 렌더러가 만든 마크다운 문자열을 저장 다이얼로그를 거쳐 .md 파일로 기록한다.
  ipcMain.handle(
    'export:saveMarkdown',
    async (event, content: string, defaultFileName: string) => {
      try {
        const parent = BrowserWindow.fromWebContents(event.sender)
        const options: Electron.SaveDialogOptions = {
          defaultPath: defaultFileName,
          filters: [{ name: 'Markdown', extensions: ['md'] }]
        }
        // 부모 창을 찾을 수 있으면 시트(모달)로 붙인다.
        const result = parent
          ? await dialog.showSaveDialog(parent, options)
          : await dialog.showSaveDialog(options)

        if (result.canceled || !result.filePath) {
          return { success: false, canceled: true }
        }

        await writeFile(result.filePath, content, 'utf-8')
        return { success: true, path: result.filePath }
      } catch (error) {
        return { success: false, error: String(error) }
      }
    }
  )
}
