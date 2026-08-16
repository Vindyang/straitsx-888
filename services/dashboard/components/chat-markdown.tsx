import ReactMarkdown, { defaultUrlTransform } from "react-markdown"
import remarkGfm from "remark-gfm"

export function ChatMarkdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      urlTransform={defaultUrlTransform}
      components={{
        h1: ({ children: heading }) => (
          <h1 className="text-base font-semibold">{heading}</h1>
        ),
        h2: ({ children: heading }) => (
          <h2 className="text-sm font-semibold">{heading}</h2>
        ),
        h3: ({ children: heading }) => (
          <h3 className="text-sm font-medium">{heading}</h3>
        ),
        p: ({ children: paragraph }) => <p>{paragraph}</p>,
        ul: ({ children: items }) => (
          <ul className="list-disc pl-5">{items}</ul>
        ),
        ol: ({ children: items }) => (
          <ol className="list-decimal pl-5">{items}</ol>
        ),
        a: ({ children: label, href }) => (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-primary underline underline-offset-4"
          >
            {label}
          </a>
        ),
      }}
    >
      {children}
    </ReactMarkdown>
  )
}
