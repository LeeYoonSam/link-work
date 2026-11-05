import { app, shell, BrowserWindow, protocol, dialog, ipcMain } from 'electron'
import { join, basename } from 'path'
import { stat, open, readFile } from 'fs/promises'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { initDatabase, closeDatabase, getDatabase } from './db/database'
import { registerProjectIpc } from './ipc/project.ipc'
import { registerTaskIpc } from './ipc/task.ipc'
import { registerCalendarIpc } from './ipc/calendar.ipc'
import { registerDocumentIpc } from './ipc/document.ipc'
import { registerVariableIpc } from './ipc/variable.ipc'
import { registerMemoIpc } from './ipc/memo.ipc'
import { registerMemoCategoryIpc } from './ipc/memo-category.ipc'
import { registerReportIpc } from './ipc/report.ipc'
import { registerTodoIpc } from './ipc/todo.ipc'
import { registerTodoTagIpc } from './ipc/todo-tag.ipc'
import { registerAiIpc } from './ipc/ai.ipc'
import { registerRecordingIpc } from './ipc/recording.ipc'
import { registerMeetingNotesIpc } from './ipc/meeting-notes.ipc'
import { registerRecognitionAidsIpc } from './ipc/recognition-aids.ipc'
import { registerExportIpc } from './ipc/export.ipc'
import { registerReleaseNoteIpc } from './ipc/release-note.ipc'
import { registerBackupIpc } from './ipc/backup.ipc'
import { registerProjectSyncIpc } from './ipc/project-sync.ipc'
import { registerAssistantIpc } from './ipc/assistant.ipc'
import { cancelAllAiQueries } from './services/ai-agent'
import { cancelAllHeadless } from './services/ai-headless'
import { startNotificationService, stopNotificationService } from './services/notification'
import { startAssistantScheduler, stopAssistantScheduler } from './services/assistant-scheduler'
import { runMorningSyncIfDue } from './services/morning-sync'
import { createTrayWidget, destroyTrayWidget } from './services/tray-widget'
import { onRendererReload } from './services/recording-recovery'
import {
  RecordingGuard,
  CLOSE_BUTTONS,
  QUIT_BUTTONS,
  closeChoiceToAction,
  quitChoiceToAction,
  forceChoiceToAction
} from './services/recording-guard'

let mainWindow: BrowserWindow | null = null

// 녹음 중 창 닫기/앱 종료 가드 (docs/MEETING_RECORDING.md "녹음 수명주기와 비정상 종료 복구").
// 렌더러가 recorder:state로 녹음 중 여부를 보고하고, 닫기/종료 시 사용자에게 묻는다.
const recordingGuard = new RecordingGuard()
// 사용자가 확인을 마친 창 닫기/앱 종료 — close/before-quit 핸들러가 다시 가로채지 않게 한다
let forceCloseWindow = false
let quitConfirmed = false
// 가드 다이얼로그가 떠 있는 동안 중복 닫기/종료 요청은 무시한다
let guardPromptOpen = false

// 렌더러가 사라졌을 때(창 닫힘·크래시): 가드를 비우고 'recording'에 남은 회의를 정리한다.
// 이 렌더러가 녹음기의 유일한 주인이므로 남은 'recording' 행은 전부 고아다.
// 렌더러가 새로 로드될 때(첫 로드·새로고침)도 같다 — 새로고침은 'closed'/'render-process-gone'
// 없이 이전 렌더러의 녹음기를 없앤다.
function recoverAfterRendererGone(): void {
  try {
    onRendererReload(getDatabase(), recordingGuard)
  } catch (err) {
    // DB를 못 열어도 가드 상태는 비운다
    recordingGuard.reset()
    console.error('[recording] 고아 녹음 복구 실패:', err)
  }
}

function stripHash(url: string): string {
  const i = url.indexOf('#')
  return i === -1 ? url : url.slice(0, i)
}

function sendRecorderCommand(win: BrowserWindow): (cmd: unknown) => void {
  return (cmd) => {
    if (win.isDestroyed()) throw new Error('창이 이미 닫혔습니다.')
    win.webContents.send('recorder:command', cmd)
  }
}

// 녹음 중 창 닫기 — 숨기고 계속 녹음 / 저장하고 닫기 / 돌아가기
async function confirmCloseWhileRecording(win: BrowserWindow): Promise<void> {
  guardPromptOpen = true
  try {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: CLOSE_BUTTONS,
      defaultId: 0,
      cancelId: 2,
      message: '녹음 중입니다.',
      detail:
        '창을 닫으면 녹음이 중단됩니다. 창만 숨기고 녹음을 계속하거나, 지금까지 녹음된 내용을 저장하고 닫을 수 있습니다.'
    })
    const action = closeChoiceToAction(response)
    if (action === 'cancel' || win.isDestroyed()) return
    if (action === 'hide') {
      win.hide()
      return
    }

    const result = await recordingGuard.requestStopAndSave(sendRecorderCommand(win), true)
    if (win.isDestroyed()) return
    if (!result.success) {
      const { response: retry } = await dialog.showMessageBox(win, {
        type: 'warning',
        buttons: ['그래도 닫기', '돌아가기'],
        defaultId: 1,
        cancelId: 1,
        message: '녹음을 저장하지 못했습니다.',
        detail: `창을 닫으면 녹음된 내용이 사라집니다.${result.error ? `\n(${result.error})` : ''}`
      })
      if (forceChoiceToAction(retry) === 'cancel' || win.isDestroyed()) return
    }
    forceCloseWindow = true
    win.close()
  } finally {
    guardPromptOpen = false
  }
}

