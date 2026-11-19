// 모바일 메모 본문 마크다운. 타이포는 mobile.css 의 .m-md 가 정한다(제목·목록·코드블록·표 가로 스크롤·인용·링크).
// 메모 본문은 raw HTML 로 주입하지 않는다: rehype-raw 를 쓰지 않아 본문의 HTML 태그는 요소가 되지 않고(skipHtml),
// rehype-sanitize 로 한 번 더 걸러 스크립트·이벤트 핸들러 속성이 남지 않게 한다.
// 링크는 기본 urlTransform 으로 javascript: 등을 막고, 새 탭(noopener noreferrer)으로 연다.
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSanitize from 'rehype-sanitize'

/** 할 일 목록 체크 표시. 읽기 전용이라 입력 요소 대신 그림 + 글자 라벨로 그린다 */
function TaskMark({ checked }: { checked: boolean }): React.ReactNode {
  return (
    <span role="img" aria-label={checked ? '완료' : '미완료'} data-checked={checked ? 'true' : 'false'} className="m-task">
      <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden>
        <rect x="2" y="2" width="16" height="16" rx="5" fill={checked ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" />
        {checked ? <path d="m6 10.2 2.7 2.6L14 7.4" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /> : null}
      </svg>
    </span>
  )
}

export default function MobileMarkdown({ content }: { content: string }): React.ReactNode {
  return (
    <div className="m-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        skipHtml
        components={{
          p: ({ children }) => <p data-primary>{children}</p>,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className="m-table-wrap">
              <table>{children}</table>
            </div>
          ),
          input: ({ type, checked }) => (type === 'checkbox' ? <TaskMark checked={!!checked} /> : null),
          img: ({ src, alt }) => <img src={typeof src === 'string' ? src : undefined} alt={alt ?? ''} loading="lazy" />
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
