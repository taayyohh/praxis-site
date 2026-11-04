// toast.js — Sonner-inspired toast notifications (vanilla JS, no React)
// Usage: import { toast } from './toast.js'
//   toast('message')
//   toast('message', { type: 'success' })
//   toast.success('done')
//   toast.error('failed')

let _container = null

function getContainer() {
  if (_container && document.body.contains(_container)) return _container
  _container = document.createElement('div')
  _container.className = 'toast-container'
  document.body.appendChild(_container)
  return _container
}

function createToast(message, opts = {}) {
  const { type = 'default', duration = 4000, html = false, onClick } = opts
  const container = getContainer()

  const el = document.createElement('div')
  el.className = `toast-item toast-${type}`
  el.setAttribute('role', 'status')
  el.setAttribute('aria-live', 'polite')

  if (html) {
    el.innerHTML = message
  } else {
    el.textContent = message
  }

  if (onClick) {
    el.style.cursor = 'pointer'
    el.addEventListener('click', () => { dismiss(el); onClick() })
  }

  // Dismiss on swipe right (touch)
  let startX = 0
  el.addEventListener('touchstart', (e) => { startX = e.touches[0].clientX }, { passive: true })
  el.addEventListener('touchend', (e) => {
    const dx = e.changedTouches[0].clientX - startX
    if (dx > 60) dismiss(el)
  }, { passive: true })

  // Insert at top of container (newest first, stacks downward visually via flex-direction)
  container.prepend(el)

  // Animate in
  requestAnimationFrame(() => el.classList.add('toast-visible'))

  // Cap at 4 visible
  const all = container.querySelectorAll('.toast-item')
  if (all.length > 4) dismiss(all[all.length - 1])

  // Auto-dismiss
  if (duration > 0) {
    setTimeout(() => dismiss(el), duration)
  }

  return el
}

function dismiss(el) {
  if (!el || !el.parentNode) return
  el.classList.remove('toast-visible')
  el.classList.add('toast-exit')
  el.addEventListener('transitionend', () => el.remove(), { once: true })
  // Fallback removal if transition doesn't fire
  setTimeout(() => el.remove(), 400)
}

export function toast(message, opts) {
  return createToast(message, opts)
}

toast.success = (msg, opts) => createToast(msg, { type: 'success', ...opts })
toast.error = (msg, opts) => createToast(msg, { type: 'error', ...opts })
toast.message = (msg, opts) => createToast(msg, { type: 'message', ...opts })
toast.dismiss = dismiss
