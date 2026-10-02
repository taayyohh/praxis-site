// Universal event card — single renderer for all protocol activity events.
// Three layouts: 'line' (compact row), 'banner' (poster/avatar hero), 'inline-reference'
// (minimal pill, embeds inside other cards). Covers ~20 event types across
// social, project-lifecycle, economic, membership, and infrastructure dimensions.
//
// Usage:
//   renderEventCard(event, { layout, resolve, external, mutedTimestamp })
//
// `event` shape (common fields; renderer is forgiving — any known alias works):
//   { type, actor, target, amount, title, projectId, posterCid, timestamp,
//     // type-specific extras: follower/followed, proposer, buyer/seller,
//     // founder, name, description, referrer/referred, disputer, recipient,
//     // role, oldWallet/newWallet, domain, threshold, signer, ... }
//
// `context`:
//   resolve(addr): domain/handle resolver (required)
//   external: open links in new tab (default false)
//   mutedTimestamp: show "·  3h ago" in meta row (default true)
//   layout: 'line' | 'banner' | 'inline-reference' (default 'line')

import { escapeHtml as esc, getProfilePic, getArtistName, timeAgo } from './utils.js'

// ---------- helpers ----------
const resolveName = (addr, resolve, explicit) =>
  explicit || getArtistName(addr) || (resolve && resolve(addr)) || ''

const avatarImg = (addr, pic, size = 28) => {
  const src = pic || getProfilePic(addr)
  if (!src) return ''
  return `<img src="${esc(src)}" class="event-card-avatar" style="width:${size}px;height:${size}px" loading="lazy" onerror="this.style.display='none'">`
}

const tenantHref = (domain) => {
  if (!domain) return ''
  if (domain.startsWith('http')) return domain
  if (domain.includes('.')) return `https://${domain}`
  if (domain.startsWith('0x')) return ''
  return `https://${domain}.ourpraxis.network`
}

const amountSpan = (wei) => {
  if (!wei || wei === '0') return ''
  return `<span class="event-card-amount" data-eth-wei="${esc(String(wei))}" data-fiat-primary="true"></span>`
}

const timeMeta = (ts, show) => {
  if (!show || !ts) return ''
  const seconds = Number(ts)
  if (!seconds) return ''
  return `<span class="event-card-time">${esc(timeAgo(seconds))}</span>`
}

const posterImg = (cid, aspect = '2/1') => {
  if (!cid) return ''
  const src = `/api/img?url=/api/ipfs-proxy/${encodeURIComponent(cid)}&w=680`
  return `<div class="event-card-poster" style="aspect-ratio:${aspect}"><img src="${esc(src)}" alt="" loading="lazy" onerror="this.parentElement.style.display='none'"></div>`
}

const ogImg = (domain) => {
  const href = tenantHref(domain)
  if (!href) return ''
  return `<div class="event-card-poster event-card-poster--og"><img src="${href}/og/index.png" alt="" loading="lazy" onerror="this.parentElement.style.display='none'"></div>`
}

// ---------- event taxonomy ----------
// For each type, produce: { icon, tone, href, poster, phrase(ctx), banner? }
// `tone` picks an accent: 'default' | 'green' | 'red' | 'muted'
// `phrase` returns an array of {text, kind} segments where kind ∈
//   'name' (accent weight), 'label' (muted), 'strong' (fg weight), 'amount' (number inline).

const PROJECT_HREF = (d) => d.projectId ? `/project?id=${d.projectId}` : ''

