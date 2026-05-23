import { useMemo, type ReactNode } from 'react'

type Block =
  | { type: 'heading'; depth: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'blockquote'; text: string }
  | { type: 'code'; lang: string; code: string }
  | { type: 'ul'; items: ListItem[] }
  | { type: 'ol'; items: ListItem[] }
  | { type: 'table'; headers: string[]; rows: string[][] }
  | { type: 'hr' }

type ListItem = {
  text: string
  checked?: boolean
}

const tableSeparatorRe = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/
const MARKDOWN_PREVIEW_CHAR_LIMIT = 60_000

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

function parseBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let index = 0

  const skipBlank = () => {
    while (index < lines.length && !lines[index]?.trim()) index += 1
  }

  while (index < lines.length) {
    skipBlank()
    if (index >= lines.length) break

    const line = lines[index] ?? ''

    const fence = line.match(/^\s*```([\w-]*)\s*$/)
    if (fence) {
      const lang = fence[1] ?? ''
      const codeLines: string[] = []
      index += 1
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index] ?? '')) {
        codeLines.push(lines[index] ?? '')
        index += 1
      }
      if (index < lines.length) index += 1
      blocks.push({ type: 'code', lang, code: codeLines.join('\n') })
      continue
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/)
    if (heading) {
      blocks.push({
        type: 'heading',
        depth: (heading[1] ?? '#').length,
        text: (heading[2] ?? '').trim(),
      })
      index += 1
      continue
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ type: 'hr' })
      index += 1
      continue
    }

    if (
      index + 1 < lines.length &&
      line.includes('|') &&
      tableSeparatorRe.test(lines[index + 1] ?? '')
    ) {
      const headers = splitTableRow(line)
      const rows: string[][] = []
      index += 2
      while (index < lines.length && (lines[index] ?? '').includes('|')) {
        rows.push(splitTableRow(lines[index] ?? ''))
        index += 1
      }
      blocks.push({ type: 'table', headers, rows })
      continue
    }

    if (/^\s{0,3}>\s?/.test(line)) {
      const quoteLines: string[] = []
      while (index < lines.length && /^\s{0,3}>\s?/.test(lines[index] ?? '')) {
        quoteLines.push((lines[index] ?? '').replace(/^\s{0,3}>\s?/, ''))
        index += 1
      }
      blocks.push({ type: 'blockquote', text: quoteLines.join('\n') })
      continue
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items: ListItem[] = []
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index] ?? '')) {
        const text = (lines[index] ?? '').replace(/^\s*[-*+]\s+/, '')
        const task = text.match(/^\[([ xX])]\s+(.*)$/)
        items.push(
          task
            ? {
                text: task[2] ?? '',
                checked: (task[1] ?? '').toLowerCase() === 'x',
              }
            : { text },
        )
        index += 1
      }
      blocks.push({ type: 'ul', items })
      continue
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: ListItem[] = []
      while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index] ?? '')) {
        items.push({
          text: (lines[index] ?? '').replace(/^\s*\d+[.)]\s+/, ''),
        })
        index += 1
      }
      blocks.push({ type: 'ol', items })
      continue
    }

    const paragraphLines: string[] = []
    while (index < lines.length) {
      const current = lines[index] ?? ''
      if (!current.trim()) break
      if (
        /^\s*```/.test(current) ||
        /^(#{1,6})\s+/.test(current) ||
        /^\s{0,3}>\s?/.test(current) ||
        /^\s*[-*+]\s+/.test(current) ||
        /^\s*\d+[.)]\s+/.test(current) ||
        /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(current)
      ) {
        break
      }
      paragraphLines.push(current)
      index += 1
    }
    blocks.push({ type: 'paragraph', text: paragraphLines.join('\n') })
  }

  return blocks
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const pattern =
    /(!\[[^\]]*]\([^)]+\)|\[[^\]]+]\([^)]+\)|`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*\n]+\*|_[^_\n]+_)/g
  const out: ReactNode[] = []
  let cursor = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(text))) {
    const raw = match[0]
    if (match.index > cursor) out.push(text.slice(cursor, match.index))

    const key = `${keyPrefix}-${match.index}`
    const image = raw.match(/^!\[([^\]]*)]\(([^)]+)\)$/)
    const link = raw.match(/^\[([^\]]+)]\(([^)]+)\)$/)

    if (image) {
      out.push(
        <img
          key={key}
          className="markdown-image"
          src={image[2]}
          alt={image[1]}
          loading="lazy"
        />,
      )
    } else if (link) {
      out.push(
        <a key={key} href={link[2]} target="_blank" rel="noreferrer">
          {link[1]}
        </a>,
      )
    } else if (raw.startsWith('`')) {
      out.push(<code key={key}>{raw.slice(1, -1)}</code>)
    } else if (raw.startsWith('**') || raw.startsWith('__')) {
      out.push(<strong key={key}>{raw.slice(2, -2)}</strong>)
    } else if (raw.startsWith('*') || raw.startsWith('_')) {
      out.push(<em key={key}>{raw.slice(1, -1)}</em>)
    }

    cursor = match.index + raw.length
  }

  if (cursor < text.length) out.push(text.slice(cursor))
  return out
}

