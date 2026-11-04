// Design workshop — scoped a11y helpers for .dw-modal / .dw-sheet.
// Loaded ONLY by design.js on /design. Does not touch any modal
// outside the workshop surface.
//
// What this gives every .dw-modal instance:
//   · role="dialog" + aria-modal="true"
//   · an aria-labelledby binding to the dialog's .dw-modal__title
//   · focus trap inside the dialog
//   · Esc + overlay click dismiss
//   · body scroll lock while open
//   · restores focus to the opener on close
//   · honors prefers-reduced-motion — the CSS already gates animation,
//     this module just avoids the artificial close-delay when reduced.

const focusables = (root) =>
  Array.from(root.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  )).filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null)

const motionReduced = () =>
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * Open a .dw-modal built from an HTML string or a DOM node.
 * Returns the overlay element so the caller can patch handlers if needed.
 *
 *   openDwModal({ kind: 'modal' | 'sheet' | 'confirm',
 *                 title, body, confirmLabel, cancelLabel,
 *                 destructive, onConfirm })
 */
export function openDwModal({
  kind = 'modal',
  title = '',
  titleId = `dw-modal-title-${Math.random().toString(36).slice(2, 8)}`,
  body = '',
  confirmLabel = 'ok',
  cancelLabel = 'cancel',
  destructive = false,
  onConfirm,
} = {}) {
  const prevFocus = document.activeElement
  const overlay = document.createElement('div')
  overlay.className = kind === 'sheet' ? 'dw-modal dw-sheet' : 'dw-modal'

  const inner = document.createElement('div')
  inner.className = 'dw-modal__overlay'

  const dialog = document.createElement('div')
  dialog.className = 'dw-modal__dialog'
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')
  if (title) dialog.setAttribute('aria-labelledby', titleId)
  dialog.tabIndex = -1

  const safeTitle = String(title).replace(/[<>]/g, '')
  const safeBody = String(body).replace(/[<>]/g, '')

  dialog.innerHTML = `
    ${kind === 'sheet' ? '<div class="dw-modal__grabber" aria-hidden="true"></div>' : ''}
    <header class="dw-modal__header">
      <h2 id="${titleId}" class="dw-modal__title">${safeTitle}</h2>
      <button type="button" class="dw-modal__close" aria-label="close">
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
          <path d="M6 6l12 12M18 6l-12 12" stroke="currentColor" stroke-width="1.75" fill="none" stroke-linecap="round"/>
        </svg>
      </button>
    </header>
    <div class="dw-modal__body">${safeBody}</div>
    <div class="dw-modal__actions">
      <button type="button" class="dw-btn dw-btn--secondary" data-dw-cancel>${cancelLabel}</button>
      <button type="button" class="dw-btn ${destructive ? 'dw-btn--danger' : 'dw-btn--primary'}" data-dw-confirm>${confirmLabel}</button>
    </div>
  `

  inner.appendChild(dialog)
  overlay.appendChild(inner)
  document.body.appendChild(overlay)
  document.body.classList.add('dw-scroll-lock')

  const trapFocus = (e) => {
    if (e.key !== 'Tab') return
    const items = focusables(dialog)
    if (!items.length) { e.preventDefault(); dialog.focus(); return }
    const first = items[0]
    const last  = items[items.length - 1]
    if (e.shiftKey && document.activeElement === first) {
      last.focus(); e.preventDefault()
    } else if (!e.shiftKey && document.activeElement === last) {
      first.focus(); e.preventDefault()
    }
  }

  const onKey = (e) => {
    if (e.key === 'Escape') close()
    else if (e.key === 'Tab') trapFocus(e)
  }

  const close = () => {
    document.removeEventListener('keydown', onKey, true)
    document.body.classList.remove('dw-scroll-lock')
    if (motionReduced()) {
      overlay.remove()
      if (prevFocus?.focus) prevFocus.focus()
      return
    }
    inner.classList.add('is-closing')
    setTimeout(() => {
      overlay.remove()
      if (prevFocus?.focus) prevFocus.focus()
    }, 200)
  }

  inner.addEventListener('click', (e) => {
    if (e.target === inner) close()
  })
  dialog.querySelector('.dw-modal__close')?.addEventListener('click', close)
  dialog.querySelector('[data-dw-cancel]')?.addEventListener('click', close)
  dialog.querySelector('[data-dw-confirm]')?.addEventListener('click', () => {
    try { onConfirm?.() } catch (err) { console.warn('[dw-modal] onConfirm threw', err) }
    close()
  })

  document.addEventListener('keydown', onKey, true)

  // Move focus into the dialog on next tick so the opener's click
  // doesn't swallow the first tab.
  setTimeout(() => {
    const items = focusables(dialog)
    ;(items[0] || dialog).focus()
  }, 0)

  return { overlay, dialog, close }
}

/**
 * Lightweight toast region bound to the .dw-toast-region
 * element in the catalog. Scoped — does not touch toast.js.
 */
export function dwToast(text, { variant = 'default', duration = 3200, role } = {}) {
  let region = document.getElementById('dw-toast-region')
  if (!region) {
    region = document.createElement('div')
    region.id = 'dw-toast-region'
    region.className = 'dw-toast-region'
    region.setAttribute('aria-live', 'polite')
    document.body.appendChild(region)
  }
  const el = document.createElement('div')
  el.className = `dw-toast dw-toast--${variant}`
  el.setAttribute('role', role || (variant === 'error' ? 'alert' : 'status'))
  const safe = String(text).replace(/[<>]/g, '')
  const icon = variant === 'success' ? '✓'
             : variant === 'error'   ? '!'
             : variant === 'message' ? '◉'
             : '·'
  el.innerHTML = `
    <span class="dw-toast__icon" aria-hidden="true">${icon}</span>
    <span class="dw-toast__text">${safe}</span>
  `
  region.appendChild(el)
  setTimeout(() => {
    if (motionReduced()) { el.remove(); return }
    el.style.transition = 'opacity 200ms ease'
    el.style.opacity = '0'
    setTimeout(() => el.remove(), 220)
  }, duration)
  return el
}

/** Wire any button[data-dw-open] inside `scope` to open a dw-modal. */
export function wireDwOpeners(scope = document) {
  scope.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-dw-open]')
    if (!btn) return
    const kind = btn.dataset.dwOpen
    if (kind === 'modal') {
      openDwModal({
        kind: 'modal',
        title: btn.dataset.dwTitle || 'name this draft',
        body: btn.dataset.dwBody || 'you can change it later.',
        confirmLabel: btn.dataset.dwConfirm || 'save',
      })
    } else if (kind === 'sheet') {
      openDwModal({
        kind: 'sheet',
        title: btn.dataset.dwTitle || 'name this draft',
        body: btn.dataset.dwBody || 'you can change it later.',
        confirmLabel: btn.dataset.dwConfirm || 'save',
      })
    } else if (kind === 'confirm') {
      openDwModal({
        kind: 'modal',
        destructive: true,
        title: btn.dataset.dwTitle || 'delete this draft',
        body: btn.dataset.dwBody || "this can't be undone.",
        confirmLabel: btn.dataset.dwConfirm || 'delete',
      })
    } else if (kind === 'toast') {
      dwToast(btn.dataset.dwText || 'your post was published',
        { variant: btn.dataset.dwVariant || 'default' })
    }
  })
}