// 녹음 중 앱 종료 — 저장하고 종료 / 돌아가기. 확인을 마치면 app.quit()을 다시 호출한다.
async function confirmQuitWhileRecording(win: BrowserWindow): Promise<void> {
  guardPromptOpen = true
  try {
    // 창을 숨겨 둔 채 녹음 중이면(트레이에서 종료) 다이얼로그를 띄울 창부터 보여 준다
    if (!win.isVisible()) win.show()
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: QUIT_BUTTONS,
      defaultId: 0,
      cancelId: 1,
      message: '녹음 중입니다.',
      detail: '종료하기 전에 지금까지 녹음된 내용을 저장합니다. 전사·요약은 다음 실행 때 다시 처리할 수 있습니다.'
    })
    if (quitChoiceToAction(response) === 'cancel') return

    if (!win.isDestroyed()) {
      const result = await recordingGuard.requestStopAndSave(sendRecorderCommand(win), false)
      if (!result.success && !win.isDestroyed()) {
        const { response: retry } = await dialog.showMessageBox(win, {
          type: 'warning',
          buttons: ['그래도 종료', '돌아가기'],
          defaultId: 1,
          cancelId: 1,
          message: '녹음을 저장하지 못했습니다.',
          detail: `종료하면 녹음된 내용이 사라집니다.${result.error ? `\n(${result.error})` : ''}`
        })
        if (forceChoiceToAction(retry) === 'cancel') return
      }
    }
    quitConfirmed = true
    app.quit()
  } finally {
    guardPromptOpen = false
  }
}

// 녹음 오디오 재생용 커스텀 프로토콜 (renderer는 userData 경로를 모르고 file://는 막힘).
// 반드시 app ready 전에 등록해야 한다.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'linkwork-media',
    privileges: { secure: true, supportFetchAPI: true, stream: true, bypassCSP: true }
  }
])

