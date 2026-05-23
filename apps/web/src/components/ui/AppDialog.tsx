import { useEffect, useRef } from 'react'

type DialogAction = {
  label: string
  variant?: 'default' | 'primary' | 'danger'
  onClick: () => void
}

function actionClass(variant: DialogAction['variant']): string {
  if (variant === 'primary') return 'btn-primary'
  if (variant === 'danger') return 'btn-danger'
  return 'btn'
}

export function AppDialog({
  open,
  title,
  description,
  children,
  actions,
  onClose,
}: {
  open: boolean
  title: string
  description?: string
  children?: React.ReactNode
  actions: DialogAction[]
  onClose: () => void
}) {
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    requestAnimationFrame(() => panelRef.current?.focus())
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="app-dialog-overlay" onMouseDown={onClose}>
      <div
        ref={panelRef}
        className="app-dialog-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="app-dialog-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="app-dialog-header">
          <div>
            <div id="app-dialog-title" className="app-dialog-title">
              {title}
            </div>
            {description && (
              <div className="app-dialog-description">{description}</div>
            )}
          </div>
          <button className="btn-ghost app-dialog-close" onClick={onClose}>
            x
          </button>
        </div>

        {children && <div className="app-dialog-body">{children}</div>}

        <div className="app-dialog-actions">
          {actions.map((action) => (
            <button
              key={action.label}
              className={actionClass(action.variant)}
              onClick={action.onClick}
            >
              {action.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

export function AlertDialog({
  open,
  title = 'Notice',
  message,
  onClose,
}: {
  open: boolean
  title?: string
  message: string
  onClose: () => void
}) {
  return (
    <AppDialog
      open={open}
      title={title}
      onClose={onClose}
      actions={[{ label: 'OK', variant: 'primary', onClick: onClose }]}
    >
      <div className="app-dialog-message">{message}</div>
    </AppDialog>
  )
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  onConfirm,
  onCancel,
}: {
  open: boolean
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <AppDialog
      open={open}
      title={title}
      onClose={onCancel}
      actions={[
        { label: cancelLabel, onClick: onCancel },
        {
          label: confirmLabel,
          variant: danger ? 'danger' : 'primary',
          onClick: onConfirm,
        },
      ]}
    >
      <div className="app-dialog-message">{message}</div>
    </AppDialog>
  )
}

export function PromptDialog({
  open,
  title,
  description,
  value,
  placeholder,
  error,
  confirmLabel = 'Create',
  cancelLabel = 'Cancel',
  onValueChange,
  onConfirm,
  onCancel,
}: {
  open: boolean
  title: string
  description?: string
  value: string
  placeholder?: string
  error?: string
  confirmLabel?: string
  cancelLabel?: string
  onValueChange: (value: string) => void
  onConfirm: () => void
  onCancel: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [open])

  return (
    <AppDialog
      open={open}
      title={title}
      description={description}
      onClose={onCancel}
      actions={[
        { label: cancelLabel, onClick: onCancel },
        { label: confirmLabel, variant: 'primary', onClick: onConfirm },
      ]}
    >
      <input
        ref={inputRef}
        className={`field ${error ? 'border-red-700' : ''}`}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onValueChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') onConfirm()
        }}
      />
      {error && <div className="app-dialog-error">{error}</div>}
    </AppDialog>
  )
}
