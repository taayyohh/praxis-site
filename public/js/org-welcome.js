// Org post-signup welcome affordance.
//
// Fires when an org admin lands on their fresh subdomain with
//   ?just-deployed=1&template=organization
// Shows a one-time welcome card with 4 next actions — add signers,
// invite members, set up vault, publish first post. Dismissible,
// dismissal state persisted in localStorage keyed by org address so
// the same user on a different org sees it again.
//
// Copy strings below are DRAFT — written to unblock the page, final
// words are Miles's to revise.

const DISMISS_KEY_PREFIX = 'praxis-org-welcome-dismissed:'
const JUST_DEPLOYED_FLAG = 'just-deployed'
const TEMPLATE_FLAG = 'template'

const CARDS = [
  {
    key: 'add-signers',
    icon: 'ph-users-three',
    href: '/settings#signers',
    headlineToken: 'add co-signers',
    bodyToken: 'shared decisions are stronger. add the people you trust to sign off on changes.',
    ctaToken: 'add people',
    testId: 'org-welcome-card-add-signers',
  },
  {
    key: 'invite-members',
    icon: 'ph-paper-plane-tilt',
    href: '/settings#invite',
    headlineToken: 'invite your people',
    bodyToken: 'send a link to your artists, collaborators, or audience. they land directly in your space.',
    ctaToken: 'send an invite',
    testId: 'org-welcome-card-invite-members',
  },
  {
    key: 'set-up-vault',
    icon: 'ph-vault',
    href: '/vault',
    headlineToken: 'set up your vault',
    bodyToken: 'where money comes in and goes out. name it, set the rules — you\'re done.',
    ctaToken: 'open vault',
    testId: 'org-welcome-card-set-up-vault',
  },
  {
    key: 'publish-first-post',
    icon: 'ph-pencil-simple-line',
    href: '/write',
    headlineToken: 'write something',
    bodyToken: 'a hello, a manifesto, a quiet update. it\'s your space — any shape is right.',
    ctaToken: 'start writing',
    testId: 'org-welcome-card-publish-first-post',
  },
]

function shouldShow() {
  try {
    const params = new URLSearchParams(location.search)
    if (params.get(JUST_DEPLOYED_FLAG) !== '1') return false
    const template = (params.get(TEMPLATE_FLAG) || '').toLowerCase()
    const bodyIsOrg = Boolean(
      document.body?.dataset?.orgId ||
      document.body?.dataset?.orgType
    )
    if (template !== 'organization' && !bodyIsOrg) return false
    const orgKey = (document.body?.dataset?.orgId || document.body?.dataset?.owner || 'default').toLowerCase()
    const dismissed = localStorage.getItem(DISMISS_KEY_PREFIX + orgKey)
    return !dismissed
  } catch {
    return false
  }
}

function markDismissed() {
  try {
    const orgKey = (document.body?.dataset?.orgId || document.body?.dataset?.owner || 'default').toLowerCase()
    localStorage.setItem(DISMISS_KEY_PREFIX + orgKey, String(Date.now()))
  } catch {}
}

function cardHtml(card) {
  return `
    <a class="org-welcome-card" href="${card.href}" data-testid="${card.testId}">
      <i class="ph ${card.icon}" aria-hidden="true"></i>
      <h3 class="org-welcome-card__headline">${card.headlineToken}</h3>
      <p class="org-welcome-card__body">${card.bodyToken}</p>
      <span class="org-welcome-card__cta">${card.ctaToken} <i class="ph ph-arrow-right" aria-hidden="true"></i></span>
    </a>
  `
}

function render() {
  const overlay = document.createElement('div')
  overlay.className = 'praxis-modal-overlay'
  overlay.id = 'org-welcome-overlay'
  overlay.dataset.testid = 'org-welcome-overlay'
  overlay.innerHTML = `
    <div class="praxis-modal-dialog org-welcome-dialog" role="dialog" aria-labelledby="org-welcome-headline">
      <button type="button" class="org-welcome-close" aria-label="dismiss" data-testid="org-welcome-dismiss">
        <i class="ph ph-x" aria-hidden="true"></i>
      </button>
      <header class="org-welcome-header">
        <p class="org-welcome-kicker">you're in</p>
        <h2 id="org-welcome-headline" class="org-welcome-headline">your space is live.</h2>
        <p class="org-welcome-subhead">four quick things to make it feel like home.</p>
      </header>
      <div class="org-welcome-grid">
        ${CARDS.map(cardHtml).join('')}
      </div>
      <footer class="org-welcome-footer">
        <button type="button" class="org-welcome-later" data-testid="org-welcome-later">later</button>
      </footer>
    </div>
  `

  const close = () => {
    overlay.classList.add('is-closing')
    markDismissed()
    setTimeout(() => overlay.remove(), 220)
  }
  overlay.querySelector('.org-welcome-close').addEventListener('click', close)
  overlay.querySelector('.org-welcome-later').addEventListener('click', close)
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close() })
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape' && overlay.isConnected) { close(); document.removeEventListener('keydown', esc) }
  })

  // Clicking through to a destination counts as "handled" — dismiss so
  // the modal does not re-appear on the next visit to the subdomain.
  overlay.querySelectorAll('.org-welcome-card').forEach(a => {
    a.addEventListener('click', () => { markDismissed() })
  })

  document.body.appendChild(overlay)
}

export function showOrgWelcomeIfJustDeployed() {
  if (!shouldShow()) return false
  render()
  return true
}

if (typeof window !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', showOrgWelcomeIfJustDeployed, { once: true })
  } else {
    setTimeout(showOrgWelcomeIfJustDeployed, 0)
  }
  // Expose for the /design catalog to open on demand.
  window._orgWelcomePreview = () => render()
}
