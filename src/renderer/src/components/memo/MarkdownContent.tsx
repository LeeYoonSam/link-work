import { memo } from 'react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import { rehypeLinkifyBareUrls, rehypeStripEmptyParagraphs } from './rehypeHtmlPlugins'
import type { PluggableList } from 'unified'

interface MarkdownContentProps {
  content: string
  className?: string
  compact?: boolean
  // 입력의 단일 줄바꿈을 시각적 줄바꿈으로 보존 (markdown 하드 브레이크로 변환).
  // 자유서술 본문(프로젝트 설명 등)에서 사용자가 친 Enter를 그대로 보여줄 때 사용.
  preserveNewlines?: boolean
  // 본문에 섞인 raw HTML 태그(<ul>, <li>, <a>, <br> 등)를 렌더링한다.
  // Google Calendar description처럼 HTML로 저장된 외부 데이터를 표시할 때 사용.
  // rehype-sanitize로 안전한 태그/속성만 통과시키므로 XSS로부터 안전하다.
  allowHtml?: boolean
  // linkwork:// 스킴 링크 클릭 시 앱 내 네비게이션을 수행할 핸들러 (AI 대화 등)
  onInternalLink?: (href: string) => void
}

// 기본 스키마(GitHub 기준)에는 <u>가 빠져 있는데, Google Calendar 설명은 밑줄을
// <u>로 보내므로 서식이 사라진다. 순수 표현용 태그라 허용해도 안전하다.
const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), 'u', 's']
}

// allowHtml일 때만: raw HTML 파싱 → 맨 URL 링크화 → 살균 → 빈 문단 정리
const HTML_REHYPE_PLUGINS: PluggableList = [
  rehypeRaw,
  rehypeLinkifyBareUrls,
  [rehypeSanitize, sanitizeSchema],
  rehypeStripEmptyParagraphs
]

function MarkdownContentImpl({
  content,
  className = '',
  compact = false,
  preserveNewlines = false,
  allowHtml = false,
  onInternalLink
}: MarkdownContentProps): React.ReactNode {
  const gap = compact ? 'space-y-1.5' : 'space-y-3'
  const rendered = preserveNewlines
    ? content.replace(/(?<!\n)\n(?!\n)/g, '  \n')
    : content
  return (
    <div className={`markdown-body ${gap} text-sm text-gray-800 leading-relaxed ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={allowHtml ? HTML_REHYPE_PLUGINS : undefined}
        // react-markdown은 기본적으로 http(s) 외 프로토콜 href를 제거하므로
        // 앱 내 네비게이션용 linkwork:// 링크는 예외로 보존한다
        urlTransform={(url) =>
          url.startsWith('linkwork://') ? url : defaultUrlTransform(url)
        }
        components={{
          h1: ({ children }) => (
            <h1 className="text-base font-bold text-gray-900 mt-2 mb-1">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="text-sm font-bold text-gray-900 mt-2 mb-1">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="text-sm font-semibold text-gray-900 mt-1.5 mb-1">{children}</h3>
          ),
          h4: ({ children }) => (
            <h4 className="text-sm font-semibold text-gray-800">{children}</h4>
          ),
          p: ({ children }) => <p className="text-sm text-gray-800">{children}</p>,
          ul: ({ children }) => (
            <ul className="list-disc pl-5 space-y-0.5 text-sm text-gray-800">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal pl-5 space-y-0.5 text-sm text-gray-800">{children}</ol>
          ),
          li: ({ children }) => <li className="text-sm text-gray-800">{children}</li>,
          a: ({ href, children }) => {
            if (href?.startsWith('linkwork://') && onInternalLink) {
              return (
                <a
                  href={href}
                  className="text-blue-600 hover:underline font-medium"
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    onInternalLink(href)
                  }}
                >
                  {children}
                </a>
              )
            }
            return (
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                className="text-blue-600 hover:underline"
                onClick={(e) => e.stopPropagation()}
              >
                {children}
              </a>
            )
          },
          code: ({ className: codeClass, children }) => {
            const isBlock = /language-/.test(codeClass || '')
            if (isBlock) {
              return (
                <code className="block text-xs font-mono text-gray-800">{children}</code>
              )
            }
            return (
              <code className="px-1 py-0.5 text-xs font-mono bg-gray-100 text-gray-800 rounded">
                {children}
              </code>
            )
          },
          pre: ({ children }) => (
            <pre className="bg-gray-50 border border-gray-200 rounded-md p-3 overflow-x-auto text-xs font-mono text-gray-800">
              {children}
            </pre>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-4 border-gray-200 pl-3 text-gray-600 italic">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="border-gray-200" />,
          table: ({ children }) => (
            <div className="overflow-x-auto">
              <table className="min-w-full text-xs border border-gray-200">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="px-2 py-1 bg-gray-50 border border-gray-200 text-left font-semibold text-gray-700">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="px-2 py-1 border border-gray-200 text-gray-700">{children}</td>
          ),
          input: ({ type, checked, disabled }) => {
            if (type === 'checkbox') {
              return (
                <input
                  type="checkbox"
                  checked={!!checked}
                  disabled={disabled}
                  readOnly
                  className="mr-1 align-middle"
                />
              )
            }
            return null
          },
          strong: ({ children }) => (
            <strong className="font-semibold text-gray-900">{children}</strong>
          ),
          em: ({ children }) => <em className="italic">{children}</em>,
          img: ({ src, alt }) => (
            <img src={src} alt={alt} className="max-w-full rounded border border-gray-200" />
          )
        }}
      >
        {rendered}
      </ReactMarkdown>
    </div>
  )
}

const MarkdownContent = memo(MarkdownContentImpl)
export default MarkdownContent
