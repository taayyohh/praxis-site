// modal-a11y.js — auto-upgrade every `.praxis-modal-overlay` with
// dialog semantics the shared CSS cannot provide: aria role +
// aria-labelledby, Esc dismiss, focus trap, initial focus, restore
// focus on close. Uses a MutationObserver so no call site needs to
// change — the moment a legacy opener inserts an overlay into the
// body, this module wires it up.
//
// Opt-outs per overlay:
//   data-no-esc    — don't dismiss on Escape (e.g. confirms-only)
//   data-no-trap   — don't trap focus inside (fullscreen wizards)
//   data-labelledby="#id" — point at a heading outside the dialog
//
// The module is idempotent. Importing it twice on the same page does
// nothing the second time.

const UPGRADED = new WeakSet()
const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'textarea:not([disabled])',
  'input:not([disabled]):not([type="hidden"])', 'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])', 'details > summary:first-of-type',
  '[contenteditable]:not([contenteditable="false"])',
].join(',')

function getFocusable(root) {
  return Array.from(root.querySelectorAll(FOCUSABLE))
    .filter(el => el.offsetParent !== null || el === document.activeElement)
}

function upgrade(overlay) {
  if (!overlay || UPGRADED.has(overlay)) return
  UPGRADED.add(overlay)

  const dialog = overlay.querySelector('.praxis-modal-dialog')
    || overlay.querySelector('[role="dialog"]')
    || overlay
  if (!dialog) return

  // Role + modality
  if (!dialog.getAttribute('role')) dialog.setAttribute('role', 'dialog')
  if (!dialog.getAttribute('aria-modal')) dialog.setAttribute('aria-modal', 'true')
  if (!dialog.hasAttribute('tabindex')) dialog.setAttribute('tabindex', '-1')

  // aria-labelledby — wire to the first heading in the dialog if
  // the caller didn't set one. A missing heading falls back to
  // aria-label on the dialog if any exists; otherwise we skip —
  // it's better to be silent than to point at nothing.
  if (!dialog.getAttribute('aria-labelledby') && !dialog.getAttribute('aria-label')) {
    const explicit = overlay.dataset.labelledby
    if (explicit) {
      const refId = explicit.startsWith('#') ? explicit.slice(1) : explicit
      if (document.getElementById(refId)) dialog.setAttribute('aria-labelledby', refId)
    } else {
      const heading = dialog.querySelector('h1, h2, h3, h4, [data-modal-title]')
      if (heading) {
        if (!heading.id) heading.id = `praxis-modal-title-${Math.random().toString(36).slice(2, 10)}`
        dialog.setAttribute('aria-labelledby', heading.id)
      }
    }
  }

  // Remember what was focused when the overlay opened, so we can
  // give it back on close.
  const prevFocus = document.activeElement
  overlay._praxisPrevFocus = prevFocus

  // Initial focus — first form control / button in the dialog,
  // else the dialog itself. Deferred one frame so inline markup
  // finishes mounting.
  requestAnimationFrame(() => {
    if (!document.body.contains(overlay)) return
    const focusables = getFocusable(dialog)
    const target = focusables.find(el => !el.hasAttribute('data-no-autofocus'))
      || focusables[0]
      || dialog
    try { target.focus({ preventScroll: true }) } catch {}
  })

  const noEsc = overlay.hasAttribute('data-no-esc')
  const noTrap = overlay.hasAttribute('data-no-trap')

  function close() {
    // Synthesize the two patterns live callers already use so we
    // don't fight them: dispatch a cancelable "praxis:modal-close"
    // event the caller can listen on; else click the first
    // `[data-prim-close]`, `.praxis-modal-close`, or `[data-close]`
    // control; else remove the overlay ourselves.
    const custom = new CustomEvent('praxis:modal-close', { cancelable: true, bubbles: true })
    overlay.dispatchEvent(custom)
    if (custom.defaultPrevented) return

    const closer = overlay.querySelector('[data-prim-close], .praxis-modal-close, [data-close]')
    if (closer) { closer.click(); return }

    overlay.classList.add('is-closing')
    setTimeout(() => overlay.remove(), 220)
  }

  // Only the topmost overlay should react — any lower overlay in a
  // stack keeps its listener installed but ignores events until it
  // is back on top. Lets Esc close one layer at a time, and traps
  // Tab in the right dialog.
  function isTopmost() {
    const all = document.querySelectorAll('.praxis-modal-overlay')
    return all.length && all[all.length - 1] === overlay
  }

  function onKey(e) {
    if (!document.body.contains(overlay) || !isTopmost()) return
    if (e.key === 'Escape' && !noEsc) {
      e.stopPropagation()
      e.preventDefault()
      close()
      return
    }
    if (e.key === 'Tab' && !noTrap) {
      const focusables = getFocusable(dialog)
      if (!focusables.length) { e.preventDefault(); dialog.focus(); return }
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement
      if (e.shiftKey && (active === first || !dialog.contains(active))) {
        e.preventDefault(); last.focus()
      } else if (!e.shiftKey && (active === last || !dialog.contains(active))) {
        e.preventDefault(); first.focus()
      }
    }
  }
  document.addEventListener('keydown', onKey, true)

  // Restore focus on removal. The observer below catches the node
  // leaving the DOM regardless of how the caller tears it down
  // (classList toggle, direct .remove(), parent cleared).
  const teardown = new MutationObserver(() => {
    if (!document.body.contains(overlay)) {
      document.removeEventListener('keydown', onKey, true)
      teardown.disconnect()
      try { prevFocus?.focus?.({ preventScroll: true }) } catch {}
    }
  })
  teardown.observe(document.body, { childList: true, subtree: true })
}

function scan(node) {
  if (node?.nodeType !== 1) return
  if (node.matches?.('.praxis-modal-overlay')) upgrade(node)
  node.querySelectorAll?.('.praxis-modal-overlay').forEach(upgrade)
}

function boot() {
  // Upgrade anything already on the page (e.g. server-rendered
  // registration modals on /vault pre-hydrate).
  document.querySelectorAll('.praxis-modal-overlay').forEach(upgrade)

  // Watch for any future insert.
  const obs = new MutationObserver(records => {
    for (const r of records) {
      r.addedNodes.forEach(scan)
    }
  })
  obs.observe(document.body, { childList: true, subtree: true })
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true })
} else {
  boot()
}
