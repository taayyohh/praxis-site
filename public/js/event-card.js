// Universal event card — single renderer for all protocol activity events.
// Three layouts: 'line' (compact row), 'banner' (poster/avatar hero), 'inline-reference'
// (minimal pill, embeds inside other cards). Covers ~20 event types across
// social, project-lifecycle, economic, membership, and infrastructure dimensions.
//
// Usage:
//   renderEventCard(event, { layout, resolve, external, mutedTimestamp, fat })
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
//   fat: opt-in to the phase 11b fat+warm line — 80px row, 40px avatars,
//        56px media thumb, 40px tinted mode-badge puck. Touch-surfaces
//        (feed + notifications) pass fat:true; every other caller stays
//        on the compact line until its host surface opts in.

import { escapeHtml as esc, getProfilePic, getArtistName, timeAgo } from './utils.js'

// ---------- helpers ----------
const resolveName = (addr, resolve, explicit) =>
  explicit || getArtistName(addr) || (resolve && resolve(addr)) || ''

const avatarImg = (addr, pic, size = 28) => {
  const src = pic || getProfilePic(addr)
  if (!src) return ''
  const name = getArtistName(addr) || ''
  const alt = name ? `${name} avatar` : ''
  return `<img src="${esc(src)}" class="event-card-avatar" style="width:${size}px;height:${size}px" alt="${esc(alt)}" loading="lazy" onerror="this.style.display='none'">`
}

// 40px tinted mode-badge puck — fills the fat row's left slot for
// infra / admin events without people or media. The Phosphor glyph
// the descriptor already carries, puck'd into the row so the
// moment reads as an event, not a thin admin line.
const badgeSpan = (tint, icon) =>
  `<span class="event-card-badge event-card-badge--${esc(tint)}"><i class="ph ${esc(icon)}" aria-hidden="true"></i></span>`

