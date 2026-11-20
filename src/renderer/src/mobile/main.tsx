// 모바일 열람(휴대폰 브라우저) 진입점. Mac 앱 메인 프로세스의 http 서버가 mobile.html 을 '/' 로 서빙한다.
// preload 브리지가 없으므로 이 아래 코드는 fetch 로만 통신한다.
import React from 'react'
import ReactDOM from 'react-dom/client'
import MobileApp from './MobileApp'
import '../styles/globals.css'
import './mobile.css'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <MobileApp />
  </React.StrictMode>
)
