import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'

export type SelectOption = {
  value: string
  label: ReactNode
  searchText?: string
  disabled?: boolean
}

export function Select({
  value,
  options,
  onChange,
  placeholder = 'Select…',
  className = '',
  disabled = false,
}: {
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  placeholder?: string
  className?: string
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const selected = options.find((option) => option.value === value)
  const searchable = options.length > 8

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return options
    return options.filter((option) => {
      const haystack =
        option.searchText ??
        (typeof option.label === 'string' ? option.label : option.value)
      return haystack.toLowerCase().includes(q)
    })
  }, [options, query])

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className={`ui-select ${className}`} ref={rootRef}>
      <button
        type="button"
        className="ui-select-button"
        disabled={disabled}
        onClick={() => {
          setOpen((next) => !next)
          setQuery('')
        }}
      >
        <span className={selected ? 'ui-select-value' : 'ui-select-placeholder'}>
          {selected?.label ?? placeholder}
        </span>
        <span className="ui-select-chev">▾</span>
      </button>
      {open && (
        <div className="ui-select-menu">
          {searchable && (
            <input
              className="ui-select-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter…"
              autoFocus
            />
          )}
          <div className="ui-select-options scrollbar">
            {filtered.length === 0 && (
              <div className="ui-select-empty">No matches</div>
            )}
            {filtered.map((option) => (
              <button
                type="button"
                key={option.value}
                className={`ui-select-option ${
                  option.value === value ? 'is-selected' : ''
                }`}
                disabled={option.disabled}
                onClick={() => {
                  onChange(option.value)
                  setOpen(false)
                  setQuery('')
                }}
              >
                <span className="ui-select-option-label">{option.label}</span>
                {option.value === value && <span className="ui-select-check">✓</span>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
