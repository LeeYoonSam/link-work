import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface MarkdownContentProps {
  content: string
  className?: string
  compact?: boolean
}

function MarkdownContentImpl({
  content,
  className = '',
  compact = false
}: MarkdownContentProps): React.ReactNode {
  const gap = compact ? 'space-y-1.5' : 'space-y-3'
  return (
    <div className={`markdown-body ${gap} text-sm text-gray-800 leading-relaxed ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
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
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="text-blue-600 hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {children}
            </a>
          ),
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
        {content}
      </ReactMarkdown>
    </div>
  )
}

const MarkdownContent = memo(MarkdownContentImpl)
export default MarkdownContent