// 56px media thumb at 12px radius (or 96×56 wide for video). Used by
// the fat line renderer when the descriptor advertises a poster CID
// and the event carries one. Not an <a> — the row itself is the link.
const thumbSpan = (cid, wide = false) => {
  if (!cid) return ''
  const src = `/api/img?url=/api/ipfs-proxy/${encodeURIComponent(cid)}&w=240`
  const cls = wide ? 'event-card-thumb event-card-thumb--wide' : 'event-card-thumb'
  return `<span class="${cls}"><img src="${esc(src)}" alt="" loading="lazy" onerror="this.parentElement.style.display='none'"></span>`
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
    badge: 'accent',
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
    phrase: (d, r) => [
      { kind: 'name', text: resolveName(d.proposer, r) },
      { kind: 'label', text: 'confirmed' },
      { kind: 'strong', text: d.title || 'a project' },
    ],
    // Collaborator count lives on its own body row, not inline with
    // the attribution phrase — see event-card.js render path for the
    // `body` slot. Keeping phrase single-noun keeps the eye on the
    // actor + verb + object.
    body: (d) => {
      const collab = d.collaboratorCount ? Number(d.collaboratorCount) : 0
      return collab ? `<p class="event-card-body">${collab} collaborator${collab !== 1 ? 's' : ''}</p>` : ''
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
    badge: 'red',
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
    badge: 'red',
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
    badge: 'amber',
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
    badge: 'accent',
    href: (d) => tenantHref(d.domain),
    actor: (d) => d.actor,
    phrase: (d, r) => [
      { kind: 'name', text: resolveName(d.actor, r) },
      { kind: 'label', text: 'registered' },
      { kind: 'strong', text: d.domain || '' },
    ],
  },
  // Blog-posted — someone published a new post. Phrasing lifted from the
  // workshop fixture: "{actor} published {title}". The post is the strong
  // noun; the actor is the name link.
  'blog-posted': {
    icon: 'ph-article',
    tone: 'default',
    badge: 'neutral',
    href: (d) => d.postId ? `/post?id=${d.postId}` : '',
    actor: (d) => d.author || d.actor,
    phrase: (d, r) => [
      { kind: 'name', text: resolveName(d.author || d.actor, r) },
      { kind: 'label', text: 'published' },
      { kind: 'strong', text: d.title || '' },
    ],
  },
  // Library-added — someone contributed a work to the shared library.
  // Workshop phrasing: "{actor} added {title} to the library".
  'library-added': {
    icon: 'ph-books',
    tone: 'default',
    badge: 'neutral',
    href: (d) => d.itemId ? `/library?item=${encodeURIComponent(d.itemId)}` : '/library',
    actor: (d) => d.contributor || d.actor,
    phrase: (d, r) => [
      { kind: 'name', text: resolveName(d.contributor || d.actor, r) },
      { kind: 'label', text: 'added' },
      { kind: 'strong', text: d.title || '' },
      { kind: 'label', text: 'to the library' },
    ],
  },
  // Org-site-registered — an organization launched its own subdomain or
  // custom domain. Workshop phrasing: "{org} launched a site at {domain}".
  // The org is the strong noun; the domain is the name link.
  'org-site-registered': {
    icon: 'ph-storefront',
    tone: 'default',
    badge: 'accent',
    href: (d) => tenantHref(d.domain),
    actor: (d) => d.actor,
    phrase: (d) => [
      { kind: 'strong', text: d.orgName || d.name || 'an organization' },
      { kind: 'label', text: 'launched a site at' },
      { kind: 'name', text: d.domain || '' },
    ],
  },
  // Ticket market — the pre-universal cards (renderTicketListedCard /
  // renderTicketPurchasedCard) rendered these as text-only rows with
  // the event name as the strong noun. Mirrored here.
  'ticket-listed': {
    icon: 'ph-ticket',
    tone: 'default',
    href: () => '/tickets',
    actor: (d) => d.seller || d.actor,
    phrase: (d, r) => [
      { kind: 'name', text: resolveName(d.seller || d.actor, r) },
      { kind: 'label', text: 'listed a ticket for' },
      { kind: 'strong', text: d.eventName || d.title || 'an event' },
      d.price && d.price !== '0' ? { kind: 'amount', text: String(d.price) } : null,
    ].filter(Boolean),
  },
  'ticket-purchased': {
    icon: 'ph-ticket',
    tone: 'green',
    href: () => '/tickets',
    actor: (d) => d.buyer || d.actor,
    phrase: (d, r) => [
      { kind: 'name', text: resolveName(d.buyer || d.actor, r) },
      { kind: 'label', text: 'got a ticket to' },
      { kind: 'strong', text: d.eventName || d.title || 'an event' },
    ],
  },
  // Credentials — the pre-universal renderCredentialCard framed these
  // as "X earned Y role in Z project".
  credential: {
    icon: 'ph-seal-check',
    tone: 'default',
    href: (d) => d.projectId ? `/project?id=${d.projectId}` : '',
    actor: (d) => d.recipient || d.actor,
    phrase: (d, r) => [
      { kind: 'name', text: resolveName(d.recipient || d.actor, r) },
      { kind: 'label', text: 'earned' },
      { kind: 'strong', text: d.role || 'contributor' },
      d.projectTitle ? { kind: 'label', text: `in ${d.projectTitle}` } : null,
    ].filter(Boolean),
  },
  // Project funded — someone backed a project. renderFundedCard
  // rendered this as a plain text row with amount + proposer context.
  funded: {
    icon: 'ph-hand-coins',
    tone: 'green',
    href: (d) => d.projectId ? `/project?id=${d.projectId}` : '',
    actor: (d) => d.funder || d.actor,
    phrase: (d, r) => [
      { kind: 'name', text: resolveName(d.funder || d.actor, r) },
      { kind: 'label', text: 'funded' },
      { kind: 'strong', text: d.title || 'a project' },
      d.amount && d.amount !== '0' ? { kind: 'amount', text: String(d.amount) } : null,
    ].filter(Boolean),
  },
  // Supporter — someone registered as an audience member of an artist.
  // renderSupporterCard framed this as "X joined Y's audience".
  supporter: {
    icon: 'ph-sparkle',
    tone: 'default',
    href: (d, r) => tenantHref(r && r(d.artist)),
    actor: (d) => d.supporter || d.actor,
    phrase: (d, r) => [
      { kind: 'name', text: resolveName(d.supporter || d.actor, r) },
      { kind: 'label', text: 'joined' },
      { kind: 'name', text: resolveName(d.artist, r) },
      { kind: 'label', text: "'s audience" },
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

// Pick the row tone for the fat shape. If the descriptor advertises a
// mode-badge color, the badge wins (accent for identity-registry moments,
// red for cancels + disputes, amber for timeouts, neutral for content).
// Otherwise fall back to the existing semantic tone so earned-value rows
// keep their green edge and must-act rows keep their red one.
function fatTone(desc) {
  if (desc.badge === 'accent') return 'accent'
  if (desc.badge === 'red') return 'red'
  if (desc.badge === 'amber') return 'amber'
  if (desc.badge === 'green') return 'green'
  if (desc.badge === 'neutral') return 'default'
  return desc.tone
}

export function renderEventCard(event, context = {}) {
  if (!event || !event.type) return ''
  const desc = DESCRIPTORS[event.type]
  if (!desc) return ''
  const { resolve = () => '', external = false, mutedTimestamp = true, layout = 'line', fat = false } = context
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

  // 'line' — fat is an opt-in modifier on this layout.
  if (fat) {
    // Left slot — badge takes precedence over avatar so mode-badge events
    // read as events, not thin admin lines. No avatar <img> is emitted
    // when a badge fills the slot.
    const leftSlot = desc.badge
      ? badgeSpan(desc.badge, desc.icon)
      : (actor ? avatarImg(actor, event.profilePic, 40) : iconHtml)
    // Right slot — 56px media thumb when the descriptor advertises a
    // poster and the event carries one. Not an <a> (the row itself is
    // the link). Wide variant kept available via descriptor opt-in.
    const posterCid = desc.poster ? desc.poster(event) : null
    const thumb = posterCid ? thumbSpan(posterCid, desc.thumbWide === true) : ''
    const inner = `
      ${leftSlot}
      <div class="event-card-inner">
        <div class="event-card-phrase">${phraseHtml}${timeHtml}</div>
      </div>
      ${thumb}
    `
    return wrap(href, external, inner, 'event-card--line event-card--fat', fatTone(desc))
  }

  // 'line' (default, compact)
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