function renderInlineWithBreaks(text: string, keyPrefix: string): ReactNode[] {
  const lines = text.split('\n')
  return lines.flatMap((line, index) => [
    ...renderInline(line, `${keyPrefix}-${index}`),
    ...(index < lines.length - 1 ? [<br key={`${keyPrefix}-br-${index}`} />] : []),
  ])
}

function renderBlock(block: Block, index: number): ReactNode {
  const key = `md-${index}`
  if (block.type === 'heading') {
    const Tag = `h${block.depth}` as keyof JSX.IntrinsicElements
    return <Tag key={key}>{renderInline(block.text, key)}</Tag>
  }
  if (block.type === 'paragraph') {
    return <p key={key}>{renderInlineWithBreaks(block.text, key)}</p>
  }
  if (block.type === 'blockquote') {
    return <blockquote key={key}>{renderInlineWithBreaks(block.text, key)}</blockquote>
  }
  if (block.type === 'code') {
    return (
      <pre key={key}>
        {block.lang && <span className="markdown-code-lang">{block.lang}</span>}
        <code>{block.code}</code>
      </pre>
    )
  }
  if (block.type === 'ul') {
    return (
      <ul key={key}>
        {block.items.map((item, itemIndex) => (
          <li key={`${key}-${itemIndex}`}>
            {item.checked !== undefined && (
              <input type="checkbox" checked={item.checked} readOnly />
            )}
            {renderInline(item.text, `${key}-${itemIndex}`)}
          </li>
        ))}
      </ul>
    )
  }
  if (block.type === 'ol') {
    return (
      <ol key={key}>
        {block.items.map((item, itemIndex) => (
          <li key={`${key}-${itemIndex}`}>
            {renderInline(item.text, `${key}-${itemIndex}`)}
          </li>
        ))}
      </ol>
    )
  }
  if (block.type === 'table') {
    return (
      <div key={key} className="markdown-table-wrap">
        <table>
          <thead>
            <tr>
              {block.headers.map((header, cellIndex) => (
                <th key={`${key}-h-${cellIndex}`}>
                  {renderInline(header, `${key}-h-${cellIndex}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={`${key}-r-${rowIndex}`}>
                {block.headers.map((_, cellIndex) => (
                  <td key={`${key}-r-${rowIndex}-${cellIndex}`}>
                    {renderInline(row[cellIndex] ?? '', `${key}-r-${rowIndex}-${cellIndex}`)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }
  return <hr key={key} />
}

export function MarkdownPreview({
  children,
  className = '',
}: {
  children: string
  className?: string
}) {
  const previewText =
    children.length > MARKDOWN_PREVIEW_CHAR_LIMIT
      ? children.slice(0, MARKDOWN_PREVIEW_CHAR_LIMIT)
      : children
  const isTruncated = previewText.length < children.length
  const blocks = useMemo(() => parseBlocks(previewText), [previewText])

  if (!children.trim()) {
    return <div className={`markdown-content ${className}`}>No content</div>
  }

  return (
    <div className={`markdown-content ${className}`}>
      {blocks.map(renderBlock)}
      {isTruncated && (
        <div className="markdown-truncated">
          Preview truncated for performance. Switch to Edit to inspect the full text.
        </div>
      )}
    </div>
  )
}