function createWindow(): void {
  forceCloseWindow = false
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  mainWindow = win

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  // 녹음 중 창 닫기(X/Cmd+W) 가드. 확인을 마친 닫기와 앱 종료 중 닫기는 통과시킨다.
  mainWindow.on('close', (event) => {
    if (forceCloseWindow || quitConfirmed || !recordingGuard.isActive()) return
    event.preventDefault()
    if (guardPromptOpen) return
    void confirmCloseWhileRecording(win)
  })

  mainWindow.on('closed', () => {
    mainWindow = null
    recoverAfterRendererGone()
  })

  // 렌더러 크래시 — 녹음은 사라졌으므로 'recording' 행을 정리한다
  mainWindow.webContents.on('render-process-gone', () => {
    recoverAfterRendererGone()
  })

  // 메인 프레임 이동 차단 — 파일 드롭·링크 클릭 등으로 앱 페이지를 벗어나면 녹음과 상태가
  // 사라진다(외부 링크는 setWindowOpenHandler가 브라우저로 연다). 같은 문서로의 이동(새로고침,
  // 개발 모드 HMR 전체 새로고침)은 통과시킨다.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const current = win.webContents.getURL()
    if (current && stripHash(url) === stripHash(current)) return
    event.preventDefault()
  })

  // 메인 프레임 이동 확정(첫 로드·새로고침) — 새로고침은 'closed'/'render-process-gone' 없이
  // 이전 렌더러의 녹음기를 없앤다. 새 렌더러가 녹음을 시작하기 전에 이전 잔재를 정리한다.
  // (did-start-loading은 다운로드로 바뀌는 이동에서도 발생해 살아 있는 녹음을 건드리므로 쓰지 않는다)
  mainWindow.webContents.on('did-navigate', () => {
    recoverAfterRendererGone()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    try {
      const parsed = new URL(details.url)
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        shell.openExternal(details.url)
      }
    } catch {
      // Invalid URL — ignore
    }
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    } else {
      createWindow()
    }
  })
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.linkwork.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // 녹음 오디오 스트리밍 (linkwork-media://audio/<파일명>). basename으로 경로 탈출 차단.
  // <audio>가 시킹할 때 보내는 HTTP Range 요청을 206 Partial Content로 처리해야
  // 전체 파일을 받지 않고도 즉시 seek이 가능하다. (Range 미지원 시 큰 WAV에서
  // 시킹이 간헐적으로 실패하거나 위치가 초기화되던 버그)
  protocol.handle('linkwork-media', async (request) => {
    const url = new URL(request.url)
    const fileName = basename(decodeURIComponent(url.pathname))

    // AI 대화 첨부 이미지 (linkwork-media://attachment/<파일명>)
    if (url.host === 'attachment') {
      const imagePath = join(app.getPath('userData'), 'ai-attachments', fileName)
      try {
        const buf = await readFile(imagePath)
        const ext = fileName.split('.').pop()?.toLowerCase()
        const imageType =
          ext === 'png'
            ? 'image/png'
            : ext === 'webp'
              ? 'image/webp'
              : ext === 'gif'
                ? 'image/gif'
                : 'image/jpeg'
        return new Response(buf, { status: 200, headers: { 'Content-Type': imageType } })
      } catch {
        return new Response('Not Found', { status: 404 })
      }
    }

    const filePath = join(app.getPath('userData'), 'recordings', fileName)

    let fileSize: number
    try {
      fileSize = (await stat(filePath)).size
    } catch {
      return new Response('Not Found', { status: 404 })
    }

    const contentType = fileName.endsWith('.wav')
      ? 'audio/wav'
      : fileName.endsWith('.ogg')
        ? 'audio/ogg'
        : 'audio/webm'

    const rangeHeader = request.headers.get('Range')
    if (rangeHeader) {
      const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader)
      let start = m && m[1] ? parseInt(m[1], 10) : 0
      let end = m && m[2] ? parseInt(m[2], 10) : fileSize - 1
      if (!Number.isFinite(start) || start < 0) start = 0
      if (!Number.isFinite(end) || end >= fileSize) end = fileSize - 1
      if (start > end) {
        return new Response('Range Not Satisfiable', {
          status: 416,
          headers: { 'Content-Range': `bytes */${fileSize}` }
        })
      }
      const chunkSize = end - start + 1
      const buf = Buffer.alloc(chunkSize)
      const fd = await open(filePath, 'r')
      try {
        await fd.read(buf, 0, chunkSize, start)
      } finally {
        await fd.close()
      }
      return new Response(buf, {
        status: 206,
        headers: {
          'Content-Type': contentType,
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(chunkSize)
        }
      })
    }

    const buf = await readFile(filePath)
    return new Response(buf, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(fileSize)
      }
    })
  })

  initDatabase()
  registerProjectIpc()
  registerTaskIpc()
  registerCalendarIpc()
  registerDocumentIpc()
  registerVariableIpc()
  registerMemoIpc()
  registerMemoCategoryIpc()
  registerReportIpc()
  registerTodoIpc()
  registerTodoTagIpc()
  registerAiIpc()
  registerRecordingIpc()
  registerMeetingNotesIpc()
  registerRecognitionAidsIpc()
  registerExportIpc()
  registerReleaseNoteIpc()
  registerBackupIpc()
  registerProjectSyncIpc()
  registerAssistantIpc()
  ipcMain.on('recorder:state', (event, payload) => {
    if (mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents) {
      recordingGuard.setState(payload)
    }
  })
  ipcMain.on('recorder:command-done', (_event, payload) => {
    recordingGuard.handleCommandDone(payload)
  })
  startNotificationService()
  // A54: 아침 자동 동기화는 스케줄러 틱 끝에서 돈다. 스케줄러는 동기화 모듈을 import 하지 않는다
  startAssistantScheduler({ getMainWindow: () => mainWindow, createWindow, onTick: runMorningSyncIfDue })
  createTrayWidget(() => createWindow())

  createWindow()

  app.on('activate', function () {
    if (mainWindow === null || mainWindow.isDestroyed()) {
      createWindow()
    } else {
      mainWindow.show()
      mainWindow.focus()
    }
  })
})

app.on('before-quit', (event) => {
  // 녹음 중이면 종료를 멈추고 저장 여부를 묻는다. 확인 후 app.quit()이 다시 들어온다.
  if (!quitConfirmed && recordingGuard.isActive() && mainWindow && !mainWindow.isDestroyed()) {
    event.preventDefault()
    if (!guardPromptOpen) void confirmQuitWhileRecording(mainWindow)
    return
  }
  // 아래 정리는 종료가 실제로 진행될 때만 실행한다(위에서 막힌 종료에서는 트레이 등을 살려 둔다).
  // 타이머/트레이 먼저 정지 (in-flight async 콜백이 DB에 접근하는 race 회피)
  stopNotificationService()
  stopAssistantScheduler()
  destroyTrayWidget()
  cancelAllAiQueries()
  cancelAllHeadless()
})

app.on('will-quit', () => {
  // 모든 window/timer가 정리된 뒤 DB 닫기 (WAL 잔존 방지)
  closeDatabase()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