const DESCRIPTORS = {
  follow: {
    icon: 'ph-user-plus',
    tone: 'default',
    href: (d) => tenantHref((d.followed && d.followedDomain) || null) || tenantHref(d.target),
    actor: (d) => d.follower || d.author || d.actor,
    phrase: (d, r) => [
      { kind: 'name', text: resolveName(d.follower || d.author || d.actor, r) },
      { kind: 'label', text: 'followed' },
      { kind: 'name', text: resolveName(d.followed || d.target || d.refId, r) },
    ],
  },
  'joined-audience': {
    icon: 'ph-sparkle',
    tone: 'default',
    href: (d) => tenantHref(d.domain || d.title),
    actor: (d) => d.wallet || d.artist || d.actor,
    phrase: (d) => [
      { kind: 'name', text: d.domain || d.title || '' },
      { kind: 'label', text: 'joined the network' },
    ],
  },
  'org-created': {
    icon: 'ph-users-three',
    tone: 'default',
    href: (d) => d.domain ? tenantHref(d.domain) : '',
    actor: (d) => d.founder || d.actor,
    poster: (d) => d.posterCid,
    phrase: (d, r) => [
      { kind: 'name', text: resolveName(d.founder || d.actor, r) },
      { kind: 'label', text: 'created' },
      { kind: 'strong', text: d.name || 'an organization' },
    ],
    body: (d) => d.description ? `<p class="event-card-body">${esc(d.description).slice(0, 200)}</p>` : '',
  },
  'referral-earned': {
    icon: 'ph-gift',
    tone: 'default',
    href: (d, r) => {
      let dom = (r && r(d.referred)) || ''
      if (dom && !dom.includes('.') && !dom.startsWith('0x')) dom += '.ourpraxis.network'
      return dom.includes('.') ? `https://${dom}` : ''
    },
    actor: (d) => d.referred,
    phrase: (d, r) => [
      { kind: 'name', text: resolveName(d.referred, r) },
      { kind: 'label', text: 'was invited by' },
      { kind: 'name', text: resolveName(d.referrer, r) },
    ],
  },
  'project-proposed': {
    icon: 'ph-clock',
    tone: 'default',
    href: PROJECT_HREF,
    actor: (d) => d.proposer,
    poster: (d) => d.posterCid,
    phrase: (d, r) => [
      { kind: 'name', text: resolveName(d.proposer, r) },
      { kind: 'label', text: 'proposed' },
      { kind: 'strong', text: d.title || 'a project' },
    ],
  },
  'project-confirmed': {
    icon: 'ph-handshake',
    tone: 'green',
    href: PROJECT_HREF,
    actor: (d) => d.proposer,
    poster: (d) => d.posterCid,
    phrase: (d, r) => {
      const collab = d.collaboratorCount ? Number(d.collaboratorCount) : 0
      return [
        { kind: 'name', text: resolveName(d.proposer, r) },
        { kind: 'label', text: 'confirmed' },
        { kind: 'strong', text: d.title || 'a project' },
        collab ? { kind: 'label', text: `· ${collab} collaborator${collab !== 1 ? 's' : ''}` } : null,
      ].filter(Boolean)
    },
  },
  'project-completing': {
    icon: 'ph-spinner',
    tone: 'default',
    href: PROJECT_HREF,
    actor: (d) => d.proposer,
    poster: (d) => d.posterCid,
    phrase: (d, r) => [
      { kind: 'name', text: resolveName(d.proposer, r) },
      { kind: 'label', text: "'s project entering dispute window" },
      { kind: 'strong', text: d.title || '' },
    ],
  },
  'project-completed': {
    icon: 'ph-star',
    tone: 'green',
    href: PROJECT_HREF,
    actor: (d) => d.proposer,
    poster: (d) => d.posterCid,
    phrase: (d, r) => [
      { kind: 'strong', text: d.title || 'a project' },
      { kind: 'label', text: 'completed' },
      d.totalFunded && d.totalFunded !== '0' ? { kind: 'amount', text: String(d.totalFunded) } : null,
    ].filter(Boolean),
  },
  'project-disputed': {
    icon: 'ph-warning',
    tone: 'red',
    href: PROJECT_HREF,
    actor: (d) => d.disputer,
    poster: (d) => d.posterCid,
    phrase: (d, r) => [
      { kind: 'name', text: resolveName(d.disputer, r) },
      { kind: 'label', text: 'disputed' },
      { kind: 'strong', text: d.title || 'a project' },
    ],
  },
  'project-cancelled': {
    icon: 'ph-x-circle',
    tone: 'muted',
    href: PROJECT_HREF,
    actor: (d) => d.proposer,
    poster: (d) => d.posterCid,
    phrase: (d, r) => [
      { kind: 'name', text: resolveName(d.proposer, r) },
      { kind: 'label', text: 'cancelled' },
      { kind: 'strong', text: d.title || 'a project' },
    ],
  },
  'project-timed-out': {
    icon: 'ph-clock-countdown',
    tone: 'muted',
    href: PROJECT_HREF,
    actor: (d) => d.proposer,
    poster: (d) => d.posterCid,
    phrase: (d) => [
      { kind: 'strong', text: d.title || 'a project' },
      { kind: 'label', text: 'timed out past deadline' },
    ],
  },
  'milestone-submitted': {
    icon: 'ph-check-square',
    tone: 'default',
    href: PROJECT_HREF,
    actor: (d) => d.proposer || d.actor,
    phrase: (d, r) => [
      { kind: 'name', text: resolveName(d.proposer || d.actor, r) },
      { kind: 'label', text: 'submitted milestone' },
      { kind: 'strong', text: d.title || d.milestoneTitle || '' },
    ],
  },
  'milestone-released': {
    icon: 'ph-coin',
    tone: 'green',
    href: PROJECT_HREF,
    actor: (d) => d.proposer || d.actor,
    phrase: (d, r) => [
      { kind: 'label', text: 'milestone released on' },
      { kind: 'strong', text: d.title || 'a project' },
      d.amount && d.amount !== '0' ? { kind: 'amount', text: String(d.amount) } : null,
    ].filter(Boolean),
  },
  'revenue-claimed': {
    icon: 'ph-coin',
    tone: 'green',
    href: PROJECT_HREF,
    actor: (d) => d.recipient || d.claimer || d.actor,
    phrase: (d, r) => [
      { kind: 'name', text: resolveName(d.recipient || d.claimer || d.actor, r) },
      { kind: 'label', text: 'claimed revenue' },
      d.amount && d.amount !== '0' ? { kind: 'amount', text: String(d.amount) } : null,
    ].filter(Boolean),
  },
  'revenue-distributed': {
    icon: 'ph-coins',
    tone: 'green',
    href: PROJECT_HREF,
    actor: (d) => d.proposer || d.actor,
    poster: (d) => d.posterCid,
    phrase: (d, r) => [
      { kind: 'name', text: resolveName(d.proposer || d.actor, r) },
      { kind: 'label', text: 'distributed revenue' },
      d.amount && d.amount !== '0' ? { kind: 'amount', text: String(d.amount) } : null,
    ].filter(Boolean),
  },
  transfer: {
    icon: 'ph-arrow-right',
    tone: 'muted',
    actor: (d) => d.newWallet || d.oldWallet || d.actor,
    phrase: (d, r) => [
      { kind: 'name', text: d.domain || resolveName(d.newWallet, r) || resolveName(d.oldWallet, r) },
      { kind: 'label', text: 'moved to a new wallet' },
    ],
  },
  'tip-sent': {
    icon: 'ph-heart',
    tone: 'green',
    href: (d, r) => {
      let dom = (r && r(d.recipient)) || ''
      if (dom && !dom.includes('.') && !dom.startsWith('0x')) dom += '.ourpraxis.network'
      return dom.includes('.') ? `https://${dom}` : ''
    },
    actor: (d) => d.sender || d.actor,
    phrase: (d, r) => [
      { kind: 'name', text: resolveName(d.sender || d.actor, r) },
      { kind: 'label', text: 'tipped' },
      { kind: 'name', text: resolveName(d.recipient, r) },
      d.amount && d.amount !== '0' ? { kind: 'amount', text: String(d.amount) } : null,
    ].filter(Boolean),
  },
  'org-signer-added': {
    icon: 'ph-user-plus',
    tone: 'default',
    href: (d) => tenantHref(d.orgDomain),
    actor: (d) => d.signer || d.actor,
    phrase: (d, r) => [
      { kind: 'name', text: resolveName(d.signer || d.actor, r) },
      { kind: 'label', text: 'joined' },
      { kind: 'strong', text: d.orgName || 'an organization' },
      { kind: 'label', text: 'as a signer' },
    ],
  },
  'org-signer-removed': {
    icon: 'ph-user-minus',
    tone: 'muted',
    href: (d) => tenantHref(d.orgDomain),
    actor: (d) => d.signer || d.actor,
    phrase: (d, r) => [
      { kind: 'name', text: resolveName(d.signer || d.actor, r) },
      { kind: 'label', text: 'left' },
      { kind: 'strong', text: d.orgName || 'an organization' },
    ],
  },
  'org-threshold-changed': {
    icon: 'ph-sliders',
    tone: 'default',
    href: (d) => tenantHref(d.orgDomain),
    actor: (d) => d.actor,
    phrase: (d) => [
      { kind: 'strong', text: d.orgName || 'an organization' },
      { kind: 'label', text: `now requires ${d.threshold || '?'} of ${d.signerCount || '?'} signers` },
    ],
  },
  'handle-reserved': {
    icon: 'ph-tag',
    tone: 'default',
    actor: (d) => d.actor,
    phrase: (d, r) => [
      { kind: 'name', text: resolveName(d.actor, r) },
      { kind: 'label', text: 'reserved the handle' },
      { kind: 'strong', text: d.handle || '' },
    ],
  },
  'domain-registered': {
    icon: 'ph-globe',
    tone: 'default',
    href: (d) => tenantHref(d.domain),
    actor: (d) => d.actor,
    phrase: (d, r) => [
      { kind: 'name', text: resolveName(d.actor, r) },
      { kind: 'label', text: 'registered' },
      { kind: 'strong', text: d.domain || '' },
    ],
  },
}

// ---------- rendering ----------
function renderPhrase(segments) {
  return segments.map(seg => {
    if (!seg || !seg.text) return ''
    const safe = esc(String(seg.text))
    if (seg.kind === 'name') return `<span class="event-card-name">${safe}</span>`
    if (seg.kind === 'strong') return `<span class="event-card-strong">${safe}</span>`
    if (seg.kind === 'amount') return amountSpan(seg.text)
    return `<span class="event-card-label">${safe}</span>`
  }).filter(Boolean).join(' ')
}

function wrap(href, external, inner, cls, tone) {
  const toneCls = tone && tone !== 'default' ? ` event-card--${tone}` : ''
  if (href) {
    const target = external ? ' target="_blank" rel="noopener"' : ''
    return `<a href="${esc(href)}"${target} class="event-card ${cls}${toneCls}">${inner}</a>`
  }
  return `<div class="event-card ${cls}${toneCls}">${inner}</div>`
}

export function renderEventCard(event, context = {}) {
  if (!event || !event.type) return ''
  const desc = DESCRIPTORS[event.type]
  if (!desc) return ''
  const { resolve = () => '', external = false, mutedTimestamp = true, layout = 'line' } = context
  const href = typeof desc.href === 'function' ? desc.href(event, resolve) : (desc.href || '')
  const actor = typeof desc.actor === 'function' ? desc.actor(event) : null
  const phraseSegments = desc.phrase(event, resolve)
  const phraseHtml = renderPhrase(phraseSegments)
  const timeHtml = timeMeta(event.timestamp, mutedTimestamp)
  const iconHtml = desc.icon ? `<i class="ph ${desc.icon} event-card-icon" aria-hidden="true"></i>` : ''

  if (layout === 'inline-reference') {
    return wrap(href, external, `${iconHtml}<span class="event-card-headline">${phraseHtml}</span>`, 'event-card--inline-reference', desc.tone)
  }

  if (layout === 'banner') {
    const poster = (desc.poster && desc.poster(event)) ? posterImg(desc.poster(event)) : (event.type === 'joined-audience' || event.type === 'follow' ? ogImg(event.domain || event.title || (resolve && resolve(event.followed || event.target))) : '')
    const bodyHtml = desc.body ? desc.body(event) : ''
    const avatar = actor ? avatarImg(actor, event.profilePic, 32) : ''
    const inner = `
      ${poster}
      <div class="event-card-inner">
        <div class="event-card-headline-row">
          ${avatar || iconHtml}
          <div class="event-card-headline">${phraseHtml}</div>
        </div>
        ${bodyHtml}
        ${timeHtml ? `<div class="event-card-meta">${timeHtml}</div>` : ''}
      </div>
    `
    return wrap(href, external, inner, 'event-card--banner', desc.tone)
  }

  // 'line' (default)
  const avatar = actor ? avatarImg(actor, event.profilePic, 24) : ''
  const inner = `
    <div class="event-card-inner">
      <div class="event-card-headline-row">
        ${avatar || iconHtml}
        <div class="event-card-headline">${phraseHtml}</div>
        ${timeHtml}
      </div>
    </div>
  `
  return wrap(href, external, inner, 'event-card--line', desc.tone)
}

// Convenience: list known event types (useful for /design catalog + tests).
export const EVENT_TYPES = Object.keys(DESCRIPTORS)
