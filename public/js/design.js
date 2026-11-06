// Living UI catalog — /design.
//
// Bird's-eye view of every visual primitive + interaction surface in
// Praxis, on one page. NOT a Storybook — instead of duplicating a
// stripped-down copy of each component, this page calls the SAME
// window-level module functions the app calls in production (e.g.
// showSendModal, showReceiveModal, showFundingSheet), and imports
// the SAME render functions the feed / collection / library use. If a
// component drifts in prod, it drifts here too — no staleness, no
// maintenance debt.
//
// Sections, top-to-bottom:
//   1. Foundation — colors, typography, chips, badges
//   2. Buttons + inputs
//   3. Money modals (send / receive / save / funding / on+offramp)
//   4. Feed event cards — one row per Ponder event type
//   5. Media + collection — art cards, album card, library item
//   6. Vault surfaces — total, activity row, ticket pass
//   7. Navigation — wallet dropdown, tab strip, dock preview
//   8. Media playback — track-play-btn, queue row
//   9. Status states — loader, empty, error, success
//
// Adding a new component? See CLAUDE.md → "Design Catalog — /design
// (MUST UPDATE)". Living rule: catalog entry lands in the same commit
// as the component itself.

import { registerPage, escapeHtml, inlineAvatar } from './utils.js'

registerPage('design-page', initDesign)

// ─── catalog sidebar — grouped jump nav ──────────────────────────────
// 25 sections is too many to scroll. The sidebar groups them into six
// categories so Miles can review one surface family at a time. All
// sections stay in the DOM — the sidebar jumps + the URL hash follow.
// Labels use Miles's existing section h2 text (number prefix stripped);
// nothing invented in the nav strings.
const CATALOG_SECTION_IDS = {
  '1': 'sec-foundation',
  '2': 'sec-buttons',
  '3': 'sec-money-modals',
  '4': 'sec-feed-cards',
  '5': 'sec-media',
  '6': 'sec-vault',
  '7': 'sec-navigation',
  '8': 'sec-playback',
  '9': 'sec-status-states',
  '10': 'sec-orgs',
  '11': 'sec-modules',
  '12': 'sec-notifications',
  '13': 'sec-states-errors',
  '14': 'sec-auth',
  '15': 'sec-vault-money',
  '16': 'sec-settings',
  '17': 'sec-messages',
  '18': 'sec-primitives',
  '19': 'sec-making-writing',
  '20': 'sec-money-inout',
  '21': 'sec-projects',
  '22': 'sec-network',
  '23': 'sec-art-post',
  '24': 'sec-templates-player',
}

const CATALOG_CATEGORIES = [
  {
    title: 'foundation',
    items: [
      { id: 'dw-workshop-root', label: 'workshop' },
      { id: 'sec-foundation', label: 'foundation' },
      { id: 'sec-buttons', label: 'buttons + inputs' },
    ],
  },
  {
    title: 'content cards',
    items: [
      { id: 'sec-feed-cards', label: 'feed event cards' },
      { id: 'sec-media', label: 'media + collection' },
      { id: 'sec-art-post', label: 'art + post detail' },
    ],
  },
  {
    title: 'chrome',
    items: [
      { id: 'sec-navigation', label: 'navigation' },
      { id: 'sec-playback', label: 'media playback' },
      { id: 'sec-notifications', label: 'notifications' },
    ],
  },
  {
    title: 'money + accounts',
    items: [
      { id: 'sec-money-modals', label: 'money modals' },
      { id: 'sec-vault', label: 'vault surfaces' },
      { id: 'sec-orgs', label: 'organizations' },
      { id: 'sec-auth', label: 'auth + accounts' },
      { id: 'sec-vault-money', label: 'vault + money' },
      { id: 'sec-settings', label: 'settings + CMS' },
      { id: 'sec-money-inout', label: 'money in + out' },
    ],
  },
  {
    title: 'collaborative',
    items: [
      { id: 'sec-modules', label: 'modules' },
      { id: 'sec-messages', label: 'messages' },
      { id: 'sec-making-writing', label: 'making + writing' },
      { id: 'sec-projects', label: 'project lifecycle' },
      { id: 'sec-network', label: 'network + profile' },
      { id: 'sec-templates-player', label: 'templates + player' },
    ],
  },
  {
    title: 'states + primitives',
    items: [
      { id: 'sec-status-states', label: 'status states' },
      { id: 'sec-states-errors', label: 'states + errors' },
      { id: 'sec-primitives', label: 'primitives + chrome' },
    ],
  },
]

function renderCatalogNav(categories) {
  const groups = categories.map(cat => {
    const items = cat.items.map(it => `
            <a class="dw-catalog-nav__item"
               href="#${escapeHtml(it.id)}"
               data-dw-nav-target="${escapeHtml(it.id)}">${escapeHtml(it.label)}</a>`).join('')
    return `
          <div class="dw-catalog-nav__group">
            <div class="dw-catalog-nav__group-label">${escapeHtml(cat.title)}</div>${items}
          </div>`
  }).join('')
  return `
      <aside class="dw-catalog-nav" id="dw-catalog-nav">
        <button type="button" class="dw-catalog-nav__trigger"
                aria-expanded="false" aria-controls="dw-catalog-nav__list">
          <span>sections</span>
          <span class="dw-catalog-nav__trigger-caret" aria-hidden="true">▾</span>
        </button>
        <nav class="dw-catalog-nav__list" id="dw-catalog-nav__list"
             role="navigation" aria-label="design sections">${groups}
        </nav>
      </aside>`
}

// Mock addresses (deterministic hex — never resolves to a real artist).
const A_ADDR = '0x1111111111111111111111111111111111111111'
const B_ADDR = '0x2222222222222222222222222222222222222222'
const C_ADDR = '0x3333333333333333333333333333333333333333'

// A resolver the feed-card render functions expect. Returns a short
// human-readable domain per address so cards read as if they came from
// real artists.
function mockResolve(addr) {
  const a = String(addr || '').toLowerCase()
  if (a === A_ADDR.toLowerCase()) return 'nappynina.com'
  if (a === B_ADDR.toLowerCase()) return 'blackmatter.world'
  if (a === C_ADDR.toLowerCase()) return 'milesxb.bio'
  // Live listings pull real artist wallets — fall back to the resolved
  // domain if the catalog's live-fetch populated it.
  try { if (globalThis._designLiveDomains?.[a]) return globalThis._designLiveDomains[a] } catch {}
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}

// Wraps a live feed-card render call in a labeled block. If the call
// throws (schema drift), catches so the rest of the catalog still
// renders — with a short "regressed" note where the card should have
// been. That is itself useful signal.
function renderCardSafely(label, fn) {
  let inner = ''
  try {
    inner = fn() || '<em style="color:var(--muted);font-size:0.85em">render returned empty (delisted or filtered)</em>'
  } catch (e) {
    inner = `<em style="color:#ef4444;font-size:0.85em">render threw: ${escapeHtml(e?.message || String(e))}</em>`
  }
  return `<div class="design-block">
    <h3>${escapeHtml(label)}</h3>
    <div class="design-card-frame">${inner}</div>
  </div>`
}

// Sandbox-mode opener dispatch. Each case opens the SAME modal the
// production app uses — pay.js, media.js, projects.js — but their
// internal RPC calls route through the fetch patch in sandbox.js so
// anything they'd send to Optimism mainnet now goes to the anvil fork.
async function openSandbox(kind, sandbox) {
  if (!sandbox?.isSandbox?.()) {
    console.warn('[sandbox] opener used without ?sandbox=1 — refusing')
    return
  }
  const seed = sandbox.getSandboxSeed?.()
  if (!seed) {
    alert('sandbox not primed — run `node scripts/sandbox-seed.js` against a live anvil fork first.')
    return
  }
  const { address: burner } = await sandbox.getSandboxWallet()
  if (kind === 'sandbox-fund-eth') {
    const mod = await import('./pay.js')
    await mod.showFundingSheet(burner, BigInt(seed.showcaseProjectId || 1))
  } else if (kind === 'sandbox-fund-erc20') {
    const mod = await import('./pay.js')
    // Same sheet — the ERC20 path lives behind the token-select inside.
    await mod.showFundingSheet(burner, BigInt(seed.showcaseProjectId || 1))
  } else if (kind === 'sandbox-buy-album') {
    // The album buy UX lives on the artist's album page. Open it in a
    // new tab so the catalog stays available for the next flow.
    window.open(`/art?media=${encodeURIComponent(seed.showcaseMediaId || '1')}`, '_blank', 'noopener')
  } else if (kind === 'sandbox-collect-single') {
    window.open(`/art?media=${encodeURIComponent(seed.showcaseMediaId || '1')}`, '_blank', 'noopener')
  } else if (kind === 'sandbox-propose') {
    window.location.href = '/propose'
  } else if (kind === 'sandbox-compose-blog') {
    // Opens /write — the compose page. On an artist site the publish
    // writes directly to BlogRegistry as the owner; on an org site the
    // same publish routes through Safe.execTransaction so the Safe is
    // recorded as the author.
    window.location.href = '/write'
  }
}

// Render a small status pane under the sandbox buttons: anvil url,
// seed project / media ids, burner address. Pure read-only — useful
// to confirm the operator primed the fork correctly before clicking.
async function renderSandboxStatus(sandbox) {
  const pane = document.getElementById('design-sandbox-status')
  if (!pane) return
  const seed = sandbox.getSandboxSeed?.()
  if (!seed) {
    pane.textContent = 'no seed found — run `node scripts/sandbox-seed.js` against your local anvil, then reload.'
    return
  }
  let burner = '(minting…)'
  try { burner = (await sandbox.getSandboxWallet()).address } catch (e) { burner = `(mint failed: ${e?.message || e})` }
  pane.textContent = [
    `anvil:   ${seed.anvilUrl || 'http://localhost:8545'}`,
    `chain:   ${seed.chainId || 10}  fork block: ${seed.forkBlock || '(current)'}`,
    `project: ${seed.showcaseProjectId}`,
    `media:   ${seed.showcaseMediaId}`,
    `usdc:    ${seed.usdcAddr}`,
    `burner:  ${burner}`,
  ].join('\n')
}

async function initDesign() {
  const el = document.getElementById('design-content')
  if (!el) return

  // Workshop scope — `#design-page` is the container's id, but every
  // scoped selector in design-workshop.css keys on the matching class
  // (`.design-page foo`). Mirror the id onto the class so the scope
  // actually matches. Idempotent across SPA re-entries.
  const pageEl = document.getElementById('design-page')
  if (pageEl && !pageEl.classList.contains('design-page')) {
    pageEl.classList.add('design-page')
  }

  // Workshop stylesheet — scoped primitives + tokens live under
  // /design only. Injected at init time so the template shells
  // don't need a new hashed-CSS link. Idempotent.
  if (!document.querySelector('link[data-dw-workshop]')) {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = '/design-workshop.css'
    link.setAttribute('data-dw-workshop', '1')
    document.head.appendChild(link)
  }
  // Workshop a11y helpers for .dw-modal / .dw-sheet / .dw-toast. Loaded
  // here so no non-catalog page imports it. Errors in the import are
  // non-fatal — the rest of the catalog still renders.
  let DW = {}
  try { DW = await import('./design-workshop.js') } catch (e) { console.warn('design-workshop import:', e) }

  // Sandbox mode (?sandbox=1) — flips a red top bar, patches fetch so
  // every /api/rpc/* call hits a local anvil fork, mints a per-session
  // burner wallet. Everything else below is unchanged.
  let sandbox = null
  try { sandbox = await import('./sandbox.js') } catch (e) { console.warn('sandbox import:', e) }
  if (sandbox?.isSandbox?.()) {
    try { await sandbox.initSandbox() } catch (e) { console.warn('sandbox init:', e) }
  }

  // Import the real render surface — same functions the /network,
  // /projects, /supporter-home, and other feed-driven views call.
  let F = {}
  try { F = await import('./feed-cards.js') } catch (e) { console.warn('feed-cards import:', e) }
  // Universal card renderers — the one-card-family migration target.
  // Section 4/5 entries labeled "universal" call these directly.
  let U = {}
  try { U = await import('./media-card.js') } catch (e) { console.warn('media-card import:', e) }
  let E = {}
  try { E = await import('./event-card.js') } catch (e) { console.warn('event-card import:', e) }

  // Pull real listings from prod so cards render with real artwork / audio
  // / prices / artist chips instead of empty frames. One fetch, then we
  // cherry-pick the best representative of each content type for the
  // MediaCard fixtures below. If the fetch fails for any reason the
  // fixtures fall back to the pre-existing structural mocks — never
  // breaks the catalog.
  let LIVE = { audio: null, audioOwned: null, video: null, image: null, pdf: null, album: null, imageAlbum: null }
  try {
    const r = await fetch('/api/feed/timeline?limit=200', { signal: AbortSignal.timeout(6000) })
    if (r.ok) {
      const d = await r.json()
      const items = Array.isArray(d.items) ? d.items : []
      const singles = items.filter(i => i.type === 'listed').map(i => i.data)
      const batches = items.filter(i => i.type === 'listed-batch').map(i => i.data)
      const bySingle = (match) => singles.find(s => s.ipfsCid && match(s.contentType || ''))
      const audio = bySingle(ct => ct.startsWith('audio/'))
      const video = bySingle(ct => ct.startsWith('video/'))
      const image = bySingle(ct => ct.startsWith('image/'))
      const pdf = bySingle(ct => ct.includes('pdf'))
      const audioAlbum = batches.find(b => b.items?.[0]?.contentType?.startsWith('audio/'))
      const imageAlbum = batches.find(b => b.items?.[0]?.contentType?.startsWith('image/'))
      if (audio) LIVE.audio = { mediaId: audio.mediaId, title: audio.title, artist: audio.artist, price: audio.price, contentType: audio.contentType, ipfsCid: audio.ipfsCid }
      if (audio) LIVE.audioOwned = { ...LIVE.audio, mediaId: `${audio.mediaId}-owned` }
      if (video) LIVE.video = { mediaId: video.mediaId, title: video.title, artist: video.artist, price: video.price, contentType: video.contentType, ipfsCid: video.ipfsCid }
      if (image) LIVE.image = { mediaId: image.mediaId, title: image.title, artist: image.artist, price: image.price, contentType: image.contentType, ipfsCid: image.ipfsCid }
      if (pdf) LIVE.pdf = { mediaId: pdf.mediaId, title: pdf.title, artist: pdf.artist, price: pdf.price, contentType: pdf.contentType, ipfsCid: pdf.ipfsCid }
      if (audioAlbum) LIVE.album = {
        mediaId: `batch-${audioAlbum.items[0].mediaId}`,
        headline: audioAlbum.headline, artist: audioAlbum.artist, aliasName: audioAlbum.aliasName,
        albumPath: audioAlbum.albumPath, count: audioAlbum.count,
        items: audioAlbum.items.slice(0, 5).map(it => ({ mediaId: it.mediaId, title: it.title, price: it.price, contentType: it.contentType, ipfsCid: it.ipfsCid })),
      }
      if (imageAlbum) LIVE.imageAlbum = {
        mediaId: `batch-${imageAlbum.items[0].mediaId}`,
        headline: imageAlbum.headline, artist: imageAlbum.artist, aliasName: imageAlbum.aliasName,
        count: imageAlbum.count,
        items: imageAlbum.items.slice(0, 4).map(it => ({ mediaId: it.mediaId, title: it.title, price: it.price, contentType: it.contentType, ipfsCid: it.ipfsCid })),
      }
    }
  } catch (e) { console.warn('[design] live-listings fetch failed:', e?.message || e) }

  // Resolve the real artist wallets we pulled, so mockResolve returns
  // the real domain (e.g. "nappynina.com") instead of 0xb4ca….
  const LIVE_DOMAINS = {}
  try {
    const addrs = Array.from(new Set(Object.values(LIVE).filter(Boolean).map(v => (v.artist || '').toLowerCase()).filter(Boolean)))
    if (addrs.length) {
      const r = await fetch('/api/artists/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ addresses: addrs }),
        signal: AbortSignal.timeout(4000),
      })
      if (r.ok) {
        const d = await r.json()
        if (d && typeof d === 'object') Object.assign(LIVE_DOMAINS, d.resolved || d)
      }
    }
  } catch (e) { console.warn('[design] resolve fetch failed:', e?.message || e) }
  try { globalThis._designLiveDomains = LIVE_DOMAINS } catch {}

  // Mock data — minimal fixtures each renderer needs to draw.
  const now = Math.floor(Date.now() / 1000)
  const m = {
    // Media / batch cards — d.mediaId, d.title, d.price, d.artist,
    // d.contentType, d.ipfsCid, d.metadataCid.
    audioCard: {
      mediaId: '1', title: 'End Credits', artist: A_ADDR, price: '2000000000000000',
      contentType: 'audio/mpeg', ipfsCid: '', metadataCid: '', artistName: 'nappy nina',
    },
    videoCard: {
      mediaId: '2', title: 'Backlot', artist: B_ADDR, price: '5000000000000000',
      contentType: 'video/mp4', ipfsCid: '', metadataCid: '', artistName: 'blackmatter',
    },
    imageCard: {
      mediaId: '3', title: 'Untitled', artist: C_ADDR, price: '3000000000000000',
      contentType: 'image/png', ipfsCid: '', metadataCid: '', artistName: 'miles',
    },
    // Batch: multiple mediaIds under one album title
    batchCard: {
      artist: A_ADDR, title: 'End Credits', albumTitle: 'End Credits',
      metadataCid: '', tracks: [
        { mediaId: '1', title: 'Track 1', price: '2000000000000000', ipfsCid: '', contentType: 'audio/mpeg' },
        { mediaId: '2', title: 'Track 2', price: '2000000000000000', ipfsCid: '', contentType: 'audio/mpeg' },
      ],
    },
    // Simple activity events — data varies but usually { artist, target, ts }
    followCard: { follower: B_ADDR, followed: A_ADDR, ts: now - 3600 },
    joinedCard: { artist: A_ADDR, ts: now - 86400 },
    // Project cards
    projectCard: {
      projectId: '10', proposer: A_ADDR, title: 'Live at Elsewhere',
      projectType: 'event', status: 1, fundingGoal: '500000000000000000',
      totalFunded: '250000000000000000', ts: now - 172800,
    },
    fundedCard: {
      projectId: '10', funder: B_ADDR, artist: A_ADDR, title: 'Live at Elsewhere',
      amount: '100000000000000000', ts: now - 3600, projectType: 'event',
    },
    purchaseCard: {
      mediaId: '1', buyer: B_ADDR, artist: A_ADDR, title: 'End Credits',
      price: '2000000000000000', ts: now - 1800,
    },
    purchaseBatchCard: {
      artist: A_ADDR, buyer: B_ADDR, albumTitle: 'End Credits',
      items: [
        { mediaId: '1', title: 'Track 1', price: '2000000000000000' },
        { mediaId: '2', title: 'Track 2', price: '2000000000000000' },
      ], ts: now - 900,
    },
    supporterCard: { supporter: B_ADDR, artist: A_ADDR, ts: now - 7200 },
    ticketListedCard: {
      tokenId: '12345', seller: B_ADDR, price: '3000000000000000',
      projectId: '10', title: 'Live at Elsewhere', ts: now - 300,
    },
    ticketPurchasedCard: {
      tokenId: '12345', seller: B_ADDR, buyer: C_ADDR, price: '3000000000000000',
      projectId: '10', title: 'Live at Elsewhere', ts: now - 60,
    },
    transferCard: { from: B_ADDR, to: C_ADDR, tokenId: '12345', ts: now - 600 },
    referralCard: { referrer: A_ADDR, referred: B_ADDR, ts: now - 43200 },
    projectCompletedCard: { projectId: '10', proposer: A_ADDR, title: 'Live at Elsewhere', ts: now - 259200 },
    projectConfirmedCard: { projectId: '10', proposer: A_ADDR, title: 'Live at Elsewhere', ts: now - 604800 },
    orgCreatedCard: { orgId: '5', founder: A_ADDR, name: 'Practice Records', ts: now - 1209600 },
    credentialCard: { credentialId: '20', projectId: '10', holder: B_ADDR, title: 'Contributor', ts: now - 86400 },
    projectCompletingCard: { projectId: '10', proposer: A_ADDR, title: 'Live at Elsewhere', ts: now - 86400 },
    projectDisputedCard: { projectId: '10', proposer: A_ADDR, disputer: C_ADDR, title: 'Live at Elsewhere', ts: now - 43200 },
    projectCancelledCard: { projectId: '10', proposer: A_ADDR, title: 'Live at Elsewhere', ts: now - 21600 },
    projectTimedOutCard: { projectId: '10', proposer: A_ADDR, title: 'Live at Elsewhere', ts: now - 3600 },
    revenueDistributedCard: {
      projectId: '10', proposer: A_ADDR, title: 'Live at Elsewhere',
      totalDistributed: '250000000000000000', ts: now - 1800,
    },

    // ── universal MediaCard fixtures ─────────────────────────────
    // One shape per variant; the component infers category + layout
    // from the item unless the caller explicitly overrides.
    uniAudioListed: LIVE.audio || {
      mediaId: '101', title: 'End Credits', artist: A_ADDR,
      aliasName: 'nappy nina', price: '2000000000000000',
      contentType: 'audio/mpeg',
    },
    uniAudioOwned: LIVE.audioOwned || {
      mediaId: '102', title: 'End Credits', artist: A_ADDR,
      aliasName: 'nappy nina', price: '2000000000000000',
      contentType: 'audio/mpeg',
    },
    uniVideo: LIVE.video || {
      mediaId: '103', title: 'Backlot', artist: B_ADDR,
      price: '5000000000000000', contentType: 'video/mp4',
    },
    uniImage: LIVE.image || {
      mediaId: '104', title: 'Study No. 3', artist: C_ADDR,
      price: '3000000000000000', contentType: 'image/jpeg',
    },
    uniPdf: LIVE.pdf || {
      mediaId: '105', title: 'A Reading of Coriolanus', artist: C_ADDR,
      price: '0', contentType: 'application/pdf',
    },
    uniPortrait: {
      mediaId: '106', title: 'The Making of Backlot', artist: B_ADDR,
      price: '1500000000000000', contentType: 'application/pdf',
    },
    uniAlbum: LIVE.album || {
      mediaId: '107', headline: 'End Credits', artist: A_ADDR,
      aliasName: 'nappy nina',
      albumPath: { alias: 0, album: 0, aliasName: 'nappy nina', albumTitle: 'End Credits' },
      count: 3, items: [
        { mediaId: '201', title: 'Overture', price: '2000000000000000', contentType: 'audio/mpeg' },
        { mediaId: '202', title: 'Second Line', price: '2000000000000000', contentType: 'audio/mpeg' },
        { mediaId: '203', title: 'Closing', price: '2000000000000000', contentType: 'audio/mpeg' },
      ],
    },
    uniImageAlbum: LIVE.imageAlbum || {
      mediaId: '108', headline: 'Studies', artist: C_ADDR,
      aliasName: 'miles', count: 4, items: [
        { mediaId: '301', title: 'Study 1', price: '1000000000000000', contentType: 'image/jpeg' },
        { mediaId: '302', title: 'Study 2', price: '1000000000000000', contentType: 'image/jpeg' },
        { mediaId: '303', title: 'Study 3', price: '1000000000000000', contentType: 'image/jpeg' },
        { mediaId: '304', title: 'Study 4', price: '1000000000000000', contentType: 'image/jpeg' },
      ],
    },
    uniTicket: {
      mediaId: '109', title: 'Live at Elsewhere', artist: A_ADDR,
      price: '15000000000000000', contentType: 'application/octet-stream',
      kind: 'ticket', maxSupply: '100', totalMinted: '87',
      // Show date lives in the meta line so limited/sold-out/ended ticket
      // cards keep the "when" signal even when no state overlay carries a
      // countdown. renderMeta surfaces `subtype` as a meta part.
      subtype: 'mar 12',
    },
    uniCredential: {
      mediaId: '110', title: 'Contributor — Live at Elsewhere',
      artist: A_ADDR, price: '0', kind: 'credential',
    },
    uniBundle: {
      mediaId: '111', headline: 'A Studio Visit', artist: B_ADDR,
      count: 5, items: [
        { mediaId: '401', title: 'photo 1', price: '0', contentType: 'image/jpeg' },
        { mediaId: '402', title: 'audio', price: '0', contentType: 'audio/mpeg' },
        { mediaId: '403', title: 'reading', price: '0', contentType: 'application/pdf' },
        { mediaId: '404', title: 'video', price: '0', contentType: 'video/mp4' },
        { mediaId: '405', title: 'extra', price: '0', contentType: 'image/jpeg' },
      ],
    },

    // ── universal EventCard fixtures ─────────────────────────────
    uniEvFollow: { type: 'follow', follower: B_ADDR, followed: A_ADDR, timestamp: now - 3600 },
    uniEvJoined: { type: 'joined-audience', wallet: B_ADDR, domain: 'blackmatter.world', timestamp: now - 86400 },
    uniEvOrgCreated: { type: 'org-created', founder: A_ADDR, name: 'Practice Records', description: 'A worker-owned label collective.', timestamp: now - 1209600 },
    uniEvReferral: { type: 'referral-earned', referrer: A_ADDR, referred: B_ADDR, timestamp: now - 43200 },
    uniEvProjectProposed: { type: 'project-proposed', proposer: C_ADDR, projectId: '10', title: 'Live at Elsewhere', timestamp: now - 172800 },
    uniEvProjectConfirmed: { type: 'project-confirmed', proposer: A_ADDR, projectId: '10', title: 'Live at Elsewhere', timestamp: now - 604800 },
    uniEvProjectDisputed: { type: 'project-disputed', proposer: A_ADDR, disputer: C_ADDR, projectId: '10', title: 'Live at Elsewhere', timestamp: now - 43200 },
    uniEvProjectCancelled: { type: 'project-cancelled', proposer: A_ADDR, projectId: '10', title: 'Live at Elsewhere', timestamp: now - 21600 },
    uniEvProjectTimedOut: { type: 'project-timed-out', proposer: A_ADDR, projectId: '10', title: 'Live at Elsewhere', timestamp: now - 3600 },
    uniEvRevenueDistributed: { type: 'revenue-distributed', proposer: A_ADDR, projectId: '10', title: 'Live at Elsewhere', amount: '250000000000000000', timestamp: now - 1800 },
    uniEvTransfer: { type: 'transfer', from: B_ADDR, to: C_ADDR, amount: '100000000000000000', timestamp: now - 600 },
    uniEvTip: { type: 'tip-sent', sender: B_ADDR, recipient: A_ADDR, amount: '5000000000000000', timestamp: now - 1200 },
    uniEvHandleReserved: { type: 'handle-reserved', wallet: B_ADDR, handle: 'blackmatter', timestamp: now - 3600 },
    uniEvDomainRegistered: { type: 'domain-registered', wallet: B_ADDR, domain: 'blackmatter.world', timestamp: now - 1200 },
  }

  el.innerHTML = `
    <div class="design-catalog dw-catalog-layout">
      ${renderCatalogNav(CATALOG_CATEGORIES)}
      <div class="dw-catalog-main">
      <header class="design-lead">
        <div class="design-eyebrow">praxis · living UI catalog</div>
        <h1>every component, on one page</h1>
        <p class="design-lead-sub">
          Buttons open the real modals, cards call the real render functions.
          If it looks wrong here, it looks wrong in prod. See
          <a href="/docs/design-philosophy.md" style="color:var(--accent)">docs/design-philosophy.md</a>
          and CLAUDE.md's "Design Catalog" rule.
        </p>
      </header>

      <!-- ─────────── 0 · workshop (NEW — scoped to /design) ─────────── -->
      <div id="dw-workshop-root" class="dw-workshop">
        <nav class="dw-jump" aria-label="workshop jump">
          <div class="dw-jump__inner">
            <a href="#dw-tokens">tokens</a>
            <a href="#dw-type">type</a>
            <a href="#dw-buttons">buttons</a>
            <a href="#dw-chips">chips</a>
            <a href="#dw-fields">fields</a>
            <a href="#dw-modals">modals</a>
            <a href="#dw-toasts">toasts</a>
            <a href="#dw-skeletons">skeletons</a>
            <a href="#dw-tabs">tabs</a>
            <a href="#dw-progress">progress</a>
            <a href="#dw-avatars">avatars</a>
            <a href="#dw-overlays">overlays</a>
            <a href="#dw-pagination">pagination</a>
            <a href="#dw-cards">cards</a>
            <a href="#dw-states">states</a>
          </div>
        </nav>

        <header class="dw-workshop-lead">
          <div class="dw-eyebrow">workshop · scoped to /design</div>
          <h1 class="dw-display">a quieter set of parts</h1>
          <p class="dw-lead-sub">
            Every primitive below is prefixed <code class="dw-mono">.dw-</code>
            and lives in <code class="dw-mono">/design-workshop.css</code> —
            nothing here leaks to any other page. The intent is calm, legible
            parts for musicians, playwrights, filmmakers. Nothing to prove,
            nothing to shout. Where a retired class is still carrying weight
            elsewhere, you'll see it alongside the workshop version below.
          </p>
        </header>

        <!-- ─── 0a · tokens ─── -->
        <section class="dw-section" id="dw-tokens">
          <div class="dw-section-header">
            <div class="dw-eyebrow">foundation</div>
            <h2 class="dw-title-1">tokens</h2>
            <p class="dw-lead-sub">
              A three-tone text hierarchy, three semantic accents, one
              hairline. No decorative fourth color. All values scoped
              to the catalog page.
            </p>
          </div>

          <div class="dw-block">
            <h3>surfaces</h3>
            <div class="dw-swatches">
              <div class="dw-swatch dw-swatch--bordered" style="background:var(--dw-bg);color:var(--dw-fg)">--dw-bg</div>
              <div class="dw-swatch" style="background:var(--dw-surface);color:var(--dw-fg)">--dw-surface</div>
              <div class="dw-swatch" style="background:var(--dw-surface-raised);color:var(--dw-fg)">--dw-surface-raised</div>
              <div class="dw-swatch" style="background:var(--dw-overlay);color:#fff">--dw-overlay</div>
            </div>
          </div>

          <div class="dw-block">
            <h3>text + lines</h3>
            <div class="dw-swatches">
              <div class="dw-swatch" style="background:var(--dw-fg);color:var(--dw-bg)">--dw-fg</div>
              <div class="dw-swatch" style="background:var(--dw-fg-secondary);color:var(--dw-bg)">--dw-fg-secondary</div>
              <div class="dw-swatch" style="background:var(--dw-fg-muted);color:var(--dw-bg)">--dw-fg-muted</div>
              <div class="dw-swatch dw-swatch--bordered" style="background:var(--dw-separator);color:var(--dw-fg)">--dw-separator</div>
              <div class="dw-swatch dw-swatch--bordered" style="background:var(--dw-separator-strong);color:var(--dw-fg)">--dw-separator-strong</div>
            </div>
          </div>

          <div class="dw-block">
            <h3>semantic</h3>
            <div class="dw-swatches">
              <div class="dw-swatch" style="background:var(--dw-accent);color:var(--dw-fg-on-accent)">--dw-accent</div>
              <div class="dw-swatch" style="background:var(--dw-success);color:#000">--dw-success</div>
              <div class="dw-swatch" style="background:var(--dw-warn);color:#000">--dw-warn</div>
              <div class="dw-swatch" style="background:var(--dw-danger);color:#fff">--dw-danger</div>
            </div>
          </div>

          <div class="dw-block">
            <h3>spacing · radius · motion</h3>
            <table class="dw-token-table">
              <thead><tr><th>token</th><th>value</th><th>use</th></tr></thead>
              <tbody>
                <tr><td>--dw-space-1</td><td>0.25rem</td><td>icon gap</td></tr>
                <tr><td>--dw-space-2</td><td>0.5rem</td><td>tight stack</td></tr>
                <tr><td>--dw-space-3</td><td>0.75rem</td><td>row gap</td></tr>
                <tr><td>--dw-space-4</td><td>1rem</td><td>default pad</td></tr>
                <tr><td>--dw-space-5</td><td>1.5rem</td><td>block gap</td></tr>
                <tr><td>--dw-space-6</td><td>2rem</td><td>card inset</td></tr>
                <tr><td>--dw-space-7</td><td>3rem</td><td>section gap</td></tr>
                <tr><td>--dw-space-8</td><td>4rem</td><td>page gutter</td></tr>
                <tr><td>--dw-radius-xs</td><td>4px</td><td>chips, tiny</td></tr>
                <tr><td>--dw-radius-sm</td><td>8px</td><td>inputs</td></tr>
                <tr><td>--dw-radius-md</td><td>12px</td><td>cards</td></tr>
                <tr><td>--dw-radius-lg</td><td>20px</td><td>modals, sheets</td></tr>
                <tr><td>--dw-radius-full</td><td>999px</td><td>buttons, dots</td></tr>
                <tr><td>--dw-motion-fast</td><td>120ms</td><td>hover, press</td></tr>
                <tr><td>--dw-motion-base</td><td>200ms</td><td>fade, lift</td></tr>
                <tr><td>--dw-motion-slow</td><td>320ms</td><td>sheet, dialog in</td></tr>
                <tr><td>--dw-tap</td><td>44px</td><td>min tap target</td></tr>
              </tbody>
            </table>
          </div>
        </section>

        <!-- ─── 0b · type ─── -->
        <section class="dw-section" id="dw-type">
          <div class="dw-section-header">
            <div class="dw-eyebrow">foundation</div>
            <h2 class="dw-title-1">type scale</h2>
            <p class="dw-lead-sub">
              Ported from Apple SF hierarchy, kept in rem so Dynamic
              Type works at 200% browser zoom. Numbers always tabular.
            </p>
          </div>
          <div class="dw-block">
            <div class="dw-stack">
              <div class="dw-display">the whole display · 2.75rem</div>
              <div class="dw-title-1">title 1 · 2rem · for section leads</div>
              <div class="dw-title-2">title 2 · 1.5rem · for subsections</div>
              <div class="dw-headline">headline · 1.125rem · block headings</div>
              <div class="dw-body">body · 1rem · paragraph default sits here</div>
              <div class="dw-callout">callout · 0.9375rem · emphasis within body</div>
              <div class="dw-subheadline">subheadline · 0.875rem · section meta</div>
              <div class="dw-footnote">footnote · 0.8125rem · captions, deltas</div>
              <div class="dw-caption">caption · 0.75rem · uppercase eyebrows</div>
              <div class="dw-num" style="font:var(--dw-type-title-1);letter-spacing:-0.02em">$1,247.80</div>
              <div class="dw-mono dw-footnote">0x504906571293819d40cb89573e9d974ec2851746</div>
            </div>
          </div>
        </section>

        <!-- ─── 0c · buttons ─── -->
        <section class="dw-section" id="dw-buttons">
          <div class="dw-section-header">
            <div class="dw-eyebrow">primitive</div>
            <h2 class="dw-title-1">buttons</h2>
            <p class="dw-lead-sub">
              One focal action per surface. Every variant below meets
              44pt tap and the focus-visible ring. Tab through the
              row — you should see the ring, not an outline.
            </p>
          </div>

          <div class="dw-compare">
            <div class="dw-compare__frame">
              <span class="dw-compare__label">retired</span>
              <div class="dw-row">
                <button class="vault-save-btn" style="width:auto;padding:0.75em 1.5em">primary · vault-save-btn</button>
                <button class="buy-btn">buy-btn</button>
                <button class="feed-card-btn green">feed-card-btn</button>
                <button class="vault-recv-copy"><i class="ph ph-copy"></i> ghost</button>
              </div>
            </div>
            <div class="dw-compare__frame">
              <span class="dw-compare__label dw-compare__label--workshop">workshop</span>
              <div class="dw-row">
                <button class="dw-btn dw-btn--primary">approve</button>
                <button class="dw-btn dw-btn--secondary">preview</button>
                <button class="dw-btn dw-btn--ghost">close</button>
                <button class="dw-btn dw-btn--quiet">skip</button>
                <button class="dw-btn dw-btn--danger">remove draft</button>
              </div>
            </div>
          </div>

          <div class="dw-block">
            <h3>sizes</h3>
            <div class="dw-row">
              <button class="dw-btn dw-btn--primary dw-btn--sm">small</button>
              <button class="dw-btn dw-btn--primary dw-btn--md">medium</button>
              <button class="dw-btn dw-btn--primary dw-btn--lg">large</button>
            </div>
          </div>

          <div class="dw-block">
            <h3>icon + block + states</h3>
            <div class="dw-row">
              <button class="dw-btn dw-btn--secondary dw-btn--icon" aria-label="copy">
                <i class="ph ph-copy" aria-hidden="true"></i>
              </button>
              <button class="dw-btn dw-btn--secondary dw-btn--icon dw-btn--sm" aria-label="more">
                <i class="ph ph-dots-three" aria-hidden="true"></i>
              </button>
              <button class="dw-btn dw-btn--primary" data-loading="true">approving</button>
              <button class="dw-btn dw-btn--primary" disabled>disabled</button>
            </div>
            <div class="dw-block__stage" style="margin-top:var(--dw-space-3);max-width:360px">
              <button class="dw-btn dw-btn--primary dw-btn--block dw-btn--lg">publish this post</button>
            </div>
          </div>
        </section>

        <!-- ─── 0d · chips ─── -->
        <section class="dw-section" id="dw-chips">
          <div class="dw-section-header">
            <div class="dw-eyebrow">primitive</div>
            <h2 class="dw-title-1">chips</h2>
            <p class="dw-lead-sub">
              Shape-plus-color signal — the dot carries meaning so
              color isn't the only cue.
            </p>
          </div>
          <div class="dw-block">
            <div class="dw-row">
              <span class="dw-chip"><span class="dw-chip__dot"></span>default</span>
              <span class="dw-chip dw-chip--neutral"><span class="dw-chip__dot"></span>neutral</span>
              <span class="dw-chip dw-chip--success"><span class="dw-chip__dot"></span>earned · $18.05</span>
              <span class="dw-chip dw-chip--warn"><span class="dw-chip__dot"></span>catching up</span>
              <span class="dw-chip dw-chip--danger"><span class="dw-chip__dot"></span>this didn't go through</span>
            </div>
          </div>
        </section>

        <!-- ─── 0e · fields ─── -->
        <section class="dw-section" id="dw-fields">
          <div class="dw-section-header">
            <div class="dw-eyebrow">primitive</div>
            <h2 class="dw-title-1">fields</h2>
            <p class="dw-lead-sub">
              Label stays above the input. Help sits below and reserves
              its own height, so error text never pushes the submit button.
            </p>
          </div>

          <div class="dw-block" style="max-width:420px">
            <div class="dw-stack">
              <div class="dw-field">
                <label class="dw-label" for="dw-demo-name">your name</label>
                <input class="dw-input" id="dw-demo-name" type="text" placeholder="the name your audience knows">
                <p class="dw-help">visible on your posts and your profile.</p>
              </div>
              <div class="dw-field">
                <label class="dw-label" for="dw-demo-handle">handle</label>
                <input class="dw-input" id="dw-demo-handle" type="text" value="nina" aria-invalid="true">
                <p class="dw-help dw-help--error">that handle is already taken.</p>
              </div>
              <div class="dw-field">
                <label class="dw-label" for="dw-demo-bio">bio <span class="dw-draft">draft</span></label>
                <textarea class="dw-textarea" id="dw-demo-bio" placeholder="a few lines about the work"></textarea>
                <p class="dw-help">160 characters or less.</p>
              </div>
              <div class="dw-field">
                <label class="dw-label" for="dw-demo-select">your currency</label>
                <select class="dw-select" id="dw-demo-select">
                  <option>USD</option>
                  <option>EUR</option>
                  <option>GBP</option>
                  <option>JPY</option>
                  <option>NGN</option>
                </select>
              </div>
              <div class="dw-stack" style="gap:var(--dw-space-2)">
                <label class="dw-checkbox">
                  <input type="checkbox" checked><span class="dw-checkbox__box"></span>
                  <span>email me when someone joins</span>
                </label>
                <label class="dw-checkbox">
                  <input type="checkbox"><span class="dw-checkbox__box"></span>
                  <span>also when they bookmark a post</span>
                </label>
              </div>
              <div class="dw-stack" style="gap:var(--dw-space-2)">
                <label class="dw-radio">
                  <input type="radio" name="dw-vis" checked><span class="dw-radio__box"></span>
                  <span>public</span>
                </label>
                <label class="dw-radio">
                  <input type="radio" name="dw-vis"><span class="dw-radio__box"></span>
                  <span>supporters only</span>
                </label>
              </div>
              <label class="dw-switch">
                <input type="checkbox" checked>
                <span class="dw-switch__track"><span class="dw-switch__thumb"></span></span>
                <span>Face ID before sending</span>
              </label>
              <div class="dw-row">
                <div class="dw-segmented" role="tablist" aria-label="view">
                  <button class="dw-segmented__option is-selected" role="tab" aria-selected="true">list</button>
                  <button class="dw-segmented__option" role="tab" aria-selected="false">grid</button>
                  <button class="dw-segmented__option" role="tab" aria-selected="false">graph</button>
                </div>
              </div>
            </div>
          </div>
        </section>

        <!-- ─── 0f · modals + sheets ─── -->
        <section class="dw-section" id="dw-modals">
          <div class="dw-section-header">
            <div class="dw-eyebrow">primitive</div>
            <h2 class="dw-title-1">modals, sheets, confirms</h2>
            <p class="dw-lead-sub">
              Each opens a real dw-modal with focus trap, Esc dismiss,
              body scroll lock, and an aria-labelledby binding. Below
              480px the modal docks as a bottom sheet.
            </p>
          </div>
          <div class="dw-block" id="dw-modal-openers">
            <div class="dw-row">
              <button class="dw-btn dw-btn--secondary" data-dw-open="modal"
                data-dw-title="name this draft"
                data-dw-body="you can change it later."
                data-dw-confirm="save">open modal</button>
              <button class="dw-btn dw-btn--secondary" data-dw-open="sheet"
                data-dw-title="share this post"
                data-dw-body="pick where this lands.">open sheet</button>
              <button class="dw-btn dw-btn--secondary" data-dw-open="confirm"
                data-dw-title="delete this draft"
                data-dw-body="this can't be undone.">destructive confirm</button>
            </div>
          </div>
        </section>

        <!-- ─── 0g · toasts ─── -->
        <section class="dw-section" id="dw-toasts">
          <div class="dw-section-header">
            <div class="dw-eyebrow">primitive</div>
            <h2 class="dw-title-1">toasts</h2>
            <p class="dw-lead-sub">
              Short, honest states. Default uses role=status;
              error uses role=alert so VoiceOver interrupts.
            </p>
          </div>
          <div class="dw-block" id="dw-modal-openers-toast">
            <div class="dw-row">
              <button class="dw-btn dw-btn--secondary" data-dw-open="toast"
                data-dw-text="your post was published">default</button>
              <button class="dw-btn dw-btn--secondary" data-dw-open="toast"
                data-dw-variant="success"
                data-dw-text="invite sent">success</button>
              <button class="dw-btn dw-btn--secondary" data-dw-open="toast"
                data-dw-variant="error"
                data-dw-text="this didn't go through">error</button>
              <button class="dw-btn dw-btn--secondary" data-dw-open="toast"
                data-dw-variant="message"
                data-dw-text="new message from nappynina">message</button>
            </div>
          </div>
        </section>

        <!-- ─── 0h · skeletons ─── -->
        <section class="dw-section" id="dw-skeletons">
          <div class="dw-section-header">
            <div class="dw-eyebrow">primitive</div>
            <h2 class="dw-title-1">skeletons</h2>
            <p class="dw-lead-sub">
              Reserve the final height so content doesn't push headers
              around when it lands.
            </p>
          </div>
          <div class="dw-block">
            <div class="dw-stack dw-skeleton--pulse" style="max-width:420px">
              <span class="dw-skeleton dw-skeleton--block"></span>
              <span class="dw-skeleton dw-skeleton--title"></span>
              <span class="dw-skeleton dw-skeleton-text"></span>
              <span class="dw-skeleton dw-skeleton-text"></span>
            </div>
          </div>
        </section>

        <!-- ─── 0i · tabs ─── -->
        <section class="dw-section" id="dw-tabs">
          <div class="dw-section-header">
            <div class="dw-eyebrow">primitive</div>
            <h2 class="dw-title-1">tabs</h2>
          </div>
          <div class="dw-block" id="dw-tabs-stage">
            <div class="dw-tabs" role="tablist" aria-label="catalog view">
              <button class="dw-tab is-active" role="tab" aria-selected="true">everything</button>
              <button class="dw-tab" role="tab" aria-selected="false">music</button>
              <button class="dw-tab" role="tab" aria-selected="false">writing</button>
              <button class="dw-tab" role="tab" aria-selected="false">film</button>
              <button class="dw-tab" role="tab" aria-selected="false">gallery</button>
            </div>
          </div>
        </section>

        <!-- ─── 0j · progress ─── -->
        <section class="dw-section" id="dw-progress">
          <div class="dw-section-header">
            <div class="dw-eyebrow">primitive</div>
            <h2 class="dw-title-1">progress</h2>
          </div>
          <div class="dw-block" style="max-width:420px">
            <div class="dw-stack">
              <div>
                <div class="dw-footnote" style="display:flex;justify-content:space-between;margin-bottom:var(--dw-space-1)">
                  <span class="dw-num">$720 raised</span>
                  <span class="dw-num" style="color:var(--dw-fg-secondary)">36% of $2,000</span>
                </div>
                <span class="dw-progress"><span class="dw-progress__bar dw-num" style="width:36%;background:var(--dw-success)"></span></span>
              </div>
              <div>
                <div class="dw-footnote" style="margin-bottom:var(--dw-space-1);color:var(--dw-fg-secondary)">we're catching up on new activity</div>
                <span class="dw-progress dw-progress--indeterminate"></span>
              </div>
            </div>
          </div>
        </section>

        <!-- ─── 0k · avatars ─── -->
        <section class="dw-section" id="dw-avatars">
          <div class="dw-section-header">
            <div class="dw-eyebrow">primitive</div>
            <h2 class="dw-title-1">avatars</h2>
          </div>
          <div class="dw-block">
            <div class="dw-row">
              <span class="dw-avatar dw-avatar--sm" aria-label="nina">n</span>
              <span class="dw-avatar dw-avatar--md" aria-label="miles">m</span>
              <span class="dw-avatar dw-avatar--lg" aria-label="black matter">b</span>
              <span class="dw-avatar dw-avatar--xl" aria-label="practice records">p</span>
            </div>
            <div style="margin-top:var(--dw-space-4)">
              <span class="dw-avatar-stack">
                <span class="dw-avatar dw-avatar--md">a</span>
                <span class="dw-avatar dw-avatar--md">b</span>
                <span class="dw-avatar dw-avatar--md">c</span>
                <span class="dw-avatar dw-avatar--md">d</span>
              </span>
              <span class="dw-footnote dw-num" style="margin-left:var(--dw-space-2);color:var(--dw-fg-secondary)">+12 more</span>
            </div>
          </div>
        </section>

        <!-- ─── 0l · overlays (divider, tooltip, popover, dropdown) ─── -->
        <section class="dw-section" id="dw-overlays">
          <div class="dw-section-header">
            <div class="dw-eyebrow">primitive</div>
            <h2 class="dw-title-1">overlays + separators</h2>
          </div>

          <div class="dw-block">
            <h3>divider</h3>
            <hr class="dw-divider">
            <hr class="dw-divider dw-divider--labeled" data-label="or"><div class="dw-divider dw-divider--labeled">or</div>
          </div>

          <div class="dw-block">
            <h3>tooltip</h3>
            <div class="dw-row">
              <span class="dw-tooltip" tabindex="0">
                <button class="dw-btn dw-btn--secondary dw-btn--icon" aria-label="copy address">
                  <i class="ph ph-copy" aria-hidden="true"></i>
                </button>
                <span class="dw-tooltip__bubble" role="tooltip">copy your address</span>
              </span>
            </div>
          </div>

          <div class="dw-block" style="position:relative;min-height:220px">
            <h3>popover</h3>
            <div class="dw-popover" style="position:relative;max-width:280px">
              <div class="dw-headline" style="margin-bottom:var(--dw-space-2)">why am i seeing this?</div>
              <p class="dw-footnote" style="color:var(--dw-fg-secondary);margin:0">
                this comes from someone you follow. open their profile to see more.
              </p>
            </div>
          </div>

          <div class="dw-block">
            <h3>dropdown</h3>
            <div class="dw-dropdown is-open" style="position:relative;min-height:220px">
              <button class="dw-btn dw-btn--secondary">your account</button>
              <ul class="dw-dropdown__menu" role="menu">
                <li><button class="dw-dropdown__item" role="menuitem">your portfolio</button></li>
                <li><button class="dw-dropdown__item" role="menuitem">your settings</button></li>
                <li><button class="dw-dropdown__item" role="menuitem">export your account</button></li>
                <li><button class="dw-dropdown__item dw-dropdown__item--danger" role="menuitem">sign out</button></li>
              </ul>
            </div>
          </div>
        </section>

        <!-- ─── 0m · pagination + load more ─── -->
        <section class="dw-section" id="dw-pagination">
          <div class="dw-section-header">
            <div class="dw-eyebrow">primitive</div>
            <h2 class="dw-title-1">pagination + load more</h2>
          </div>
          <div class="dw-block">
            <nav class="dw-pagination" aria-label="pagination">
              <button class="dw-pagination__page" aria-label="previous">‹</button>
              <button class="dw-pagination__page" aria-current="page">1</button>
              <button class="dw-pagination__page">2</button>
              <button class="dw-pagination__page">3</button>
              <button class="dw-pagination__page" aria-label="next">›</button>
            </nav>
          </div>
          <div class="dw-block" style="max-width:420px">
            <button class="dw-load-more">show earlier posts</button>
          </div>
        </section>

        <!-- ─── 0n · cards ─── -->
        <section class="dw-section" id="dw-cards">
          <div class="dw-section-header">
            <div class="dw-eyebrow">composite</div>
            <h2 class="dw-title-1">cards</h2>
            <p class="dw-lead-sub">
              One focal action per card. 1:1 artwork for media, 16:9
              for events. State overlays sit absolute over the artwork
              so the layout never shifts when state changes.
            </p>
          </div>

          <div class="dw-block">
            <h3>media cards + state overlays</h3>
            <div class="dw-grid-sm">
              <article class="dw-card dw-card--media">
                <div class="dw-card__artwork" style="background:linear-gradient(135deg,#2a2a2a,#111)"></div>
                <div class="dw-card__body">
                  <span class="dw-card__title">End Credits</span>
                  <span class="dw-card__meta"><span class="dw-avatar dw-avatar--sm">n</span>nappynina.com</span>
                  <span class="dw-card__price dw-num">$8.00</span>
                  <div class="dw-card__actions">
                    <button class="dw-btn dw-btn--primary dw-btn--sm dw-btn--block">collect</button>
                  </div>
                </div>
              </article>

              <article class="dw-card dw-card--media">
                <div class="dw-card__artwork" style="background:linear-gradient(135deg,#4a2a2a,#1a0a0a)">
                  <span class="dw-card__state dw-card__state--limited">
                    <span class="dw-chip__dot" aria-hidden="true"></span>only 13 left
                  </span>
                </div>
                <div class="dw-card__body">
                  <span class="dw-card__title">Live at Elsewhere</span>
                  <span class="dw-card__meta">Mar 12 · doors 8pm</span>
                  <span class="dw-card__price dw-num">$15.00</span>
                  <div class="dw-card__actions">
                    <button class="dw-btn dw-btn--primary dw-btn--sm dw-btn--block">reserve a seat</button>
                  </div>
                </div>
              </article>

              <article class="dw-card dw-card--media">
                <div class="dw-card__artwork" style="background:linear-gradient(135deg,#2a2a4a,#0a0a1a)">
                  <span class="dw-card__state dw-card__state--sold-out">
                    <span class="dw-chip__dot" aria-hidden="true"></span>sold out
                  </span>
                </div>
                <div class="dw-card__body">
                  <span class="dw-card__title">Second Line</span>
                  <span class="dw-card__meta">nappynina.com</span>
                  <span class="dw-card__price dw-num">—</span>
                  <div class="dw-card__actions">
                    <button class="dw-btn dw-btn--secondary dw-btn--sm dw-btn--block" disabled>sold out</button>
                  </div>
                </div>
              </article>

              <article class="dw-card dw-card--media dw-card--delisted">
                <div class="dw-card__artwork" style="background:linear-gradient(135deg,#333,#111)">
                  <span class="dw-card__state dw-card__state--delisted">
                    <span class="dw-chip__dot" aria-hidden="true"></span>no longer listed
                  </span>
                </div>
                <div class="dw-card__body">
                  <span class="dw-card__title">Study No. 3</span>
                  <span class="dw-card__meta">milesxb.bio</span>
                </div>
              </article>

              <article class="dw-card dw-card--media">
                <div class="dw-card__artwork" style="background:linear-gradient(135deg,#1f3a2f,#0a1a10)">
                  <span class="dw-card__state dw-card__state--gated">
                    <span class="dw-chip__dot" aria-hidden="true"></span>unlocks with ticket #12345
                  </span>
                </div>
                <div class="dw-card__body">
                  <span class="dw-card__title">Backlot · rehearsal cut</span>
                  <span class="dw-card__meta">blackmatter.world</span>
                  <div class="dw-card__actions">
                    <button class="dw-btn dw-btn--secondary dw-btn--sm dw-btn--block">unlock</button>
                  </div>
                </div>
              </article>

              <article class="dw-card dw-card--media">
                <div class="dw-card__artwork" style="background:linear-gradient(135deg,#1a1a1a,#060606)">
                  <span class="dw-card__state dw-card__state--upcoming">
                    <span class="dw-chip__dot" aria-hidden="true"></span>opens in 14 days
                  </span>
                </div>
                <div class="dw-card__body">
                  <span class="dw-card__title">A Reading of Coriolanus</span>
                  <span class="dw-card__meta">milesxb.bio</span>
                </div>
              </article>
            </div>
          </div>

          <div class="dw-block">
            <h3>event card · 16:9</h3>
            <article class="dw-card dw-card--event" style="max-width:420px">
              <div class="dw-card__artwork" style="background:linear-gradient(120deg,#7c3aed,#db2777)">
                <span class="dw-card__state dw-card__state--live">
                  <span class="dw-chip__dot" aria-hidden="true"></span>live now
                </span>
              </div>
              <div class="dw-card__body" style="gap:var(--dw-space-2)">
                <span class="dw-card__title">that guy · a short film</span>
                <span class="dw-card__meta">by <span style="color:var(--dw-accent)">milesxb.bio</span></span>
                <span class="dw-footnote" style="color:var(--dw-fg-secondary);margin-top:var(--dw-space-1)">A 16-minute cut, two takes, premiering tonight.</span>
                <div class="dw-card__actions">
                  <button class="dw-btn dw-btn--primary dw-btn--sm">watch</button>
                  <button class="dw-btn dw-btn--secondary dw-btn--sm">share</button>
                </div>
              </div>
            </article>
          </div>
        </section>

        <!-- ─── 0o · states ─── -->
        <section class="dw-section" id="dw-states">
          <div class="dw-section-header">
            <div class="dw-eyebrow">composite</div>
            <h2 class="dw-title-1">empty · error · loading</h2>
            <p class="dw-lead-sub">
              Honest states. No marketing voice, no hype. "this didn't
              go through" over a tracking code.
            </p>
          </div>
          <div class="dw-block" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:var(--dw-space-4)">
            <div class="dw-empty">
              <div class="dw-empty__title">no posts yet <span class="dw-draft">draft</span></div>
              <p class="dw-empty__body">when you publish, it lands here first.</p>
              <button class="dw-btn dw-btn--primary dw-btn--sm">start a post</button>
            </div>
            <div class="dw-error">
              <div class="dw-error__title">this didn't go through</div>
              <p class="dw-error__body">the network dropped on the way out. try again.</p>
              <button class="dw-btn dw-btn--secondary dw-btn--sm">try again</button>
            </div>
            <div class="dw-loading">
              <div class="dw-loading__title dw-headline">we're catching up</div>
              <span class="dw-progress dw-progress--indeterminate" style="max-width:220px"></span>
              <p class="dw-footnote" style="color:var(--dw-fg-secondary)">new activity should land in a moment.</p>
            </div>
          </div>
        </section>
      </div>

      <!-- ─────────── 1 · foundation ─────────── -->
      <section class="design-section">
        <h2 class="design-section-title">1 · foundation</h2>

        <div class="design-block">
          <h3>colors</h3>
          <div class="design-swatch-row">
            <div class="design-swatch" style="background:var(--bg);color:var(--fg);border:1px solid var(--border)"><span>--bg</span></div>
            <div class="design-swatch" style="background:var(--fg);color:var(--bg)"><span>--fg</span></div>
            <div class="design-swatch" style="background:var(--dim);color:var(--bg)"><span>--dim</span></div>
            <div class="design-swatch" style="background:var(--muted);color:var(--bg)"><span>--muted</span></div>
            <div class="design-swatch" style="background:var(--accent);color:var(--bg)"><span>--accent</span></div>
            <div class="design-swatch" style="background:var(--border);color:var(--fg)"><span>--border</span></div>
            <div class="design-swatch" style="background:var(--green);color:var(--bg)"><span>--green</span></div>
          </div>
        </div>

        <div class="design-block">
          <h3>typography</h3>
          <div class="design-type-row">
            <h1 style="margin:0;font-size:2em">h1 · display</h1>
            <h2 style="margin:0;font-size:1.4em">h2 · section title</h2>
            <h3 style="margin:0;font-size:1.1em">h3 · block heading</h3>
            <p style="margin:0">body text — sits at the reader's default size for the artist tenant.</p>
            <p style="margin:0;color:var(--dim);font-size:0.9em">dim — captions + secondary meta</p>
            <p style="margin:0;color:var(--muted);font-size:0.85em">muted — hint copy</p>
            <p style="margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:0.85em">monospace 0x46db55ad42da6ba3c29a3c1522ebbf8e16960725</p>
          </div>
        </div>

        <div class="design-block">
          <h3>chips + badges</h3>
          <div class="design-btn-row">
            <span class="vault-lead-chip"><span class="vault-lead-chip-key">earned</span> <span style="color:var(--green)">$18.05</span></span>
            <span class="vault-lead-chip"><span class="vault-lead-chip-key">spent</span> $24.25</span>
            <span style="padding:0.15em 0.6ch;border-radius:4px;background:color-mix(in srgb,var(--fg) 6%,transparent);color:var(--dim);font-size:0.72em;text-transform:uppercase;letter-spacing:0.12em">pill · uppercase</span>
            <span style="padding:0.15em 0.5ch;background:color-mix(in srgb,var(--green) 20%,transparent);color:var(--green);border-radius:3px;font-size:0.72em;text-transform:uppercase;letter-spacing:0.1em">badge · confirmed</span>
            <span style="padding:0.15em 0.5ch;background:color-mix(in srgb,#ef4444 20%,transparent);color:#ef4444;border-radius:3px;font-size:0.72em;text-transform:uppercase;letter-spacing:0.1em">badge · disputed</span>
          </div>
        </div>
      </section>

      <!-- ─────────── 2 · buttons + inputs ─────────── -->
      <section class="design-section">
        <h2 class="design-section-title">2 · buttons + inputs</h2>

        <div class="design-block">
          <h3>buttons</h3>
          <div class="design-btn-row">
            <button class="vault-save-btn" style="width:auto;padding:0.75em 1.5em">primary — vault-save-btn</button>
            <button class="buy-btn">buy-btn</button>
            <button class="feed-card-btn green">feed-card-btn · green (buy)</button>
            <button class="feed-card-btn">feed-card-btn · neutral</button>
            <button class="vault-verb">vault-verb</button>
            <button class="vault-recv-copy"><i class="ph ph-copy"></i> ghost · vault-recv-copy</button>
            <button class="vault-save-btn vault-save-btn-done" style="width:auto;padding:0.75em 1.5em"><i class="ph ph-check"></i> success · btn-done</button>
            <button class="vault-save-btn" disabled style="width:auto;padding:0.75em 1.5em">disabled</button>
          </div>
        </div>

        <div class="design-block">
          <h3>filter pills — /collection style</h3>
          <div class="design-btn-row">
            <button class="collection-filter collection-filter-active" data-filter="all">all</button>
            <button class="collection-filter" data-filter="saved-posts">saved posts</button>
            <button class="collection-filter" data-filter="audio">audio</button>
            <button class="collection-filter" data-filter="video">video</button>
          </div>
        </div>

        <div class="design-block">
          <h3>inputs</h3>
          <div class="design-input-row">
            <input type="text" class="project-input" placeholder="project-input" style="max-width:24ch">
            <input type="text" class="vault-save-to-input" placeholder="vault-save-to-input" style="max-width:24ch">
            <input type="text" class="vault-save-amount-input" placeholder="0.00" style="max-width:12ch">
          </div>
        </div>
      </section>

      <!-- ─────────── 3 · money modals (live openers) ─────────── -->
      <section class="design-section">
        <h2 class="design-section-title">3 · money modals</h2>
        <p style="color:var(--dim);font-size:0.9em;margin:0 0 1em">
          Each opens the LIVE modal — same function every route calls.
        </p>
        <div class="design-btn-row" id="design-modal-openers">
          <button class="buy-btn" data-open="send">send</button>
          <button class="buy-btn" data-open="receive">receive</button>
          <button class="buy-btn" data-open="save">save to BOLD →</button>
          <button class="buy-btn" data-open="funding">funding sheet</button>
          <button class="buy-btn" data-open="onramp">onramp — buy with card</button>
          <button class="buy-btn" data-open="offramp">offramp — cash out (link)</button>
        </div>

        <!-- sandbox flows — visible only when ?sandbox=1 is set on the url -->
        <div id="design-sandbox-section" style="display:none;margin-top:1.5em;padding-top:1em;border-top:1px dashed var(--border)">
          <h3 style="margin:0 0 0.3em">sandbox flows</h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.75em">
            click any flow — it opens the production modal, pointed at the local anvil fork.
            no real value changes hands. a burner wallet is minted per session and funded
            automatically. seed shown below is from <code>/api/sandbox-seed</code>.
          </p>
          <div class="design-btn-row">
            <button class="buy-btn" data-open="sandbox-fund-eth">fund project (eth)</button>
            <button class="buy-btn" data-open="sandbox-fund-erc20">fund project (erc20)</button>
            <button class="buy-btn" data-open="sandbox-buy-album">buy album</button>
            <button class="buy-btn" data-open="sandbox-collect-single">collect single</button>
            <button class="buy-btn" data-open="sandbox-propose">propose project</button>
            <button class="buy-btn" data-open="sandbox-compose-blog">compose blog post</button>
          </div>
          <pre id="design-sandbox-status" style="font-size:0.75em;color:var(--muted);background:var(--bg);padding:0.6em;border-radius:4px;margin:0.75em 0 0;white-space:pre-wrap;word-break:break-all">loading sandbox state…</pre>
        </div>

        <div class="design-block">
          <h3>cashout sheet — /cashout</h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            Real peer.xyz offramp flow — amount + platform picker + payee handle
            + quote + submit button. Open at <a href="/cashout" style="color:var(--accent)">/cashout</a>.
          </p>
          <div class="cashout-sheet" style="max-width:520px;padding:1em;background:var(--bg);border:1px solid var(--border);border-radius:12px">
            <div class="cashout-balance-line">
              <span class="cashout-balance-label">available</span>
              <span class="cashout-balance-value">50.00 USDC</span>
            </div>
            <div class="cashout-field">
              <div class="cashout-field-label">amount</div>
              <div class="cashout-amount-row">
                <span class="cashout-amount-currency">$</span>
                <input type="text" placeholder="25.00" class="cashout-amount-input" value="25">
                <span class="cashout-amount-token">USDC</span>
              </div>
            </div>
            <div class="cashout-field">
              <div class="cashout-field-label">send to</div>
              <div class="cashout-platforms">
                <button class="cashout-platform cashout-platform-active"><i class="ph ph-hand-coins"></i><span>Venmo</span></button>
                <button class="cashout-platform"><i class="ph ph-paypal-logo"></i><span>PayPal</span></button>
                <button class="cashout-platform"><i class="ph ph-dollar"></i><span>Cash App</span></button>
                <button class="cashout-platform"><i class="ph ph-bank"></i><span>Zelle</span></button>
              </div>
            </div>
            <div class="cashout-quote">
              <div class="cashout-quote-row">
                <span class="cashout-quote-label">you'll get</span>
                <span class="cashout-quote-amount">$24.85</span>
              </div>
              <div class="cashout-quote-eta">typically fills in ~4 min</div>
            </div>
            <button class="cashout-btn">cash out $24.85</button>
          </div>
        </div>
      </section>

      <!-- ─────────── 4 · feed event cards ─────────── -->
      <section class="design-section">
        <h2 class="design-section-title">4 · feed event cards</h2>
        <p style="color:var(--dim);font-size:0.9em;margin:0 0 1em">
          Every renderXCard() from public/js/feed-cards.js, rendered with
          minimal mock data + mockResolve(). These are the SAME functions
          feed.js, supporter-home.js, and network.js call on the live
          feed. If Ponder adds a new event type, its card gets a row
          here in the same commit.
        </p>

        <div class="design-block">
          <h3>universal EventCard, line</h3>
          <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.75em">
            One renderer for every protocol event — social, project lifecycle,
            economic, membership, infrastructure. Default compact row.
            Red/green tones encode disputes vs. earnings. See
            public/js/event-card.js.
          </p>
          <div style="display:flex;flex-direction:column;gap:0.5em;max-width:720px">
            ${renderCardSafely('follow', () => E.renderEventCard?.(m.uniEvFollow, { resolve: mockResolve }))}
            ${renderCardSafely('joined-audience', () => E.renderEventCard?.(m.uniEvJoined, { resolve: mockResolve }))}
            ${renderCardSafely('referral-earned', () => E.renderEventCard?.(m.uniEvReferral, { resolve: mockResolve }))}
            ${renderCardSafely('tip-sent (green tone)', () => E.renderEventCard?.(m.uniEvTip, { resolve: mockResolve }))}
            ${renderCardSafely('transfer', () => E.renderEventCard?.(m.uniEvTransfer, { resolve: mockResolve }))}
            ${renderCardSafely('handle-reserved', () => E.renderEventCard?.(m.uniEvHandleReserved, { resolve: mockResolve }))}
            ${renderCardSafely('domain-registered', () => E.renderEventCard?.(m.uniEvDomainRegistered, { resolve: mockResolve }))}
            ${renderCardSafely('project-cancelled (red tone)', () => E.renderEventCard?.(m.uniEvProjectCancelled, { resolve: mockResolve }))}
            ${renderCardSafely('project-timed-out (red tone)', () => E.renderEventCard?.(m.uniEvProjectTimedOut, { resolve: mockResolve }))}
          </div>
        </div>

        <div class="design-block">
          <h3>event line, fatter + warmer — four shapes <code class="proposed-tag">proposed</code></h3>
          <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.75em">
            Phase 10a put identity first — a 32px actor avatar, an
            optional stacked related-party avatar, a 48px media thumb
            when the event carried a poster, and a 2px tone hairline
            on the left edge. Phase 10b thickens the row into a
            tactile object: 80px min-height, 1.25rem × 1.5rem
            padding, 16px radius, 3px tone inset at 60% opacity, 40px
            avatars, 56px media thumb at 12px radius so the inner
            tile sits chunky-but-softer than the row, 1.0625rem
            phrase, 0.8125rem timestamp still at the phrase tail,
            and a 1px translateY lift on hover. The new primitive —
            a 40px rounded <strong>mode badge</strong> — fills the
            left slot for events without people or media
            (infrastructure, project admin, content milestones),
            carrying the existing Phosphor glyph in a tinted puck.
            Row shape resolves into four groups. One left-slot per
            row, one phrase, one timestamp — never a badge AND an
            avatar. See §9 of <code>design-workshop.css</code> for
            the <code>.dw-event--fat</code> + <code>.dw-event-badge</code>
            primitives; promotion into <code>event-card.js</code>
            is phase 11b.
          </p>

          <!-- ────────── group 1 — two-party events with avatars ────────── -->
          <h4 style="font:600 1rem/1.3 var(--dw-font-display);letter-spacing:var(--dw-tracking-title);margin:1.5em 0 0.4em">two-party rows — actor + related party avatars</h4>
          <p style="color:var(--muted);font-size:0.78em;margin:0 0 0.75em">
            follow, referral-earned, tip-sent. Two 40px monograms
            stacked -10px so the pair reads as a related moment, not
            two signatures. Tip inherits the green tone inset.
          </p>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:1em;max-width:980px;margin-bottom:0.75em">
            <div>
              <div style="color:var(--muted);font-size:0.72em;text-transform:lowercase;letter-spacing:0.08em;margin-bottom:0.5em;font-family:var(--dw-font-mono)"><code class="retired-tag">retired</code> live renderer</div>
              <div style="display:flex;flex-direction:column;gap:0.5em">
                ${renderCardSafely('follow', () => E.renderEventCard?.(m.uniEvFollow, { resolve: mockResolve }))}
              </div>
            </div>
            <div>
              <div style="color:var(--muted);font-size:0.72em;text-transform:lowercase;letter-spacing:0.08em;margin-bottom:0.5em;font-family:var(--dw-font-mono)"><code class="proposed-tag">proposed</code> fat + warm</div>
              <div style="display:flex;flex-direction:column;gap:0.75em">
                <a class="dw-event dw-event--fat" href="https://nappynina.com">
                  <div class="dw-event-avatars">
                    <span class="dw-event-avatar dw-event-avatar--mono-2" aria-label="blackmatter.world avatar">b<span aria-hidden="true"></span></span>
                    <span class="dw-event-avatar dw-event-avatar--mono-3" aria-label="nappynina.com avatar">n<span aria-hidden="true"></span></span>
                  </div>
                  <div class="dw-event-body">
                    <div class="dw-event-phrase">
                      <span class="dw-event-name">blackmatter.world</span>
                      <span class="dw-event-verb">followed</span>
                      <span class="dw-event-name">nappynina.com</span>
                      <time class="dw-event-time" datetime="PT1H">1h</time>
                    </div>
                  </div>
                </a>
              </div>
            </div>
          </div>
          <div style="display:flex;flex-direction:column;gap:0.75em;max-width:980px">
            <a class="dw-event dw-event--fat" href="https://blackmatter.world">
              <div class="dw-event-avatars">
                <span class="dw-event-avatar dw-event-avatar--mono-2" aria-label="blackmatter.world avatar">b</span>
                <span class="dw-event-avatar dw-event-avatar--mono-3" aria-label="nappynina.com avatar">n</span>
              </div>
              <div class="dw-event-body">
                <div class="dw-event-phrase">
                  <span class="dw-event-name">blackmatter.world</span>
                  <span class="dw-event-verb">was invited by</span>
                  <span class="dw-event-name">nappynina.com</span>
                  <time class="dw-event-time" datetime="PT12H">12h</time>
                </div>
              </div>
            </a>
            <a class="dw-event dw-event--fat dw-event--tone-green" href="https://nappynina.com">
              <div class="dw-event-avatars">
                <span class="dw-event-avatar dw-event-avatar--mono-2" aria-label="blackmatter.world avatar">b</span>
                <span class="dw-event-avatar dw-event-avatar--mono-3" aria-label="nappynina.com avatar">n</span>
              </div>
              <div class="dw-event-body">
                <div class="dw-event-phrase">
                  <span class="dw-event-name">blackmatter.world</span>
                  <span class="dw-event-verb">tipped</span>
                  <span class="dw-event-name">nappynina.com</span>
                  <span class="dw-event-amount">$0.0096</span>
                  <time class="dw-event-time" datetime="PT20M">20m</time>
                </div>
              </div>
            </a>
          </div>

          <!-- ────────── group 2 — one-party events with avatars ────────── -->
          <h4 style="font:600 1rem/1.3 var(--dw-font-display);letter-spacing:var(--dw-tracking-title);margin:1.75em 0 0.4em">one-party rows — actor avatar only</h4>
          <p style="color:var(--muted);font-size:0.78em;margin:0 0 0.75em">
            joined-audience, handle-reserved. Single 40px monogram.
            No related party, no media — the actor is the whole
            story. handle-reserved stays neutral; the handle itself
            is the strong noun.
          </p>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:1em;max-width:980px;margin-bottom:0.75em">
            <div>
              <div style="color:var(--muted);font-size:0.72em;text-transform:lowercase;letter-spacing:0.08em;margin-bottom:0.5em;font-family:var(--dw-font-mono)"><code class="retired-tag">retired</code> live renderer</div>
              <div style="display:flex;flex-direction:column;gap:0.5em">
                ${renderCardSafely('joined-audience', () => E.renderEventCard?.(m.uniEvJoined, { resolve: mockResolve }))}
              </div>
            </div>
            <div>
              <div style="color:var(--muted);font-size:0.72em;text-transform:lowercase;letter-spacing:0.08em;margin-bottom:0.5em;font-family:var(--dw-font-mono)"><code class="proposed-tag">proposed</code> fat + warm</div>
              <div style="display:flex;flex-direction:column;gap:0.75em">
                <a class="dw-event dw-event--fat" href="https://blackmatter.world">
                  <div class="dw-event-avatars">
                    <span class="dw-event-avatar dw-event-avatar--mono-2" aria-label="blackmatter.world avatar">b</span>
                  </div>
                  <div class="dw-event-body">
                    <div class="dw-event-phrase">
                      <span class="dw-event-name">blackmatter.world</span>
                      <span class="dw-event-verb">joined the network</span>
                      <time class="dw-event-time" datetime="P1D">1d</time>
                    </div>
                  </div>
                </a>
              </div>
            </div>
          </div>
          <div style="display:flex;flex-direction:column;gap:0.75em;max-width:980px">
            <a class="dw-event dw-event--fat" href="https://blackmatter.world">
              <div class="dw-event-avatars">
                <span class="dw-event-avatar dw-event-avatar--mono-2" aria-label="blackmatter.world avatar">b</span>
              </div>
              <div class="dw-event-body">
                <div class="dw-event-phrase">
                  <span class="dw-event-name">blackmatter.world</span>
                  <span class="dw-event-verb">reserved the handle</span>
                  <span class="dw-event-strong">blackmatter</span>
                  <time class="dw-event-time" datetime="PT1H">1h</time>
                </div>
              </div>
            </a>
          </div>

          <!-- ────────── group 3 — media-reference events with thumb ────────── -->
          <h4 style="font:600 1rem/1.3 var(--dw-font-display);letter-spacing:var(--dw-tracking-title);margin:1.75em 0 0.4em">media-reference rows — actor avatar + 56px thumb</h4>
          <p style="color:var(--muted);font-size:0.78em;margin:0 0 0.75em">
            collected, listed, project-proposed, project-confirmed,
            project-completing, project-completed, revenue-distributed.
            One 40px actor monogram in the left slot, a 56px square
            thumb at 12px radius on the right slot carrying the
            work's poster or the project's cover. Green tone where
            the row commemorates an earning or completion; neutral
            elsewhere.
          </p>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:1em;max-width:980px;margin-bottom:0.75em">
            <div>
              <div style="color:var(--muted);font-size:0.72em;text-transform:lowercase;letter-spacing:0.08em;margin-bottom:0.5em;font-family:var(--dw-font-mono)"><code class="retired-tag">retired</code> live renderer</div>
              <div style="display:flex;flex-direction:column;gap:0.5em">
                ${renderCardSafely('collected', () => E.renderEventCard?.({ type: 'tip-sent', sender: B_ADDR, recipient: A_ADDR, amount: '2000000000000000', timestamp: now - 1800 }, { resolve: mockResolve }))}
              </div>
            </div>
            <div>
              <div style="color:var(--muted);font-size:0.72em;text-transform:lowercase;letter-spacing:0.08em;margin-bottom:0.5em;font-family:var(--dw-font-mono)"><code class="proposed-tag">proposed</code> fat + warm</div>
              <div style="display:flex;flex-direction:column;gap:0.75em">
                <a class="dw-event dw-event--fat dw-event--tone-green" href="/art?media=1">
                  <div class="dw-event-avatars">
                    <span class="dw-event-avatar dw-event-avatar--mono-2" aria-label="blackmatter.world avatar">b</span>
                  </div>
                  <div class="dw-event-body">
                    <div class="dw-event-phrase">
                      <span class="dw-event-name">blackmatter.world</span>
                      <span class="dw-event-verb">collected</span>
                      <span class="dw-event-strong">End Credits</span>
                      <span class="dw-event-amount">$3.84</span>
                      <time class="dw-event-time" datetime="PT30M">30m</time>
                    </div>
                  </div>
                  <span class="dw-event-thumb" aria-hidden="true" style="background:linear-gradient(135deg,#2a2a2a,#111)"></span>
                </a>
              </div>
            </div>
          </div>
          <div style="display:flex;flex-direction:column;gap:0.75em;max-width:980px">
            <a class="dw-event dw-event--fat" href="/tickets">
              <div class="dw-event-avatars">
                <span class="dw-event-avatar dw-event-avatar--mono-3" aria-label="nappynina.com avatar">n</span>
              </div>
              <div class="dw-event-body">
                <div class="dw-event-phrase">
                  <span class="dw-event-name">nappynina.com</span>
                  <span class="dw-event-verb">listed a ticket for</span>
                  <span class="dw-event-strong">Live at Elsewhere</span>
                  <span class="dw-event-amount">$18.00</span>
                  <time class="dw-event-time" datetime="PT2H">2h</time>
                </div>
              </div>
              <span class="dw-event-thumb" aria-hidden="true" style="background:linear-gradient(135deg,#1a2a3a,#06101a)"></span>
            </a>
            <a class="dw-event dw-event--fat" href="/project?id=10">
              <div class="dw-event-avatars">
                <span class="dw-event-avatar dw-event-avatar--mono-1" aria-label="cedric.lens avatar">c</span>
              </div>
              <div class="dw-event-body">
                <div class="dw-event-phrase">
                  <span class="dw-event-name">cedric.lens</span>
                  <span class="dw-event-verb">proposed</span>
                  <span class="dw-event-strong">Live at Elsewhere</span>
                  <time class="dw-event-time" datetime="P2D">2d</time>
                </div>
              </div>
              <span class="dw-event-thumb" aria-hidden="true" style="background:linear-gradient(135deg,#3a2a1a,#120a04)"></span>
            </a>
            <a class="dw-event dw-event--fat dw-event--tone-green" href="/project?id=10">
              <div class="dw-event-avatars">
                <span class="dw-event-avatar dw-event-avatar--mono-3" aria-label="nappynina.com avatar">n</span>
              </div>
              <div class="dw-event-body">
                <div class="dw-event-phrase">
                  <span class="dw-event-name">nappynina.com</span>
                  <span class="dw-event-verb">confirmed</span>
                  <span class="dw-event-strong">Live at Elsewhere</span>
                  <time class="dw-event-time" datetime="P7D">7d</time>
                </div>
              </div>
              <span class="dw-event-thumb" aria-hidden="true" style="background:linear-gradient(135deg,#3a2a1a,#120a04)"></span>
            </a>
            <a class="dw-event dw-event--fat" href="/project?id=10">
              <div class="dw-event-avatars">
                <span class="dw-event-avatar dw-event-avatar--mono-3" aria-label="nappynina.com avatar">n</span>
              </div>
              <div class="dw-event-body">
                <div class="dw-event-phrase">
                  <span class="dw-event-name">nappynina.com</span>
                  <span class="dw-event-verb">'s project entering dispute window</span>
                  <span class="dw-event-strong">Live at Elsewhere</span>
                  <time class="dw-event-time" datetime="PT6H">6h</time>
                </div>
              </div>
              <span class="dw-event-thumb" aria-hidden="true" style="background:linear-gradient(135deg,#3a2a1a,#120a04)"></span>
            </a>
            <a class="dw-event dw-event--fat dw-event--tone-green" href="/project?id=10">
              <div class="dw-event-avatars">
                <span class="dw-event-avatar dw-event-avatar--mono-3" aria-label="nappynina.com avatar">n</span>
              </div>
              <div class="dw-event-body">
                <div class="dw-event-phrase">
                  <span class="dw-event-strong">Live at Elsewhere</span>
                  <span class="dw-event-verb">completed</span>
                  <span class="dw-event-amount">$2,480.00</span>
                  <time class="dw-event-time" datetime="PT3H">3h</time>
                </div>
              </div>
              <span class="dw-event-thumb" aria-hidden="true" style="background:linear-gradient(135deg,#3a2a1a,#120a04)"></span>
            </a>
            <a class="dw-event dw-event--fat dw-event--tone-green" href="/project?id=10">
              <div class="dw-event-avatars">
                <span class="dw-event-avatar dw-event-avatar--mono-3" aria-label="nappynina.com avatar">n</span>
              </div>
              <div class="dw-event-body">
                <div class="dw-event-phrase">
                  <span class="dw-event-name">nappynina.com</span>
                  <span class="dw-event-verb">distributed revenue</span>
                  <span class="dw-event-amount">$620.00</span>
                  <time class="dw-event-time" datetime="PT30M">30m</time>
                </div>
              </div>
              <span class="dw-event-thumb" aria-hidden="true" style="background:linear-gradient(135deg,#3a2a1a,#120a04)"></span>
            </a>
          </div>

          <!-- ────────── group 4 — mode-badge events ────────── -->
          <h4 style="font:600 1rem/1.3 var(--dw-font-display);letter-spacing:var(--dw-tracking-title);margin:1.75em 0 0.4em">mode-badge rows — tinted puck, no people, no media</h4>
          <p style="color:var(--muted);font-size:0.78em;margin:0 0 0.75em">
            domain-registered, project-cancelled, project-disputed,
            project-timed-out, org-site-registered, blog-posted,
            library-added, org-created. A 40px tinted circle fills
            the left slot — the Phosphor glyph the retired renderer
            already carries, puck'd into the row so these admin /
            infra events stop reading as thin admin lines. Tint
            mapping: <strong>accent</strong> for identity-registry
            moments (domain, org, org-site), <strong>neutral</strong>
            for content milestones (blog, library),
            <strong>red</strong> for cancels + disputes,
            <strong>amber</strong> for timeouts.
          </p>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:1em;max-width:980px;margin-bottom:0.75em">
            <div>
              <div style="color:var(--muted);font-size:0.72em;text-transform:lowercase;letter-spacing:0.08em;margin-bottom:0.5em;font-family:var(--dw-font-mono)"><code class="retired-tag">retired</code> live renderer</div>
              <div style="display:flex;flex-direction:column;gap:0.5em">
                ${renderCardSafely('project-cancelled', () => E.renderEventCard?.(m.uniEvProjectCancelled, { resolve: mockResolve }))}
              </div>
            </div>
            <div>
              <div style="color:var(--muted);font-size:0.72em;text-transform:lowercase;letter-spacing:0.08em;margin-bottom:0.5em;font-family:var(--dw-font-mono)"><code class="proposed-tag">proposed</code> fat + warm</div>
              <div style="display:flex;flex-direction:column;gap:0.75em">
                <a class="dw-event dw-event--fat dw-event--tone-red" href="/project?id=10">
                  <span class="dw-event-badge dw-event-badge--red"><i class="ph ph-x-circle" aria-hidden="true"></i></span>
                  <div class="dw-event-body">
                    <div class="dw-event-phrase">
                      <span class="dw-event-name">nappynina.com</span>
                      <span class="dw-event-verb">cancelled</span>
                      <span class="dw-event-strong">Live at Elsewhere</span>
                      <time class="dw-event-time" datetime="PT6H">6h</time>
                    </div>
                  </div>
                </a>
              </div>
            </div>
          </div>
          <div style="display:flex;flex-direction:column;gap:0.75em;max-width:980px">
            <a class="dw-event dw-event--fat dw-event--tone-accent" href="https://blackmatter.world">
              <span class="dw-event-badge dw-event-badge--accent"><i class="ph ph-globe" aria-hidden="true"></i></span>
              <div class="dw-event-body">
                <div class="dw-event-phrase">
                  <span class="dw-event-name">blackmatter.world</span>
                  <span class="dw-event-verb">registered</span>
                  <span class="dw-event-strong">blackmatter.world</span>
                  <time class="dw-event-time" datetime="PT20M">20m</time>
                </div>
              </div>
            </a>
            <a class="dw-event dw-event--fat dw-event--tone-red" href="/project?id=10">
              <span class="dw-event-badge dw-event-badge--red"><i class="ph ph-warning" aria-hidden="true"></i></span>
              <div class="dw-event-body">
                <div class="dw-event-phrase">
                  <span class="dw-event-name">cedric.lens</span>
                  <span class="dw-event-verb">disputed</span>
                  <span class="dw-event-strong">Live at Elsewhere</span>
                  <time class="dw-event-time" datetime="PT12H">12h</time>
                </div>
              </div>
            </a>
            <a class="dw-event dw-event--fat dw-event--tone-warn" href="/project?id=10">
              <span class="dw-event-badge dw-event-badge--amber"><i class="ph ph-clock-countdown" aria-hidden="true"></i></span>
              <div class="dw-event-body">
                <div class="dw-event-phrase">
                  <span class="dw-event-strong">Live at Elsewhere</span>
                  <span class="dw-event-verb">timed out past deadline</span>
                  <time class="dw-event-time" datetime="PT1H">1h</time>
                </div>
              </div>
            </a>
            <a class="dw-event dw-event--fat dw-event--tone-accent" href="https://practice.records">
              <span class="dw-event-badge dw-event-badge--accent"><i class="ph ph-storefront" aria-hidden="true"></i></span>
              <div class="dw-event-body">
                <div class="dw-event-phrase">
                  <span class="dw-event-strong">Practice Records</span>
                  <span class="dw-event-verb">launched a site at</span>
                  <span class="dw-event-name">practice.records</span>
                  <time class="dw-event-time" datetime="P1D">1d</time>
                </div>
              </div>
            </a>
            <a class="dw-event dw-event--fat" href="/post?id=1">
              <span class="dw-event-badge dw-event-badge--neutral"><i class="ph ph-article" aria-hidden="true"></i></span>
              <div class="dw-event-body">
                <div class="dw-event-phrase">
                  <span class="dw-event-name">nappynina.com</span>
                  <span class="dw-event-verb">published</span>
                  <span class="dw-event-strong">Notes on dispossession</span>
                  <time class="dw-event-time" datetime="PT4H">4h</time>
                </div>
              </div>
            </a>
            <a class="dw-event dw-event--fat" href="/library">
              <span class="dw-event-badge dw-event-badge--neutral"><i class="ph ph-books" aria-hidden="true"></i></span>
              <div class="dw-event-body">
                <div class="dw-event-phrase">
                  <span class="dw-event-name">blackmatter.world</span>
                  <span class="dw-event-verb">added</span>
                  <span class="dw-event-strong">The Undercommons</span>
                  <span class="dw-event-verb">to the library</span>
                  <time class="dw-event-time" datetime="PT2H">2h</time>
                </div>
              </div>
            </a>
            <a class="dw-event dw-event--fat dw-event--tone-accent" href="https://practice.records">
              <span class="dw-event-badge dw-event-badge--accent"><i class="ph ph-users-three" aria-hidden="true"></i></span>
              <div class="dw-event-body">
                <div class="dw-event-phrase">
                  <span class="dw-event-name">nappynina.com</span>
                  <span class="dw-event-verb">created</span>
                  <span class="dw-event-strong">Practice Records</span>
                  <time class="dw-event-time" datetime="P14D">14d</time>
                </div>
              </div>
            </a>
          </div>
        </div>

        <div class="design-block">
          <h3>universal EventCard, banner</h3>
          <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.75em">
            Richer rendering when the event deserves a hero — project
            lifecycle events, org-created, revenue distributions.
          </p>
          <div style="display:flex;flex-direction:column;gap:0.75em;max-width:720px">
            ${renderCardSafely('project proposed', () => E.renderEventCard?.(m.uniEvProjectProposed, { resolve: mockResolve, layout: 'banner' }))}
            ${renderCardSafely('project confirmed', () => E.renderEventCard?.(m.uniEvProjectConfirmed, { resolve: mockResolve, layout: 'banner' }))}
            ${renderCardSafely('project disputed', () => E.renderEventCard?.(m.uniEvProjectDisputed, { resolve: mockResolve, layout: 'banner' }))}
            ${renderCardSafely('revenue distributed', () => E.renderEventCard?.(m.uniEvRevenueDistributed, { resolve: mockResolve, layout: 'banner' }))}
            ${renderCardSafely('org created', () => E.renderEventCard?.(m.uniEvOrgCreated, { resolve: mockResolve, layout: 'banner' }))}
          </div>
        </div>

        <div class="design-block">
          <h3>universal EventCard, inline</h3>
          <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.75em">
            Zero-border pill meant to embed inside other cards (e.g. a
            MediaCard footer referencing a dispute event, or a project
            timeline listing recent activity).
          </p>
          <div style="display:flex;flex-wrap:wrap;gap:0.5em;max-width:720px">
            ${renderCardSafely('follow', () => E.renderEventCard?.(m.uniEvFollow, { resolve: mockResolve, layout: 'inline-reference' }))}
            ${renderCardSafely('project confirmed', () => E.renderEventCard?.(m.uniEvProjectConfirmed, { resolve: mockResolve, layout: 'inline-reference' }))}
            ${renderCardSafely('transfer', () => E.renderEventCard?.(m.uniEvTransfer, { resolve: mockResolve, layout: 'inline-reference' }))}
          </div>
        </div>

        <div class="design-block">
          <h3>project card, feed</h3>
          <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.75em">
            Feed-shaped project card still rendered by renderProjectCard in
            feed-cards.js — the funding progress bar + status pill aren't
            covered by the universal MediaCard yet. Retired byline reads
            <code>${'$'}{domain} · ${'$'}{deadline} · ${'$'}{projectType}</code> — three
            dot-separated fragments. Proposed collapses to <code>by ${'$'}{domain}</code>
            with deadline on a hairline and the type dropped.
          </p>
          <div class="design-cards-grid" style="grid-template-columns:1fr;max-width:620px">
            ${renderCardSafely('project card', () => F.renderProjectCard?.(m.projectCard, mockResolve))}
          </div>
        </div>

        <div class="design-block">
          <h3>project card, feed — side-by-side <code class="proposed-tag">proposed</code></h3>
          <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.75em">
            Same payload, hierarchy intended: title · by ${'$'}{proposer}
            · progress · hairline footnote for deadline. Project
            type drops out — the status pill is enough.
          </p>
          <div style="display:grid;grid-template-columns:1fr;gap:1em;max-width:620px">
            <div>
              <div style="color:var(--muted);font-size:0.72em;text-transform:lowercase;letter-spacing:0.08em;margin-bottom:0.5em;font-family:var(--dw-font-mono)"><code class="proposed-tag">proposed</code></div>
              <div style="border:1px solid var(--border);border-radius:6px;overflow:hidden">
                <div style="padding:1.5em 1.75em">
                  <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:0.5em;gap:1ch">
                    <span style="color:var(--fg);font-weight:500;font-size:1.2em;line-height:1.25;letter-spacing:-0.01em">Live at Elsewhere</span>
                    <span style="font-size:0.72em;color:#4ade80;flex-shrink:0;font-family:var(--dw-font-mono);letter-spacing:0.04em">funded</span>
                  </div>
                  <div style="font-size:0.825em;color:var(--dim);line-height:1.5">by <span style="color:var(--fg)">nappynina.com</span></div>
                  <div style="margin-top:1.25em">
                    <div style="background:color-mix(in srgb, var(--fg) 8%, transparent);height:6px;border-radius:3px;overflow:hidden"><div style="background:var(--green);height:100%;border-radius:3px;width:50%"></div></div>
                    <div style="font-size:0.75em;color:var(--muted);margin-top:0.5em;font-family:var(--dw-font-mono);letter-spacing:0.04em;display:flex;gap:1.5ch"><span>50% funded</span><span style="color:var(--dim)">2 days in</span></div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- ─────────── 5 · media + collection cards ─────────── -->
      <section class="design-section">
        <h2 class="design-section-title">5 · media + collection</h2>

        <div class="design-block">
          <h3>universal MediaCard, square</h3>
          <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.75em">
            Default for single-item cards — audio singles, images,
            documents, 3D, interactive, tickets, credentials. 1:1 art
            + title + meta + actions. See public/js/media-card.js.
            Workshop css drops the hex-wallet fallback row, promotes
            the title, and strips the inline price from the buy
            button (meta row carries the money). Compare the retired
            and proposed variants below.
          </p>
          <div class="design-cards-grid" style="grid-template-columns:repeat(auto-fill,minmax(240px,1fr))">
            ${renderCardSafely('audio for sale', () => U.renderMediaCard?.(m.uniAudioListed, { resolve: mockResolve, header: { kind: 'listed', actor: A_ADDR } }))}
            ${renderCardSafely('audio owned', () => U.renderMediaCard?.(m.uniAudioOwned, { resolve: mockResolve, owned: true }))}
            ${renderCardSafely('image for sale', () => U.renderMediaCard?.(m.uniImage, { resolve: mockResolve, header: { kind: 'listed', actor: C_ADDR } }))}
            ${renderCardSafely('document, free', () => U.renderMediaCard?.(m.uniPdf, { resolve: mockResolve }))}
            ${renderCardSafely('ticket, limited', () => U.renderMediaCard?.(m.uniTicket, { resolve: mockResolve, state: 'limited' }))}
            ${renderCardSafely('credential', () => U.renderMediaCard?.(m.uniCredential, { resolve: mockResolve }))}
          </div>
        </div>

        <div class="design-block">
          <h3>media card — side-by-side <code class="proposed-tag">proposed</code></h3>
          <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.75em">
            Audio listing · retired left, proposed right. Proposed
            drops the author fallback row, promotes the title to
            title-2, and runs a single-verb <code>collect</code>
            button with the price living in its one home (the meta
            row above). Same rule applies across every square /
            wide / portrait variant — the same css rules handle them.
          </p>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:1em;max-width:620px">
            <div>
              <div style="color:var(--muted);font-size:0.72em;text-transform:lowercase;letter-spacing:0.08em;margin-bottom:0.5em;font-family:var(--dw-font-mono)"><code class="retired-tag">retired</code> live renderer</div>
              <div class="design-card-frame">
                ${renderCardSafely('audio listed buy', () => U.renderMediaCard?.(m.uniAudioListed, { resolve: mockResolve, header: { kind: 'listed', actor: A_ADDR } }))}
              </div>
            </div>
            <div>
              <div style="color:var(--muted);font-size:0.72em;text-transform:lowercase;letter-spacing:0.08em;margin-bottom:0.5em;font-family:var(--dw-font-mono)"><code class="proposed-tag">proposed</code> intended hierarchy</div>
              <div class="design-card-frame">
                <div class="media-card media-card--square media-card--cat-audio" style="max-width:240px">
                  <a class="media-card-art" href="#" onclick="return false" style="background:linear-gradient(135deg,#2a2a2a,#111)"></a>
                  <div class="media-card-info">
                    <div class="media-card-header">
                      <span class="media-card-header-actor">nappynina.com</span>
                      <span class="media-card-header-verb">listed</span>
                    </div>
                    <a class="media-card-title" href="#" onclick="return false">End Credits</a>
                    <div class="media-card-meta"><span>$1.92</span></div>
                    <div class="media-card-actions">
                      <button class="feed-card-btn green">collect</button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="design-block">
          <h3>universal MediaCard, wide (video)</h3>
          <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.75em">
            16:9 artwork for video + live. This is the surface
            Miles screenshotted — hex wallet below the header,
            doubled price between meta + button, catalog h3 as
            <code>kind · value · verb</code>. Workshop css fixes
            all three for the live-renderer variant; the proposed
            side-by-side below shows the intended hierarchy.
          </p>
          <div class="design-cards-grid" style="grid-template-columns:repeat(auto-fill,minmax(320px,1fr))">
            ${renderCardSafely('video for sale', () => U.renderMediaCard?.(m.uniVideo, { resolve: mockResolve, header: { kind: 'listed', actor: B_ADDR } }))}
          </div>
        </div>

        <div class="design-block">
          <h3>video card — side-by-side <code class="proposed-tag">proposed</code></h3>
          <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.75em">
            Miles's screenshot card. Left: live renderer with the
            four issues — hex wallet, stacked identifiers, doubled
            price, dot-separator eyebrow. Right: intended
            hierarchy — title first, artist as subheadline, price
            as meta, one verb (<code>collect</code>) as the
            button. The workshop css already hides the hex row +
            doubled price on the left card; this side-by-side is
            the fully rewritten shape for Miles to sign off.
          </p>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:1em;max-width:720px">
            <div>
              <div style="color:var(--muted);font-size:0.72em;text-transform:lowercase;letter-spacing:0.08em;margin-bottom:0.5em;font-family:var(--dw-font-mono)"><code class="retired-tag">retired</code> live renderer</div>
              <div class="design-card-frame">
                ${renderCardSafely('video listed', () => U.renderMediaCard?.(m.uniVideo, { resolve: mockResolve, header: { kind: 'listed', actor: B_ADDR } }))}
              </div>
            </div>
            <div>
              <div style="color:var(--muted);font-size:0.72em;text-transform:lowercase;letter-spacing:0.08em;margin-bottom:0.5em;font-family:var(--dw-font-mono)"><code class="proposed-tag">proposed</code> intended hierarchy</div>
              <div class="design-card-frame">
                <div class="media-card media-card--wide media-card--cat-video">
                  <a class="media-card-art" href="#" onclick="return false" style="background:linear-gradient(135deg,#1a1a2a,#060612)"></a>
                  <div class="media-card-info">
                    <div class="media-card-header">
                      <span class="media-card-header-actor">blackmatter.world</span>
                      <span class="media-card-header-verb">listed</span>
                    </div>
                    <a class="media-card-title" href="#" onclick="return false">Real Tea</a>
                    <div class="media-card-meta"><span>$9.68</span></div>
                    <div class="media-card-actions">
                      <button class="feed-card-btn green">collect</button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="design-block">
          <h3>universal MediaCard, portrait</h3>
          <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.75em">2:3 artwork for book covers, chapbooks, posters, vertical video.</p>
          <div class="design-cards-grid" style="grid-template-columns:repeat(auto-fill,minmax(200px,1fr))">
            ${renderCardSafely('book cover', () => U.renderMediaCard?.(m.uniPortrait, { resolve: mockResolve, layout: 'portrait', category: 'document' }))}
          </div>
        </div>

        <div class="design-block">
          <h3>universal MediaCard, album</h3>
          <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.75em">
            Two-column: 220px art + info with play-all / buy-album +
            numbered tracklist. For image bundles the tracklist is
            replaced by a 12-cell gallery grid.
          </p>
          <div style="display:flex;flex-direction:column;gap:1em;max-width:720px">
            ${renderCardSafely('audio album', () => U.renderMediaCard?.(m.uniAlbum, { resolve: mockResolve, header: { kind: 'listed', actor: A_ADDR } }))}
            ${renderCardSafely('image gallery', () => U.renderMediaCard?.(m.uniImageAlbum, { resolve: mockResolve, header: { kind: 'posted', actor: C_ADDR } }))}
            ${renderCardSafely('bundle', () => U.renderMediaCard?.(m.uniBundle, { resolve: mockResolve, category: 'bundle', layout: 'album' }))}
          </div>
        </div>

        <div class="design-block">
          <h3>universal MediaCard, row + horizontal</h3>
          <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.75em">
            Row is the collection list-view (48px thumb, inline info).
            Horizontal is feed-collected-card's shape (120px art, text
            block right).
          </p>
          <div style="display:flex;flex-direction:column;gap:0.5em;max-width:620px">
            ${renderCardSafely('audio', () => U.renderMediaCardRow?.(m.uniAudioOwned, { resolve: mockResolve, owned: true }))}
            ${renderCardSafely('video', () => U.renderMediaCardRow?.(m.uniVideo, { resolve: mockResolve, owned: true }))}
            ${renderCardSafely('document', () => U.renderMediaCardRow?.(m.uniPdf, { resolve: mockResolve, owned: true }))}
            ${renderCardSafely('feed collected', () => U.renderMediaCardHorizontal?.(m.uniAudioOwned, { resolve: mockResolve, header: { kind: 'collected', actor: B_ADDR } }))}
          </div>
        </div>

        <div class="design-block">
          <h3>universal MediaCard, state overlays</h3>
          <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.75em">
            Every state renders as an absolute-positioned overlay over
            the artwork, never pushing layout. Delisted strikes the
            title. Gated shows the lock + a caption in the meta line.
          </p>
          <div class="design-cards-grid" style="grid-template-columns:repeat(auto-fill,minmax(220px,1fr))">
            ${renderCardSafely('upcoming', () => U.renderMediaCard?.({ ...m.uniTicket, startsAt: now + 3 * 86400 }, { resolve: mockResolve, state: 'upcoming' }))}
            ${renderCardSafely('live now', () => U.renderMediaCard?.(m.uniVideo, { resolve: mockResolve, state: 'live-now' }))}
            ${renderCardSafely('ended', () => U.renderMediaCard?.(m.uniTicket, { resolve: mockResolve, state: 'ended' }))}
            ${renderCardSafely('sold out', () => U.renderMediaCard?.(m.uniTicket, { resolve: mockResolve, state: 'sold-out' }))}
            ${renderCardSafely('limited', () => U.renderMediaCard?.(m.uniTicket, { resolve: mockResolve, state: 'limited' }))}
            ${renderCardSafely('delisted', () => U.renderMediaCard?.(m.uniAudioListed, { resolve: mockResolve, state: 'delisted' }))}
            ${renderCardSafely('gated', () => U.renderMediaCard?.(m.uniAudioListed, { resolve: mockResolve, state: 'gated', gated: { unlockBy: 'ticket #12345' } }))}
          </div>
        </div>

        <div class="design-block">
          <h3>collection album card (owned)</h3>
          <div class="design-cards-grid" style="grid-template-columns:repeat(auto-fill,minmax(220px,1fr))">
            <div class="collection-card collection-album-card collection-item" data-media-id="1" data-media-type="audio">
              <div style="background:color-mix(in srgb,var(--fg) 4%,transparent);height:150px;display:flex;align-items:center;justify-content:center"><i class="ph ph-music-notes" style="font-size:2.5em;color:var(--muted)"></i></div>
              <div style="padding:0.6em 0.8em">
                <div style="color:var(--fg);font-weight:600;font-size:0.95em">End Credits</div>
                <div style="color:var(--dim);font-size:0.8em">nappynina.com · album (5)</div>
              </div>
            </div>
            <div class="collection-card collection-item" data-media-id="2" data-media-type="video">
              <div style="background:color-mix(in srgb,var(--fg) 4%,transparent);height:150px;display:flex;align-items:center;justify-content:center"><i class="ph ph-film-strip" style="font-size:2.5em;color:var(--muted)"></i></div>
              <div style="padding:0.6em 0.8em">
                <div style="color:var(--fg);font-weight:600;font-size:0.95em">Backlot</div>
                <div style="color:var(--dim);font-size:0.8em">blackmatter.world · video</div>
              </div>
            </div>
          </div>
        </div>

        <div class="design-block">
          <h3>collection album card — side-by-side <code class="proposed-tag">proposed</code></h3>
          <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.75em">
            The retired byline reads <code>nappynina.com · album
            (5)</code> — the classic <code>kind · value</code> join
            phase 3 killed elsewhere. The thumbnail already shows
            the kind (music notes glyph), so the "album" word is
            redundant. Proposed: title · artist, with the count on
            a hairline below.
          </p>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:1em;max-width:520px">
            <div>
              <div style="color:var(--muted);font-size:0.72em;text-transform:lowercase;letter-spacing:0.08em;margin-bottom:0.5em;font-family:var(--dw-font-mono)"><code class="retired-tag">retired</code></div>
              <div class="collection-card collection-album-card collection-item">
                <div style="background:color-mix(in srgb,var(--fg) 4%,transparent);height:150px;display:flex;align-items:center;justify-content:center"><i class="ph ph-music-notes" style="font-size:2.5em;color:var(--muted)"></i></div>
                <div style="padding:0.6em 0.8em">
                  <div style="color:var(--fg);font-weight:600;font-size:0.95em">End Credits</div>
                  <div style="color:var(--dim);font-size:0.8em">nappynina.com · album (5)</div>
                </div>
              </div>
            </div>
            <div>
              <div style="color:var(--muted);font-size:0.72em;text-transform:lowercase;letter-spacing:0.08em;margin-bottom:0.5em;font-family:var(--dw-font-mono)"><code class="proposed-tag">proposed</code></div>
              <div class="collection-card collection-album-card collection-item">
                <div style="background:color-mix(in srgb,var(--fg) 4%,transparent);height:150px;display:flex;align-items:center;justify-content:center"><i class="ph ph-music-notes" style="font-size:2.5em;color:var(--muted)"></i></div>
                <div style="padding:0.6em 0.8em">
                  <div style="color:var(--fg);font-weight:500;font-size:1em;letter-spacing:-0.01em">End Credits</div>
                  <div style="color:var(--dim);font-size:0.8em;margin-top:0.1em">nappynina.com</div>
                  <div style="color:var(--muted);font-size:0.72em;margin-top:0.4em;font-family:var(--dw-font-mono);letter-spacing:0.04em">5 tracks</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="design-block">
          <h3>project summary card · portfolio strip below identity divider</h3>
          <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.75em">Wide card that renders on any tenant whose wallet is proposer or collaborator on the project. 1 or 2 per row. Poster hero + status pill · title · proposer domain + collaborators strip + deadline · blurb · funding progress. Card links to attached tenant domain if set, else /project?id=X.</p>
          <div style="display:grid;grid-template-columns:repeat(2, 1fr);gap:1.25em;max-width:820px">
            <a href="#" class="project-summary-card" style="display:flex;flex-direction:column;border:1px solid var(--border);border-radius:8px;overflow:hidden;text-decoration:none;color:inherit;background:color-mix(in srgb, var(--fg) 2%, transparent);transition:border-color 0.15s, transform 0.15s">
              <div class="project-summary-poster" style="aspect-ratio:16 / 9;background:color-mix(in srgb, var(--fg) 4%, var(--bg));position:relative;overflow:hidden">
                <span style="position:absolute;top:0.75em;left:0.75em;display:inline-flex;align-items:center;gap:0.4ch;background:rgba(0,0,0,0.55);color:#fff;font-size:0.7em;padding:0.25em 0.75ch;border-radius:99px"><i class="ph ph-clock" style="font-size:1em;color:#c0c0c0"></i>proposed</span>
              </div>
              <div style="padding:1.25em 1.5em 1.5em;display:flex;flex-direction:column;gap:0.6em">
                <h3 style="margin:0;font-size:1.15em;line-height:1.3;color:var(--fg);font-weight:600">A Reading of Coriolanus</h3>
                <div style="font-size:0.8em;color:var(--muted);display:flex;align-items:center;gap:0.4ch;flex-wrap:wrap">
                  <span>by <span style="color:var(--accent)">milesxb.bio</span></span>
                  <span style="color:var(--dim);margin-left:0.75ch">· 14 days left</span>
                </div>
                <p style="margin:0.2em 0 0;color:var(--dim);font-size:0.85em;line-height:1.55">A one-night reading of Coriolanus at a black-box space in Bushwick. Actors compensated, seats donation-only, recording archived.</p>
                <div style="margin-top:0.4em">
                  <div style="display:flex;justify-content:space-between;font-size:0.75em;color:var(--dim);margin-bottom:0.35em"><span>$720 raised</span><span>36% of $2,000</span></div>
                  <div style="background:color-mix(in srgb, var(--fg) 8%, transparent);height:6px;border-radius:3px;overflow:hidden"><div style="background:var(--green);height:100%;border-radius:3px;width:36%"></div></div>
                </div>
              </div>
            </a>
            <a href="#" class="project-summary-card" style="display:flex;flex-direction:column;border:1px solid var(--border);border-radius:8px;overflow:hidden;text-decoration:none;color:inherit;background:color-mix(in srgb, var(--fg) 2%, transparent);transition:border-color 0.15s, transform 0.15s">
              <div class="project-summary-poster" style="aspect-ratio:16 / 9;background:linear-gradient(120deg, #7c3aed, #db2777);position:relative;overflow:hidden">
                <span style="position:absolute;top:0.75em;left:0.75em;display:inline-flex;align-items:center;gap:0.4ch;background:rgba(0,0,0,0.55);color:#fff;font-size:0.7em;padding:0.25em 0.75ch;border-radius:99px"><i class="ph ph-check-circle" style="font-size:1em;color:#4ade80"></i>funded</span>
              </div>
              <div style="padding:1.25em 1.5em 1.5em;display:flex;flex-direction:column;gap:0.6em">
                <h3 style="margin:0;font-size:1.15em;line-height:1.3;color:var(--fg);font-weight:600">that guy · a short film</h3>
                <div style="font-size:0.8em;color:var(--muted);display:flex;align-items:center;gap:0.4ch;flex-wrap:wrap">
                  <span>by <span style="color:var(--accent)">milesxb.bio</span></span>
                  <span style="display:inline-flex;align-items:center;margin-left:0.75ch;padding-left:6px">
                    <span style="display:inline-flex;width:22px;height:22px;border-radius:50%;border:1px solid var(--bg);margin-left:-6px;background:var(--bg-2,#111);color:var(--muted);align-items:center;justify-content:center;font-size:0.7em">W</span>
                    <span style="display:inline-flex;width:22px;height:22px;border-radius:50%;border:1px solid var(--bg);margin-left:-6px;background:var(--bg-2,#111);color:var(--muted);align-items:center;justify-content:center;font-size:0.7em">T</span>
                    <span style="margin-left:0.5ch;font-size:0.7em;color:var(--dim)">+2</span>
                  </span>
                </div>
                <p style="margin:0.2em 0 0;color:var(--dim);font-size:0.85em;line-height:1.55">Short film about a returning veteran learning to be still. In collab with whatifwe pictures. Currently in pre-production; page hosts crew credits, trailer, screening dates.</p>
                <div style="margin-top:0.4em">
                  <div style="display:flex;justify-content:space-between;font-size:0.75em;color:var(--dim);margin-bottom:0.35em"><span>$12,400 raised</span><span>103% of $12,000</span></div>
                  <div style="background:color-mix(in srgb, var(--fg) 8%, transparent);height:6px;border-radius:3px;overflow:hidden"><div style="background:var(--green);height:100%;border-radius:3px;width:100%"></div></div>
                </div>
              </div>
            </a>
          </div>
        </div>

        <div class="design-block">
          <h3>project card · owner view with hide affordance</h3>
          <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.75em">Same wide card, but with the small "hide from my portfolio" button surfaced. Rendered only when <code>#portfolio-projects</code> carries the <code>.is-owner</code> class — set client-side after wallet connect matches <code>body.dataset.owner</code>. Click asks for confirmation, wallet-signs <code>praxis-portfolio-hide:&lt;wallet&gt;:&lt;projectId&gt;:hide:&lt;ts&gt;</code>, POSTs to <code>/api/portfolio-hide</code>, then fades the card out. Undo lives in settings → hidden projects.</p>
          <div id="portfolio-projects" class="is-populated is-owner" style="margin:0">
            <div class="portfolio-projects-grid" style="max-width:820px">
              <a href="#" class="project-summary-card" style="display:flex;flex-direction:column;border:1px solid var(--border);border-radius:8px;overflow:hidden;text-decoration:none;color:inherit;background:color-mix(in srgb, var(--fg) 2%, transparent)">
                <div class="project-summary-poster" style="aspect-ratio:16 / 9;background:linear-gradient(120deg, #7c3aed, #db2777);position:relative;overflow:hidden">
                  <span style="position:absolute;top:0.75em;left:0.75em;display:inline-flex;align-items:center;gap:0.4ch;background:rgba(0,0,0,0.55);color:#fff;font-size:0.7em;padding:0.25em 0.75ch;border-radius:99px"><i class="ph ph-check-circle" style="font-size:1em;color:#4ade80"></i>funded</span>
                  <button type="button" class="project-summary-hide-btn" style="opacity:1" aria-label="hide from my portfolio"><i class="ph ph-eye-slash"></i></button>
                </div>
                <div style="padding:1.25em 1.5em 1.5em;display:flex;flex-direction:column;gap:0.6em">
                  <h3 style="margin:0;font-size:1.15em;line-height:1.3;color:var(--fg);font-weight:600">that guy · a short film</h3>
                  <div style="font-size:0.8em;color:var(--muted)"><span>by <span style="color:var(--accent)">milesxb.bio</span></span></div>
                  <p style="margin:0.2em 0 0;color:var(--dim);font-size:0.85em;line-height:1.55">Owner sees the small eye-slash top-right of the poster — one click asks to hide.</p>
                </div>
              </a>
            </div>
          </div>
        </div>

        <div class="design-block">
          <h3>funding widget · project template hero</h3>
          <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.75em">The one baked-in module for project sites (template: 'project'). Renders as a full-bleed hero on the project's own domain (e.g. thatguythefilm.com). Server-side shell + client hydration pulls live state from Praxis.sol at load. Progress bar → tier list → fund CTA. Same on-chain state as the wide project card, sized up.</p>
          <div class="project-funding-widget" style="max-width:640px;margin:0">
            <div class="funding-hero" style="background-image:linear-gradient(120deg, #7c3aed, #db2777);aspect-ratio:16/9;position:relative;color:#fff;background-size:cover;background-position:center">
              <div class="funding-hero-fade" style="position:absolute;inset:0;background:linear-gradient(180deg, transparent 45%, rgba(0,0,0,0.72) 100%)"></div>
              <div class="funding-hero-body" style="position:absolute;left:0;right:0;bottom:0;padding:1.25rem 1.5rem;display:flex;flex-direction:column;gap:0.4rem">
                <div class="funding-status-pill" style="align-self:flex-start;font-size:0.72em;text-transform:uppercase;letter-spacing:0.12em;padding:0.2em 0.7em;border:1px solid #4ade80;color:#4ade80;border-radius:99px">funded</div>
                <h2 class="funding-title" style="font-size:1.6em;margin:0;font-weight:600;line-height:1.15;color:#fff;text-shadow:0 1px 2px rgba(0,0,0,0.4)">that guy · a short film</h2>
                <p class="funding-blurb" style="margin:0;font-size:0.95em;color:rgba(255,255,255,0.85);text-shadow:0 1px 2px rgba(0,0,0,0.4)">Short film about a returning veteran learning to be still. In collab with whatifwe pictures.</p>
              </div>
            </div>
            <div class="funding-progress-wrap" style="padding:1.25rem 1.5rem 0.75rem">
              <div class="funding-numbers" style="display:flex;align-items:baseline;gap:0.4ch;font-variant-numeric:tabular-nums;margin-bottom:0.6rem">
                <span class="funding-raised" style="font-size:1.35em;color:var(--fg);font-weight:700">$12,400</span>
                <span class="funding-of" style="color:var(--dim);font-size:0.9em">of</span>
                <span class="funding-goal" style="color:var(--muted);font-size:0.9em">$12,000</span>
                <span class="funding-pct" style="margin-left:auto;color:var(--accent);font-weight:700;font-size:1.1em">103%</span>
              </div>
              <div class="funding-bar" style="height:6px;background:color-mix(in srgb, var(--fg) 8%, transparent);border-radius:3px;overflow:hidden;margin-bottom:0.6rem"><div class="funding-bar-fill" style="width:100%;background:var(--accent);height:100%"></div></div>
              <div class="funding-meta" style="font-size:0.85em;color:var(--muted);display:flex;gap:0.6ch;align-items:center">
                <span>47 backers</span><span style="color:var(--dim)">·</span><span>funding closed</span>
              </div>
            </div>
            <div class="funding-tiers" style="display:flex;flex-direction:column;gap:0.5rem;padding:0.5rem 1.5rem 1rem">
              <div style="display:grid;grid-template-columns:1fr auto auto;gap:0.75ch;align-items:center;padding:0.75rem 1rem;border:1px solid var(--border);border-radius:8px;color:var(--fg);font-size:0.95em">
                <span style="font-weight:500">crew credit</span>
                <span style="color:var(--accent);font-weight:600">$50</span>
                <span style="color:var(--dim);font-size:0.8em">32/50 left</span>
              </div>
              <div style="display:grid;grid-template-columns:1fr auto auto;gap:0.75ch;align-items:center;padding:0.75rem 1rem;border:1px solid var(--border);border-radius:8px;color:var(--fg);font-size:0.95em">
                <span style="font-weight:500">named producer</span>
                <span style="color:var(--accent);font-weight:600">$500</span>
                <span style="color:var(--dim);font-size:0.8em">3/5 left</span>
              </div>
            </div>
            <div class="funding-cta-row" style="display:flex;gap:1rem;align-items:center;padding:0.75rem 1.5rem 1.25rem">
              <button type="button" class="buy-btn funding-cta-btn" style="flex:1;padding:0.85rem 1.5rem;font-size:1em">choose a tier</button>
              <a class="funding-detail-link" href="#" style="color:var(--muted);text-decoration:none;font-size:0.85em">view full detail →</a>
            </div>
          </div>
        </div>

        <div class="design-block">
          <h3>create organization + attach domain modal</h3>
          <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.75em">From the artist site's manage → orgs section, "create organization" now runs the full sequence: upload metadata, on-chain createOrg (signer becomes admin), extract orgId from the event, on-chain updateDomain, wallet-sign <code>praxis-org-attach:&lt;orgId&gt;:&lt;domain&gt;:&lt;ts&gt;</code>, POST /orchestrator/org-site/attach. Provisioner writes /data/artists/&lt;domain-slug&gt;/site.json with template: 'organization' + orgType + orgId + wallet. Site resolves at the attached domain after ~30s cert + Traefik regen.</p>
          <div class="praxis-modal-dialog" style="position:static;box-shadow:0 8px 30px rgba(0,0,0,0.3);max-width:520px;margin:0">
            <h3 style="margin:0 0 0.5em;font-size:1.05em">create organization</h3>
            <p style="color:var(--muted);font-size:0.85em;margin:0 0 1em">Sign the on-chain create + link the domain in one flow. The site provisions on our infrastructure.</p>
            <label style="font-size:0.8em;color:var(--muted)">name</label>
            <input type="text" class="project-input" placeholder="e.g. whatifwe pictures" style="width:100%;box-sizing:border-box;margin:0.25em 0 0.75em">
            <label style="font-size:0.8em;color:var(--muted)">type</label>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.5em;margin:0.4em 0 0.75em">
              <div class="template-card" style="padding:0.5em 0.75em"><span class="template-card-name" style="font-size:0.85em">collective</span><span class="template-card-desc" style="font-size:0.7em">shared practice</span></div>
              <div class="template-card" style="padding:0.5em 0.75em"><span class="template-card-name" style="font-size:0.85em">label</span><span class="template-card-desc" style="font-size:0.7em">roster + catalog</span></div>
              <div class="template-card" style="padding:0.5em 0.75em"><span class="template-card-name" style="font-size:0.85em">gallery</span><span class="template-card-desc" style="font-size:0.7em">exhibitions</span></div>
              <div class="template-card active" style="padding:0.5em 0.75em"><span class="template-card-name" style="font-size:0.85em">company</span><span class="template-card-desc" style="font-size:0.7em">productions, cast/crew</span></div>
            </div>
            <label style="font-size:0.8em;color:var(--muted)">domain</label>
            <div style="display:flex;gap:0;border-bottom:1px solid var(--border);margin:0.4em 0 0.5em">
              <span style="color:var(--fg);font-size:0.85em;padding:0.4em 1ch;border-bottom:2px solid var(--accent);margin-bottom:-1px">use a domain I own</span>
              <span style="color:var(--muted);font-size:0.85em;padding:0.4em 1ch">buy a new one</span>
            </div>
            <p style="color:var(--muted);font-size:0.75em;margin:0 0 0.5em">Point A record at <code style="background:color-mix(in srgb, var(--fg) 8%, transparent);padding:0.1em 0.4ch;border-radius:3px">5.161.199.120</code>, then paste.</p>
            <input type="text" class="project-input" placeholder="whatifwe.nyc" style="width:100%;box-sizing:border-box">
            <div style="display:flex;gap:0.5em;margin-top:1em">
              <button class="buy-btn" style="flex:1;font-size:0.85em;padding:0.5em">create + attach</button>
              <button class="buy-btn" style="flex:0 0 auto;font-size:0.85em;padding:0.5em 1.25ch;border-color:var(--dim);color:var(--dim)">cancel</button>
            </div>
          </div>
        </div>

        <div class="design-block">
          <h3>attach a domain modal · project site provisioning</h3>
          <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.75em">Opens from /project/:id when the proposer clicks "attach a domain". Two-tab modal — BYO (point A record then paste) or Buy (NameSilo search + contact form). Proposer wallet-signs the shape <code>praxis-project-attach:&lt;projectId&gt;:&lt;domain&gt;:&lt;ts&gt;</code>; orchestrator verifies against Praxis.getProjectProposer, provisions the tenant, inserts the project_site row.</p>
          <div class="project-attach-modal" style="max-width:520px;margin:0;position:static;transform:none;box-shadow:0 8px 30px rgba(0,0,0,0.3)">
            <h2 class="project-attach-title" style="margin:0 0 0.5em">attach a domain to <span style="color:var(--accent)">that guy · a short film</span></h2>
            <p class="project-attach-lede" style="margin:0 0 1.25em">The domain becomes this project's home — funding widget as hero, optional modules stack below, wallet-signed edits by the proposer. Nothing changes on Ethereum.</p>
            <div class="project-attach-tabs">
              <button class="project-attach-tab active">use a domain I own</button>
              <button class="project-attach-tab">buy a new domain</button>
            </div>
            <p class="project-attach-help">Point an A record for your domain at <code>5.161.199.120</code>, wait a minute for DNS to propagate, then paste the domain below.</p>
            <div class="project-attach-form">
              <input type="text" class="project-input" placeholder="thatguythefilm.com" style="min-width:0">
              <button class="buy-btn">attach</button>
            </div>
            <p class="project-attach-status" style="color:var(--muted);font-size:0.85em">will verify DNS + provision on submit.</p>
          </div>
        </div>

        <div class="design-block">
          <h3>project template · minimal chrome</h3>
          <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.75em">A project site's shell (template: 'project'). Subtle top bar with domain + praxis menu, no dock, no sidebar. Footer credits Praxis and links back to the on-chain project detail page. The funding widget is the entire homepage hero; modules stack below.</p>
          <div style="border:1px solid var(--border);border-radius:8px;overflow:hidden;background:var(--bg);max-width:640px">
            <div style="display:flex;align-items:center;justify-content:space-between;padding:0.75rem 1.25rem;border-bottom:1px solid var(--border);gap:1rem">
              <span style="color:var(--fg);font-size:0.85em;opacity:0.7">thatguythefilm.com</span>
              <span style="color:var(--muted);font-size:0.85em">⊙</span>
            </div>
            <div style="padding:1.25rem 1.5rem;color:var(--muted);font-size:0.85em;text-align:center">funding widget here (hero)</div>
            <div style="padding:0 1.5rem 1.5rem;color:var(--dim);font-size:0.75em;text-align:center;border-top:1px dashed var(--border);padding-top:1rem;margin-top:0.5rem">optional modules — trailer, gallery, credits, journal…</div>
            <div style="text-align:center;padding:1rem;color:var(--dim);font-size:0.8em;border-top:1px solid var(--border)">a praxis project · project detail →</div>
          </div>
        </div>

        <div class="design-block">
          <h3>publish to org panel · media detail owner-only affordance</h3>
          <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.75em">Rendered on /art?media=X for the media's on-chain artist. Fetches /api/orgs/by-member/&lt;wallet&gt;, then multicalls <code>isWorkTagged(orgId, mediaContract, mediaId)</code> for each. Toggling calls <code>Praxis.tagWork</code> / <code>untagWork</code>. Panel self-hides for non-owners or wallets without orgs. This is the UI that lets a member curate an org's catalog — the org catalog endpoint is explicit-tag-only, so this is how work gets published to whatifwe pictures, lucidhaus, etc.</p>
          <div class="publish-to-org" style="max-width:520px">
            <div class="publish-to-org-title">publish to</div>
            <div class="publish-to-org-hint">show this work in an organization's catalog. only the on-chain owner (you) can publish.</div>
            <div class="publish-to-org-list">
              <label class="publish-to-org-row">
                <input type="checkbox" class="publish-to-org-toggle" checked>
                <span class="publish-to-org-name">whatifwe pictures</span>
                <a href="#" class="publish-to-org-domain">whatifwe.nyc</a>
              </label>
              <label class="publish-to-org-row">
                <input type="checkbox" class="publish-to-org-toggle">
                <span class="publish-to-org-name">lucidhaus</span>
                <a href="#" class="publish-to-org-domain">lucid.haus</a>
              </label>
            </div>
            <p class="publish-to-org-status" style="color:var(--accent)">published ✓</p>
          </div>
        </div>

        <div class="design-block">
          <h3>library item</h3>
          <div class="library-item" style="cursor:pointer;max-width:520px">
            <div class="library-item-header">
              <span class="library-item-title">The Practice of Everyday Life</span>
              <span class="library-item-date">Sep 8</span>
            </div>
            <div class="library-item-meta">
              <span class="library-item-author">Michel de Certeau</span>
              <span class="library-item-contributor">added by <a>miles</a></span>
            </div>
            <div class="library-item-tags">
              <span class="library-tag">theory</span>
              <span class="library-tag">reading</span>
            </div>
          </div>
        </div>

        <div class="design-block">
          <h3>library item · side-by-side <code class="proposed-tag">proposed</code></h3>
          <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.75em">
            Retired card renders two attribution rows — the
            author and the contributor — competing for the same
            tier. Proposed: one byline (<code>by X · added by
            Y</code>), tags demoted to a mono hairline.
          </p>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:1em;max-width:720px">
            <div>
              <div style="color:var(--muted);font-size:0.72em;text-transform:lowercase;letter-spacing:0.08em;margin-bottom:0.5em;font-family:var(--dw-font-mono)"><code class="retired-tag">retired</code></div>
              <div class="library-item" style="cursor:pointer">
                <div class="library-item-header">
                  <span class="library-item-title">The Practice of Everyday Life</span>
                  <span class="library-item-date">Sep 8</span>
                </div>
                <div class="library-item-meta">
                  <span class="library-item-author">Michel de Certeau</span>
                  <span class="library-item-contributor">added by <a>miles</a></span>
                </div>
                <div class="library-item-tags">
                  <span class="library-tag">theory</span>
                  <span class="library-tag">reading</span>
                </div>
              </div>
            </div>
            <div>
              <div style="color:var(--muted);font-size:0.72em;text-transform:lowercase;letter-spacing:0.08em;margin-bottom:0.5em;font-family:var(--dw-font-mono)"><code class="proposed-tag">proposed</code></div>
              <div class="library-item" style="cursor:pointer">
                <div style="color:var(--fg);font-weight:500;font-size:1em;letter-spacing:-0.01em;line-height:1.3">The Practice of Everyday Life</div>
                <div style="color:var(--dim);font-size:0.825em;margin-top:0.2em">Michel de Certeau</div>
                <div style="color:var(--muted);font-size:0.75em;margin-top:0.5em;font-family:var(--dw-font-mono);letter-spacing:0.04em">added by miles · sep 8 · theory, reading</div>
              </div>
            </div>
          </div>
        </div>

        <div class="design-block">
          <h3>library — rights attestation checkbox</h3>
          <label style="display:flex;gap:0.6ch;align-items:flex-start;color:var(--muted);font-size:0.85em;line-height:1.4;cursor:pointer;max-width:520px">
            <input type="checkbox" style="margin-top:0.25em;flex-shrink:0">
            <span>i have the right to share this — i created it, it's in the public domain, it's under a permissive license, or i have the author's permission. i understand that copyrighted material posted without authorization will be removed. <a href="/dmca" target="_blank" style="color:var(--dim)">policy</a></span>
          </label>
        </div>

        <div class="design-block">
          <h3>works card · publish to organization affordance (owner-only)</h3>
          <div style="border:1px solid var(--border);padding:1em;max-width:520px;position:relative">
            <div style="display:flex;gap:1em;align-items:flex-start">
              <div style="width:96px;height:96px;background:var(--surface);border:1px solid var(--border);flex-shrink:0"></div>
              <div style="flex:1">
                <div style="color:var(--fg);font-weight:600;margin-bottom:0.3em">Tunnel Vision</div>
                <div style="color:var(--muted);font-size:0.85em;margin-bottom:0.6em">$1.35 · 3 minted</div>
                <div style="display:flex;gap:0.4em;align-items:center;position:relative">
                  <button class="feed-card-btn green" style="font-size:0.8em;padding:0.3em 1ch">buy</button>
                  <button style="background:none;border:1px solid var(--border);color:var(--dim);font-family:inherit;font-size:0.75em;padding:0.2em 0.8ch;cursor:pointer;border-radius:2px">in 1 org</button>
                </div>
              </div>
            </div>
            <div style="margin-top:1em;background:var(--bg,#0a0a0a);border:1px solid var(--border);padding:0.5em 0.6em;max-width:280px">
              <p style="font-size:0.7em;color:var(--muted);margin:0 0 0.4em;text-transform:uppercase;letter-spacing:0.05em">publish to organization</p>
              <label style="display:flex;align-items:center;gap:0.5em;padding:0.3em 0;font-size:0.85em;color:var(--fg)">
                <input type="checkbox" checked>
                <span>lucidhaus</span>
              </label>
              <label style="display:flex;align-items:center;gap:0.5em;padding:0.3em 0;font-size:0.85em;color:var(--fg)">
                <input type="checkbox">
                <span>whatifwe pictures</span>
              </label>
            </div>
          </div>
        </div>

        <div class="design-block">
          <h3>inline organization admin card · settings /notifications</h3>
          <div style="border:1px solid var(--border);padding:1em;max-width:520px">
            <div style="display:flex;justify-content:space-between;align-items:baseline;gap:0.5em;margin-bottom:0.4em">
              <a style="color:var(--accent);text-decoration:none;font-size:1em;font-weight:500">lucid.haus</a>
              <span style="font-size:0.7em;color:var(--dim);border:1px solid var(--border);padding:0.1em 0.5ch;border-radius:3px">admin</span>
            </div>
            <p style="font-size:0.8em;color:var(--muted);margin:0 0 0.5em">3 members · you are the admin</p>
            <a style="color:var(--muted);font-size:0.85em">manage organization →</a>
            <div style="margin-top:1em">
              <p style="font-size:0.75em;color:var(--muted);margin:0 0 0.4em;text-transform:uppercase;letter-spacing:0.05em">pending invites</p>
              <div>
                <div style="display:flex;justify-content:space-between;align-items:center;padding:0.4em 0;border-bottom:1px solid var(--border)">
                  <span style="font-size:0.9em;color:var(--fg)">milesxb.bio</span>
                  <button style="background:none;border:1px solid var(--border);color:var(--dim);font-family:inherit;font-size:0.75em;padding:0.2em 0.8ch;cursor:pointer">revoke</button>
                </div>
              </div>
            </div>
            <div style="margin-top:1em">
              <p style="font-size:0.75em;color:var(--muted);margin:0 0 0.4em;text-transform:uppercase;letter-spacing:0.05em">invite an artist</p>
              <div style="display:flex;gap:0.5em;align-items:flex-start">
                <div style="position:relative;flex:1">
                  <input type="text" class="project-input" placeholder="domain (e.g. milesxb.bio) or 0x wallet" style="width:100%;box-sizing:border-box;font-size:0.85em">
                </div>
                <button class="buy-btn" style="font-size:0.85em;padding:0.4em 1.5ch;white-space:nowrap">invite</button>
              </div>
              <p style="font-size:0.75em;color:var(--dim);margin:0.5em 0 0;line-height:1.5">the artist has to accept from their own site's settings before they show up as a member. typeahead pulls matching domains as they type.</p>
            </div>
          </div>
        </div>

        <div class="design-block">
          <h3>org invite confirmation modal · notifications tap → this modal, not straight to a signature</h3>
          <div style="border:1px solid var(--border);padding:1.2em;max-width:440px">
            <div style="display:flex;gap:0.9em;align-items:center;margin-bottom:0.9em">
              <div style="width:44px;height:44px;flex-shrink:0;border:1px solid var(--border);display:flex;align-items:center;justify-content:center;background:var(--bg-2,#111);color:var(--muted);font-size:1.4em">⊕</div>
              <div style="flex:1;min-width:0">
                <div style="font-size:0.75em;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:0.15em">invitation to join</div>
                <div style="font-size:1em;color:var(--fg);font-weight:500">lucidhaus</div>
              </div>
            </div>
            <h3 style="margin:0 0 0.5em;font-size:1em">join this organization?</h3>
            <p style="font-size:0.85em;color:var(--muted);margin:0 0 1em;line-height:1.55">joining <strong>lucidhaus</strong> adds it to your profile as an organization you're part of. the admin can invite or remove members at any time — you can leave whenever you want. this signs one small transaction on Ethereum.</p>
            <div style="display:flex;gap:0.5em">
              <button class="buy-btn" style="flex:1;font-size:0.85em;padding:0.55em">join organization</button>
              <button class="buy-btn" style="flex:1;font-size:0.85em;padding:0.55em;border-color:var(--dim);color:var(--dim)">cancel</button>
            </div>
          </div>
        </div>

        <div class="design-block">
          <h3>ticket pass (mini) · full page at /ticket</h3>
          <article class="ticket-pass" style="max-width:340px">
            <header class="ticket-pass-head">
              <div class="ticket-pass-eyebrow">artist.example</div>
              <h1 class="ticket-pass-title" style="font-size:1.35em">Backlot · release show</h1>
            </header>
            <div class="ticket-pass-fields">
              <div class="ticket-pass-field">
                <div class="ticket-pass-field-label">when</div>
                <div class="ticket-pass-field-value">Fri Sep 12 · 8:00 PM</div>
              </div>
              <div class="ticket-pass-field">
                <div class="ticket-pass-field-label">tier</div>
                <div class="ticket-pass-field-value">GA</div>
              </div>
              <div class="ticket-pass-field ticket-pass-field-wide">
                <div class="ticket-pass-field-label">where</div>
                <div class="ticket-pass-field-value">Elsewhere · Zone 2</div>
              </div>
            </div>
            <div class="ticket-pass-perforation" aria-hidden="true">
              <span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span>
            </div>
            <div class="ticket-pass-code">
              <div class="ticket-pass-qr" id="design-ticket-qr-slot"></div>
              <div class="ticket-pass-serial">
                <span class="ticket-pass-field-label">ticket</span>
                <span class="ticket-pass-field-value">#42</span>
              </div>
            </div>
          </article>
        </div>
      </section>

      <!-- ─────────── 6 · vault surfaces ─────────── -->
      <section class="design-section">
        <h2 class="design-section-title">6 · vault surfaces</h2>

        <div class="design-block">
          <h3>vault total + verbs</h3>
          <div class="vault-doc" style="max-width:520px">
            <section class="vault-lead">
              <div class="vault-lead-label">total balance</div>
              <button type="button" class="vault-lead-toggle" aria-expanded="false">
                <span class="vault-lead-value">$59.24</span>
                <span class="vault-lead-caret">▾</span>
              </button>
              <div class="vault-lead-meta">
                <span class="vault-lead-chip"><span class="vault-lead-chip-key">earned</span> <span style="color:var(--green)">$18.05</span></span>
                <span class="vault-lead-chip"><span class="vault-lead-chip-key">spent</span> $24.25</span>
              </div>
              <div class="vault-lead-verbs">
                <button class="vault-verb">send</button>
                <button class="vault-verb">receive</button>
                <button class="vault-verb">add funds</button>
                <button class="vault-verb">cash out</button>
              </div>
            </section>
          </div>
        </div>

        <div class="design-block">
          <h3>activity rows (positive + negative)</h3>
          <div class="vault-history vault-history-inline" style="max-width:520px">
            <div class="vault-tx">
              <div class="vault-tx-icon" style="color:var(--green)"><i class="ph ph-music-note"></i></div>
              <div class="vault-tx-body">
                <span class="vault-tx-label">media sale</span>
                <span class="vault-tx-detail">End Credits</span>
              </div>
              <div class="vault-tx-right">
                <span class="vault-tx-amount" style="color:var(--green)">+$1.29</span>
                <span class="vault-tx-time">3d ago</span>
              </div>
            </div>
            <div class="vault-tx">
              <div class="vault-tx-icon" style="color:var(--muted)"><i class="ph ph-shopping-cart"></i></div>
              <div class="vault-tx-body">
                <span class="vault-tx-label">collected</span>
                <span class="vault-tx-detail">Backlot</span>
              </div>
              <div class="vault-tx-right">
                <span class="vault-tx-amount" style="color:var(--muted)">-$4.75</span>
                <span class="vault-tx-time">1w ago</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- ─────────── 7 · navigation ─────────── -->
      <section class="design-section">
        <h2 class="design-section-title">7 · navigation</h2>

        <div class="design-block">
          <h3>wallet dropdown (owner view)</h3>
          <div style="max-width:280px;background:var(--bg);border:1px solid var(--border);border-radius:12px;padding:0.5em;display:flex;flex-direction:column;gap:0.15em">
            <div style="padding:0.6em 0.85em">
              <div style="color:var(--dim);font-size:0.7em;letter-spacing:0.14em;text-transform:uppercase">hi, artist</div>
              <div style="color:var(--fg);font-weight:600">artist.example</div>
            </div>
            <div style="height:1px;background:var(--border);margin:0.15em 0"></div>
            <a class="dd-nav-btn"><i class="ph ph-house"></i> praxis</a>
            <a class="dd-nav-btn"><i class="ph ph-vault"></i> vault</a>
            <button class="dd-nav-btn"><i class="ph ph-gear"></i> manage</button>
            <div style="height:1px;background:var(--border);margin:0.15em 0"></div>
            <button class="dd-nav-btn"><i class="ph ph-sign-out"></i> sign out</button>
          </div>
        </div>

        <div class="design-block">
          <h3>hub tab strip</h3>
          <nav style="display:flex;gap:0.5em;flex-wrap:wrap">
            <a class="tab-btn tab-btn-active">network</a>
            <a class="tab-btn">projects</a>
            <a class="tab-btn">library</a>
          </nav>
        </div>

        <div class="design-block">
          <h3>artist site nav (live) — portfolio-nav</h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">The same markup build.js emits from <code>buildPortfolioNav()</code>, wrapped in <code>.portfolio-nav</code> so it inherits the production stylesheet. Click any link to cycle the active state — <code>href</code>s are hijacked locally to keep you on /design.</p>
          <nav class="portfolio-nav design-dock-live" data-dock-kind="artist">
            <a href="javascript:void(0)" class="dd-active">music</a>
            <a href="javascript:void(0)">writing</a>
            <a href="javascript:void(0)">film</a>
            <a href="javascript:void(0)">credits</a>
            <a href="javascript:void(0)">library</a>
            <a href="javascript:void(0)">blog</a>
          </nav>
        </div>

        <div class="design-block">
          <h3>org site nav (live) — slim portfolio-nav (#140)</h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">Orgs land on a slimmer surface — fewer modules until an admin turns them on. Click to cycle active state.</p>
          <nav class="portfolio-nav design-dock-live" data-dock-kind="org">
            <a href="javascript:void(0)" class="dd-active">greeting</a>
            <a href="javascript:void(0)">projects</a>
            <a href="javascript:void(0)">vault</a>
            <a href="javascript:void(0)">blog</a>
          </nav>
        </div>

        <div class="design-block">
          <h3>mobile menu drawer (slide-in sheet)</h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">The real markup from <code>templates/*/layout.html</code> — the drawer artists see on mobile. Click &ldquo;open drawer&rdquo; to toggle it; click outside or any item to close.</p>
          <button type="button" class="design-drawer-toggle" style="padding:0.5em 1em;border:1px solid var(--border);background:transparent;color:var(--fg);border-radius:6px;cursor:pointer">open drawer</button>
          <div class="design-drawer-wrap" style="position:relative;margin-top:0.75em;height:360px;border:1px solid var(--border);border-radius:8px;overflow:hidden;background:color-mix(in srgb,var(--fg) 2%,transparent)">
            <div class="design-drawer-overlay" style="position:absolute;inset:0;background:rgba(0,0,0,0.35);opacity:0;transition:opacity 180ms;pointer-events:none"></div>
            <div class="design-drawer-sheet" style="position:absolute;top:0;right:0;bottom:0;width:72%;max-width:280px;background:var(--bg);border-left:1px solid var(--border);padding:1em;overflow-y:auto;transform:translateX(100%);transition:transform 220ms">
              <div class="mobile-menu-section-title">portfolio</div>
              <a class="mobile-menu-item" href="javascript:void(0)">music</a>
              <a class="mobile-menu-item" href="javascript:void(0)">writing</a>
              <div class="mobile-menu-section-title" style="margin-top:0.75em">praxis</div>
              <a class="mobile-menu-item" href="javascript:void(0)">network</a>
              <a class="mobile-menu-item" href="javascript:void(0)">projects</a>
              <a class="mobile-menu-item" href="javascript:void(0)">library</a>
              <div class="mobile-menu-section-title" style="margin-top:0.75em">account</div>
              <a class="mobile-menu-item" href="javascript:void(0)">manage</a>
              <a class="mobile-menu-item" href="javascript:void(0)">notifications</a>
              <div class="mobile-menu-section-title" style="margin-top:0.75em">wallet</div>
              <a class="mobile-menu-item" href="javascript:void(0)">vault</a>
              <button class="mobile-menu-item" type="button">add funds</button>
              <button class="mobile-menu-item" type="button">send</button>
              <button class="mobile-menu-item" type="button">cash out</button>
            </div>
          </div>
        </div>
      </section>
      <style>
        /* portfolio-nav has no built-in active-state style; give the catalog
           cycler a visible cue so demos read as interactive. */
        .design-dock-live a.dd-active { color: var(--accent); }
      </style>
      <script>
      (function(){
        // Active-state cycler for the two live portfolio-navs in the catalog.
        document.querySelectorAll('.design-dock-live').forEach(function(nav){
          nav.addEventListener('click', function(e){
            var a = e.target.closest('a')
            if (!a || !nav.contains(a)) return
            nav.querySelectorAll('a').forEach(function(n){ n.classList.remove('dd-active') })
            a.classList.add('dd-active')
          })
        })
        // Drawer slide-in/out for the mobile menu catalog block.
        document.querySelectorAll('.design-drawer-toggle').forEach(function(btn){
          var wrap = btn.parentElement.querySelector('.design-drawer-wrap')
          if (!wrap) return
          var sheet = wrap.querySelector('.design-drawer-sheet')
          var overlay = wrap.querySelector('.design-drawer-overlay')
          function open(){
            sheet.style.transform = 'translateX(0)'
            overlay.style.opacity = '1'; overlay.style.pointerEvents = 'auto'
          }
          function close(){
            sheet.style.transform = 'translateX(100%)'
            overlay.style.opacity = '0'; overlay.style.pointerEvents = 'none'
          }
          btn.addEventListener('click', open)
          overlay.addEventListener('click', close)
          sheet.querySelectorAll('a,button').forEach(function(el){ el.addEventListener('click', close) })
        })
      })()
      </script>

      <!-- ─────────── 8 · media playback ─────────── -->
      <section class="design-section">
        <h2 class="design-section-title">8 · media playback</h2>
        <div class="design-block">
          <h3>track play button</h3>
          <div style="display:flex;gap:1.5em;align-items:center">
            <button class="track-play-btn" data-track-src="/api/ipfs-proxy/QmFake" data-track-title="Untitled" data-track-artist="artist">play</button>
            <span style="color:var(--dim);font-size:0.9em">click to test the persistent player pipeline</span>
          </div>
        </div>
        <div class="design-block">
          <h3>queue row (mock)</h3>
          <div style="max-width:400px;background:color-mix(in srgb,var(--fg) 3%,transparent);border-radius:8px;overflow:hidden">
            <div class="gp-queue-item" data-idx="0" style="display:flex;align-items:center;gap:0.75ch;padding:0.5em 1em;cursor:pointer;border-left:2px solid var(--accent);background:var(--surface,#111)">
              <i class="ph ph-music-note" style="font-size:1.2em;color:var(--dim);width:36px;text-align:center;flex-shrink:0"></i>
              <div style="flex:1;min-width:0;overflow:hidden">
                <div class="gp-queue-title" style="color:var(--accent);font-size:0.85em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">Now Playing</div>
                <div class="gp-queue-artist" style="color:var(--dim);font-size:0.75em">nappy nina</div>
              </div>
              <button class="gp-queue-rm" data-idx="0" style="background:none;border:none;color:var(--dim);cursor:pointer;font-size:0.9em">&times;</button>
            </div>
          </div>
        </div>
      </section>

      <!-- ─────────── 9 · status states ─────────── -->
      <section class="design-section">
        <h2 class="design-section-title">9 · status states</h2>
        <div class="design-block">
          <h3>loader</h3>
          <span class="praxis-loader"></span>
        </div>
        <div class="design-block">
          <h3>empty</h3>
          <p style="color:var(--muted)">no items in your collection yet</p>
        </div>
        <div class="design-block">
          <h3>error</h3>
          <p style="color:var(--muted)">failed to load — try again in a moment</p>
        </div>
      </section>

      <!-- ─────────── 10 · organizations ─────────── -->
      <section class="design-section">
        <h2 class="design-section-title">10 · organizations</h2>
        <p style="color:var(--dim);font-size:0.9em;margin:0 0 1em">
          The full day-1 org story — from "spin up a shared account" to the
          chrome that marks a site as an org and the actions that flow through
          the shared account.
        </p>

        <div class="design-btn-row" id="design-org-openers">
          <button class="buy-btn" data-open="org-create">create organization</button>
          <button class="buy-btn" data-open="org-attach">attach a site to an existing org</button>
          <button class="buy-btn" data-open="org-migrate">upgrade admin to shared account</button>
          <button class="buy-btn" data-open="org-welcome" data-testid="design-open-org-welcome">post-signup welcome (draft copy)</button>
        </div>

        <div class="design-block">
          <h3>associated-orgs badges — in the hero header</h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            Rendered on artist tenants only, from <code>public/js/assoc-orgs.js</code>.
            Each circle avatar links to the org's own tenant. Skipped on org tenants
            themselves. Markup here is a static snapshot of the live chip row.
          </p>
          <div style="display:flex;justify-content:flex-end;max-width:520px;padding:0.75em 1em;background:var(--bg);border:1px solid var(--border);border-radius:8px">
            <div style="display:flex;gap:0.4ch;align-items:center">
              <a href="#" title="whatifwe pictures" style="width:24px;height:24px;border-radius:50%;background:#333;display:inline-flex;align-items:center;justify-content:center;font-size:0.65em;color:#fff;text-decoration:none">W</a>
              <a href="#" title="lucidhaus" style="width:24px;height:24px;border-radius:50%;background:#555;display:inline-flex;align-items:center;justify-content:center;font-size:0.65em;color:#fff;text-decoration:none">L</a>
              <a href="#" title="sellout labs" style="width:24px;height:24px;border-radius:50%;background:#444;display:inline-flex;align-items:center;justify-content:center;font-size:0.65em;color:#fff;text-decoration:none">S</a>
            </div>
          </div>
        </div>

        <div class="design-block">
          <h3>org dock — the slim scope</h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            An org tenant's dock shows only the icons that make sense for a
            shared working account — portfolio, roster, write, create project.
            Removed: journal (private), messages (routed through EIP-1271 per #153).
            Snapshot of the live dock shape.
          </p>
          <nav style="display:flex;gap:1em;padding:0.8em 1.2em;background:var(--bg);border:1px solid var(--border);border-radius:8px;max-width:520px">
            <a href="#" title="portfolio"><i class="ph ph-house" style="font-size:1.2em;color:var(--fg)"></i></a>
            <a href="#" title="roster"><i class="ph ph-users" style="font-size:1.2em;color:var(--muted)"></i></a>
            <a href="#" title="write"><i class="ph ph-pencil-line" style="font-size:1.2em;color:var(--muted)"></i></a>
            <a href="#" title="create project"><i class="ph ph-plus-circle" style="font-size:1.2em;color:var(--muted)"></i></a>
          </nav>
        </div>

        <div class="design-block">
          <h3>signer + threshold panel</h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            Lives inside the org admin card (settings.js:1326 — <code>_renderOrgSafePanel</code>).
            Lists co-owners, exposes a signatures-required slider when there's
            more than one, and an input to add another. Static snapshot with three
            mock co-owners below.
          </p>
          <div id="design-org-signers-slot" style="max-width:520px;padding:1em;background:var(--bg);border:1px solid var(--border);border-radius:8px"></div>
        </div>

        <div class="design-block">
          <h3>org admin card — inline on the org tenant</h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            Rendered by <code>_renderInlineOrgAdmin</code> (settings.js:1259) for
            wallets the Praxis contract identifies as org admins or Safe signers.
            Shows the org identity, pending invites, roster shortcuts, and the
            signer panel above. Static shape below.
          </p>
          <div style="max-width:520px;padding:1em;background:var(--bg);border:1px solid var(--border);border-radius:8px">
            <p style="font-size:0.75em;color:var(--muted);margin:0 0 0.5em;text-transform:uppercase;letter-spacing:0.05em">shared account</p>
            <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:0.75em">
              <div>
                <div style="font-size:1em;color:var(--fg)">whatifwe pictures</div>
                <div style="font-family:'SF Mono',monospace;font-size:0.75em;color:var(--dim)">0x1234…9abc</div>
              </div>
              <a href="#" style="font-size:0.75em;color:var(--accent);text-decoration:none">open settings</a>
            </div>
            <div style="font-size:0.8em;color:var(--muted)">roster: 3 members, 1 pending invite</div>
          </div>
        </div>

        <div class="design-block">
          <h3>messages — org label (EIP-1271)</h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            Per #153, an org's XMTP inbox is signed by the shared account using
            EIP-1271. In the messages list, an org thread carries the shared-account
            label so viewers can distinguish it from a personal DM.
          </p>
          <div style="max-width:520px;padding:0.75em 1em;background:var(--bg);border:1px solid var(--border);border-radius:8px;display:flex;align-items:center;gap:0.75ch">
            <div style="width:32px;height:32px;border-radius:50%;background:#444;color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:0.75em">W</div>
            <div style="flex:1">
              <div style="display:flex;align-items:center;gap:0.5ch">
                <span style="font-size:0.9em;color:var(--fg)">whatifwe pictures</span>
                <span style="font-size:0.65em;color:var(--dim);border:1px solid var(--border);border-radius:3px;padding:0.1em 0.5ch">shared account</span>
              </div>
              <div style="font-size:0.75em;color:var(--muted)">hey — adding you as a signer</div>
            </div>
            <span style="font-size:0.7em;color:var(--dim)">2m</span>
          </div>
        </div>

        <div class="design-block">
          <h3>publish to org — media detail chip</h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            A compact cross-reference to the publish-to-org panel in §5 above.
            On <code>/art?media=…</code>, the owner of a media sees this list of
            their orgs with a checkbox each, calling <code>Praxis.tagWork</code>
            / <code>untagWork</code> to add or remove the work from an org's
            catalog.
          </p>
          <div style="max-width:520px;padding:0.75em 1em;background:var(--bg);border:1px solid var(--border);border-radius:8px;display:flex;justify-content:space-between;align-items:center">
            <span style="font-size:0.85em;color:var(--fg)">publish this work to</span>
            <span style="font-size:0.75em;color:var(--dim)">see §5 · media + collection — publish-to-org</span>
          </div>
        </div>

        <div class="design-block">
          <h3>org blog via shared account — cross-reference</h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            Per #141, an org's blog post is proposed by a signer, then the shared
            account executes <code>BlogRegistry.post</code> via
            <code>execSafeTx</code> so the author on-chain is the org, not the
            signer. Use <code>?sandbox=1</code> + "compose blog post" in §3 to
            drive it end-to-end against the anvil fork.
          </p>

      <!-- ─────────── 11 · modules ─────────── -->
      <!--
        Each module's live renderSection() is called with a terse fixture so
        the catalog shows the real production surface, not a static mock.
        Fixture strings are structural ("track 1", "scene 1") — no invented
        artist-facing copy. Modules that render empty for the given fixture
        show the empty state, which is still part of the catalog.
      -->
      <section class="design-section">
        <h2 class="design-section-title">11 · modules</h2>
        <div class="design-block"><h3>music</h3><div id="design-mod-music" class="design-module-slot"></div></div>
        <div class="design-block"><h3>audio</h3><div id="design-mod-audio" class="design-module-slot"></div></div>
        <div class="design-block"><h3>credits</h3><div id="design-mod-credits" class="design-module-slot"></div></div>
        <div class="design-block"><h3>gallery</h3><div id="design-mod-gallery" class="design-module-slot"></div></div>
        <div class="design-block"><h3>writing</h3><div id="design-mod-writing" class="design-module-slot"></div></div>
        <div class="design-block"><h3>film</h3><div id="design-mod-film" class="design-module-slot"></div></div>
        <div class="design-block"><h3>video</h3><div id="design-mod-video" class="design-module-slot"></div></div>
        <div class="design-block"><h3>technology</h3><div id="design-mod-technology" class="design-module-slot"></div></div>
        <div class="design-block"><h3>education</h3><div id="design-mod-education" class="design-module-slot"></div></div>
        <div class="design-block"><h3>demos</h3><div id="design-mod-demos" class="design-module-slot"></div></div>
      </section>

      <!-- ─────────── 12 · notifications ─────────── -->
      <!-- Every variant renders through renderNotificationsPage in
           notifications.js. Icons from NOTIF_ICONS (line 808), unread
           distinction from n.time > lastSeen (.notif-unread), aggregate
           forms from aggregateNotifications (line 715). Fixtures use
           structural placeholders only — no invented artist copy. -->
      <section class="design-section">
        <h2 class="design-section-title">12 · notifications</h2>

        <div class="design-block">
          <h3>page rows — one of each type</h3>
          <div class="notif-page" style="border:1px solid var(--border);border-radius:6px;padding:0 1em;background:var(--bg,#0a0a0a)">
            <div class="notif-page-row notif-unread" style="display:flex;align-items:center;gap:1ch;padding:0.75em 0;border-bottom:1px solid var(--border)"><span class="notif-icon" style="color:var(--muted);font-family:monospace;width:1.5ch;text-align:center">$</span><span class="notif-text" style="flex:1"><strong>test-artist.xyz</strong> funded your project with 0.5 ETH</span><span class="notif-time" style="color:var(--dim);font-size:0.8em">2m</span><a href="#" style="color:var(--muted);font-size:0.8em">view</a></div>
            <div class="notif-page-row notif-unread" style="display:flex;align-items:center;gap:1ch;padding:0.75em 0;border-bottom:1px solid var(--border)"><span class="notif-icon" style="color:var(--muted);font-family:monospace;width:1.5ch;text-align:center">~</span><span class="notif-text" style="flex:1"><strong>test-artist.xyz</strong> followed you</span><span class="notif-time" style="color:var(--dim);font-size:0.8em">5m</span><a href="#" style="color:var(--muted);font-size:0.8em">view</a></div>
            <div class="notif-page-row" style="display:flex;align-items:center;gap:1ch;padding:0.75em 0;border-bottom:1px solid var(--border)"><span class="notif-icon" style="color:var(--muted);font-family:monospace;width:1.5ch;text-align:center">*</span><span class="notif-text" style="flex:1"><strong>test-artist.xyz</strong> collected <em>test track</em></span><span class="notif-time" style="color:var(--dim);font-size:0.8em">1h</span><a href="#" style="color:var(--muted);font-size:0.8em">view</a></div>
            <div class="notif-page-row notif-unread" style="display:flex;align-items:center;gap:1ch;padding:0.75em 0;border-bottom:1px solid var(--border)"><span class="notif-icon" style="color:var(--muted);font-family:monospace;width:1.5ch;text-align:center">!</span><span class="notif-text" style="flex:1"><em>test project</em> needs your confirmation</span><span class="notif-time" style="color:var(--dim);font-size:0.8em">15m</span><a href="#" style="color:var(--accent);font-size:0.8em;white-space:nowrap;font-weight:bold">confirm</a></div>
            <div class="notif-page-row" style="display:flex;align-items:center;gap:1ch;padding:0.75em 0;border-bottom:1px solid var(--border)"><span class="notif-icon" style="color:var(--muted);font-family:monospace;width:1.5ch;text-align:center">!</span><span class="notif-text" style="flex:1"><em>test project</em> completed — funds distributed</span><span class="notif-time" style="color:var(--dim);font-size:0.8em">4h</span><a href="#" style="color:var(--muted);font-size:0.8em">view</a></div>
            <div class="notif-page-row" style="display:flex;align-items:center;gap:1ch;padding:0.75em 0;border-bottom:1px solid var(--border)"><span class="notif-icon" style="color:var(--muted);font-family:monospace;width:1.5ch;text-align:center">x</span><span class="notif-text" style="flex:1"><em>test project</em> was cancelled</span><span class="notif-time" style="color:var(--dim);font-size:0.8em">6h</span><a href="#" style="color:var(--muted);font-size:0.8em">view</a></div>
            <div class="notif-page-row" style="display:flex;align-items:center;gap:1ch;padding:0.75em 0;border-bottom:1px solid var(--border)"><span class="notif-icon" style="color:var(--muted);font-family:monospace;width:1.5ch;text-align:center">?</span><span class="notif-text" style="flex:1"><em>test project</em> has been disputed</span><span class="notif-time" style="color:var(--dim);font-size:0.8em">1d</span><a href="#" style="color:var(--muted);font-size:0.8em">view</a></div>
            <div class="notif-page-row" style="display:flex;align-items:center;gap:1ch;padding:0.75em 0;border-bottom:1px solid var(--border)"><span class="notif-icon" style="color:var(--muted);font-family:monospace;width:1.5ch;text-align:center">.</span><span class="notif-text" style="flex:1"><em>test project</em> entering dispute window</span><span class="notif-time" style="color:var(--dim);font-size:0.8em">1d</span><a href="#" style="color:var(--muted);font-size:0.8em">view</a></div>
            <div class="notif-page-row" style="display:flex;align-items:center;gap:1ch;padding:0.75em 0;border-bottom:1px solid var(--border)"><span class="notif-icon" style="color:var(--muted);font-family:monospace;width:1.5ch;text-align:center">$</span><span class="notif-text" style="flex:1">revenue share: 0.08 ETH from <em>test project</em></span><span class="notif-time" style="color:var(--dim);font-size:0.8em">2d</span><a href="#" style="color:var(--muted);font-size:0.8em">view</a></div>
            <div class="notif-page-row" style="display:flex;align-items:center;gap:1ch;padding:0.75em 0;border-bottom:1px solid var(--border)"><span class="notif-icon" style="color:var(--muted);font-family:monospace;width:1.5ch;text-align:center">></span><span class="notif-text" style="flex:1"><strong>test-artist.xyz</strong> replied to your post</span><span class="notif-time" style="color:var(--dim);font-size:0.8em">3h</span><a href="#" style="color:var(--muted);font-size:0.8em">view</a></div>
            <div class="notif-page-row notif-unread" style="display:flex;align-items:center;gap:1ch;padding:0.75em 0;border-bottom:1px solid var(--border)"><span class="notif-icon" style="color:var(--muted);font-family:monospace;width:1.5ch;text-align:center">@</span><span class="notif-text" style="flex:1"><strong>test-artist.xyz</strong> mentioned you in a post</span><span class="notif-time" style="color:var(--dim);font-size:0.8em">30m</span><a href="#" style="color:var(--muted);font-size:0.8em">view</a></div>
            <div class="notif-page-row" style="display:flex;align-items:center;gap:1ch;padding:0.75em 0;border-bottom:1px solid var(--border)"><span class="notif-icon" style="color:var(--muted);font-family:monospace;width:1.5ch;text-align:center">+</span><span class="notif-text" style="flex:1"><strong>test-artist.xyz</strong> used your invite</span><span class="notif-time" style="color:var(--dim);font-size:0.8em">2d</span><a href="#" style="color:var(--muted);font-size:0.8em">view</a></div>
            <div class="notif-page-row" style="display:flex;align-items:center;gap:1ch;padding:0.75em 0;border-bottom:1px solid var(--border)"><span class="notif-icon" style="color:var(--muted);font-family:monospace;width:1.5ch;text-align:center">+</span><span class="notif-text" style="flex:1"><strong>test-artist.xyz</strong> redeemed a sponsored invite</span><span class="notif-time" style="color:var(--dim);font-size:0.8em">2d</span><a href="#" style="color:var(--muted);font-size:0.8em">view</a></div>
            <div class="notif-page-row" style="display:flex;align-items:center;gap:1ch;padding:0.75em 0;border-bottom:1px solid var(--border)"><span class="notif-icon" style="color:var(--muted);font-family:monospace;width:1.5ch;text-align:center">+</span><span class="notif-text" style="flex:1">referral bonus from <strong>test-artist.xyz</strong></span><span class="notif-time" style="color:var(--dim);font-size:0.8em">3d</span><a href="#" style="color:var(--muted);font-size:0.8em">view</a></div>
            <div class="notif-page-row notif-unread" style="display:flex;align-items:center;gap:1ch;padding:0.75em 0;border-bottom:1px solid var(--border)"><span class="notif-icon" style="color:var(--muted);font-family:monospace;width:1.5ch;text-align:center">+</span><span class="notif-text" style="flex:1">you have unclaimed earnings</span><span class="notif-time" style="color:var(--dim);font-size:0.8em">1h</span><button class="buy-btn notif-claim-btn" style="font-size:0.75em;padding:0.2em 0.8ch">claim</button></div>
            <div class="notif-page-row notif-unread" style="display:flex;align-items:center;gap:1ch;padding:0.75em 0;border-bottom:1px solid var(--border)"><span class="notif-icon" style="color:var(--muted);font-family:monospace;width:1.5ch;text-align:center">⊕</span><span class="notif-text" style="flex:1"><strong>test-artist.xyz</strong> invited you to collaborate on <em>test project</em></span><span class="notif-time" style="color:var(--dim);font-size:0.8em">10m</span><span style="display:flex;gap:0.3ch"><button class="buy-btn" style="font-size:0.75em;padding:0.2em 0.8ch">accept</button><button style="background:none;border:1px solid var(--border);color:var(--dim);font-family:inherit;font-size:0.75em;padding:0.2em 0.8ch;cursor:pointer">dismiss</button></span></div>
            <div class="notif-page-row" style="display:flex;align-items:center;gap:1ch;padding:0.75em 0;border-bottom:1px solid var(--border)"><span class="notif-icon" style="color:var(--muted);font-family:monospace;width:1.5ch;text-align:center">⊖</span><span class="notif-text" style="flex:1">removed from <em>test project</em></span><span class="notif-time" style="color:var(--dim);font-size:0.8em">1d</span></div>
            <div class="notif-page-row notif-unread" style="display:flex;align-items:center;gap:1ch;padding:0.75em 0;border-bottom:1px solid var(--border)"><span class="notif-icon" style="color:var(--muted);font-family:monospace;width:1.5ch;text-align:center">⊕</span><span class="notif-text" style="flex:1"><strong>test org</strong> invited you to join</span><span class="notif-time" style="color:var(--dim);font-size:0.8em">8m</span><span style="display:inline-flex;gap:0.3ch;align-items:center"><button class="buy-btn" style="font-size:0.7em;padding:0.15em 0.9ch">accept</button><button style="background:none;border:1px solid var(--border);color:var(--dim);font-family:inherit;font-size:0.7em;padding:0.15em 0.9ch;cursor:pointer">decline</button></span></div>
            <div class="notif-page-row" style="display:flex;align-items:center;gap:1ch;padding:0.75em 0;border-bottom:1px solid var(--border)"><span class="notif-icon" style="color:var(--muted);font-family:monospace;width:1.5ch;text-align:center">.</span><span class="notif-text" style="flex:1"><strong>test-artist.xyz</strong> published a new post</span><span class="notif-time" style="color:var(--dim);font-size:0.8em">6h</span><a href="#" style="color:var(--muted);font-size:0.8em">view</a></div>
          </div>
          <p style="color:var(--dim);font-size:0.85em;margin-top:0.5em">unread rows carry <code>.notif-unread</code>; icons from <code>NOTIF_ICONS</code> (notifications.js:808).</p>
        </div>

        <div class="design-block">
          <h3>aggregated forms — 24h windows</h3>
          <div class="notif-page" style="border:1px solid var(--border);border-radius:6px;padding:0 1em;background:var(--bg,#0a0a0a)">
            <div class="notif-page-row" style="display:flex;align-items:center;gap:1ch;padding:0.75em 0;border-bottom:1px solid var(--border)"><span class="notif-icon" style="color:var(--muted);font-family:monospace;width:1.5ch;text-align:center">~</span><span class="notif-text" style="flex:1"><strong>test-artist.xyz</strong> and 4 others followed you</span><span class="notif-time" style="color:var(--dim);font-size:0.8em">1h</span><a href="#" style="color:var(--muted);font-size:0.8em">view</a></div>
            <div class="notif-page-row" style="display:flex;align-items:center;gap:1ch;padding:0.75em 0;border-bottom:1px solid var(--border)"><span class="notif-icon" style="color:var(--muted);font-family:monospace;width:1.5ch;text-align:center">$</span><span class="notif-text" style="flex:1"><strong>test-artist.xyz</strong> and 2 others funded <em>test project</em></span><span class="notif-time" style="color:var(--dim);font-size:0.8em">2h</span><a href="#" style="color:var(--muted);font-size:0.8em">view</a></div>
            <div class="notif-page-row" style="display:flex;align-items:center;gap:1ch;padding:0.75em 0"><span class="notif-icon" style="color:var(--muted);font-family:monospace;width:1.5ch;text-align:center">*</span><span class="notif-text" style="flex:1"><strong>test-artist.xyz</strong> and 7 others collected <em>test track</em></span><span class="notif-time" style="color:var(--dim);font-size:0.8em">3h</span><a href="#" style="color:var(--muted);font-size:0.8em">view</a></div>
          </div>
          <p style="color:var(--dim);font-size:0.85em;margin-top:0.5em">follower / funded / purchased collapse into "x and N others" via <code>aggregateNotifications()</code> (notifications.js:715).</p>
        </div>

        <div class="design-block">
          <h3>panel wrapper — bell dropdown</h3>
          <div class="notif-panel" style="position:relative;margin:0;border:1px solid var(--border);border-radius:6px;background:var(--bg,#0a0a0a);max-width:360px">
            <div class="notif-header" style="padding:0.75em 1em;border-bottom:1px solid var(--border);font-weight:600">notifications</div>
            <a class="notif-item notif-unread" href="#" style="display:flex;padding:0.75em 1em;border-bottom:1px solid var(--border);text-decoration:none;color:inherit"><span class="notif-icon" style="color:var(--muted);font-family:monospace;margin-right:0.5ch;width:1.5ch;display:inline-block;text-align:center">$</span><span class="notif-text"><strong>test-artist.xyz</strong> funded your project</span></a>
            <a class="notif-item notif-unread" href="#" style="display:flex;padding:0.75em 1em;border-bottom:1px solid var(--border);text-decoration:none;color:inherit"><span class="notif-icon" style="color:var(--muted);font-family:monospace;margin-right:0.5ch;width:1.5ch;display:inline-block;text-align:center">~</span><span class="notif-text"><strong>test-artist.xyz</strong> followed you</span></a>
            <a class="notif-item" href="#" style="display:flex;padding:0.75em 1em;text-decoration:none;color:inherit"><span class="notif-icon" style="color:var(--muted);font-family:monospace;margin-right:0.5ch;width:1.5ch;display:inline-block;text-align:center">@</span><span class="notif-text">mentioned you in a post</span></a>
          </div>
          <p style="color:var(--dim);font-size:0.85em;margin-top:0.5em">rendered by <code>renderPanel()</code> (notifications.js:961); appears beside the bell, closes on outside click.</p>
        </div>

        <div class="design-block">
          <h3>empty state</h3>
          <p style="color:var(--muted)">no notifications yet</p>
        </div>
      </section>

      <!-- ─────────── 13 · states & errors ─────────── -->
      <section class="design-section">
        <h2 class="design-section-title">13 · states & errors</h2>
        <p style="color:var(--muted);margin-bottom:1.5em;max-width:60ch">
          Every string below is reused verbatim from the live surface where
          it fires. Catalog shows them side-by-side so the voice stays
          consistent across the places artists hit them. Where the app
          has no shipped copy yet, a <code>__STATE_NEEDS_COPY__</code> token
          marks the slot.
        </p>

        <!-- Wallet states -->
        <div class="design-block">
          <h3>wallet — still locked (cashout.js:616)</h3>
          <p style="color:var(--muted)">wallet still locked — try again</p>
        </div>
        <div class="design-block">
          <h3>wallet — needs passphrase (cashout.js:664)</h3>
          <p style="color:var(--muted)">wallet still locked — enter your password and try again</p>
        </div>
        <div class="design-block">
          <h3>wallet — locked (embedded-wallet.js:424)</h3>
          <p style="color:var(--muted)">wallet is locked</p>
        </div>
        <div class="design-block">
          <h3>wallet — locked, retry hint (vault.js:2705)</h3>
          <p style="color:var(--muted)">unlock your wallet and try again</p>
        </div>

        <!-- On-chain states -->
        <div class="design-block">
          <h3>on-chain — insufficient funds (profile.js:368, network.js:190)</h3>
          <p style="color:var(--muted)">insufficient funds for gas</p>
        </div>
        <div class="design-block">
          <h3>on-chain — insufficient on Optimism (network.js:886)</h3>
          <p style="color:var(--muted)">insufficient ETH on Optimism</p>
        </div>
        <div class="design-block">
          <h3>on-chain — wrong chain (network.js:171)</h3>
          <p style="color:var(--muted)">switch to Optimism</p>
        </div>
        <div class="design-block">
          <h3>on-chain — tx rejected by wallet (landing.js:4651, utils.js:1128)</h3>
          <p style="color:var(--muted)">transaction cancelled</p>
        </div>
        <div class="design-block">
          <h3>on-chain — tx rejected (vault.js:2705)</h3>
          <p style="color:var(--muted)">cancelled</p>
        </div>
        <div class="design-block">
          <h3>on-chain — tx timed out (project-detail.js:764, network.js:152)</h3>
          <p style="color:var(--muted)">transaction timed out</p>
        </div>

        <!-- Indexer / Ponder -->
        <div class="design-block">
          <h3>ponder — circuit breaker open (ponder.js:117)</h3>
          <p style="color:var(--muted)">ponder circuit breaker open — too many recent failures</p>
          <p style="color:var(--dim);font-size:0.8em;margin-top:0.5em">internal exception; UIs surface it as "could not load"</p>
        </div>
        <div class="design-block">
          <h3>ponder — feed showing "indexing in progress" <code>draft</code></h3>
          <p style="color:var(--muted)">we're catching up on new activity. this usually takes a few seconds — pull down to refresh.</p>
          <p style="color:var(--dim);font-size:0.75em;margin-top:0.5em">draft copy — needs your pass. unshipped; feed currently either stale or falls back to "failed to load" on lag.</p>
        </div>

        <!-- Bridge / ramp -->
        <div class="design-block">
          <h3>bridge — submitted (relay-bridge.js:289)</h3>
          <p style="color:var(--muted)">bridge submitted — waiting for confirmation...</p>
        </div>
        <div class="design-block">
          <h3>bridge — confirmed, waiting for funds (relay-bridge.js:297)</h3>
          <p style="color:var(--muted)">bridge confirmed — waiting for funds on Optimism...</p>
        </div>
        <div class="design-block">
          <h3>bridge — failed (relay-bridge.js:641)</h3>
          <p style="color:var(--muted)">swap + bridge failed</p>
        </div>
        <div class="design-block">
          <h3>bridge — safe-funds recovery (ramp.js:2050)</h3>
          <p style="color:var(--muted)">swap+bridge failed — your USDC is safe on Base. retry from "add funds" using the manual bridge.</p>
        </div>
        <div class="design-block">
          <h3>ramp — bridging label (ramp.js:77)</h3>
          <p style="color:var(--muted)">bridging</p>
        </div>
        <div class="design-block">
          <h3>ramp — rate-limited (ramp.js:1726)</h3>
          <p style="color:var(--muted)">too many quote requests — wait a few seconds</p>
        </div>

        <!-- Stripe / payment -->
        <div class="design-block">
          <h3>stripe — processing to IPFS (library.js:652, settings.js:4948)</h3>
          <p style="color:var(--muted)">uploading to IPFS...</p>
        </div>
        <div class="design-block">
          <h3>stripe — processing payment <code>draft</code></h3>
          <p style="color:var(--muted)">hold on — confirming the charge with your bank. don't close this tab.</p>
          <p style="color:var(--dim);font-size:0.75em;margin-top:0.5em">draft copy — needs your pass. pay.js surfaces the Stripe SDK's confirmation UI today; no in-app processing string shipped.</p>
        </div>

        <!-- Signup / cert -->
        <div class="design-block">
          <h3>signup — step error, 6-step shared-account flow <code>draft</code></h3>
          <p style="color:var(--muted)">this step didn't go through. try it again, or send us a note if it keeps happening.</p>
          <p style="color:var(--dim);font-size:0.75em;margin-top:0.5em">draft copy — needs your pass. landing.js step rows pass the raw viem/orchestrator throw through today; parent #95 flagged the gap.</p>
        </div>
        <div class="design-block">
          <h3>cert — still issuing after fresh signup <code>draft</code></h3>
          <p style="color:var(--muted)">your subdomain is almost ready. we're finishing the lock in your browser's address bar — refresh in about a minute.</p>
          <p style="color:var(--dim);font-size:0.75em;margin-top:0.5em">draft copy — needs your pass. Traefik + Let's Encrypt handle issuance; today the fresh subdomain shows the browser's raw TLS warning while cert is issued.</p>
        </div>

        <!-- Upload queue -->
        <div class="design-block">
          <h3>upload — job queued, generic failure (write.js:621)</h3>
          <p style="color:var(--muted)">(renders <code>compose.uploadFailed</code> with the queue error interpolated)</p>
        </div>
        <div class="design-block">
          <h3>upload — queue busy / full <code>draft</code></h3>
          <p style="color:var(--muted)">a lot of people are uploading right now. your file will go up in a moment — or come back in a minute or two.</p>
          <p style="color:var(--dim);font-size:0.75em;margin-top:0.5em">draft copy — needs your pass. server.js caps at 1000 jobs and returns 503; today the client shows a generic "upload failed".</p>
        </div>

        <!-- IPFS -->
        <div class="design-block">
          <h3>ipfs — fetch timeout <code>draft</code></h3>
          <p style="color:var(--muted)">this file is taking longer than usual to reach your browser. refresh, or try again in a moment.</p>
          <p style="color:var(--dim);font-size:0.75em;margin-top:0.5em">draft copy — needs your pass. ipfs-proxy retries then returns the gateway's error; today media tags fail silently.</p>
        </div>

        <!-- XMTP / messages -->
        <div class="design-block">
          <h3>xmtp — too many installations (messages.js:1055)</h3>
          <p style="color:var(--muted)">too many messaging sessions (${'$'}{installations.length}/10). revoke old sessions in settings to reconnect.</p>
        </div>
        <div class="design-block">
          <h3>xmtp — too many installations, status line (messages.js:1067)</h3>
          <p style="color:var(--muted)">XMTP: too many installations (10/10)</p>
        </div>
        <div class="design-block">
          <h3>library — this wallet blocked (library.js:607)</h3>
          <p style="color:var(--muted)">this wallet has been blocked from contributing to the library — see the copyright policy</p>
        </div>

        <!-- Empty states -->
        <div class="design-block">
          <h3>empty — collection (design.js:1116, collection.js:242)</h3>
          <p style="color:var(--muted)">no items in your collection yet</p>
        </div>
        <div class="design-block">
          <h3>empty — library (library.js:131)</h3>
          <p style="color:var(--muted)">(renders <code>t('library.empty')</code>: "nothing in the library yet" — i18n key)</p>
        </div>
        <div class="design-block">
          <h3>empty — messages / conversations (dm.js:419)</h3>
          <p style="color:var(--muted)">no conversations yet — start one with the + button above</p>
        </div>
        <div class="design-block">
          <h3>empty — messages, syncing (messages.js:2327)</h3>
          <p style="color:var(--muted)">no conversations yet</p>
        </div>
        <div class="design-block">
          <h3>empty — post collection (post.js:984)</h3>
          <p style="color:var(--muted)">no posts in this collection yet.</p>
        </div>
        <div class="design-block">
          <h3>empty — collection load failed (supporter-home.js:207, collection.js:485)</h3>
          <p style="color:var(--muted)">could not load collection</p>
        </div>
      </section>

      <!-- ─────────── 14 · auth & accounts ─────────── -->
      <section class="design-section">
        <h2 class="design-section-title">14 · auth & accounts</h2>
        <p style="color:var(--dim);font-size:0.9em;margin:0 0 1em">
          Every embedded-account prompt and auth surface in one place. Openers call the SAME live functions the real flows call — unlock, create, recover, sign in, change passphrase. Destructive paths route to a mock address so the catalog never touches a real account.
        </p>

        <div class="design-btn-row" id="design-auth-openers">
          <button class="buy-btn" data-open="auth-unlock">unlock prompt</button>
          <button class="buy-btn" data-open="auth-create">create account</button>
          <button class="buy-btn" data-open="auth-recovery-reveal">recovery phrase — reveal</button>
          <button class="buy-btn" data-open="auth-recovery">recover from phrase</button>
          <button class="buy-btn" data-open="auth-signin">sign in</button>
          <button class="buy-btn" data-open="auth-change-password">change passphrase</button>
          <button class="buy-btn" data-open="auth-unregister">delete account (destructive)</button>
          <button class="buy-btn" data-open="auth-audience">audience prompt</button>
        </div>
        <p id="design-auth-fallback" style="color:var(--muted);font-size:0.8em;margin:0.5em 0 1em;min-height:1em"></p>

        <div class="design-block">
          <h3>unlock prompt — password + biometric branch</h3>
          <p style="color:var(--dim);font-size:0.85em"><em>Appears on hard refresh of /vault, /journal, /messages after the 30-minute trust window elapses, and before any approval that needs your key. embedded-wallet.js:1306.</em></p>
        </div>

        <div class="design-block">
          <h3>create account — passphrase + confirm <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em"><em>First time a visitor spins up their own space — the embedded-account flow asks for a passphrase they'll use to unlock on this device. embedded-wallet.js:1568.</em></p>
        </div>

        <div class="design-block">
          <h3>recovery phrase — reveal (one-time) <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em"><em>Shows once, right after an account is created. Twelve words — if the person loses their passphrase, these are the only way back in. Opener passes a mock phrase + 0x…dEaD address. embedded-wallet.js:1200.</em></p>
        </div>

        <div class="design-block">
          <h3>recover from phrase — paste 12 words <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em"><em>The "i lost my passphrase" path. Paste the twelve words, set a new passphrase on this device. embedded-wallet.js:1639.</em></p>
        </div>

        <div class="design-block">
          <h3>sign in — returning visitor <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em"><em>Shown when the browser has an encrypted account on disk but no cached session — the returning-visitor entry point. embedded-wallet.js:1760.</em></p>
        </div>

        <div class="design-block">
          <h3>change passphrase <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em"><em>From settings → security. Asks for the current passphrase first, then the new one twice. embedded-wallet.js:1976.</em></p>
        </div>

        <div class="design-block">
          <h3>delete account — confirmation (destructive) <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em"><em>From settings → danger zone. Requires typing a confirmation phrase before the delete runs on Ethereum. Opener uses the mock 0x…dEaD address so no real account is touched. wallet.js:1532.</em></p>
        </div>

        <div class="design-block">
          <h3>audience prompt — supporter sign-up bar <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em"><em>Appears along the bottom of the page for signed-in visitors who haven't registered as an audience member yet. Not window-exposed in prod; opener surfaces a muted fallback hint. wallet.js:848.</em></p>
        </div>

        <div class="design-block">
          <h3>inline error — password field <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em"><em>Fires inside the unlock prompt body when the passphrase is wrong — red border + shake, screen-reader text only. No layout shift. Static snapshot below; the live showError closure lives inside <code>showUnlockPrompt</code> at embedded-wallet.js:1498.</em></p>
          <div style="max-width:420px;margin-top:0.5em;padding:1em;background:var(--bg);border:1px solid var(--border);border-radius:8px">
            <label style="display:block;font-size:0.8em;color:var(--muted);margin-bottom:0.3em">passphrase</label>
            <input type="password" class="project-input is-error" aria-invalid="true" value="●●●●●●●●" readonly style="width:100%;font-family:'SF Mono',monospace">
            <p style="color:var(--dim);font-size:0.75em;margin:0.5em 0 0">wrong password</p>
      <!-- ─────────── 15 · vault & money ─────────── -->
      <section class="design-section">
        <h2 class="design-section-title">15 · vault & money</h2>
        <p style="color:var(--dim);font-size:0.9em;margin:0 0 1em">
          Every place money shows up — your balance, your earnings, what you've sent
          or bought. Openers call the live sheets; the dashboard renders inline.
          Draft copy below is marked for Miles's pass.
        </p>

        <div class="design-block">
          <h3>openers <code>draft</code></h3>
          <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.75em">
            Each button opens the live sheet — same function the vault page calls
            in production. Labels are drafts, not shipped copy. The mock address
            <code>0x…dEaD</code> stands in when no wallet is connected.
          </p>
          <div class="design-btn-row" id="design-vault-openers" style="display:flex;flex-wrap:wrap;gap:0.4em 0.5em">
            <button class="dw-chip-pill" data-open="vault-send"><i class="dw-chip-pill__icon ph ph-paper-plane-tilt" aria-hidden="true"></i>send money</button>
            <button class="dw-chip-pill" data-open="vault-receive"><i class="dw-chip-pill__icon ph ph-tray-arrow-down" aria-hidden="true"></i>receive money</button>
            <button class="dw-chip-pill" data-open="vault-swap"><i class="dw-chip-pill__icon ph ph-arrows-left-right" aria-hidden="true"></i>move between chains</button>
            <button class="dw-chip-pill" data-open="vault-purchase-confirm"><i class="dw-chip-pill__icon ph ph-check-circle" aria-hidden="true"></i>confirm a purchase</button>
            <button class="dw-chip-pill" data-open="vault-funding"><i class="dw-chip-pill__icon ph ph-receipt" aria-hidden="true"></i>funding sheet</button>
            <button class="dw-chip-pill" data-open="vault-onramp"><i class="dw-chip-pill__icon ph ph-credit-card" aria-hidden="true"></i>add funds from a card</button>
            <button class="dw-chip-pill" data-open="vault-offramp"><i class="dw-chip-pill__icon ph ph-bank" aria-hidden="true"></i>cash out to a bank</button>
      <!-- ─────────── 16 · settings & CMS ─────────── -->
      <section class="design-section">
        <h2 class="design-section-title">16 · settings & CMS</h2>
        <p style="color:var(--dim);font-size:0.9em;margin:0 0 1em;max-width:60ch">
          The whole settings tour on one scroll — identity, modules, theme,
          highlights, sell widget, blog collections, module editor. Each slot
          calls the live render fn from <code>public/js/settings.js</code>.
          Slots that need a signed-in owner show a muted fallback here; open
          the real panel to see them wired.
        </p>

        <div class="design-btn-row" id="design-settings-openers">
          <button class="buy-btn" data-open="settings-open">open settings</button>
          <button class="buy-btn" data-open="settings-remove-module">remove a module</button>
        </div>

        <div class="design-block">
          <h3>your profile <code>draft</code></h3>
          <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.5em">
            identity tab — name, picture, short bio, template, domain, security, danger zone.
            calls <code>renderIdentityTab(el)</code> at settings.js:626.
          </p>
          <div id="design-settings-identity-slot" class="design-settings-slot" style="max-width:560px;border:1px solid var(--border);border-radius:8px;padding:1em;background:color-mix(in srgb,var(--fg) 2%,transparent)"></div>
        </div>

        <div class="design-block">
          <h3>your modules <code>draft</code></h3>
          <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.5em">
            modules tab — pick the sections on your site, reorder them, add
            or remove. calls <code>renderModulesTab(el)</code> at settings.js:2931.
          </p>
          <div id="design-settings-modules-slot" class="design-settings-slot" style="max-width:560px;border:1px solid var(--border);border-radius:8px;padding:1em;background:color-mix(in srgb,var(--fg) 2%,transparent)"></div>
        </div>

        <div class="design-block">
          <h3>your theme <code>draft</code></h3>
          <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.5em">
            theme tab — palette, font, light or dark. calls
            <code>renderThemeTab(el)</code> at settings.js:5223.
          </p>
          <div id="design-settings-theme-slot" class="design-settings-slot" style="max-width:560px;border:1px solid var(--border);border-radius:8px;padding:1em;background:color-mix(in srgb,var(--fg) 2%,transparent)"></div>
        </div>

        <div class="design-block">
          <h3>biometric confirmation</h3>
          <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.5em">
            card inside the identity tab. shown in the "on" state. calls
            <code>renderBiometricCard(true)</code> at settings.js:587.
          </p>
          <div id="design-settings-biometric-slot" class="design-settings-slot" style="max-width:560px"></div>
        </div>

        <div class="design-block">
          <h3>your highlights <code>draft</code></h3>
          <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.5em">
            no standalone renderer — each module carries its own highlight
            items. reorder, add, remove live on this editor shape. snapshot
            of the live markup with three mock entries.
          </p>
          <div style="max-width:560px;border:1px solid var(--border);border-radius:8px;padding:0.75em 1em;background:color-mix(in srgb,var(--fg) 2%,transparent)">
            <div class="editor-item" style="border-bottom:1px solid var(--border);padding:0.5em 0;display:flex;align-items:center;gap:0.75ch">
              <span class="drag-handle" style="cursor:grab;font-size:1.1em;color:var(--dim);padding:0 0.3ch">≡</span>
              <span class="collapse-title" style="flex:1;font-size:0.9em;color:var(--fg)">track 1</span>
              <button style="background:none;border:1px solid var(--border);color:var(--muted);font-family:inherit;font-size:0.75em;padding:0.15em 0.5ch;cursor:pointer">▲</button>
              <button style="background:none;border:1px solid var(--border);color:var(--muted);font-family:inherit;font-size:0.75em;padding:0.15em 0.5ch;cursor:pointer">▼</button>
              <button style="background:none;border:none;color:var(--dim);cursor:pointer;font-size:0.8em">remove</button>
            </div>
            <div class="editor-item" style="border-bottom:1px solid var(--border);padding:0.5em 0;display:flex;align-items:center;gap:0.75ch">
              <span class="drag-handle" style="cursor:grab;font-size:1.1em;color:var(--dim);padding:0 0.3ch">≡</span>
              <span class="collapse-title" style="flex:1;font-size:0.9em;color:var(--fg)">track 2</span>
              <button style="background:none;border:1px solid var(--border);color:var(--muted);font-family:inherit;font-size:0.75em;padding:0.15em 0.5ch;cursor:pointer">▲</button>
              <button style="background:none;border:1px solid var(--border);color:var(--muted);font-family:inherit;font-size:0.75em;padding:0.15em 0.5ch;cursor:pointer">▼</button>
              <button style="background:none;border:none;color:var(--dim);cursor:pointer;font-size:0.8em">remove</button>
            </div>
            <div class="editor-item" style="padding:0.5em 0;display:flex;align-items:center;gap:0.75ch">
              <span class="drag-handle" style="cursor:grab;font-size:1.1em;color:var(--dim);padding:0 0.3ch">≡</span>
              <span class="collapse-title" style="flex:1;font-size:0.9em;color:var(--fg)">track 3</span>
              <button style="background:none;border:1px solid var(--border);color:var(--muted);font-family:inherit;font-size:0.75em;padding:0.15em 0.5ch;cursor:pointer">▲</button>
              <button style="background:none;border:1px solid var(--border);color:var(--muted);font-family:inherit;font-size:0.75em;padding:0.15em 0.5ch;cursor:pointer">▼</button>
              <button style="background:none;border:none;color:var(--dim);cursor:pointer;font-size:0.8em">remove</button>
            </div>
            <button class="buy-btn" style="margin-top:0.75em;font-size:0.8em;padding:0.3em 1ch">add a highlight</button>
      <!-- ─────────── 17 · messages ─────────── -->
      <!--
        Every messaging + DM surface, in one place. Most of these render
        functions are file-local in messages.js / dm.js (not window-exposed,
        no module exports), so the catalog mirrors their markup shape 1:1 —
        changes in prod show up here when we hand-sync. Live openers call
        the pages that wrap them. Any copy drafted here is marked
        <code>draft</code> in the block heading so Miles can scan for the
        words that still need his pass.
      -->
      <section class="design-section">
        <h2 class="design-section-title">17 · messages</h2>
        <p style="color:var(--dim);font-size:0.9em;margin:0 0 1em">
          every surface you see when you tap messages — the two-column page,
          the people you've talked to, one chat, the quiet bits. redesign
          the voice here.
        </p>

        <div class="design-btn-row" id="design-msg-openers">
          <button class="buy-btn" data-open="msg-page">open /messages</button>
          <button class="buy-btn" data-open="msg-new">start a new chat</button>
          <button class="buy-btn" data-open="msg-new-group">start a group</button>
          <button class="buy-btn" data-open="msg-chat-menu">chat menu (rename, leave, archive)</button>
          <button class="buy-btn" data-open="msg-emoji">emoji picker</button>
          <button class="buy-btn" data-open="msg-toast">new message toast</button>
          <button class="buy-btn" data-open="msg-typing">play the typing indicator</button>
        </div>

        <div class="design-block">
          <h3>full two-column layout — sidebar + chat <code>draft</code></h3>
          <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.75em">
            mirrors the <code>#messages-container</code> markup
            <code>build.js</code> emits (line 712). three seed contacts in
            the sidebar; an open chat on the right with one of their
            messages and one of yours. live <code>renderMessages()</code>
            in <code>dm.js:663</code> and <code>messages.js:2990</code>
            both require a mounted XMTP client — out of reach from the
            catalog — so this is a static mirror of the shape they draw.
          </p>
          <div id="design-messages-slot" style="max-height:480px;border:1px solid var(--border);overflow:hidden;background:var(--bg)"></div>
        </div>

        <div class="design-block">
          <h3>start a new chat — DM picker (static shape) <code>draft</code></h3>
          <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.75em">
            shape of <code>showDmPicker()</code> inside the compose sheet
            (messages.js:470). the list is the people you both follow.
            file-local closure — opener above routes to /messages, where
            the + button in the sidebar header shows it.
          </p>
          <div class="msg-compose-sheet" style="position:static;max-width:360px;margin:0;padding:1em;background:var(--bg);border:1px solid var(--border);border-radius:12px">
            <div class="msg-picker-header" style="display:flex;align-items:center;gap:0.75ch;margin-bottom:0.75em">
              <button class="msg-picker-back" style="background:none;border:none;color:var(--muted);cursor:pointer;padding:0"><i class="ph ph-arrow-left"></i></button>
              <span style="color:var(--fg);font-size:0.95em">a new chat</span>
            </div>
            <input class="msg-picker-search" type="text" placeholder="search the people you both follow" style="width:100%;padding:0.5em;background:var(--surface);border:1px solid var(--border);color:var(--fg);font-family:inherit;font-size:0.85em;border-radius:4px;box-sizing:border-box;margin-bottom:0.5em">
            <div class="msg-picker-list" style="max-height:200px;overflow-y:auto">
              <div class="msg-convo-item msg-new-item">nappynina.com</div>
              <div class="msg-convo-item msg-new-item">blackmatter.world</div>
              <div class="msg-convo-item msg-new-item">milesxb.bio</div>
            </div>
          </div>
        </div>

        <div class="design-block">
          <h3>biometric — off (settings card)</h3>
          <p style="color:var(--dim);font-size:0.85em"><em>Default state in settings → security. Offers Face ID / fingerprint as a second factor before any approval or unlock. renderBiometricCard is file-local to settings.js; rendered here as a static snapshot. settings.js:587.</em></p>
          <div id="design-auth-bio-off-slot" style="max-width:520px;margin-top:0.5em"></div>
        </div>

        <div class="design-block">
          <h3>biometric — on (settings card)</h3>
          <p style="color:var(--dim);font-size:0.85em"><em>After the person enrolls — unlocking and approvals require their device biometric.</em></p>
          <div id="design-auth-bio-on-slot" style="max-width:520px;margin-top:0.5em"></div>
          <h3>full dashboard — live <code>renderVault</code> <code>draft</code></h3>
          <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.75em">
            The vault page's complete surface, rendered inline into the slot below
            against a dense fixture. If <code>renderVault</code> is exposed from
            <code>public/js/vault.js</code> the live function fills this slot and
            its internal state produces the sub-views (swap sheet, breakdown
            toggle, savings expansion). Otherwise the slot falls back to a short
            note so the catalog keeps rendering — see the snapshots below for the
            sub-view shapes.
          </p>
          <div id="design-vault-dashboard-slot" style="max-width:720px"></div>
        </div>

        <div class="design-block">
          <h3>chain balance list (snapshot) <code>draft</code></h3>
          <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.75em">
            The per-chain breakdown that opens when you tap the total. Dollar
            equivalent primary, token amount secondary.
          </p>
          <div class="vault-doc" style="max-width:520px">
            <div class="vault-lead-breakdown" style="display:block">
              <div class="vault-lead-row">
                <span class="vault-lead-row-name">Optimism</span>
                <span class="vault-lead-row-bal">1.2346 <span style="color:var(--dim)">ETH</span></span>
                <span class="vault-lead-row-fiat">$4,567.89</span>
              </div>
              <div class="vault-lead-row">
                <span class="vault-lead-row-name">Base</span>
                <span class="vault-lead-row-bal">0.2340 <span style="color:var(--dim)">ETH</span></span>
                <span class="vault-lead-row-fiat">$870.12</span>
              </div>
              <div class="vault-lead-row">
                <span class="vault-lead-row-name">Ethereum <span style="color:var(--dim);font-size:0.9em">· BOLD savings</span></span>
                <span class="vault-lead-row-bal">1,750.00 <span style="color:var(--dim)">BOLD</span></span>
                <span class="vault-lead-row-fiat">$1,750.00</span>
          <h3>sell this work <code>draft</code></h3>
          <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.5em">
            per-item sell widget inside a module editor. mock item is
            unlisted so the "sell this work" shape renders. calls
            <code>renderSellWidget(item, id)</code> at settings.js:3108.
          </p>
          <div id="design-settings-sell-slot" class="design-settings-slot" style="max-width:560px"></div>
        </div>

        <div class="design-block">
          <h3>blog collections</h3>
          <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.5em">
            group your posts under names. lives at the bottom of the modules
            tab. calls <code>renderBlogCollectionsSection()</code> at settings.js:2663.
          </p>
          <div id="design-settings-blog-slot" class="design-settings-slot" style="max-width:560px;border:1px solid var(--border);border-radius:8px;padding:1em;background:color-mix(in srgb,var(--fg) 2%,transparent)"></div>
        </div>

        <div class="design-block">
          <h3>edit a module</h3>
          <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.5em">
            the per-module editor (music variant shown). the real surface
            fills out from live data. calls
            <code>renderModuleEditor(el, { name: 'music', items: [] })</code>
            at settings.js:3743.
          </p>
          <div id="design-settings-module-editor-slot" class="design-settings-slot" style="max-width:560px;border:1px solid var(--border);border-radius:8px;padding:1em;background:color-mix(in srgb,var(--fg) 2%,transparent)"></div>
        </div>

        <div class="design-block">
          <h3>upload your picture <code>draft</code></h3>
          <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.5em">
            avatar upload affordance inside the identity tab. the upload
            path auto-shrinks to 512px before sending, no cropper in flight
            today. snapshot of the upload row.
          </p>
          <div style="max-width:560px;border:1px solid var(--border);border-radius:8px;padding:1em;background:color-mix(in srgb,var(--fg) 2%,transparent)">
            <div class="settings-field">
              <label class="settings-label" style="font-size:0.8em;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em">profile picture</label>
              <div style="display:flex;align-items:center;gap:1em;margin-top:0.5em">
                <div style="width:64px;height:64px;border-radius:50%;border:1px solid var(--border);overflow:hidden;flex-shrink:0;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb,var(--fg) 4%,transparent)">
                  <span style="font-size:0.7em;color:var(--dim)">none</span>
                </div>
                <button type="button" class="btn-small buy-btn" style="font-size:0.8em;padding:0.3em 1ch">upload</button>
              </div>
          <h3>start a group — group picker (static shape) <code>draft</code></h3>
          <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.75em">
            shape of <code>showGroupPicker()</code> → <code>_renderGroupForm()</code>
            at messages.js:493 — name the group, pick people. file-local,
            routed through /messages.
          </p>
          <div class="msg-compose-sheet" style="position:static;max-width:360px;margin:0;padding:1em;background:var(--bg);border:1px solid var(--border);border-radius:12px">
            <div class="msg-picker-header" style="display:flex;align-items:center;gap:0.75ch;margin-bottom:0.75em">
              <button class="msg-picker-back" style="background:none;border:none;color:var(--muted);cursor:pointer;padding:0"><i class="ph ph-arrow-left"></i></button>
              <span style="color:var(--fg);font-size:0.95em">a new group</span>
            </div>
            <div style="padding:0 0.25em">
              <div style="font-size:0.75em;color:var(--muted);margin-bottom:0.3em">a name</div>
              <input type="text" placeholder="e.g. the crew" style="width:100%;padding:0.5em;margin-bottom:0.75em;background:var(--surface);border:1px solid var(--border);color:var(--fg);font-family:inherit;font-size:0.85em;border-radius:4px;box-sizing:border-box">
              <div style="font-size:0.75em;color:var(--muted);margin-bottom:0.3em">the people in it</div>
              <div class="group-chips-wrap">
                <span class="group-chip">nappynina <i class="ph ph-x" style="cursor:pointer;font-size:0.8em;opacity:0.7"></i></span>
                <span class="group-chip">blackmatter <i class="ph ph-x" style="cursor:pointer;font-size:0.8em;opacity:0.7"></i></span>
              </div>
              <input type="text" placeholder="search" style="width:100%;padding:0.5em;margin-bottom:0.5em;background:var(--surface);border:1px solid var(--border);color:var(--fg);font-family:inherit;font-size:0.85em;border-radius:4px;box-sizing:border-box">
              <div>
                <div class="msg-member-row"><div class="msg-convo-avatar" style="background:#444">M</div><span style="font-size:0.85em">milesxb.bio</span></div>
              </div>
              <button class="msg-compose-option" style="margin-top:0.75em;justify-content:center;font-weight:600;background:none;border:1px solid var(--border);color:var(--fg);padding:0.6em;width:100%;border-radius:4px;cursor:pointer;font-family:inherit">make the group</button>
            </div>
          </div>
        </div>

        <div class="design-block">
          <h3>chat menu — rename, leave, archive <code>draft</code></h3>
          <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.75em">
            no chat-level menu is shipped today — leaving happens from the
            members panel (<code>members-leave-btn</code>, messages.js:4437),
            rename and archive aren't wired. draft shape below so we can
            agree on the words before it ships.
          </p>
          <div style="max-width:260px;background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:0.4em;display:flex;flex-direction:column;gap:0.1em">
            <button class="dd-nav-btn" style="text-align:left"><i class="ph ph-pencil-simple"></i> rename this chat</button>
            <button class="dd-nav-btn" style="text-align:left"><i class="ph ph-archive"></i> move to archive</button>
            <button class="dd-nav-btn" style="text-align:left"><i class="ph ph-bell-slash"></i> mute for a bit</button>
            <div style="height:1px;background:var(--border);margin:0.15em 0"></div>
            <button class="dd-nav-btn" style="text-align:left;color:#ef4444"><i class="ph ph-sign-out"></i> leave this chat</button>
          </div>
        </div>

        <div class="design-block">
          <h3>typing indicator — &quot;peer is typing...&quot; (messages.js:1846)</h3>
          <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.75em">
            opener above injects the live indicator into the chat mock
            further up. file-local function — the indicator is appended
            right below <code>#messages-msgs</code>.
          </p>
          <div style="max-width:420px;background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:1em">
            <div class="dm-typing-indicator" style="color:var(--muted);font-size:0.8em;font-style:italic;padding:0.4em 1ch">nappynina is typing...</div>
          </div>
        </div>

        <div class="design-block">
          <h3>markdown message rendering — one bubble, every seam <code>draft</code></h3>
          <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.75em">
            mirror of <code>renderMessageContent()</code> (messages.js:2936).
            it escapes HTML, then expands four patterns: <code>[image:…](…)</code>,
            <code>[video:…](…)</code>, <code>[pdf:…](…)</code>, and any
            https?:// URL (praxis domains become a preview card; everything
            else a plain link). markdown-style <code>**bold**</code> /
            <code>_italic_</code> / <code>@mentions</code> aren't parsed
            today — they render as literal text. file-local, so the row
            below shows the actual output shape.
          </p>
          <div style="max-width:420px;padding:1em;background:var(--bg);border:1px solid var(--border);border-radius:10px">
            <div style="color:var(--dim);font-size:0.7em;margin-bottom:0.3em">sample: <code>hello [link](https://praxis) @nappynina **bold** _italic_</code></div>
            <div class="dm-msg dm-msg-theirs">
              <div class="dm-bubble msg-text">hello [link](https://praxis) @nappynina **bold** _italic_</div>
              <div class="dm-time">now</div>
            </div>
          </div>
        </div>

        <div class="design-block">
          <h3>reactions bar — shape only <code>draft</code></h3>
          <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.75em">
            today only the heart ships (double-tap a message, messages.js:3192).
            the shape below is the multi-emoji + overflow count we'd grow
            into — mirrors the pill style at messages.js:3101.
          </p>
          <div style="max-width:420px;padding:1em;background:var(--bg);border:1px solid var(--border);border-radius:10px">
            <div class="dm-msg dm-msg-theirs">
              <div class="dm-bubble">one sentence, read a few times.</div>
              <div class="msg-reaction" style="font-size:0.85em;margin-top:0.25em;display:flex;gap:0.3em;flex-wrap:wrap">
                <span style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:0.1em 0.5em;font-size:0.9em">&#x2764; 3</span>
                <span style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:0.1em 0.5em;font-size:0.9em">&#x1F525; 2</span>
                <span style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:0.1em 0.5em;font-size:0.9em">&#x1F44F;</span>
                <span style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:0.1em 0.5em;font-size:0.9em">&#x1F60A;</span>
                <span style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:0.1em 0.5em;font-size:0.9em;color:var(--dim)">+4</span>
              </div>
            </div>
          </div>
        </div>

        <div class="design-block">
          <h3>emoji picker — not shipped <code>draft</code></h3>
          <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.75em">
            no <code>showEmojiPicker()</code> lives in messages.js today.
            reactions are the heart only. draft shape below — a short
            tray of six, with a &quot;more&quot; button for the long list.
          </p>
          <div style="max-width:320px;padding:0.5em;background:var(--bg);border:1px solid var(--border);border-radius:14px;display:flex;align-items:center;gap:0.3ch">
            <button style="background:none;border:none;font-size:1.3em;cursor:pointer;padding:0.1em 0.4ch">&#x2764;</button>
            <button style="background:none;border:none;font-size:1.3em;cursor:pointer;padding:0.1em 0.4ch">&#x1F525;</button>
            <button style="background:none;border:none;font-size:1.3em;cursor:pointer;padding:0.1em 0.4ch">&#x1F44F;</button>
            <button style="background:none;border:none;font-size:1.3em;cursor:pointer;padding:0.1em 0.4ch">&#x1F60A;</button>
            <button style="background:none;border:none;font-size:1.3em;cursor:pointer;padding:0.1em 0.4ch">&#x1F62E;</button>
            <button style="background:none;border:none;font-size:1.3em;cursor:pointer;padding:0.1em 0.4ch">&#x1F622;</button>
            <button style="background:none;border:1px solid var(--border);color:var(--muted);font-size:0.75em;padding:0.3em 0.75ch;cursor:pointer;border-radius:10px;margin-left:auto">more</button>
          </div>
        </div>

        <div class="design-block">
          <h3>attachment — image preview (messages.js:2945)</h3>
          <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.75em">
            an image embed in a bubble — rendered when a message body
            holds <code>[image:name](url)</code>. the bubble loses its
            inner padding so the picture fills edge-to-edge.
          </p>
          <div style="max-width:380px;padding:1em;background:var(--bg);border:1px solid var(--border);border-radius:10px">
            <div class="dm-msg dm-msg-theirs">
              <div class="dm-bubble" style="padding:0;overflow:hidden">
                <div class="dm-img-wrap" style="margin:0;position:relative">
                  <div style="width:260px;height:180px;background:linear-gradient(120deg,#334,#556);display:flex;align-items:center;justify-content:center;color:#fff;font-size:0.8em">a picture lives here</div>
                  <a href="#" class="dm-img-download" title="download" style="position:absolute;top:0.4em;right:0.4em;padding:0.3em;border-radius:4px;background:rgba(0,0,0,0.5);color:#fff;opacity:1"><i class="ph ph-download-simple"></i></a>
                </div>
              </div>
              <div class="dm-time">now</div>
            </div>
          </div>
        </div>

        <div class="design-block">
          <h3>BOLD yield block (snapshot) <code>draft</code></h3>
          <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.75em">
            The savings section — a dollar-stable coin earning interest on its own.
            Numbers derived from the fixture: 1,250 liquid + 500 in a pool at 8.2%.
          </p>
          <div class="vault-doc" style="max-width:520px">
            <section class="vault-act vault-act-savings">
              <header class="vault-act-head">
                <h2 class="vault-act-title">savings</h2>
                <span class="vault-act-badge">8.2% APR available</span>
              </header>
              <div class="vault-act-figure vault-coin-figure">
                <span class="vault-coin-mark"><i class="ph ph-coin" style="font-size:1.4em;color:var(--green)"></i></span>
                <span class="vault-act-figure-main">1,750.00</span>
                <span class="vault-act-figure-unit">BOLD</span>
                <span class="vault-act-figure-secondary">$1,750.00</span>
              </div>
              <div class="vault-act-yield">
                earning <span style="color:var(--green)">$3.42/mo</span> — $41.00/yr projected
              </div>
              <div class="vault-act-sub">500.00 earning yield, 1,250.00 liquid</div>
            </section>
          </div>
        </div>

        <div class="design-block">
          <h3>SP deposits (snapshot) <code>draft</code></h3>
          <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.75em">
            The per-pool table below the savings figure. Your pool carries a dot
            + your balance; other pools read as options you can move into.
          </p>
          <div class="vault-doc" style="max-width:520px">
            <div class="vault-pool-table">
              <div class="vault-pool-table-head vault-pool-table-head-4"><span>pool</span><span>apr</span><span>30d</span><span>size</span></div>
              <div class="vault-pool-line vault-pool-line-4col vault-pool-line-active">
                <span class="vault-pool-line-name-you">
                  <span class="vault-pool-line-dot"></span>
                  <span><span class="vault-pool-line-name-main">ETH</span><span class="vault-pool-line-you-sub">you — 500.00 BOLD</span></span>
                </span>
                <span class="vault-pool-line-apr">8.2%</span>
                <span class="vault-pool-line-apr" style="color:var(--dim)">7.9%</span>
                <span class="vault-pool-line-tvl">$42.3M</span>
              </div>
              <div class="vault-pool-line vault-pool-line-4col">
                <span class="vault-pool-line-name">wstETH</span>
                <span class="vault-pool-line-apr">6.1%</span>
                <span class="vault-pool-line-apr" style="color:var(--dim)">5.8%</span>
                <span class="vault-pool-line-tvl">$18.7M</span>
              </div>
              <div class="vault-pool-line vault-pool-line-4col">
                <span class="vault-pool-line-name">rETH</span>
                <span class="vault-pool-line-apr">4.9%</span>
                <span class="vault-pool-line-apr" style="color:var(--dim)">4.6%</span>
                <span class="vault-pool-line-tvl">$9.1M</span>
              </div>
              <div class="vault-pool-meta">
                <span>rates updated 2m ago</span>
                <button type="button" class="vault-pool-meta-toggle" aria-expanded="false">how this works ↓</button>
              </div>
          <h3>attachment — video preview (messages.js:2953)</h3>
          <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.75em">
            same shape as an image, with native <code>controls</code> on
            the video. poster frame comes from <code>/api/video-thumb</code>.
          </p>
          <div style="max-width:380px;padding:1em;background:var(--bg);border:1px solid var(--border);border-radius:10px">
            <div class="dm-msg dm-msg-theirs">
              <div class="dm-bubble" style="padding:0;overflow:hidden">
                <div class="dm-img-wrap" style="margin:0;position:relative">
                  <div style="width:260px;height:180px;background:linear-gradient(120deg,#223,#445);display:flex;align-items:center;justify-content:center;color:#fff"><i class="ph ph-play-circle" style="font-size:3em;opacity:0.9"></i></div>
                  <a href="#" class="dm-img-download" title="download" style="position:absolute;top:0.4em;right:0.4em;padding:0.3em;border-radius:4px;background:rgba(0,0,0,0.5);color:#fff;opacity:1"><i class="ph ph-download-simple"></i></a>
                </div>
              </div>
              <div class="dm-time">now</div>
            </div>
          </div>
        </div>

        <div class="design-block">
          <h3>unclaimed earnings panel (snapshot) <code>draft</code></h3>
          <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.75em">
            What's waiting for you to pull in. The fixture's 0.042 ETH shown
            dollar-first; one tap approves the pull.
          </p>
          <div class="vault-doc" style="max-width:520px">
            <section class="vault-act">
              <header class="vault-act-head">
                <h2 class="vault-act-title">unclaimed</h2>
              </header>
              <div class="vault-act-figure">
                <span class="vault-act-figure-main">$155.40</span>
                <span class="vault-act-figure-secondary">0.042 ETH</span>
              </div>
              <div class="vault-act-sub">one place is holding it for you — pull it in</div>
              <div class="vault-lead-verbs" style="margin-top:0.75em">
                <button type="button" class="vault-verb">pull earnings</button>
              </div>
            </section>
          <h3>attachment — link preview (messages.js:2974)</h3>
          <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.75em">
            a praxis domain url becomes a card — <code>/og/index.png</code>
            on top, the domain under it. any other url renders as a plain
            accent-color link.
          </p>
          <div style="max-width:380px;padding:1em;background:var(--bg);border:1px solid var(--border);border-radius:10px">
            <div class="dm-msg dm-msg-theirs">
              <div class="dm-bubble" style="padding:0;overflow:hidden">
                <a class="dm-og-card" href="#" style="display:block;text-decoration:none;color:inherit;min-width:260px">
                  <div style="width:100%;aspect-ratio:1200/630;background:linear-gradient(120deg,#7c3aed,#db2777)"></div>
                  <div class="dm-og-domain" style="padding:0.5em 0.8em;font-size:0.85em;color:var(--accent)">nappynina.com</div>
                </a>
              </div>
              <div class="dm-time">now</div>
            </div>
          </div>
        </div>

        <div class="design-block">
          <h3>total + breakdown toggle (snapshot) <code>draft</code></h3>
          <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.75em">
            The lead number + caret that opens the chain breakdown above. Eye
            icon toggles private mode; four verbs sit under the number. Shape
            mirrors <code>renderVault</code>'s lead section.
          </p>
          <div class="vault-doc" style="max-width:520px">
            <section class="vault-lead">
              <div class="vault-lead-label">
                total balance
                <button type="button" class="vault-privacy-toggle" aria-label="hide values"><i class="ph ph-eye"></i></button>
              </div>
              <button type="button" class="vault-lead-toggle" aria-expanded="false">
                <span class="vault-lead-value">$7,187.01</span>
                <span class="vault-lead-caret" aria-hidden="true">▾</span>
              </button>
              <div class="vault-lead-meta">
                <span class="vault-lead-chip"><span class="vault-lead-chip-key">earned</span> <span style="color:var(--green)">$3,300.40</span></span>
                <span class="vault-lead-chip"><span class="vault-lead-chip-key">spent</span> $5,180.00</span>
                <span class="vault-lead-chip"><span class="vault-lead-chip-key">net</span> <span style="color:var(--fg)">−$1,879.60</span></span>
              </div>
              <div class="vault-lead-verbs">
                <button type="button" class="vault-verb">send</button>
                <button type="button" class="vault-verb">receive</button>
                <button type="button" class="vault-verb">add funds</button>
                <button type="button" class="vault-verb">cash out</button>
              </div>
            </section>
          <h3>reading language <code>draft</code></h3>
          <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.5em">
            the picker lives in the account menu (template layout.html),
            not in the settings panel. snapshot of the live select,
            same shape across every template.
          </p>
          <div style="max-width:560px;border:1px solid var(--border);border-radius:8px;padding:1em;background:color-mix(in srgb,var(--fg) 2%,transparent);display:flex;align-items:center;gap:1ch">
            <label style="font-size:0.85em;color:var(--muted)">read the site in</label>
            <select class="lang-switcher project-input" style="font-size:0.85em;padding:0.3em 1ch;max-width:16ch">
              <option>english</option>
              <option>español</option>
              <option>français</option>
              <option>português</option>
              <option>deutsch</option>
              <option>日本語</option>
              <option>中文</option>
              <option>العربية</option>
            </select>
          <h3>add participants — group member picker (messages.js:4413)</h3>
          <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.75em">
            the list <code>renderAddList()</code> paints inside the group
            members panel. three mutuals, searchable. file-local — the
            opener routes to /messages &rarr; group header &rarr; add
            member.
          </p>
          <div style="max-width:320px;padding:0.75em;background:var(--bg);border:1px solid var(--border);border-radius:8px">
            <input type="text" placeholder="search" style="width:100%;padding:0.4em;margin-bottom:0.4em;background:var(--surface);border:1px solid var(--border);color:var(--fg);font-family:inherit;font-size:0.8em;border-radius:4px;box-sizing:border-box">
            <div id="design-msg-addlist">
              <div class="msg-member-row"><div class="msg-convo-avatar" style="background:#444">N</div><span style="font-size:0.8em">nappynina.com</span></div>
              <div class="msg-member-row"><div class="msg-convo-avatar" style="background:#555">B</div><span style="font-size:0.8em">blackmatter.world</span></div>
              <div class="msg-member-row"><div class="msg-convo-avatar" style="background:#666">M</div><span style="font-size:0.8em">milesxb.bio</span></div>
            </div>
          </div>
        </div>

        <div class="design-block">
          <h3>filter chips — unread, groups, DMs <code>draft</code></h3>
          <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.75em">
            not shipped today — the sidebar separates mutuals from
            requests (messages.js:2343) but has no top-row filter chips.
            draft row below, meant to live above <code>#messages-list</code>.
          </p>
          <div style="max-width:320px;padding:0.75em;background:var(--bg);border:1px solid var(--border);border-radius:8px;display:flex;gap:0.4em">
            <button class="collection-filter collection-filter-active">all</button>
            <button class="collection-filter">unread</button>
            <button class="collection-filter">groups</button>
            <button class="collection-filter">one-to-one</button>
          </div>
        </div>

        <div class="design-block">
          <h3>install-limit recovery view — 10 of 10 (messages.js:3749)</h3>
          <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.75em">
            when the account has used all ten XMTP sessions, the chat
            pane shows a revoke list instead of a conversation. file-local,
            so the shape below mirrors <code>renderStaticInstallations()</code>
            with ten stub rows.
          </p>
          <div id="design-xmtp-installs" style="max-width:480px;padding:1em;background:var(--bg);border:1px solid var(--border);border-radius:10px"></div>
        </div>

        <div class="design-block">
          <h3>DM toast — new message from someone <code>draft</code></h3>
          <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.75em">
            opener fires the real <code>toast()</code> from
            <code>public/js/toast.js</code> in message-type style. the
            production wrapper <code>showMsgToast()</code> (messages.js:1519)
            resolves the sender domain first — file-local, so this
            matches the final HTML it hands to <code>toast()</code>.
          </p>
          <p style="color:var(--dim);font-size:0.8em">click the opener above — it lands bottom-right.</p>
        </div>

        <div class="design-block">
          <h3>unread dot — on the dock messages icon (style.css:1279)</h3>
          <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.75em">
            a tiny red dot sits on the messages icon when something new
            is waiting. <code>.dock-msg-dot</code> — positioned absolute
            top-right of the button. snapshot below.
          </p>
          <div style="display:flex;gap:1.5em;align-items:center">
            <button style="position:relative;background:none;border:1px solid var(--border);color:var(--fg);width:3em;height:3em;border-radius:8px;cursor:pointer">
              <i class="ph ph-chat-circle" style="font-size:1.2em"></i>
              <span class="dock-msg-dot" style="position:absolute;top:0;right:0;width:6px;height:6px;background:#ef4444;border-radius:50%;pointer-events:none;font-size:0">unread</span>
            </button>
            <span style="color:var(--dim);font-size:0.85em">messages icon with an unread flag</span>
          </div>
        </div>
      <!-- ─────────── 18 · primitives & chrome ─────────── -->
      <section class="design-section">
        <h2 class="design-section-title">18 · primitives & chrome</h2>
        <p style="color:var(--muted);margin-bottom:1.5em;max-width:60ch">
          The foundations everything else sits on — toasts, skeletons,
          the modal shell, form controls, chrome. Live openers where it
          matters; static markup where the shape is the point. Any copy
          marked <code>draft</code> is Miles's to replace.
        </p>

        <div id="design-primitives-openers" style="display:flex;flex-wrap:wrap;gap:0.5em;margin-bottom:1.5em">
          <button class="dw-chip-pill" data-open="prim-toast-default"><i class="dw-chip-pill__icon ph ph-chat-centered-text" aria-hidden="true"></i>toast</button>
          <button class="dw-chip-pill dw-chip-pill--success" data-open="prim-toast-success"><i class="dw-chip-pill__icon ph ph-check-circle" aria-hidden="true"></i>success toast</button>
          <button class="dw-chip-pill dw-chip-pill--danger" data-open="prim-toast-error"><i class="dw-chip-pill__icon ph ph-warning-circle" aria-hidden="true"></i>error toast</button>
          <button class="dw-chip-pill" data-open="prim-toast-message"><i class="dw-chip-pill__icon ph ph-envelope-simple" aria-hidden="true"></i>message toast</button>
          <button class="dw-chip-pill" data-open="prim-modal"><i class="dw-chip-pill__icon ph ph-square" aria-hidden="true"></i>modal</button>
          <button class="dw-chip-pill" data-open="prim-sheet"><i class="dw-chip-pill__icon ph ph-arrow-line-up" aria-hidden="true"></i>bottom sheet</button>
          <button class="dw-chip-pill dw-chip-pill--danger" data-open="prim-confirm"><i class="dw-chip-pill__icon ph ph-warning" aria-hidden="true"></i>destructive confirm</button>
          <button class="dw-chip-pill" data-open="prim-copy"><i class="dw-chip-pill__icon ph ph-copy" aria-hidden="true"></i>copy to clipboard</button>
        </div>

        <!-- Toasts -->
        <div class="design-block">
          <h3>toast — default (toast.js)</h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            <code>toast('your post was published')</code> — neutral confirm. 4s auto-dismiss, swipe to clear. Click the opener above.
          </p>
          <div class="toast-item toast-visible" style="position:static;max-width:320px">your post was published</div>
        </div>
        <div class="design-block">
          <h3>toast — success (toast.js)</h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            <code>toast.success('invite sent')</code> — green left-rule. For completed actions.
          </p>
          <div class="toast-item toast-success toast-visible" style="position:static;max-width:320px">invite sent</div>
        </div>
        <div class="design-block">
          <h3>toast — error (toast.js)</h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            <code>toast.error("something didn't go through")</code> — red left-rule. Short and plain; never scold.
          </p>
          <div class="toast-item toast-error toast-visible" style="position:static;max-width:320px">something didn't go through</div>
        </div>
        <div class="design-block">
          <h3>toast — message (toast.js)</h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            <code>toast.message('new message from nappynina')</code> — accent left-rule. Used for inbound DM pings.
          </p>
          <div class="toast-item toast-message toast-visible" style="position:static;max-width:320px">new message from nappynina</div>
        </div>

        <!-- Skeletons -->
        <div class="design-block">
          <h3>skeleton — base block (style.css:5271)</h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            <code>.skeleton</code> — pulse 1.5s, <code>var(--surface)</code>. All other skeleton classes layer dimensions on top.
          </p>
          <div class="skeleton" style="height:3em;width:100%;border-radius:4px"></div>
        </div>
        <div class="design-block">
          <h3>skeleton — text line</h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em"><code>.skeleton .skeleton-text</code> — 0.9em tall, full width.</p>
          <div class="skeleton skeleton-text" style="width:100%"></div>
          <div class="skeleton skeleton-text" style="width:92%"></div>
          <div class="skeleton skeleton-text" style="width:78%"></div>
        </div>
        <div class="design-block">
          <h3>skeleton — title</h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em"><code>.skeleton .skeleton-title</code> — 1.2em tall, 60% width.</p>
          <div class="skeleton skeleton-title"></div>
        </div>
        <div class="design-block">
          <h3>skeleton — block</h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em"><code>.skeleton .skeleton-block</code> — 4em tall, full width. Placeholder for a card or row.</p>
          <div class="skeleton skeleton-block"></div>
        </div>
        <div class="design-block">
          <h3>spinner — inline pulse <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">Small round pulse for inline wait. No shipped primitive today; this is the shape we'd ship.</p>
          <span class="skeleton" style="display:inline-block;width:1em;height:1em;border-radius:50%;vertical-align:middle"></span>
          <span style="color:var(--muted);margin-left:0.5em">one moment</span>
        </div>

        <!-- Modal shells -->
        <div class="design-block">
          <h3>modal shell — overlay + dialog (praxis-modal-*) <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            <code>.praxis-modal-overlay</code> + <code>.praxis-modal-dialog</code>. Backdrop blur, scale-in. Click the opener; click outside or the x to close.
          </p>
          <p style="color:var(--muted);font-size:0.85em;margin:0">example body: "name this draft. you can change it later."</p>
        </div>
        <div class="design-block">
          <h3>bottom sheet — same shell, anchored low <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            Same overlay, dialog pinned to the bottom edge for one-handed phone use. Full-width rail with a grab affordance.
          </p>
        </div>
        <div class="design-block">
          <h3>confirm — destructive variant <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            Red-accent primary. Used for delete, remove, unfollow. Cancel is the quiet button; the destructive button sits to the right.
          </p>
          <p style="color:var(--muted);font-size:0.85em;margin:0">example body: "delete this draft. this can't be undone."</p>
        </div>

        <!-- Form controls -->
        <div class="design-block">
          <h3>textarea — with label</h3>
          <div style="max-width:420px">
            <label style="display:block;color:var(--muted);font-size:0.8em;margin-bottom:0.35em">note</label>
            <textarea class="project-input" rows="3" style="width:100%;resize:vertical;font-family:inherit" placeholder="a line or two"></textarea>
          </div>
        </div>
        <div class="design-block">
          <h3>toggle — on + off</h3>
          <div style="display:flex;gap:1.5em;align-items:center">
            <label style="display:inline-flex;align-items:center;gap:0.6ch;cursor:pointer">
              <span style="position:relative;display:inline-block;width:2.4em;height:1.3em;background:var(--accent);border-radius:999px;transition:background 150ms">
                <span style="position:absolute;top:2px;left:calc(100% - 1.1em - 2px);width:1.1em;height:1.1em;background:var(--bg);border-radius:50%;transition:left 150ms"></span>
              </span>
              <span style="color:var(--fg);font-size:0.9em">on</span>
            </label>
            <label style="display:inline-flex;align-items:center;gap:0.6ch;cursor:pointer">
              <span style="position:relative;display:inline-block;width:2.4em;height:1.3em;background:color-mix(in srgb, var(--fg) 15%, transparent);border-radius:999px;transition:background 150ms">
                <span style="position:absolute;top:2px;left:2px;width:1.1em;height:1.1em;background:var(--muted);border-radius:50%;transition:left 150ms"></span>
              </span>
              <span style="color:var(--muted);font-size:0.9em">off</span>
            </label>
          </div>
        </div>
        <div class="design-block">
          <h3>checkbox — unchecked / checked / indeterminate</h3>
          <div style="display:flex;gap:1.25em;align-items:center">
            <label style="display:inline-flex;gap:0.6ch;align-items:center;color:var(--muted)"><input type="checkbox"> empty</label>
            <label style="display:inline-flex;gap:0.6ch;align-items:center;color:var(--fg)"><input type="checkbox" checked> checked</label>
            <label style="display:inline-flex;gap:0.6ch;align-items:center;color:var(--fg)"><input type="checkbox" id="prim-indet"> mixed</label>
          </div>
          <script>(function(){ var el=document.getElementById('prim-indet'); if (el) el.indeterminate = true })()</script>
        </div>
        <div class="design-block">
          <h3>radio — three options, one selected</h3>
          <div style="display:flex;flex-direction:column;gap:0.35em">
            <label style="display:inline-flex;gap:0.6ch;align-items:center;color:var(--fg)"><input type="radio" name="prim-radio" checked> everyone</label>
            <label style="display:inline-flex;gap:0.6ch;align-items:center;color:var(--muted)"><input type="radio" name="prim-radio"> followers only</label>
            <label style="display:inline-flex;gap:0.6ch;align-items:center;color:var(--muted)"><input type="radio" name="prim-radio"> just you</label>
          </div>
        </div>
        <div class="design-block">
          <h3>select / combobox</h3>
          <select class="project-input" style="max-width:280px">
            <option>theater</option>
            <option>film</option>
            <option>music</option>
            <option>writing</option>
          </select>
        </div>
        <div class="design-block">
          <h3>segmented control — three segments</h3>
          <div style="display:inline-flex;border:1px solid var(--border);border-radius:8px;overflow:hidden;background:color-mix(in srgb, var(--fg) 2%, transparent)">
            <button type="button" style="padding:0.4em 1em;background:var(--accent);color:var(--bg);border:0;font:inherit;cursor:pointer">week</button>
            <button type="button" style="padding:0.4em 1em;background:transparent;color:var(--muted);border:0;font:inherit;cursor:pointer">month</button>
            <button type="button" style="padding:0.4em 1em;background:transparent;color:var(--muted);border:0;font:inherit;cursor:pointer">year</button>
          </div>
        </div>
        <div class="design-block">
          <h3>file picker — styled input</h3>
          <label style="display:inline-flex;align-items:center;gap:0.75ch;padding:0.5em 1em;border:1px dashed var(--border);border-radius:8px;color:var(--muted);cursor:pointer;background:color-mix(in srgb, var(--fg) 2%, transparent)">
            <i class="ph ph-upload-simple" aria-hidden="true"></i>
            <span>choose a file</span>
            <input type="file" style="display:none">
          </label>
        </div>
        <div class="design-block">
          <h3>tag / pill input — three pills + empty slot</h3>
          <div style="display:flex;flex-wrap:wrap;gap:0.35em;align-items:center;max-width:420px;padding:0.4em 0.5em;border:1px solid var(--border);border-radius:8px;background:color-mix(in srgb, var(--fg) 2%, transparent)">
            <span class="chip" style="padding:0.2em 0.7ch;border-radius:999px;background:color-mix(in srgb, var(--accent) 15%, transparent);color:var(--fg);font-size:0.85em;display:inline-flex;align-items:center;gap:0.4ch">theater <span style="color:var(--muted);cursor:pointer">x</span></span>
            <span class="chip" style="padding:0.2em 0.7ch;border-radius:999px;background:color-mix(in srgb, var(--accent) 15%, transparent);color:var(--fg);font-size:0.85em;display:inline-flex;align-items:center;gap:0.4ch">brooklyn <span style="color:var(--muted);cursor:pointer">x</span></span>
            <span class="chip" style="padding:0.2em 0.7ch;border-radius:999px;background:color-mix(in srgb, var(--accent) 15%, transparent);color:var(--fg);font-size:0.85em;display:inline-flex;align-items:center;gap:0.4ch">devised <span style="color:var(--muted);cursor:pointer">x</span></span>
            <input type="text" placeholder="add a tag" style="flex:1;min-width:8ch;border:0;outline:0;background:transparent;color:var(--fg);font:inherit;padding:0.2em">
          </div>
        </div>

        <!-- Chrome -->
        <div class="design-block">
          <h3>dropdown — button + popover shape</h3>
          <div style="max-width:220px;background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:0.4em;display:flex;flex-direction:column;gap:0.1em">
            <button class="dd-nav-btn" type="button">edit</button>
            <button class="dd-nav-btn" type="button">share</button>
            <div style="height:1px;background:var(--border);margin:0.25em 0"></div>
            <button class="dd-nav-btn" type="button" style="color:#e24a4a">delete</button>
          </div>
        </div>
        <div class="design-block">
          <h3>tooltip / popover — hover</h3>
          <div style="position:relative;display:inline-block">
            <button type="button" class="buy-btn">hover me</button>
            <span style="position:absolute;bottom:calc(100% + 0.5em);left:50%;transform:translateX(-50%);padding:0.35em 0.7em;background:color-mix(in srgb, var(--fg) 92%, var(--bg));color:var(--bg);font-size:0.8em;border-radius:6px;white-space:nowrap">one line of context</span>
          </div>
        </div>
        <div class="design-block">
          <h3>inline tabs — three, one active</h3>
          <nav style="display:flex;gap:0.25em;border-bottom:1px solid var(--border)">
            <button type="button" style="padding:0.5em 1em;background:transparent;border:0;border-bottom:2px solid var(--accent);color:var(--fg);font:inherit;cursor:pointer;margin-bottom:-1px">overview</button>
            <button type="button" style="padding:0.5em 1em;background:transparent;border:0;border-bottom:2px solid transparent;color:var(--muted);font:inherit;cursor:pointer;margin-bottom:-1px">activity</button>
            <button type="button" style="padding:0.5em 1em;background:transparent;border:0;border-bottom:2px solid transparent;color:var(--muted);font:inherit;cursor:pointer;margin-bottom:-1px">backers</button>
          </nav>
        </div>
        <div class="design-block">
          <h3>progress bar — 0 / 30 / 70 / 100</h3>
          <div style="display:flex;flex-direction:column;gap:0.75em;max-width:420px">
            <div style="height:6px;background:color-mix(in srgb, var(--fg) 8%, transparent);border-radius:999px;overflow:hidden"><div style="width:0%;height:100%;background:var(--accent)"></div></div>
            <div style="height:6px;background:color-mix(in srgb, var(--fg) 8%, transparent);border-radius:999px;overflow:hidden"><div style="width:30%;height:100%;background:var(--accent)"></div></div>
            <div style="height:6px;background:color-mix(in srgb, var(--fg) 8%, transparent);border-radius:999px;overflow:hidden"><div style="width:70%;height:100%;background:var(--accent)"></div></div>
            <div style="height:6px;background:color-mix(in srgb, var(--fg) 8%, transparent);border-radius:999px;overflow:hidden"><div style="width:100%;height:100%;background:var(--accent)"></div></div>
          </div>
        </div>
        <div class="design-block">
          <h3>pagination — page 2 of 10</h3>
          <nav style="display:inline-flex;gap:0.35em;align-items:center">
            <button type="button" class="buy-btn" style="padding:0.3em 0.9ch">prev</button>
            <button type="button" style="padding:0.3em 0.9ch;background:transparent;border:1px solid var(--border);color:var(--muted);font:inherit;cursor:pointer;border-radius:6px">1</button>
            <button type="button" style="padding:0.3em 0.9ch;background:var(--accent);border:1px solid var(--accent);color:var(--bg);font:inherit;cursor:pointer;border-radius:6px">2</button>
            <button type="button" style="padding:0.3em 0.9ch;background:transparent;border:1px solid var(--border);color:var(--muted);font:inherit;cursor:pointer;border-radius:6px">3</button>
            <span style="color:var(--dim);padding:0 0.4em">…</span>
            <button type="button" style="padding:0.3em 0.9ch;background:transparent;border:1px solid var(--border);color:var(--muted);font:inherit;cursor:pointer;border-radius:6px">10</button>
            <button type="button" class="buy-btn" style="padding:0.3em 0.9ch">next</button>
          </nav>
        </div>
        <div class="design-block">
          <h3>load more — button</h3>
          <button type="button" class="buy-btn">load more</button>
        </div>
        <div class="design-block">
          <h3>infinite-scroll sentinel — small loader at bottom</h3>
          <div style="display:flex;justify-content:center;padding:1.5em 0;color:var(--muted);font-size:0.85em;align-items:center;gap:0.6ch">
            <span class="skeleton" style="display:inline-block;width:0.75em;height:0.75em;border-radius:50%"></span>
            <span>loading more</span>
          </div>
        </div>
        <div class="design-block">
          <h3>inline avatar — live from utils.inlineAvatar</h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            <code>inlineAvatar(addr)</code> from utils.js. Falls back to an empty string when no cached picture — so adjacent text stays on its own baseline.
          </p>
          <div style="display:flex;align-items:center;gap:0.6ch">
            ${inlineAvatar(A_ADDR)}
            <span style="color:var(--muted);font-size:0.9em">${mockResolve(A_ADDR)} — no cached pic, so this prints as empty today</span>
          </div>
        </div>
        <div class="design-block">
          <h3>copy to clipboard — static + live</h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            Static shape (left). The opener above copies a stub string via <code>utils.copyToClipboard</code>.
          </p>
          <button type="button" class="buy-btn" style="display:inline-flex;align-items:center;gap:0.5ch">
            <i class="ph ph-copy" aria-hidden="true"></i>
            <span>copy link</span>
          </button>
        </div>
        <div class="design-block">
          <h3>pulse — unread dot</h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">Used on bell, dock, conversation rows. Accent color, 8px.</p>
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 0 color-mix(in srgb, var(--accent) 60%, transparent);animation:praxis-prim-pulse 1.6s ease-out infinite"></span>
        </div>
        <style>
          @keyframes praxis-prim-pulse {
            0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 60%, transparent); }
            70% { box-shadow: 0 0 0 10px transparent; }
            100% { box-shadow: 0 0 0 0 transparent; }
          }
        </style>
      </section>

      <!-- ─────────── 19 · making & writing ─────────── -->
      <section class="design-section">
        <h2 class="design-section-title">19 · making & writing</h2>
        <p style="color:var(--muted);margin-bottom:1.5em;max-width:60ch">
          every authoring surface in one scroll — compose, reply, journal,
          screenplay. openers hand off to the live /write and /journal pages.
          where a renderer is file-local (reply form, post history, journal,
          script editor), the catalog mirrors its shape with a
          <code>draft</code> marker in the heading so miles's pass is
          unmistakable.
        </p>

        <div class="design-btn-row" id="design-make-openers">
          <button class="buy-btn" data-open="make-compose-blog">start a new post</button>
          <button class="buy-btn" data-open="make-compose-amend">open a post to amend</button>
          <button class="buy-btn" data-open="make-reply">jump to reply form</button>
          <button class="buy-btn" data-open="make-history">jump to post history</button>
          <button class="buy-btn" data-open="make-journal-unlock">jump to journal unlock</button>
          <button class="buy-btn" data-open="make-journal-editor">jump to journal editor</button>
          <button class="buy-btn" data-open="make-script-editor">jump to screenplay editor</button>
          <button class="buy-btn" data-open="make-autocomplete">jump to name autocomplete</button>
        </div>
        <p id="design-make-fallback" style="color:var(--muted);font-size:0.85em;margin:0.25em 0 1em;min-height:1.2em"></p>

        <!-- compose — new draft, live via /write -->
        <div class="design-block">
          <h3>compose — a new post</h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            <code>window.openComposeModal(blogAddr, null, '', '', opts)</code>
            at <code>public/js/write.js:964</code>. the live function redirects
            to <code>/write</code>, where the toolbar, @-mentions, reference
            attach, media attach and preview tab all live. the opener above
            opens /write in a new tab so the catalog view stays alongside.
            mock blog: <code>0x0000000000000000000000000000000000000Bl0</code>.
          </p>
          <p style="color:var(--dim);font-size:0.8em;margin:0">live surface — strings on /write are miles-authored. this entry stays a pointer.</p>
        </div>

        <!-- compose — amendment of post variant -->
        <div class="design-block">
          <h3>compose — amending a post</h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            same opener with <code>amendPostId</code> set, plus
            <code>prefillTitle</code> / <code>prefillContent</code>. on
            <code>/write</code>, the compose form surfaces an "editing post"
            badge and routes through <code>BlogRegistry.amend</code> on
            confirm. mock post id: <code>42</code>.
          </p>
          <p style="color:var(--dim);font-size:0.8em;margin:0">live surface. prefill copy in the catalog opener is marked <code>draft</code> so a stray screenshot reads as a draft.</p>
        </div>

        <!-- reply form mirror -->
        <div class="design-block" id="design-make-reply-block">
          <h3>reply form <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            <code>renderReplyForm(blogAddr, postId)</code> at
            <code>public/js/post.js:1032</code> is file-local — not exported,
            not on window. mirrored shape below. the live form writes a
            reply via <code>BlogRegistry.postWithRef</code> with
            <code>refType=3</code>. placeholder, label and status strings
            below are draft stand-ins; the live ones are miles's.
          </p>
          <div class="design-card-frame">
            <div style="padding-top:1em;max-width:520px">
              <textarea placeholder="write a comment..." style="width:100%;background:transparent;border:1px solid color-mix(in srgb, var(--fg) 15%, transparent);color:var(--fg);font-family:inherit;font-size:0.95em;padding:0.75em 1ch;resize:vertical;min-height:4em;line-height:1.7;border-radius:10px;box-sizing:border-box"></textarea>
              <div style="display:flex;justify-content:space-between;align-items:center;margin-top:0.75em">
                <span style="color:var(--muted);font-size:0.85em"></span>
                <button class="buy-btn" style="font-size:0.85em;padding:0.4em 2ch;border-radius:8px">comment</button>
      <!-- ─────────── 21 · project lifecycle ─────────── -->
      <section class="design-section">
        <h2 class="design-section-title">21 · project lifecycle</h2>
        <p style="color:var(--muted);margin-bottom:1.5em;max-width:60ch">
          Every state a project detail page can sit in — the pill strip, the
          progress panel, the action card below — plus the shared surfaces
          that live under every state (tier grid, comments, check-in). Shapes
          below are static snapshots of <code>project-detail.js</code>; the
          renderers run their own page, so the catalog can't call them live.
          Any invented copy is marked <code>draft</code> in the block header.
          Mock project: <em>draft project</em> — goal $10,000, $6,400 raised, 42 contributors, 30 days left.
        </p>

        <div class="design-btn-row" id="design-proj-openers">
          <button class="buy-btn" data-open="proj-proposed">proposed</button>
          <button class="buy-btn" data-open="proj-funded">funded</button>
          <button class="buy-btn" data-open="proj-delivered">delivered</button>
          <button class="buy-btn" data-open="proj-finalized">finalized</button>
          <button class="buy-btn" data-open="proj-disputed">disputed</button>
          <button class="buy-btn" data-open="proj-cancelled">cancelled</button>
          <button class="buy-btn" data-open="proj-tiers">tier grid</button>
          <button class="buy-btn" data-open="proj-comments">comments</button>
          <button class="buy-btn" data-open="proj-checkin">check-in</button>
          <button class="buy-btn" data-open="proj-dispute">challenge card</button>
          <button class="buy-btn" data-open="proj-finalize">finalize card</button>
        </div>

        <!-- state card · proposed -->
        <div class="design-block" id="design-proj-state-proposed">
          <h3><code>proposed</code> state card <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            Mirrors project-detail.js:641 — pill strip + title + goal panel.
            Status label and color pulled from <code>STATUS_LABELS[0]</code>
            + <code>STATUS_COLORS[0]</code>. Apple one-liner is draft copy.
          </p>
          <div class="design-card-frame">
            <div style="margin-bottom:1em">
              <span style="color:var(--dim);font-size:0.7em;text-transform:uppercase;letter-spacing:0.1em">album</span>
              <span style="color:#c0c0c0;font-size:0.7em;text-transform:uppercase;letter-spacing:0.1em;margin-left:1ch">proposed</span>
            </div>
            <h1 style="color:var(--accent);font-size:1.4em;font-weight:normal;margin:0 0 0.25em">draft project</h1>
            <div style="color:var(--muted);font-size:0.85em;margin-bottom:1em">almost there — $3,600 to go</div>
            <div class="pd-glass">
              <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:0.5em">
                <div>
                  <span style="color:var(--accent);font-size:1.4em;font-weight:700">$6,400</span>
                  <span style="color:var(--muted);font-size:0.85em"> / $10,000</span>
                </div>
                <span style="color:#c0c0c0;font-weight:700;font-size:1.2em">64%</span>
              </div>
              <div class="project-progress-bar"><div class="project-progress-fill" style="width:64%"></div></div>
              <div style="display:flex;gap:2em;font-size:0.8em;color:var(--muted);margin-top:0.5em">
                <span><span style="color:var(--fg);font-weight:600">42</span> backers</span>
                <span><span style="color:var(--fg);font-weight:600">30</span> days left</span>
              </div>
            </div>
          </div>
        </div>

        <!-- state card · funded -->
        <div class="design-block" id="design-proj-state-funded">
          <h3><code>funded</code> state card <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            Goal met — green pill + full bar. Label from <code>STATUS_LABELS[1]</code>;
            color <code>#4ade80</code>. One-liner invented.
          </p>
          <div class="design-card-frame">
            <div style="margin-bottom:1em">
              <span style="color:var(--dim);font-size:0.7em;text-transform:uppercase;letter-spacing:0.1em">album</span>
              <span style="color:#4ade80;font-size:0.7em;text-transform:uppercase;letter-spacing:0.1em;margin-left:1ch">funded</span>
            </div>
            <h1 style="color:var(--accent);font-size:1.4em;font-weight:normal;margin:0 0 0.25em">draft project</h1>
            <div style="color:var(--muted);font-size:0.85em;margin-bottom:1em">funded — $10,000 from 42 contributors</div>
            <div class="pd-glass">
              <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:0.5em">
                <div>
                  <span style="color:var(--accent);font-size:1.4em;font-weight:700">$10,000</span>
                  <span style="color:var(--muted);font-size:0.85em"> / $10,000</span>
                </div>
                <span style="color:#4ade80;font-weight:700;font-size:1.2em">100%</span>
              </div>
              <div class="project-progress-bar"><div class="project-progress-fill" style="width:100%"></div></div>
              <div style="display:flex;gap:2em;font-size:0.8em;color:var(--muted);margin-top:0.5em">
                <span><span style="color:var(--fg);font-weight:600">42</span> backers</span>
                <span><span style="color:var(--fg);font-weight:600">30</span> days left</span>
              </div>
            </div>
          </div>
        </div>

        <!-- state card · delivered (completing) -->
        <div class="design-block" id="design-proj-state-delivered">
          <h3><code>delivered</code> state card <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            Maps to <code>STATUS_LABELS[3]</code> (<code>completing</code>) —
            proposer has marked the work delivered, backers have a window to
            raise a challenge. Color <code>#fbbf24</code>.
          </p>
          <div class="design-card-frame">
            <div style="margin-bottom:1em">
              <span style="color:var(--dim);font-size:0.7em;text-transform:uppercase;letter-spacing:0.1em">album</span>
              <span style="color:#fbbf24;font-size:0.7em;text-transform:uppercase;letter-spacing:0.1em;margin-left:1ch">completing</span>
            </div>
            <h1 style="color:var(--accent);font-size:1.4em;font-weight:normal;margin:0 0 0.25em">draft project</h1>
            <div style="color:var(--muted);font-size:0.85em;margin-bottom:1em">delivered — thank you</div>
            <div class="pd-glass">
              <div style="padding:0.75em;border:1px solid rgba(251,191,36,0.2);border-radius:8px;background:rgba(251,191,36,0.04);margin-bottom:1em;display:flex;align-items:center;gap:0.75em">
                <i class="ph ph-warning" style="color:#fbbf24;font-size:1.2em;flex-shrink:0"></i>
                <span style="font-size:0.85em">backers can raise a challenge for 3 more days</span>
              </div>
            </div>
          </div>
        </div>

        <!-- state card · finalized (completed) -->
        <div class="design-block" id="design-proj-state-finalized">
          <h3><code>finalized</code> state card <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            Maps to <code>STATUS_LABELS[4]</code> (<code>completed</code>) —
            challenge window closed, proposer + collaborators can claim. Color <code>#a78bfa</code>.
          </p>
          <div class="design-card-frame">
            <div style="margin-bottom:1em">
              <span style="color:var(--dim);font-size:0.7em;text-transform:uppercase;letter-spacing:0.1em">album</span>
              <span style="color:#a78bfa;font-size:0.7em;text-transform:uppercase;letter-spacing:0.1em;margin-left:1ch">completed</span>
            </div>
            <h1 style="color:var(--accent);font-size:1.4em;font-weight:normal;margin:0 0 0.25em">draft project</h1>
            <div style="color:var(--muted);font-size:0.85em;margin-bottom:1em">finalized — everyone's paid</div>
            <div class="pd-glass">
              <div class="pd-section-title"><i class="ph ph-lightning" style="margin-right:0.3ch"></i> actions</div>
              <div style="display:flex;gap:0.5em;flex-wrap:wrap">
                <button type="button" class="buy-btn" style="border-color:#4ade80;color:#4ade80;background:transparent;margin-top:0"><i class="ph ph-wallet" style="margin-right:0.3ch"></i> claim funds</button>
                <button type="button" class="buy-btn" style="background:transparent;border:1px solid var(--border);color:var(--fg);margin-top:0"><i class="ph ph-envelope-simple" style="margin-right:0.3ch"></i> claim invite codes</button>
              </div>
            </div>
          </div>
        </div>

        <!-- state card · disputed -->
        <div class="design-block" id="design-proj-state-disputed">
          <h3><code>disputed</code> state card <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            Maps to <code>STATUS_LABELS[6]</code> — a backer challenged the delivery. Color <code>#ef4444</code>. Copy below is draft.
          </p>
          <div class="design-card-frame">
            <div style="margin-bottom:1em">
              <span style="color:var(--dim);font-size:0.7em;text-transform:uppercase;letter-spacing:0.1em">album</span>
              <span style="color:#ef4444;font-size:0.7em;text-transform:uppercase;letter-spacing:0.1em;margin-left:1ch">disputed</span>
            </div>
            <h1 style="color:var(--accent);font-size:1.4em;font-weight:normal;margin:0 0 0.25em">draft project</h1>
            <div style="color:var(--muted);font-size:0.85em;margin-bottom:1em">a backer raised a challenge — we're sorting it</div>
            <div class="pd-glass">
              <div style="padding:0.75em;border:1px solid rgba(239,68,68,0.2);border-radius:8px;background:rgba(239,68,68,0.04);display:flex;align-items:center;gap:0.75em">
                <i class="ph ph-warning" style="color:#ef4444;font-size:1.2em;flex-shrink:0"></i>
                <span style="font-size:0.85em">funds stay held while this is being worked out</span>
              </div>
            </div>
          </div>
        </div>

        <!-- state card · cancelled -->
        <div class="design-block" id="design-proj-state-cancelled">
          <h3><code>cancelled</code> state card <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            <code>STATUS_LABELS[5]</code> — proposer pulled the project (or it
            timed out). Color <code>#666</code>. Refund action card below is
            Miles-authored copy (project-detail.js:574).
          </p>
          <div class="design-card-frame">
            <div style="margin-bottom:1em">
              <span style="color:var(--dim);font-size:0.7em;text-transform:uppercase;letter-spacing:0.1em">album</span>
              <span style="color:#666;font-size:0.7em;text-transform:uppercase;letter-spacing:0.1em;margin-left:1ch">cancelled</span>
            </div>
            <h1 style="color:var(--accent);font-size:1.4em;font-weight:normal;margin:0 0 0.25em">draft project</h1>
            <div style="color:var(--muted);font-size:0.85em;margin-bottom:1em">cancelled — refunds available</div>
            <div class="pd-glass">
              <div class="pd-section-title"><i class="ph ph-lightning" style="margin-right:0.3ch"></i> actions</div>
              <div style="display:flex;gap:0.5em;flex-wrap:wrap">
                <button type="button" class="buy-btn" style="margin-top:0"><i class="ph ph-arrow-counter-clockwise" style="margin-right:0.3ch"></i> claim refund</button>
              </div>
            </div>
          </div>
        </div>

        <!-- tier selection grid -->
        <div class="design-block" id="design-proj-tiers">
          <h3>tier selection grid <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            Shape from project-detail.js:333 (<code>.pd-tier</code>). Three
            tiers — supporter / credits / producer — with the quantity stepper
            + CTA row from <code>p.status &lt;= FUNDED</code>. Tier names and
            prices below are draft.
          </p>
          <div class="design-card-frame">
            <div class="pd-glass" style="padding:0;overflow:hidden">
              <div style="padding:1em 1.25em 0"><div class="pd-section-title"><i class="ph ph-stack" style="margin-right:0.3ch"></i> tiers</div></div>
              <div class="pd-tier">
                <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:1em">
                  <div style="flex:1;min-width:0">
                    <span class="pd-tier-badge" data-tier="supporter">supporter</span>
                    <div class="pd-tier-name">supporter</div>
                  </div>
                  <div style="text-align:right;flex-shrink:0">
                    <div class="pd-tier-price">$20</div>
                    <div class="pd-tier-meta">8/40 sold</div>
                  </div>
                </div>
                <div class="pd-tier-footer">
                  <div class="pd-qty-stepper">
                    <button type="button" class="qty-minus">−</button>
                    <input type="number" class="fund-qty" value="1" min="1" max="32" readonly>
                    <button type="button" class="qty-plus">+</button>
                  </div>
                  <button type="button" class="dw-btn dw-btn--ghost">fund</button>
                </div>
              </div>
              <div class="pd-tier">
                <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:1em">
                  <div style="flex:1;min-width:0">
                    <span class="pd-tier-badge" data-tier="credits">credits</span>
                    <div class="pd-tier-name">credits</div>
                  </div>
                  <div style="text-align:right;flex-shrink:0">
                    <div class="pd-tier-price">$75</div>
                    <div class="pd-tier-meta">12/20 sold</div>
                  </div>
                </div>
                <div class="pd-tier-footer">
                  <div class="pd-qty-stepper">
                    <button type="button" class="qty-minus">−</button>
                    <input type="number" class="fund-qty" value="1" min="1" max="8" readonly>
                    <button type="button" class="qty-plus">+</button>
                  </div>
                  <button type="button" class="dw-btn dw-btn--secondary">fund</button>
                </div>
              </div>
              <div class="pd-tier">
                <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:1em">
                  <div style="flex:1;min-width:0">
                    <span class="pd-tier-badge" data-tier="producer">producer</span>
                    <div class="pd-tier-name">producer</div>
                  </div>
                  <div style="text-align:right;flex-shrink:0">
                    <div class="pd-tier-price">$200</div>
                    <div class="pd-tier-meta">3/10 sold</div>
                  </div>
                </div>
                <div class="pd-tier-footer">
                  <div class="pd-qty-stepper">
                    <button type="button" class="qty-minus">−</button>
                    <input type="number" class="fund-qty" value="1" min="1" max="7" readonly>
                    <button type="button" class="qty-plus">+</button>
                  </div>
                  <button type="button" class="dw-btn dw-btn--primary">fund</button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- comment thread row -->
        <div class="design-block" id="design-proj-comments">
          <h3>comment thread row <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            <code>renderComment(c)</code> is file-local in project-detail.js:1495,
            so this is a DOM snapshot of a single row (+ one indented reply).
            Author + body + timestamp come from a mock contributor.
          </p>
          <div class="design-card-frame">
            <div class="pd-glass">
              <div class="pd-section-title"><i class="ph ph-chat-dots" style="margin-right:0.3ch"></i> 2 comments</div>
              <div>
                <div class="project-comment" style="padding:0.75em 0;border-bottom:1px solid var(--border)">
                  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.4em">
                    <span style="display:flex;align-items:center;gap:0.5ch">${inlineAvatar('0x1111111111111111111111111111111111111111', 20)}<a href="#" style="color:var(--fg);font-size:0.85em;font-weight:500">nappynina.com</a></span>
                    <time style="color:var(--dim);font-size:0.8em">nov 3</time>
                  </div>
                  <div style="color:var(--fg);font-size:0.9em;line-height:1.65">excited for this one — in for a producer tier</div>
                  <div class="comment-replies">
                    <div style="margin-left:2ch;padding:0.6em 0;border-top:1px solid var(--border)">
                      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.25em">
                        <span style="display:flex;align-items:center;gap:0.5ch">${inlineAvatar('0x3333333333333333333333333333333333333333', 18)}<a href="#" style="color:var(--fg);font-size:0.8em;font-weight:500">milesxb.bio</a></span>
                        <time style="color:var(--dim);font-size:0.75em">nov 3</time>
                      </div>
                      <div style="color:var(--fg);font-size:0.88em;line-height:1.6">thank you — credits by january</div>
                    </div>
                  </div>
                </div>
                <div class="project-comment" style="padding:0.75em 0;border-bottom:1px solid var(--border)">
                  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.4em">
                    <span style="display:flex;align-items:center;gap:0.5ch">${inlineAvatar('0x2222222222222222222222222222222222222222', 20)}<a href="#" style="color:var(--fg);font-size:0.85em;font-weight:500">blackmatter.world</a></span>
                    <time style="color:var(--dim);font-size:0.8em">nov 4</time>
                  </div>
                  <div style="color:var(--fg);font-size:0.9em;line-height:1.65">will the credits ship as a physical booklet</div>
                  <div class="comment-replies"></div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- comment form -->
        <div class="design-block" id="design-proj-comment-form">
          <h3>comment form <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            <code>renderCommentForm()</code> at project-detail.js:1632 — the
            placeholder (<code>add a comment...</code>) and button label
            (<code>comment</code>) are Miles-authored and preserved verbatim.
          </p>
          <div class="design-card-frame">
            <div class="pd-glass">
              <textarea class="project-input" placeholder="add a comment..." style="min-height:4em;resize:vertical;line-height:1.6;margin-bottom:0.5em;width:100%"></textarea>
              <div style="display:flex;justify-content:space-between;align-items:center">
                <span style="color:var(--muted);font-size:0.85em"></span>
                <button type="button" class="buy-btn" style="font-size:0.85em;padding:0.4em 1.5ch;margin-top:0"><i class="ph ph-paper-plane-tilt" style="margin-right:0.3ch"></i> comment</button>
              </div>
            </div>
          </div>
        </div>

        <!-- reply rendered row mirror -->
        <div class="design-block">
          <h3>reply — rendered row <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            <code>renderReply(r)</code> is closure-local inside
            <code>loadReplies</code> at <code>public/js/post.js:680</code>.
            one row, author + date + body. mirrored shape with a draft body
            line so miles's words land on his pass.
          </p>
          <div class="design-card-frame">
            <div style="max-width:520px;padding:1.25em 0;border-top:1px solid var(--border)">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.4em">
                <a href="#" style="color:var(--muted);font-size:0.85em;text-decoration:none">milesxb.bio</a>
                <time style="color:var(--dim);font-size:0.8em">nov 4</time>
              </div>
              <div style="color:var(--fg);font-size:0.95em;line-height:1.7">draft reply — a reader's reply lands here, trimmed by the live markdown-strip.</div>
      <!-- ─────────── 20 · money in & out ─────────── -->
      <section class="design-section">
        <h2 class="design-section-title">20 · money in & out</h2>
        <p style="color:var(--dim);font-size:0.9em;margin:0 0 1em;max-width:60ch">
          every place money moves — add funds, cash out, send home — and
          the sub-views you only see once you're mid-flow. the full
          wizards' openers live in §15 above; this section mirrors the
          method tiles, the details field, each QR pane, the chain
          picker, the fee card and the three beats of a move, so you
          can see them without walking the whole thing.
        </p>

        <div class="design-btn-row" id="design-money-openers" style="display:flex;flex-wrap:wrap;gap:0.4em 0.5em">
          <button class="dw-chip-pill" data-open="money-method-wise"><i class="dw-chip-pill__icon ph ph-globe-hemisphere-west" aria-hidden="true"></i>wise</button>
          <button class="dw-chip-pill" data-open="money-method-revolut"><i class="dw-chip-pill__icon ph ph-credit-card" aria-hidden="true"></i>revolut</button>
          <button class="dw-chip-pill" data-open="money-method-cashapp"><i class="dw-chip-pill__icon ph ph-currency-dollar" aria-hidden="true"></i>cash app</button>
          <button class="dw-chip-pill" data-open="money-method-venmo"><i class="dw-chip-pill__icon ph ph-currency-dollar" aria-hidden="true"></i>venmo</button>
          <button class="dw-chip-pill" data-open="money-chain-1"><span class="dw-chip-pill__dot" aria-hidden="true"></span>ethereum</button>
          <button class="dw-chip-pill" data-open="money-chain-10"><span class="dw-chip-pill__dot" aria-hidden="true"></span>optimism</button>
          <button class="dw-chip-pill" data-open="money-chain-42161"><span class="dw-chip-pill__dot" aria-hidden="true"></span>arbitrum</button>
          <button class="dw-chip-pill" data-open="money-chain-8453"><span class="dw-chip-pill__dot" aria-hidden="true"></span>base</button>
          <button class="dw-chip-pill" data-open="money-chain-137"><span class="dw-chip-pill__dot" aria-hidden="true"></span>polygon</button>
          <button class="dw-chip-pill" data-open="money-chain-324"><span class="dw-chip-pill__dot" aria-hidden="true"></span>zksync</button>
        </div>

        <!-- method picker tiles -->
        <div class="design-block">
          <h3>method tiles <code>draft</code></h3>
          <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.5em">
            the row of payment-method chips at the top of the add-funds
            and cash-out wizards. mirrors
            <code>renderPaymentMethods(selected)</code> at ramp.js:1104 —
            a file-local helper, so the shape is hand-synced here. click
            a method opener above to re-render with a different active
            chip.
          </p>
          <div id="design-money-methods-slot" style="display:flex;flex-wrap:wrap;gap:0.4ch"></div>
        </div>

        <!-- payment details input -->
        <div class="design-block">
          <h3>payment details input <code>draft</code></h3>
          <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.5em">
            the one-line field that asks for your handle or email on
            the cash-out wizard. mirrors
            <code>renderPaymentDetailsInput()</code> at ramp.js:2339 — a
            closure-local helper inside <code>showOfframpModal</code>.
            click a method opener above to swap the placeholder.
          </p>
          <div id="design-money-details-slot" style="max-width:420px"></div>
        </div>

        <!-- stripe QR pane -->
        <div class="design-block">
          <h3>stripe QR pane <code>draft</code></h3>
          <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.5em">
            the QR you scan when the method is a card charge via Stripe.
            live rendered by <code>_renderQrCode('stripe')</code> inside
            the onramp closure at ramp.js:1586; the snapshot here uses
            the same <code>qrcode()</code> helper on a mock payload.
          </p>
          <div style="display:flex;align-items:center;gap:1em;max-width:420px;padding:1em;border:1px solid var(--border);border-radius:8px;background:color-mix(in srgb,var(--fg) 2%,transparent)">
            <div id="design-money-qr-stripe" style="width:160px;height:160px;background:#fff;border:1px solid var(--border);border-radius:4px;display:flex;align-items:center;justify-content:center;flex-shrink:0"></div>
            <div style="flex:1;min-width:0">
              <div style="color:var(--muted);font-size:0.72em;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:0.3em">pay $100 with</div>
              <div style="color:var(--fg);font-size:1em;font-weight:500">a card</div>
              <div style="color:var(--dim);font-size:0.78em;margin-top:0.5em;line-height:1.4">scan to open the checkout on your phone, or tap continue below.</div>
        <!-- QR check-in surface -->
        <div class="design-block" id="design-proj-checkin">
          <h3>QR check-in surface <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            Snapshot of the check-in panel at project-detail.js:1292 — the
            counters strip, the token-ID input, and the scan + check-in
            buttons. Shown with 24 of 40 tickets scanned in.
          </p>
          <div class="design-card-frame">
            <div class="pd-glass">
              <div class="pd-section-title"><i class="ph ph-qr-code" style="margin-right:0.3ch"></i> check-in</div>
              <div style="display:flex;gap:2em;margin-bottom:1em;font-size:0.85em">
                <span><span style="color:var(--accent);font-weight:700">24</span> checked in</span>
                <span><span style="color:var(--accent);font-weight:700">40</span> tickets sold</span>
                <span><span style="color:var(--accent);font-weight:700">60%</span> attendance</span>
              </div>
              <div style="display:flex;gap:0.5ch;align-items:center;flex-wrap:wrap">
                <input type="text" class="project-input" placeholder="token ID" style="flex:1;min-width:12ch;padding:0.5em 0.8ch;font-size:0.85em">
                <button type="button" class="buy-btn" style="margin-top:0;background:none;border:1px solid var(--border);color:var(--fg)"><i class="ph ph-qr-code" style="margin-right:0.3ch"></i> scan</button>
                <button type="button" class="buy-btn" style="margin-top:0"><i class="ph ph-check-circle" style="margin-right:0.3ch"></i> check in</button>
              </div>
              <p style="color:var(--muted);font-size:0.85em;margin-top:0.5em">point the camera at the ticket QR</p>
            </div>
          </div>
        </div>

        <!-- post amendments history mirror -->
        <div class="design-block" id="design-make-history-block">
          <h3>post history — amendments <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            <code>renderHistoryView(contentEl, originalPost, amendments, postId)</code>
            at <code>public/js/post.js:611</code> is file-local. three mock
            versions below — current one carries the accent border, past
            versions fade to 0.7 opacity. the "original" / "amendment" /
            "current" labels on the live page come from
            <code>t('post.*')</code>.
          </p>
          <div class="design-card-frame">
            <div style="max-width:520px">
              <header class="post-page-header">
                <h1 class="post-page-title">draft title</h1>
                <div class="post-page-meta">
                  <a href="#">milesxb.bio</a>
                  <span style="color:var(--dim)"> — </span>
                  <a href="#" style="color:var(--dim)">back</a>
                </div>
              </header>
              <h3 style="color:var(--muted);font-size:0.8em;text-transform:uppercase;letter-spacing:0.1em;margin:1.5em 0 1em">3 versions</h3>
              <div style="border:1px solid var(--border);padding:1.25em;margin-bottom:1em;opacity:0.7">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.75em">
                  <span style="font-size:0.8em;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em">original</span>
                  <time style="color:var(--dim);font-size:0.8em">march 27, 10:14 pm</time>
                </div>
                <h3 style="margin-bottom:0.5em">draft title — first pass</h3>
                <div class="post-page-body" style="font-size:0.95em">draft body — miles's first pass.</div>
              </div>
              <div style="border:1px solid var(--border);padding:1.25em;margin-bottom:1em;opacity:0.7">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.75em">
                  <span style="font-size:0.8em;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em">amendment 1</span>
                  <time style="color:var(--dim);font-size:0.8em">march 28, 9:02 am</time>
                </div>
                <h3 style="margin-bottom:0.5em">draft title — second pass</h3>
                <div class="post-page-body" style="font-size:0.95em">draft body — second pass, tighter phrasing.</div>
              </div>
              <div style="border:1px solid var(--accent);padding:1.25em;margin-bottom:1em">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.75em">
                  <span style="font-size:0.8em;color:var(--accent);text-transform:uppercase;letter-spacing:0.05em">amendment 2 (current)</span>
                  <time style="color:var(--dim);font-size:0.8em">march 29, 8:48 pm</time>
                </div>
                <h3 style="margin-bottom:0.5em">draft title</h3>
                <div class="post-page-body" style="font-size:0.95em">draft body — the version readers land on today.</div>
      <!-- ─────────── 22 · network & profile ─────────── -->
      <section class="design-section">
        <h2 class="design-section-title">22 · network & profile</h2>
        <p style="color:var(--dim);font-size:0.9em;margin:0 0 1em;max-width:60ch">
          every surface that puts the network on screen — the people you follow, the people
          who follow you, your audience, the one who found your site through a friend.
          live openers where the real modal is window-exposed; static snapshots of the shape
          where the function is file-local. draft copy marked for Miles's pass.
        </p>

        <div class="design-btn-row" id="design-net-openers">
          <button class="buy-btn" data-open="net-invites">invites</button>
          <button class="buy-btn" data-open="net-deploy-options">post-signup — what next</button>
          <button class="buy-btn" data-open="net-block">block this person (destructive)</button>
          <button class="buy-btn" data-open="net-connections-followers">who follows you</button>
          <button class="buy-btn" data-open="net-connections-following">who you follow</button>
          <button class="buy-btn" data-open="net-audience-prompt">become an audience member</button>
        </div>
        <p id="design-net-fallback" style="color:var(--muted);font-size:0.8em;margin:0.5em 0 1em;min-height:1em"></p>

        <div class="design-block">
          <h3>list / graph toggle — the top bar <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            the one switch at the top of /network. list on the left, graph on the right,
            a thin rule between. snapshot mirrors the live markup <code>build.js:408</code>
            emits.
          </p>
          <div id="network-top-bar" style="display:flex;align-items:center;justify-content:space-between;max-width:520px;margin-bottom:0;gap:1ch;flex-wrap:wrap;padding:0.5em 0.75em;border:1px solid var(--border);border-radius:8px;background:var(--bg)">
            <div style="display:flex;align-items:center;gap:0">
              <button class="network-toggle active" type="button" style="background:none;border:0;color:var(--fg);font:inherit;cursor:pointer;padding:0.3em 0.5ch">list</button>
              <span style="color:var(--dim);margin:0 0.5ch">|</span>
              <button class="network-toggle" type="button" style="background:none;border:0;color:var(--muted);font:inherit;cursor:pointer;padding:0.3em 0.5ch">graph</button>
            </div>
            <button class="buy-btn" type="button" style="font-size:0.8em;padding:0.25em 1ch">invites</button>
          </div>
        </div>

        <div class="design-block">
          <h3>list view — artists + audience, in a 2x2 grid <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            live render in <code>network.js</code> is wired to Ponder — infinite scroll,
            follow state, og thumbnails. snapshot mirrors the <code>.nc-grid</code> /
            <code>.nc-item</code> shape it writes (network.js:39, :325, :411) with two artists
            and two audience members. in prod the og thumbnail loads per row; here, a muted block.
          </p>
          <ul class="nc-grid reading-list" style="list-style:none;padding:0;margin:0;display:grid;grid-template-columns:1fr 1fr;gap:0.75em;max-width:560px">
            <li class="nc-item" data-addr="${A_ADDR.toLowerCase()}" style="padding:0;border:1px solid var(--border);border-radius:8px;overflow:hidden;background:var(--bg)">
              <a href="#" class="nc-link" style="display:flex;flex-direction:column;text-decoration:none;color:var(--fg)" onclick="return false">
                <div style="aspect-ratio:1200/630;background:color-mix(in srgb, var(--fg) 6%, var(--bg));display:grid;place-items:center;color:var(--dim);font-size:0.7em">og preview</div>
                <div class="nc-body" style="padding:0.5em 0.75ch">
                  <div class="nc-header" style="display:flex;align-items:center;justify-content:space-between;gap:0.5ch">
                    <span class="nc-domain" style="font-size:0.9em">nappynina.com</span>
                    <span style="display:flex;gap:0.3ch;align-items:center">
                      <button class="buy-btn nc-btn" style="font-size:0.7em;padding:0.15em 0.9ch">follow</button>
                    </span>
                  </div>
                </div>
              </a>
            </li>
            <li class="nc-item" data-addr="${B_ADDR.toLowerCase()}" style="padding:0;border:1px solid var(--border);border-radius:8px;overflow:hidden;background:var(--bg)">
              <a href="#" class="nc-link" style="display:flex;flex-direction:column;text-decoration:none;color:var(--fg)" onclick="return false">
                <div style="aspect-ratio:1200/630;background:color-mix(in srgb, var(--fg) 6%, var(--bg));display:grid;place-items:center;color:var(--dim);font-size:0.7em">og preview</div>
                <div class="nc-body" style="padding:0.5em 0.75ch">
                  <div class="nc-header" style="display:flex;align-items:center;justify-content:space-between;gap:0.5ch">
                    <span class="nc-domain" style="font-size:0.9em">blackmatter.world</span>
                    <span style="display:flex;gap:0.3ch;align-items:center">
                      <button class="buy-btn nc-btn nc-btn-filled" style="font-size:0.7em;padding:0.15em 0.9ch">unfollow</button>
                    </span>
                  </div>
                </div>
              </a>
            </li>
            <li class="nc-item supporter-item" data-addr="${C_ADDR.toLowerCase()}" style="padding:0;border:1px solid var(--border);border-radius:8px;overflow:hidden;background:var(--bg)">
              <a href="#" class="nc-link" style="display:flex;flex-direction:column;text-decoration:none;color:var(--fg)" onclick="return false">
                <div style="aspect-ratio:1200/630;background:color-mix(in srgb, var(--fg) 6%, var(--bg));display:grid;place-items:center;color:var(--dim);font-size:0.7em">og preview</div>
                <div class="nc-body" style="padding:0.5em 0.75ch">
                  <div class="nc-header" style="display:flex;align-items:center;justify-content:space-between;gap:0.5ch">
                    <span class="nc-domain" style="font-size:0.9em">milesxb.bio</span>
                    <span style="display:flex;gap:0.3ch;align-items:center">
                      <button class="buy-btn nc-btn" style="font-size:0.7em;padding:0.15em 0.9ch">follow</button>
                    </span>
                  </div>
                </div>
              </a>
            </li>
            <li class="nc-item supporter-item" data-addr="0x4444444444444444444444444444444444444444" style="padding:0;border:1px solid var(--border);border-radius:8px;overflow:hidden;background:var(--bg)">
              <a href="#" class="nc-link" style="display:flex;flex-direction:column;text-decoration:none;color:var(--fg)" onclick="return false">
                <div style="aspect-ratio:1200/630;background:color-mix(in srgb, var(--fg) 6%, var(--bg));display:grid;place-items:center;color:var(--dim);font-size:0.7em">no site yet</div>
                <div class="nc-body" style="padding:0.5em 0.75ch">
                  <div class="nc-header" style="display:flex;align-items:center;justify-content:space-between;gap:0.5ch">
                    <span class="nc-domain" style="font-size:0.9em">nineisgiantess</span>
                    <span style="display:flex;gap:0.3ch;align-items:center">
                      <button class="buy-btn nc-btn" style="font-size:0.7em;padding:0.15em 0.9ch">follow</button>
                    </span>
                  </div>
                </div>
              </a>
            </li>
          </ul>
        </div>

        <div class="design-block">
          <h3>artist card — stand-alone <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            one row of the <code>.nc-grid</code> above, pulled out at full width so the
            artist variant is readable by itself. follow button on the right, domain on
            the left, their site preview above. network.js:325.
          </p>
          <div class="nc-item" style="max-width:420px;padding:0;border:1px solid var(--border);border-radius:8px;overflow:hidden;background:var(--bg)">
            <div style="aspect-ratio:1200/630;background:color-mix(in srgb, var(--fg) 6%, var(--bg));display:grid;place-items:center;color:var(--dim);font-size:0.75em">nappynina.com — site preview</div>
            <div class="nc-body" style="padding:0.5em 0.75ch">
              <div class="nc-header" style="display:flex;align-items:center;justify-content:space-between;gap:0.5ch">
                <span class="nc-domain">nappynina.com</span>
                <span style="display:flex;gap:0.3ch;align-items:center">
                  <button class="buy-btn nc-btn" type="button" style="font-size:0.75em;padding:0.2em 1ch">follow</button>
                  <button class="buy-btn nc-btn" type="button" style="font-size:0.75em;padding:0.2em 1ch">dm</button>
                </span>
              </div>
            </div>
          </div>
        </div>

        <!-- grouped post card mirror -->
        <div class="design-block">
          <h3>post card — on a profile <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            <code>renderPostCard(p)</code> at
            <code>public/js/profile.js:457</code> is file-local. a single
            card as it appears on an artist's profile. the preview trims to
            120 chars; cards with media show the rendered markdown instead.
          </p>
          <div class="design-card-frame">
            <a href="#" class="profile-post-card" style="max-width:520px">
              <div style="display:flex;justify-content:space-between;align-items:baseline">
                <span class="profile-post-title">draft title</span>
                <span class="profile-post-date">nov 4, 2026</span>
              </div>
              <span class="profile-post-preview">draft preview — the first 120 characters of a post land here, then a soft ellipsis...</span>
            </a>
          </div>
        </div>

        <!-- journal unlock mirror -->
        <div class="design-block" id="design-make-journal-unlock-block">
          <h3>journal — unlock <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            <code>showUnlock()</code> is closure-local inside
            <code>initJournal</code> at <code>public/js/journal.js:224</code>.
            the live surface uses <code>t('journal.encrypted')</code> +
            <code>t('journal.signToUnlock')</code>. mirrored copy below is
            a draft stand-in — not the shipped i18n strings.
          </p>
          <div class="design-card-frame">
            <div style="text-align:center;padding:3em 0;max-width:520px;margin:0 auto">
              <p style="color:var(--muted);margin-bottom:1em">your journal is private. unlock it on this device to read and write.</p>
              <button class="buy-btn">unlock</button>
        <!-- zkp2p QR pane -->
        <div class="design-block">
          <h3>zkp2p QR pane <code>draft</code></h3>
          <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.5em">
            the QR you scan when the method is a peer transfer via Cash
            App or Venmo. same <code>_renderQrCode('zkp2p')</code> path
            at ramp.js:1586; the payload is a Cash App deep link built
            by <code>_buildPaymentDeepLink()</code> at ramp.js:1165.
          </p>
          <div style="display:flex;align-items:center;gap:1em;max-width:420px;padding:1em;border:1px solid var(--border);border-radius:8px;background:color-mix(in srgb,var(--fg) 2%,transparent)">
            <div id="design-money-qr-zkp2p" style="width:160px;height:160px;background:#fff;border:1px solid var(--border);border-radius:4px;display:flex;align-items:center;justify-content:center;flex-shrink:0"></div>
            <div style="flex:1;min-width:0">
              <div style="color:var(--muted);font-size:0.72em;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:0.3em">send $100 to</div>
              <div style="color:var(--fg);font-size:0.95em;font-family:'SF Mono',ui-monospace,monospace">$nappy-nina</div>
              <div style="color:var(--dim);font-size:0.78em;margin-top:0.5em;line-height:1.4">open cash app and scan — the amount and recipient prefill. memo: Coffee.</div>
            </div>
          </div>
        </div>

        <!-- journal regular editor mirror + live preview slot -->
        <div class="design-block" id="design-make-journal-editor-block">
          <h3>journal — prose editor <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            <code>showEditor(existingFile, existingContent)</code> is
            closure-local inside <code>initJournal</code> at
            <code>public/js/journal.js:448</code>. markdown editor, autosave
            every 2s, publish-to-blog is a preview + confirm sheet. the
            preview slot below runs <code>renderContentInEditor</code>'s
            sibling — <code>fountainToHtml</code> — against a draft sample
            so miles can see the rich preview without opening the editor.
          </p>
          <div class="design-card-frame">
            <div style="max-width:680px">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1em">
                <span style="color:var(--muted);font-size:0.85em;text-transform:uppercase;letter-spacing:0.1em">new entry</span>
                <div style="display:flex;gap:0.5ch">
                  <button class="buy-btn" style="font-size:0.8em;padding:0.2em 1ch">publish to blog</button>
                  <button class="buy-btn" style="font-size:0.8em;padding:0.2em 1ch">back</button>
                </div>
              </div>
              <input type="text" placeholder="title" value="2026-11-04-draft" style="width:100%;background:transparent;border:1px solid var(--border);color:var(--fg);font-family:inherit;font-size:0.9em;padding:0.5em 1ch;margin-bottom:1em">
              <textarea rows="8" placeholder="start writing..." style="width:100%;background:transparent;border:1px solid var(--border);color:var(--fg);font-family:inherit;font-size:0.95em;padding:0.75em 1ch;line-height:1.7;resize:vertical"></textarea>
              <div id="design-journal-preview-slot" style="margin-top:1em;padding:1em;border:1px dashed var(--border);border-radius:6px;min-height:4em;color:var(--muted);font-size:0.85em">live preview slot — rendered below on load.</div>
              <div style="display:flex;justify-content:space-between;align-items:center;padding-top:1em;border-top:1px solid var(--border);margin-top:1em">
                <span style="color:var(--dim);font-size:0.85em">saved</span>
        <!-- scan button (owner side) -->
        <div class="design-block" id="design-proj-scan">
          <h3>scan button — owner side</h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            Only renders when the browser exposes <code>BarcodeDetector</code>
            (Chrome, iOS 17+ Safari) and the viewer is on the team. Standalone
            snapshot of the live button from project-detail.js:1300.
          </p>
          <div class="design-card-frame">
            <button type="button" class="buy-btn" style="margin-top:0;background:none;border:1px solid var(--border);color:var(--fg)"><i class="ph ph-qr-code" style="margin-right:0.3ch"></i> scan</button>
          </div>
        </div>

        <!-- challenge (dispute) action card -->
        <div class="design-block" id="design-proj-dispute">
          <h3>challenge action card</h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            From project-detail.js:547 — appears for backers while the project
            is in the <code>completing</code> state. The warning strip above
            carries the live dispute-window countdown.
          </p>
          <div class="design-card-frame">
            <div class="pd-glass">
              <div class="pd-section-title"><i class="ph ph-lightning" style="margin-right:0.3ch"></i> actions</div>
              <div style="padding:0.75em;border:1px solid rgba(251,191,36,0.2);border-radius:8px;background:rgba(251,191,36,0.04);margin-bottom:1em;display:flex;align-items:center;gap:0.75em">
                <i class="ph ph-warning" style="color:#fbbf24;font-size:1.2em;flex-shrink:0"></i>
                <span style="font-size:0.85em">dispute window <span style="color:var(--accent);font-weight:600">2d 14h 30m</span></span>
              </div>
              <div style="display:flex;gap:0.5em;flex-wrap:wrap">
                <button type="button" class="buy-btn" style="border-color:#ef4444;color:#ef4444;background:transparent;margin-top:0"><i class="ph ph-warning" style="margin-right:0.3ch"></i> dispute</button>
              </div>
              <p style="color:var(--muted);font-size:0.85em;margin-top:0.75em"></p>
            </div>
          </div>
        </div>

        <!-- finalize action card -->
        <div class="design-block" id="design-proj-finalize">
          <h3>finalize action card</h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            From project-detail.js:554 — appears for the proposer during
            <code>completing</code>. Disabled while the window is open,
            enabled once it ends. Both states below.
          </p>
          <div class="design-card-frame">
            <div class="pd-glass" style="margin-bottom:1em">
              <div class="pd-section-title"><i class="ph ph-lightning" style="margin-right:0.3ch"></i> actions — window open</div>
              <div style="padding:0.75em;border:1px solid rgba(251,191,36,0.2);border-radius:8px;background:rgba(251,191,36,0.04);margin-bottom:1em;display:flex;align-items:center;gap:0.75em">
                <i class="ph ph-warning" style="color:#fbbf24;font-size:1.2em;flex-shrink:0"></i>
                <span style="font-size:0.85em">dispute window <span style="color:var(--accent);font-weight:600">2d 14h 30m</span></span>
              </div>
              <div style="display:flex;gap:0.5em;flex-wrap:wrap">
                <button type="button" class="buy-btn" disabled style="margin-top:0;opacity:0.5"><i class="ph ph-seal-check" style="margin-right:0.3ch"></i> finalize</button>
              </div>
            </div>
            <div class="pd-glass">
              <div class="pd-section-title"><i class="ph ph-lightning" style="margin-right:0.3ch"></i> actions — window ended</div>
              <div style="padding:0.75em;border:1px solid rgba(251,191,36,0.2);border-radius:8px;background:rgba(251,191,36,0.04);margin-bottom:1em;display:flex;align-items:center;gap:0.75em">
                <i class="ph ph-warning" style="color:#fbbf24;font-size:1.2em;flex-shrink:0"></i>
                <span style="font-size:0.85em">dispute window <span style="color:var(--accent);font-weight:600">ended</span></span>
              </div>
              <div style="display:flex;gap:0.5em;flex-wrap:wrap">
                <button type="button" class="buy-btn" style="margin-top:0"><i class="ph ph-seal-check" style="margin-right:0.3ch"></i> finalize</button>
        <div class="design-block">
          <h3>audience card — stand-alone <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            same row shape, audience variant — the handle instead of a domain, no og preview
            when the person hasn't claimed a site yet. network.js:411.
          </p>
          <div class="nc-item supporter-item" style="max-width:420px;padding:0;border:1px solid var(--border);border-radius:8px;overflow:hidden;background:var(--bg)">
            <div style="aspect-ratio:1200/630;background:color-mix(in srgb, var(--fg) 6%, var(--bg));display:grid;place-items:center;color:var(--dim);font-size:0.75em">no site yet</div>
            <div class="nc-body" style="padding:0.5em 0.75ch">
              <div class="nc-header" style="display:flex;align-items:center;justify-content:space-between;gap:0.5ch">
                <span class="nc-domain">nineisgiantess</span>
                <span class="nc-badge nc-badge-audience" style="font-size:0.65em;border:1px solid var(--border);border-radius:3px;padding:0.1em 0.5ch;color:var(--muted)">audience</span>
              </div>
            </div>
          </div>
        </div>

        <!-- screenplay editor mirror -->
        <div class="design-block" id="design-make-script-editor-block">
          <h3>screenplay editor <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            <code>showScriptEditor(existingFile, existingContent, 'fountain')</code>
            is closure-local in <code>public/js/journal.js:654</code>. toolbar
            cycles line type (scene / action / character / dialogue / paren /
            transition / shot / text / act). tab + enter navigates. editor is
            a <code>contenteditable</code> with <code>.script-line</code>
            children; the live classes do the typography, mirrored here with
            a short draft sample.
          </p>
          <div class="design-card-frame">
            <div style="max-width:680px">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1em">
                <span style="color:var(--muted);font-size:0.85em;text-transform:uppercase;letter-spacing:0.1em">screenplay</span>
                <div style="display:flex;gap:0.5ch">
                  <button class="buy-btn" style="font-size:0.8em;padding:0.2em 1ch">publish to blog</button>
                  <button class="buy-btn" style="font-size:0.8em;padding:0.2em 1ch">back</button>
                </div>
              </div>
              <input type="text" value="2026-11-04-draft-script" style="width:100%;background:transparent;border:1px solid var(--border);color:var(--fg);font-family:inherit;font-size:0.9em;padding:0.5em 1ch">
              <div class="script-toolbar">
                <span class="script-type-indicator">scene</span>
                <button class="active">scene</button>
                <button>action</button>
                <button>character</button>
                <button>dialogue</button>
                <button>paren</button>
                <button>transition</button>
                <button>shot</button>
              </div>
              <div class="script-editor" contenteditable="false" style="min-height:10em">
                <div class="script-line script-scene">INT. ROOM - DAY</div>
                <div class="script-line script-action">the morning light comes in slowly.</div>
                <div class="script-line script-character">MILES</div>
                <div class="script-line script-paren">(nervous)</div>
                <div class="script-line script-dialogue">here we go.</div>
                <div class="script-line script-transition">CUT TO:</div>
              </div>
              <div style="display:flex;justify-content:space-between;align-items:center;padding-top:1em;border-top:1px solid var(--border);margin-top:0.5em">
                <span style="color:var(--dim);font-size:0.85em">saved</span>
                <span style="color:var(--dim);font-size:0.85em">~1 page</span>
        <div class="design-block">
          <h3>graph canvas chrome — the whole network as dots <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            the force-directed view in <code>graph.js</code> — a canvas, a small status line,
            and a legend reading "you, artists, audience" alongside. live canvas elided for
            the catalog; the chrome + layout is the thing to see.
          </p>
          <div style="display:grid;grid-template-columns:1fr 160px;gap:1em;max-width:620px;align-items:start">
            <div style="display:flex;flex-direction:column;gap:0.3em">
              <div style="aspect-ratio:1/1;background:var(--bg);border:1px solid var(--border);display:grid;place-items:center;color:var(--dim);font-size:0.75em;text-align:center;padding:1em">graph chrome (canvas elided for catalog)</div>
              <p style="color:var(--muted);font-size:0.75em;margin:0">pan to drift. scroll to zoom. tap a node to open their site.</p>
            </div>
            <div style="padding:0.75em;border:1px solid var(--border);border-radius:6px;background:var(--bg);display:flex;flex-direction:column;gap:0.5em">
              <p style="font-size:0.7em;color:var(--muted);margin:0;text-transform:uppercase;letter-spacing:0.05em">legend</p>
              <div style="display:flex;align-items:center;gap:0.5ch;font-size:0.8em;color:var(--fg)"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--fg)"></span> you</div>
              <div style="display:flex;align-items:center;gap:0.5ch;font-size:0.8em;color:var(--muted)"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#aaa"></span> an artist</div>
              <div style="display:flex;align-items:center;gap:0.5ch;font-size:0.8em;color:var(--muted)"><span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#886644"></span> an audience member</div>
            </div>
          </div>
        </div>

        <div class="design-block">
          <h3>graph — empty state <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            fires when the ponder registry has no artists yet — "no artists in the network"
            goes to <code>#graph-status</code>. graph.js:599.
          </p>
          <div style="aspect-ratio:1/1;max-width:300px;background:var(--bg);border:1px solid var(--border);display:grid;place-items:center;color:var(--muted);font-size:0.85em;text-align:center;padding:1em">no artists in the network yet</div>
        </div>

        <div class="design-block">
          <h3>graph — hovered node tooltip <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            on hover, the node grows and prints its domain above and its degree-of-separation
            below ("2 degrees from you"). live render in graph.js:558 draws straight to the
            canvas; snapshot of the floating label shape below.
          </p>
          <div style="position:relative;display:inline-block;padding:3em 4em;background:var(--bg);border:1px solid var(--border);border-radius:6px">
            <span style="position:absolute;top:1em;left:50%;transform:translateX(-50%);font-size:0.75em;color:var(--fg)">nappynina.com</span>
            <span style="display:inline-block;width:14px;height:14px;border-radius:50%;background:var(--fg)"></span>
            <span style="position:absolute;bottom:1em;left:50%;transform:translateX(-50%);font-size:0.7em;color:var(--muted);white-space:nowrap">2 degrees from you</span>
          </div>
        </div>

        <div class="design-block">
          <h3>follow button — three states <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            the inline follow / following / unfollow button rendered on every profile +
            network row. "following" is the hover-safe label; "unfollow" is the destructive
            hover variant. filled fill means you already follow them. profile.js:218,
            network.js:317.
          </p>
          <div style="display:flex;gap:0.5em;align-items:center;flex-wrap:wrap">
            <button class="buy-btn profile-btn profile-btn-follow follow-btn nc-btn" type="button" style="font-size:0.85em;padding:0.3em 1ch">follow</button>
            <button class="buy-btn profile-btn profile-btn-follow follow-btn nc-btn nc-btn-filled profile-btn-active" type="button" style="font-size:0.85em;padding:0.3em 1ch">following</button>
            <button class="buy-btn profile-btn profile-btn-follow follow-btn nc-btn nc-btn-filled profile-btn-active" type="button" style="font-size:0.85em;padding:0.3em 1ch">unfollow</button>
          </div>
        </div>

        <div class="design-block">
          <h3>invites modal <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            the sheet an artist opens from the top bar to invite someone. prints the cards —
            one per unused invite — with a color picker, a short note, a copy link, a download.
            opener calls <code>window.openInvitesModal</code> which is file-local in
            <code>network.js:1183</code>; if it hasn't been exposed yet the fallback below says so.
          </p>
        </div>

        <div class="design-block">
          <h3>post-signup — what next (deploy options) <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            the three tiles a brand-new artist lands on the moment their site deploys —
            share your link, pick up where you left off, bring people in. opener wires to
            <code>window.showDeployOptions</code>, which is file-local in
            <code>network.js:1876</code>; fallback says so if not exposed.
          </p>
        </div>

        <div class="design-block">
          <h3>block confirm — destructive <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            the small sheet that fires when you tap block on a profile. three lines of what
            happens next, cancel on the left, block in red on the right. opener wires to
            <code>window.showBlockConfirmModal</code>, which is file-local in
            <code>profile.js:416</code>; fallback says so if not exposed.
          </p>
        </div>

        <div class="design-block">
          <h3>who follows you / who you follow — connections modal <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            the list that opens when you tap the follow counts on a profile. paginated,
            hover highlight per row, close on escape. opener wires to
            <code>window.showConnectionsModal</code>, which is file-local in
            <code>profile.js:627</code>; fallback says so if not exposed.
          </p>
        </div>

        <div class="design-block">
          <h3>audience / supporter prompt <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            the bottom sheet a signed-in visitor sees when they haven't registered as an
            audience member yet — one line of why, one line of what, a pick-a-handle field,
            a confirm. opener wires to <code>window.showAudiencePrompt</code>, file-local
            in <code>wallet.js:848</code>; fallback says so if not exposed.
          </p>
        </div>

        <div class="design-block">
          <h3>top artists — horizontal strip <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            the row above the masonry on an audience portfolio — up to four artists you
            follow most, each with their site preview + name. markup is live in
            <code>build.js:498</code>; snapshot below mirrors the <code>.top-artist-card</code>
            shape with three stubs.
          </p>
          <div class="my-artists-section" style="max-width:560px">
            <p style="font-size:0.75em;color:var(--muted);margin:0 0 0.5em;text-transform:uppercase;letter-spacing:0.05em">my artists</p>
            <div class="top-artists-grid" style="display:grid;grid-template-columns:repeat(4, 1fr);gap:0.75em">
              <div class="top-artist-card" style="display:flex;flex-direction:column;gap:0.3em">
                <div class="top-artist-avatar" style="width:100%;aspect-ratio:1200/630;background:color-mix(in srgb, var(--fg) 6%, var(--bg));border-radius:6px"></div>
                <span class="top-artist-name" style="font-size:0.8em;color:var(--fg)">nappynina.com</span>
              </div>
              <div class="top-artist-card" style="display:flex;flex-direction:column;gap:0.3em">
                <div class="top-artist-avatar" style="width:100%;aspect-ratio:1200/630;background:color-mix(in srgb, var(--fg) 6%, var(--bg));border-radius:6px"></div>
                <span class="top-artist-name" style="font-size:0.8em;color:var(--fg)">blackmatter.world</span>
              </div>
              <div class="top-artist-card" style="display:flex;flex-direction:column;gap:0.3em">
                <div class="top-artist-avatar" style="width:100%;aspect-ratio:1200/630;background:color-mix(in srgb, var(--fg) 6%, var(--bg));border-radius:6px"></div>
                <span class="top-artist-name" style="font-size:0.8em;color:var(--fg)">milesxb.bio</span>
              </div>
              <div class="top-artist-card" style="display:flex;flex-direction:column;gap:0.3em;opacity:0.4">
                <div class="top-artist-avatar" style="width:100%;aspect-ratio:1200/630;background:color-mix(in srgb, var(--fg) 4%, var(--bg));border-radius:6px;border:1px dashed var(--border)"></div>
                <span class="top-artist-name" style="font-size:0.8em;color:var(--muted)">empty slot</span>
              </div>
            </div>
          </div>
        </div>

        <!-- @-mention autocomplete mirror -->
        <div class="design-block" id="design-make-autocomplete-block">
          <h3>@-mention autocomplete <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            <code>showAutocomplete(line, matches)</code> is closure-local at
            <code>public/js/journal.js:1170</code> (character names + scene
            locations inside the script editor), and <code>_atDropdown</code>
            at <code>public/js/write.js:922</code> (artist mentions in
            /write). the dropdown anchors below the current line. mirrored
            shape with three draft matches below.
          </p>
          <div class="design-card-frame">
            <div style="position:relative;padding:1.5em;max-width:520px">
              <div style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:0.9em;color:var(--fg)">@mil</div>
              <div class="script-autocomplete" style="position:static;display:inline-block;margin-top:0.5em">
                <div class="script-autocomplete-item active">milesxb.bio</div>
                <div class="script-autocomplete-item">milesandco</div>
                <div class="script-autocomplete-item">milo.studio</div>
              </div>
            </div>
          </div>
        </div>

        <!-- live rich preview — fountain sample through fountainToHtml -->
        <div class="design-block">
          <h3>live rich preview — screenplay</h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            a short sample ("INT. ROOM — DAY / MILES / (nervous) / here we
            go.") passed through <code>fountainToHtml</code> (exported from
            <code>public/js/fountain.js</code>). renders inside the script
            editor and on <code>/post</code> when a post is a screenplay.
            the slot below is live — if the parser changes, the shape here
            changes with it.
          </p>
          <div id="design-make-fountain-preview-slot" class="design-card-frame"></div>
        </div>

        <!-- fountain primitives — one per line type -->
        <div class="design-block">
          <h3>fountain primitives — line by line</h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            each paragraph class <code>fountainToHtml</code> emits:
            <code>.fountain-scene</code>, <code>.fountain-action</code>,
            <code>.fountain-character</code>, <code>.fountain-dialogue</code>,
            <code>.fountain-paren</code>, <code>.fountain-transition</code>,
            <code>.fountain-shot</code>, plus <code>.dual-dialogue</code>
            for side-by-side. slot below runs the same sample through
            <code>parseFountain</code> and labels each line by type.
          </p>
          <div id="design-make-fountain-primitives-slot" class="design-card-frame"></div>
        <!-- chain picker tiles -->
        <div class="design-block">
          <h3>chain picker <code>draft</code></h3>
          <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.5em">
            the six chains you can move ETH from, shown in the "from"
            row of the save and send sheets. shape mirrors
            <code>chainRowInner()</code> at vault.js:1885 and the
            <code>CHAINS</code> list at relay-bridge.js:11. click a
            chain opener above to change the selected row.
          </p>
          <div id="design-money-chains-slot" style="max-width:420px;border:1px solid var(--border);border-radius:8px;overflow:hidden"></div>
        </div>

        <!-- fee preview card -->
        <div class="design-block">
          <h3>fee preview <code>draft</code></h3>
          <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.5em">
            the summary card that lands once Relay returns a quote.
            shape derived from the <code>_relayQuote()</code> return in
            relay-bridge.js — <code>quote.steps[0].items[0]</code> plus
            the price impact Relay publishes. snapshot values here are
            mock and in draft voice.
          </p>
          <div style="max-width:420px;border:1px solid var(--border);border-radius:8px;padding:0.9em 1em;background:color-mix(in srgb,var(--fg) 2%,transparent);font-variant-numeric:tabular-nums">
            <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:0.4em">
              <span style="color:var(--muted);font-size:0.78em">you move</span>
              <span style="color:var(--fg)">0.1 ETH</span>
            </div>
            <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:0.4em">
              <span style="color:var(--muted);font-size:0.78em">you receive</span>
              <span style="color:var(--fg)">0.0994 ETH</span>
            </div>
            <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:0.4em">
              <span style="color:var(--muted);font-size:0.78em">relay fee</span>
              <span style="color:var(--dim)">0.0006 ETH</span>
            </div>
            <div style="display:flex;justify-content:space-between;align-items:baseline;padding-top:0.5em;border-top:1px dashed var(--border);margin-top:0.5em">
              <span style="color:var(--muted);font-size:0.78em">arrives on</span>
              <span style="color:var(--fg);font-variant-numeric:normal">optimism — about 30s</span>
            </div>
          </div>
        </div>

        <!-- Move progress — three beats (shipped strings) -->
        <div class="design-block">
          <h3>move — submitted <code>draft</code></h3>
          <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.5em">
            first beat — your signed tx is in a mainnet mempool, the
            source chain hasn't included it yet. live string at
            relay-bridge.js:289.
          </p>
          <p style="color:var(--muted)">bridge submitted — waiting for confirmation...</p>
        </div>
        <div class="design-block">
          <h3>move — confirmed <code>draft</code></h3>
          <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.5em">
            second beat — source chain included it; relay is pushing to
            optimism. live string at relay-bridge.js:297.
          </p>
          <p style="color:var(--muted)">bridge confirmed — waiting for funds on Optimism...</p>
        </div>
        <div class="design-block">
          <h3>move — ready <code>draft</code></h3>
          <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.5em">
            third beat — the ETH is on optimism; the dock balance
            refreshes on the next event. live string at
            relay-bridge.js:641 and 657.
          </p>
          <p style="color:var(--muted)">complete — ETH on Optimism</p>
        </div>

        <!-- Failure + safe-funds recovery (shipped strings) -->
        <div class="design-block">
          <h3>move — failed <code>draft</code></h3>
          <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.5em">
            relay-side failure during the swap+move step — nothing
            landed on optimism. live string at relay-bridge.js:641.
          </p>
          <p style="color:var(--muted)">swap + bridge failed</p>
        </div>
        <div class="design-block">
          <h3>move — safe-funds recovery <code>draft</code></h3>
          <p style="color:var(--muted);font-size:0.8em;margin:0 0 0.5em">
            the usdc landed on base but the second leg didn't. live
            copy at ramp.js:2050 — tells you where the money sits and
            how to retry without a second relay fee.
          </p>
          <p style="color:var(--muted)">swap+bridge failed — your USDC is safe on Base. retry from "add funds" using the manual bridge.</p>
        <div class="design-block">
          <h3>supporter masonry — single purchase tile <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            one square on an audience member's portfolio masonry — cover art, title, artist.
            probe below attempts <code>renderMasonryTile(stubPurchase)</code>; the function
            is file-local in <code>supporter-home.js:357</code> and relies on module-scoped
            media + domain maps, so the probe is expected to miss and the snapshot stands in.
          </p>
          <div id="design-net-masonry-tile-slot" style="max-width:260px"></div>
        </div>

        <div class="design-block">
          <h3>supporter masonry — album tile <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            same shape as the single-tile, but the overlay prints "n tracks" in the corner.
            probe below attempts <code>renderAlbumTile(mcid, items)</code>; file-local in
            <code>supporter-home.js:305</code> — if the probe misses, a snapshot stands in.
          </p>
          <div id="design-net-album-tile-slot" style="max-width:260px"></div>
        </div>

        <div class="design-block">
          <h3>profile — credentials strip <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            the inline row of role tags under a profile's header — "contributor — project title"
            and "producer — project title" for every project they've worked on. probe attempts
            <code>renderCredentials(contributor, producer)</code>, file-local in
            <code>profile.js:490</code>; snapshot stands in if the probe misses.
          </p>
          <div id="design-net-credentials-slot" style="max-width:560px"></div>
        </div>

        <div class="design-block">
          <h3>profile — blog post card <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            one card in the list of a person's recent posts — title left, date right, a short
            preview below. probe attempts <code>renderPostCard(p)</code>, file-local in
            <code>profile.js:457</code>; snapshot stands in if the probe misses.
          </p>
          <div id="design-net-postcard-slot" style="max-width:560px"></div>
        </div>
      </section>

      <!-- ─────────── 23 · art & post detail ─────────── -->
      <section class="design-section">
        <h2 class="design-section-title">23 · art & post detail</h2>
        <p style="color:var(--dim);font-size:0.9em;margin:0 0 1em;max-width:60ch">
          every full-page view a piece can land in — an album, a gallery image,
          a film, a video, an audio item, a writing item, the owned view, a
          collab, a vanity edition — and the blog surfaces alongside: a full
          post, the history of amendments, a reply, the reply form, and the
          collection hub. renderers in <code>art.js</code> and <code>post.js</code>
          are file-local, so each block is a snapshot of the live shape. draft
          copy marked for miles's pass.
        </p>

        <div class="design-btn-row" id="design-art-openers">
          <button class="buy-btn" data-open="art-album">album</button>
          <button class="buy-btn" data-open="art-gallery">gallery image</button>
          <button class="buy-btn" data-open="art-film">film</button>
          <button class="buy-btn" data-open="art-video">video</button>
          <button class="buy-btn" data-open="art-audio">audio</button>
          <button class="buy-btn" data-open="art-writing">writing</button>
          <button class="buy-btn" data-open="art-onchain">owned view</button>
          <button class="buy-btn" data-open="art-cross-album">collab album</button>
          <button class="buy-btn" data-open="art-cross-item">collab item</button>
          <button class="buy-btn" data-open="art-vanity">vanity edition</button>
          <button class="buy-btn" data-open="art-blogpost">a full post</button>
          <button class="buy-btn" data-open="art-history">post history</button>
          <button class="buy-btn" data-open="art-reply">reply</button>
          <button class="buy-btn" data-open="art-replyform">reply form</button>
          <button class="buy-btn" data-open="art-grouped">posts by collection</button>
        </div>

        <!-- 1. full-page music album -->
        <div class="design-block" id="design-art-album-block">
          <h3>full-page album <code class="retired-tag">retired</code></h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            <code>renderMusicAlbum(el, alias, album, aliasIdx, albumIdx)</code> at
            <code>public/js/art.js:311</code>. the shape Miles saw on
            <a href="https://milesxb.bio/music/nappy-nina/sow-so" target="_blank" rel="noopener noreferrer" style="color:var(--accent)">milesxb.bio/music/nappy-nina/sow-so</a> —
            dense B&W cover, clamp-sized system title, muted byline, play and
            buy at equal weight, write-about buried in the ··· overflow.
          </p>
          <div class="design-card-frame" style="max-width:720px">
            <div class="art-album-hero" style="display:flex;gap:1.25em;align-items:flex-start;flex-wrap:wrap;margin-bottom:1em">
              <div class="art-album-hero-cover" style="flex:0 0 240px">
                <div style="aspect-ratio:1/1;background:color-mix(in srgb, var(--fg) 6%, var(--bg));display:grid;place-items:center;color:var(--dim);font-size:0.75em;border-radius:4px">cover art</div>
              </div>
              <div class="art-album-hero-meta" style="flex:1;min-width:220px">
                <h1 style="font-size:clamp(1.4em, 3vw, 2em);margin:0 0 0.3em;font-weight:700;letter-spacing:-0.02em">sow &amp; so</h1>
                <div style="color:var(--muted);margin-bottom:1em;font-size:0.95em">by nappy nina &amp; swarvy (2026)</div>
                <div style="color:var(--fg);font-size:0.9em;line-height:1.6;margin-bottom:1em">a short note about the album, in the artist's own words.</div>
                <div style="display:flex;gap:0.5ch;align-items:center;flex-wrap:wrap">
                  <button class="album-play-btn feed-card-btn" type="button"><i class="ph ph-play"></i> play</button>
                  <button class="feed-buy-btn feed-card-btn green" type="button">buy 0.002 ETH</button>
                  <button class="track-overflow-btn" type="button" style="background:none;border:none;color:var(--dim);font-size:1.1em;padding:0.2em 0.6ch"><i class="ph ph-dots-three"></i></button>
                </div>
              </div>
            </div>
            <div class="art-tracklist" style="border-top:1px solid var(--border);padding-top:0.5em">
              <div class="album-track" style="display:flex;align-items:center;gap:0.75ch;padding:0.5em 0.25em;border-bottom:1px solid color-mix(in srgb, var(--fg) 4%, transparent)">
                <span class="art-num" style="color:var(--dim);min-width:2ch;text-align:right;font-size:0.9em">1.</span>
                <span class="track-title" style="flex:1;font-size:0.95em">track 1</span>
                <span class="art-num" style="color:var(--dim);font-size:0.85em">3:35</span>
                <button class="track-play-btn" type="button" style="background:none;border:none;color:var(--fg);cursor:pointer;padding:0.2em 0.35ch"><i class="ph ph-play"></i></button>
                <button class="track-buy-btn feed-card-btn green" type="button" style="font-size:0.75em;padding:0.15em 1ch">buy</button>
              </div>
              <div class="album-track" style="display:flex;align-items:center;gap:0.75ch;padding:0.5em 0.25em;border-bottom:1px solid color-mix(in srgb, var(--fg) 4%, transparent)">
                <span class="art-num" style="color:var(--dim);min-width:2ch;text-align:right;font-size:0.9em">2.</span>
                <span class="track-title" style="flex:1;font-size:0.95em">track 2</span>
                <span class="art-num" style="color:var(--dim);font-size:0.85em">3:18</span>
                <button class="track-play-btn" type="button" style="background:none;border:none;color:var(--fg);cursor:pointer;padding:0.2em 0.35ch"><i class="ph ph-play"></i></button>
                <button class="track-buy-btn feed-card-btn green" type="button" style="font-size:0.75em;padding:0.15em 1ch">buy</button>
              </div>
              <div class="album-track" style="display:flex;align-items:center;gap:0.75ch;padding:0.5em 0.25em">
                <span class="art-num" style="color:var(--dim);min-width:2ch;text-align:right;font-size:0.9em">3.</span>
                <span class="track-title" style="flex:1;font-size:0.95em">track 3</span>
                <span class="art-num" style="color:var(--dim);font-size:0.85em">4:00</span>
                <button class="track-play-btn" type="button" style="background:none;border:none;color:var(--fg);cursor:pointer;padding:0.2em 0.35ch"><i class="ph ph-play"></i></button>
                <button class="track-buy-btn feed-card-btn green" type="button" style="font-size:0.75em;padding:0.15em 1ch">buy</button>
              </div>
            </div>
          </div>
        </div>

        <!-- 1b. full-page album, phase 12 — hero + fat tracklist + promoted write-about -->
        <div class="design-block" id="design-art-album-fat-block">
          <h3>full-page album, hero + fat tracklist <code class="proposed-tag">proposed</code></h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em;max-width:62ch">
            phase 12 pulls the album into the same editorial register the feed
            lives in. cover at 320px/16px radius; chillax display title; mixed
            switzer/space-mono byline; optional "with &lt;artist&gt;" collab line;
            space-mono meta strip. three first-class actions —
            <strong>play</strong> (filled dark), <strong>buy</strong> (green
            outline), <strong>write about this</strong> (ghost, promoted out
            of the ··· overflow). description sits in a left-ruled pull-quote
            with a fade-out mask + "read more" expansion. the tracklist
            inherits the phase 11 fat/warm rhythm — 64px rows, 12px radius
            hover wash, chillax titles with features inline. collectors strip
            at the tail; external platforms drop to muted chips below. see
            §10 of <code>design-workshop.css</code> for the
            <code>.dw-album-*</code> primitives; promotion to global
            <code>.art-album-*</code> + <code>renderMusicAlbum</code> ships
            in the same commit.
          </p>
          <div class="design-card-frame" style="max-width:860px">
            <div class="dw-album">
              <div class="dw-album-cover dw-album-cover--placeholder" aria-label="sow &amp; so cover">cover</div>
              <div class="dw-album-meta">
                <h1 class="dw-album-title">sow &amp; so</h1>
                <div class="dw-album-byline">
                  by <a class="dw-album-byline-artist" href="/collection?artist=nappynina.com">nappy nina &amp; swarvy</a><span class="dw-album-byline-year">2026</span>
                </div>
                <div class="dw-album-collab">with <a class="dw-album-collab-artist" href="/collection?artist=swarvy.bandcamp.com">swarvy</a></div>
                <div class="dw-album-metaline">
                  <span>hip-hop</span>
                  <span>13 tracks</span>
                  <span>released 2026-03-14</span>
                </div>
                <div class="dw-album-description">a short note in the artist's own words — the album described as a statement, in the register the writer uses when they're not performing. the fade-out mask hints at more below; the "read more" button opens the full passage in place.</div>
                <button class="dw-album-description-more" type="button" aria-expanded="false">read more</button>
                <div class="dw-album-actions">
                  <button class="dw-album-play" type="button" aria-label="play album"><i class="ph ph-play-fill" aria-hidden="true"></i> play</button>
                  <button class="dw-album-buy" type="button" aria-label="buy album for 0.002 ETH">
                    <i class="ph ph-shopping-bag-open" aria-hidden="true"></i>
                    buy
                    <span class="dw-album-buy-price">0.002 ETH</span>
                  </button>
                  <button class="dw-album-write" type="button" aria-label="write about this album"><i class="ph ph-note-pencil" aria-hidden="true"></i> write about this</button>
                  <button class="dw-album-more" type="button" aria-label="more actions" aria-haspopup="menu" aria-expanded="false"><i class="ph ph-dots-three" aria-hidden="true"></i></button>
                </div>
              </div>
            </div>

            <div class="dw-album-tracklist">
              ${[
                { n: 1,  title: 'headlights',           ft: '',                      dur: '2:47', price: '0.0003 ETH' },
                { n: 2,  title: 'sow & so',             ft: ', ft. swarvy',          dur: '3:18', price: '0.0003 ETH' },
                { n: 3,  title: 'brown sugar barbacoa', ft: '',                      dur: '2:55', price: '0.0003 ETH' },
                { n: 4,  title: 'water signs',          ft: ', ft. pink siifu',      dur: '3:41', price: '0.0003 ETH' },
                { n: 5,  title: 'interlude — radio off',ft: '',                      dur: '0:48', price: '0.0003 ETH' },
                { n: 6,  title: 'root work',            ft: '',                      dur: '3:12', price: '0.0003 ETH' },
                { n: 7,  title: 'auntie’s couch',  ft: ', ft. nitty scott',     dur: '3:33', price: '0.0003 ETH' },
                { n: 8,  title: 'low stakes',           ft: '',                      dur: '2:59', price: '0.0003 ETH' },
                { n: 9,  title: 'dog ear',              ft: '',                      dur: '2:22', price: '0.0003 ETH' },
                { n: 10, title: 'how it should be',     ft: ', ft. akua',            dur: '4:04', price: '0.0003 ETH' },
                { n: 11, title: 'the long way',         ft: '',                      dur: '3:28', price: '0.0003 ETH' },
                { n: 12, title: 'back-porch coda',      ft: '',                      dur: '2:15', price: '0.0003 ETH' },
                { n: 13, title: 'sow & so (reprise)',   ft: ', ft. swarvy',          dur: '1:52', price: '0.0003 ETH' },
              ].map(t => `
                <div class="dw-album-track">
                  <span class="dw-album-track-num">${t.n}</span>
                  <span class="dw-album-track-title-cell">
                    <a class="dw-album-track-title" href="#">${t.title}</a>${t.ft ? `<span class="dw-album-track-features">${t.ft}</span>` : ''}
                  </span>
                  <span class="dw-album-track-duration">${t.dur}</span>
                  <button class="dw-album-track-play" type="button" aria-label="play ${t.title}"><i class="ph ph-play" aria-hidden="true"></i></button>
                  <button class="dw-album-track-buy" type="button" aria-label="buy ${t.title} for ${t.price}">buy <span class="dw-album-track-buy-price">${t.price}</span></button>
                  <button class="dw-album-track-more" type="button" aria-label="more actions for ${t.title}" aria-haspopup="menu" aria-expanded="false"><i class="ph ph-dots-three" aria-hidden="true"></i></button>
                </div>`).join('')}
            </div>

            <div class="dw-album-collectors">
              <span class="dw-album-collectors-label">owned by</span>
              <div class="dw-album-collectors-row">
                <div class="dw-event-avatars" aria-hidden="true">
                  <span class="dw-event-avatar dw-event-avatar--mono-1">b</span>
                  <span class="dw-event-avatar dw-event-avatar--mono-3">m</span>
                  <span class="dw-event-avatar dw-event-avatar--mono-5">p</span>
                </div>
                <span class="dw-album-collectors-count">12 collectors</span>
              </div>
            </div>

            <div class="dw-album-links">
              <a class="dw-album-chip" href="#" rel="noopener noreferrer"><span>bandcamp</span><i class="ph ph-arrow-up-right" aria-hidden="true"></i></a>
              <a class="dw-album-chip" href="#" rel="noopener noreferrer"><span>spotify</span><i class="ph ph-arrow-up-right" aria-hidden="true"></i></a>
              <a class="dw-album-chip" href="#" rel="noopener noreferrer"><span>soundcloud</span><i class="ph ph-arrow-up-right" aria-hidden="true"></i></a>
            </div>
          </div>
        </div>

        <!-- 2. gallery image — phase 13 retired / proposed -->
        <div class="design-block" id="design-art-gallery-block">
          <h3>gallery image <code class="proposed-tag">proposed</code> <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.75em;max-width:68ch">
            <code>renderGalleryImage(el, image, idx)</code> at
            <code>public/js/art.js:553</code>. phase 13 lands the image LEFT at
            native aspect (max 560px tall), title + metadata RIGHT. Chillax 700
            title, Switzer byline, Space Mono metadata with whitespace gaps (no
            dot separators). write-about-this is promoted to a hero pill next
            to buy and share — the three network-benefit moves sit together.
            awards render as a trophy pull-quote; the external "view in person"
            link lands as a chip row below.
          </p>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:1em;max-width:1000px">
            <div>
              <div style="color:var(--muted);font-size:0.72em;text-transform:lowercase;letter-spacing:0.08em;margin-bottom:0.5em;font-family:var(--dw-font-mono)"><code class="retired-tag">retired</code> live renderer</div>
              <div class="design-card-frame" style="max-width:420px">
                <div class="art-cover art-cover-full" style="margin-bottom:1em">
                  <div style="aspect-ratio:3/2;background:color-mix(in srgb, var(--fg) 6%, var(--bg));display:grid;place-items:center;color:var(--dim);font-size:0.75em;border-radius:4px">the image</div>
                </div>
                <h1 class="art-title" style="margin:0 0 0.3em">draft piece</h1>
                <div class="art-meta" style="color:var(--muted);font-size:0.9em;margin-bottom:0.5em">oil on canvas -- 2026 -- series one -- 60 x 80 cm -- new york</div>
                <div class="art-description" style="color:var(--fg);font-size:0.9em;line-height:1.6;margin-bottom:1em">a short note placed under the piece, in the artist's own words.</div>
                <div class="art-action-row" style="display:flex;gap:0.5ch;align-items:center">
                  <button class="track-buy-btn feed-card-btn green" type="button">buy 0.01 ETH</button>
                  <button class="buy-btn" type="button" style="font-size:0.8em;padding:0.3em 1ch"><i class="ph ph-note-pencil"></i> write about</button>
                </div>
              </div>
            </div>
            <div>
              <div style="color:var(--muted);font-size:0.72em;text-transform:lowercase;letter-spacing:0.08em;margin-bottom:0.5em;font-family:var(--dw-font-mono)"><code class="proposed-tag">proposed</code> phase 13</div>
              <div class="design-card-frame" style="max-width:720px">
                <div class="art-detail-hero">
                  <div class="art-detail-hero-media art-detail-hero-media--gallery">
                    <div style="aspect-ratio:3/2;background:color-mix(in srgb, var(--fg) 6%, var(--bg));display:grid;place-items:center;color:var(--dim);font-size:0.75em;border-radius:16px">the image</div>
                  </div>
                  <div class="art-detail-hero-meta">
                    <div class="art-detail-eyebrow"><i class="ph ph-image" aria-hidden="true"></i><span>oil on canvas</span></div>
                    <h1 class="art-detail-title">draft piece</h1>
                    <div class="art-detail-byline">by nappynina.com</div>
                    <div class="art-detail-meta-row"><span>2026</span><span>60 x 80 cm</span><span>series one</span><span>new york</span></div>
                    <div class="art-detail-actions">
                      <button class="art-detail-action art-detail-action--write" type="button" aria-label="write about this"><i class="ph ph-note-pencil" aria-hidden="true"></i><span>write</span></button>
                      <button class="art-detail-action art-detail-action--share" type="button" aria-label="share"><i class="ph ph-share-fat" aria-hidden="true"></i><span>share</span></button>
                      <button class="art-detail-action art-detail-action--buy" type="button"><i class="ph ph-plus" aria-hidden="true"></i><span>buy</span> 0.01 ETH</button>
                    </div>
                  </div>
                </div>
                <div class="art-detail-description">a short note placed under the piece, in the artist's own words.</div>
                <div class="art-detail-pullquote art-detail-pullquote--awards"><i class="ph ph-trophy" aria-hidden="true"></i><span>honored at the 2026 emerging artists prize</span></div>
                <div class="art-detail-chip-row">
                  <a class="art-detail-chip" href="#" onclick="return false"><i class="ph ph-arrow-up-right" aria-hidden="true"></i><span>view in person</span></a>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 3. film work — phase 13 retired / proposed -->
        <div class="design-block" id="design-art-film-block">
          <h3>film work <code class="proposed-tag">proposed</code> <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.75em;max-width:68ch">
            <code>renderFilmWork(el, work)</code> at <code>public/js/art.js:607</code>.
            phase 13 puts the poster LEFT (2:3, max-height 480px) and credits
            RIGHT. byline reads "dir. &lt;director&gt;" + year the way a film
            credit reads. role (actor / writer) sits on its own line in Switzer
            500 when the viewer's relationship to the piece isn't director.
            watch is the primary action when a stream is attached; write and
            share join the hero row. cast renders as a labeled section; awards
            become a trophy pull-quote.
          </p>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:1em;max-width:1000px">
            <div>
              <div style="color:var(--muted);font-size:0.72em;text-transform:lowercase;letter-spacing:0.08em;margin-bottom:0.5em;font-family:var(--dw-font-mono)"><code class="retired-tag">retired</code> live renderer</div>
              <div class="design-card-frame" style="max-width:420px">
                <div class="art-cover" style="margin-bottom:1em">
                  <div style="aspect-ratio:2/3;max-width:220px;background:color-mix(in srgb, var(--fg) 6%, var(--bg));display:grid;place-items:center;color:var(--dim);font-size:0.75em;border-radius:4px">poster</div>
                </div>
                <h1 class="art-title" style="margin:0 0 0.3em">draft film</h1>
                <div class="art-meta" style="color:var(--muted);font-size:0.9em;margin-bottom:0.5em">director -- dir. a colleague -- 2026 -- 92 min -- a festival</div>
                <div class="art-description" style="color:var(--fg);font-size:0.9em;line-height:1.6;margin-bottom:0.75em">a short logline.</div>
                <div class="art-meta-secondary" style="color:var(--dim);font-size:0.85em;margin-bottom:1em">cast: a short list</div>
                <div style="display:flex;gap:0.5ch;align-items:center">
                  <button class="track-buy-btn feed-card-btn green" type="button">buy 0.005 ETH</button>
                  <button class="buy-btn" type="button" style="font-size:0.8em;padding:0.3em 1ch"><i class="ph ph-note-pencil"></i> write about</button>
                </div>
              </div>
            </div>
            <div>
              <div style="color:var(--muted);font-size:0.72em;text-transform:lowercase;letter-spacing:0.08em;margin-bottom:0.5em;font-family:var(--dw-font-mono)"><code class="proposed-tag">proposed</code> phase 13</div>
              <div class="design-card-frame" style="max-width:720px">
                <div class="art-detail-hero">
                  <div class="art-detail-hero-media art-detail-hero-media--poster">
                    <div style="aspect-ratio:2/3;background:color-mix(in srgb, var(--fg) 6%, var(--bg));display:grid;place-items:center;color:var(--dim);font-size:0.75em;border-radius:16px">poster</div>
                  </div>
                  <div class="art-detail-hero-meta">
                    <div class="art-detail-eyebrow"><i class="ph ph-film-slate" aria-hidden="true"></i><span>film</span></div>
                    <h1 class="art-detail-title">draft film</h1>
                    <div class="art-detail-byline">dir. a colleague  2026</div>
                    <div class="art-detail-role">actor</div>
                    <div class="art-detail-meta-row"><span>92 min</span><span>english</span><span>a festival</span></div>
                    <div class="art-detail-actions">
                      <a class="art-detail-action art-detail-action--primary" href="#" onclick="return false"><i class="ph ph-play-fill" aria-hidden="true"></i><span>watch</span></a>
                      <button class="art-detail-action art-detail-action--write" type="button" aria-label="write about this"><i class="ph ph-note-pencil" aria-hidden="true"></i><span>write</span></button>
                      <button class="art-detail-action art-detail-action--share" type="button" aria-label="share"><i class="ph ph-share-fat" aria-hidden="true"></i><span>share</span></button>
                      <button class="art-detail-action art-detail-action--buy" type="button"><i class="ph ph-plus" aria-hidden="true"></i><span>buy</span> 0.005 ETH</button>
                    </div>
                  </div>
                </div>
                <div class="art-detail-description">a short logline — one sentence, the piece in plain words.</div>
                <div class="art-detail-pullquote art-detail-pullquote--awards"><i class="ph ph-trophy" aria-hidden="true"></i><span>official selection, 2026 locarno</span></div>
                <div class="art-detail-section">
                  <div class="art-detail-section-label">with</div>
                  <div class="art-detail-section-body">a short list of the cast — commas, not bullets.</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 4. video item — phase 13 retired / proposed -->
        <div class="design-block" id="design-art-video-block">
          <h3>video item <code class="proposed-tag">proposed</code> <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.75em;max-width:68ch">
            <code>renderVideoItem(el, item)</code> at <code>public/js/art.js:669</code>.
            phase 13 lets the video LEAD — the player sits full-width at the top
            (16:9 reserved, 16px radius). title, byline, duration, type sit below
            in the editorial rhythm. the type eyebrow (music video / short film
            / documentary) reads at a glance; actions row carries write + share
            + buy.
          </p>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:1em;max-width:1000px">
            <div>
              <div style="color:var(--muted);font-size:0.72em;text-transform:lowercase;letter-spacing:0.08em;margin-bottom:0.5em;font-family:var(--dw-font-mono)"><code class="retired-tag">retired</code> live renderer</div>
              <div class="design-card-frame" style="max-width:420px">
                <h1 class="art-title" style="margin:0 0 0.3em">draft video</h1>
                <div class="art-meta" style="color:var(--muted);font-size:0.9em;margin-bottom:0.5em">2026 -- with a colleague</div>
                <div class="art-description" style="color:var(--fg);font-size:0.9em;line-height:1.6;margin-bottom:1em">a short note.</div>
                <div class="art-action-row" style="display:flex;gap:0.5ch;align-items:center;margin-bottom:1em">
                  <button class="track-buy-btn feed-card-btn green" type="button">buy 0.003 ETH</button>
                  <button class="buy-btn" type="button" style="font-size:0.8em;padding:0.3em 1ch"><i class="ph ph-note-pencil"></i> write about</button>
                </div>
                <div class="video-lazy art-video-lazy-frame" style="aspect-ratio:16/9;background:#000;display:grid;place-items:center;color:#aaa;font-size:0.8em;border-radius:4px">play</div>
              </div>
            </div>
            <div>
              <div style="color:var(--muted);font-size:0.72em;text-transform:lowercase;letter-spacing:0.08em;margin-bottom:0.5em;font-family:var(--dw-font-mono)"><code class="proposed-tag">proposed</code> phase 13</div>
              <div class="design-card-frame" style="max-width:720px">
                <div class="art-detail-hero" style="margin-bottom:1.25rem">
                  <div class="art-detail-hero-media art-detail-hero-media--video">
                    <div class="art-video-lazy-frame" style="border-radius:16px;aspect-ratio:16/9;background:#000;display:grid;place-items:center;color:#aaa;font-size:0.8em">
                      <i class="ph ph-play-fill" aria-hidden="true" style="color:var(--muted);font-size:2em"></i>
                    </div>
                  </div>
                </div>
                <div class="art-detail-eyebrow"><i class="ph ph-video" aria-hidden="true"></i><span>music video</span></div>
                <h1 class="art-detail-title">draft video</h1>
                <div class="art-detail-byline">blackmatter.world  with a colleague</div>
                <div class="art-detail-meta-row"><span>3:42</span><span>2026</span></div>
                <div class="art-detail-actions">
                  <button class="art-detail-action art-detail-action--write" type="button" aria-label="write about this"><i class="ph ph-note-pencil" aria-hidden="true"></i><span>write</span></button>
                  <button class="art-detail-action art-detail-action--share" type="button" aria-label="share"><i class="ph ph-share-fat" aria-hidden="true"></i><span>share</span></button>
                  <button class="art-detail-action art-detail-action--buy" type="button"><i class="ph ph-plus" aria-hidden="true"></i><span>buy</span> 0.003 ETH</button>
                </div>
                <div class="art-detail-description">a short note on the piece, in the artist's own words.</div>
              </div>
            </div>
          </div>
        </div>

        <!-- 5. audio item — phase 13 retired / proposed -->
        <div class="design-block" id="design-art-audio-block">
          <h3>audio item <code class="proposed-tag">proposed</code> <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.75em;max-width:68ch">
            <code>renderAudioItem(el, item, idx)</code> at <code>public/js/art.js:736</code>.
            phase 13 lets the cover live LEFT at 320px square when the piece
            carries art; play is the primary action in the hero row, add-to-queue
            sits next to it. type eyebrow (podcast / single / mixtape) reads at
            a glance in Space Mono. write, share, and buy join the actions row.
          </p>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:1em;max-width:1000px">
            <div>
              <div style="color:var(--muted);font-size:0.72em;text-transform:lowercase;letter-spacing:0.08em;margin-bottom:0.5em;font-family:var(--dw-font-mono)"><code class="retired-tag">retired</code> live renderer</div>
              <div class="design-card-frame" style="max-width:420px">
                <h1 class="art-title" style="margin:0 0 0.3em">draft audio</h1>
                <div class="art-meta" style="color:var(--muted);font-size:0.9em;margin-bottom:0.5em">2026 -- nappynina.com</div>
                <div class="art-description" style="color:var(--fg);font-size:0.9em;line-height:1.6;margin-bottom:1em">a short note.</div>
                <div style="margin-bottom:1em">
                  <button class="track-play-btn" type="button" style="background:none;border:1px solid var(--border);color:var(--fg);padding:0.4em 1ch;border-radius:6px"><i class="ph ph-play"></i> play</button>
                </div>
                <div class="art-action-row" style="display:flex;gap:0.5ch;align-items:center">
                  <button class="track-buy-btn feed-card-btn green" type="button">buy 0.001 ETH</button>
                  <button class="buy-btn" type="button" style="font-size:0.8em;padding:0.3em 1ch"><i class="ph ph-note-pencil"></i> write about</button>
                </div>
              </div>
            </div>
            <div>
              <div style="color:var(--muted);font-size:0.72em;text-transform:lowercase;letter-spacing:0.08em;margin-bottom:0.5em;font-family:var(--dw-font-mono)"><code class="proposed-tag">proposed</code> phase 13</div>
              <div class="design-card-frame" style="max-width:720px">
                <div class="art-detail-hero">
                  <div class="art-detail-hero-media art-detail-hero-media--cover-sq">
                    <div style="aspect-ratio:1/1;background:color-mix(in srgb, var(--fg) 6%, var(--bg));display:grid;place-items:center;color:var(--dim);font-size:0.75em;border-radius:16px">cover</div>
                  </div>
                  <div class="art-detail-hero-meta">
                    <div class="art-detail-eyebrow"><i class="ph ph-waveform" aria-hidden="true"></i><span>podcast</span></div>
                    <h1 class="art-detail-title">draft audio</h1>
                    <div class="art-detail-byline">by nappynina.com</div>
                    <div class="art-detail-publisher">the long walk  ep. 12</div>
                    <div class="art-detail-meta-row"><span>42:18</span><span>2026</span><span>english</span></div>
                    <div class="art-detail-actions">
                      <button class="art-detail-action art-detail-action--primary" type="button"><i class="ph ph-play-fill" aria-hidden="true"></i><span>play</span></button>
                      <button class="art-detail-action" type="button" aria-label="add to queue"><i class="ph ph-plus" aria-hidden="true"></i><span>queue</span></button>
                      <button class="art-detail-action art-detail-action--write" type="button" aria-label="write about this"><i class="ph ph-note-pencil" aria-hidden="true"></i><span>write</span></button>
                      <button class="art-detail-action art-detail-action--share" type="button" aria-label="share"><i class="ph ph-share-fat" aria-hidden="true"></i><span>share</span></button>
                      <button class="art-detail-action art-detail-action--buy" type="button"><i class="ph ph-plus" aria-hidden="true"></i><span>buy</span> 0.001 ETH</button>
                    </div>
                  </div>
                </div>
                <div class="art-detail-description">a short note on the piece, in the artist's own words.</div>
              </div>
            </div>
          </div>
        </div>

        <!-- 6. writing item — phase 13 retired / proposed -->
        <div class="design-block" id="design-art-writing-block">
          <h3>writing item <code class="proposed-tag">proposed</code> <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.75em;max-width:68ch">
            <code>renderWritingItem(el, item, idx)</code> at
            <code>public/js/art.js:802</code>. phase 13 puts the cover LEFT (3:4,
            max 400px tall), title block RIGHT. byline "by &lt;author&gt;",
            publisher in Space Mono, form / ISBN / pages in a tabular metadata
            row. read is the primary action (writing is the one type where read
            earns the primary slot), write-about-this is promoted — this is
            the type most likely to be referenced in /write. excerpt reads as
            a pull-quote with a leading quotation glyph.
          </p>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:1em;max-width:1000px">
            <div>
              <div style="color:var(--muted);font-size:0.72em;text-transform:lowercase;letter-spacing:0.08em;margin-bottom:0.5em;font-family:var(--dw-font-mono)"><code class="retired-tag">retired</code> live renderer</div>
              <div class="design-card-frame" style="max-width:420px">
                <div class="art-cover" style="margin-bottom:1em">
                  <div style="aspect-ratio:2/3;max-width:180px;background:color-mix(in srgb, var(--fg) 6%, var(--bg));display:grid;place-items:center;color:var(--dim);font-size:0.75em;border-radius:4px">cover</div>
                </div>
                <h1 class="art-title" style="margin:0 0 0.3em">draft piece</h1>
                <div class="art-meta" style="color:var(--muted);font-size:0.9em;margin-bottom:0.3em">a journal -- a publisher -- 2026 -- [en]</div>
                <div class="art-meta-secondary" style="color:var(--dim);font-size:0.85em;margin-bottom:0.75em">ISBN 000-0-000-00000-0 -- 180 pages -- essay</div>
                <div class="art-description" style="color:var(--fg);font-size:0.9em;line-height:1.6;margin-bottom:1em">a short note.</div>
                <div class="art-excerpt" style="color:var(--muted);font-size:0.9em;line-height:1.7;border-left:2px solid var(--border);padding-left:1ch;margin-bottom:1em">a short excerpt.</div>
                <div class="art-action-row" style="display:flex;gap:0.5ch;align-items:center">
                  <button class="track-buy-btn feed-card-btn green" type="button">buy 0.004 ETH</button>
                  <button class="buy-btn" type="button" style="font-size:0.8em;padding:0.3em 1ch"><i class="ph ph-note-pencil"></i> write about</button>
                </div>
              </div>
            </div>
            <div>
              <div style="color:var(--muted);font-size:0.72em;text-transform:lowercase;letter-spacing:0.08em;margin-bottom:0.5em;font-family:var(--dw-font-mono)"><code class="proposed-tag">proposed</code> phase 13</div>
              <div class="design-card-frame" style="max-width:720px">
                <div class="art-detail-hero">
                  <div class="art-detail-hero-media art-detail-hero-media--cover-tall">
                    <div style="aspect-ratio:3/4;background:color-mix(in srgb, var(--fg) 6%, var(--bg));display:grid;place-items:center;color:var(--dim);font-size:0.75em;border-radius:16px">cover</div>
                  </div>
                  <div class="art-detail-hero-meta">
                    <div class="art-detail-eyebrow"><i class="ph ph-book-open" aria-hidden="true"></i><span>essay</span></div>
                    <h1 class="art-detail-title">draft piece</h1>
                    <div class="art-detail-byline">by nappynina.com</div>
                    <div class="art-detail-publisher">a journal  a publisher</div>
                    <div class="art-detail-meta-row"><span>2026</span><span>en</span><span>ISBN 000-0-000-00000-0</span><span>180 pages</span></div>
                    <div class="art-detail-actions">
                      <a class="art-detail-action art-detail-action--primary" href="#" onclick="return false"><i class="ph ph-book-open" aria-hidden="true"></i><span>read</span></a>
                      <button class="art-detail-action art-detail-action--write" type="button" aria-label="write about this"><i class="ph ph-note-pencil" aria-hidden="true"></i><span>write</span></button>
                      <button class="art-detail-action art-detail-action--share" type="button" aria-label="share"><i class="ph ph-share-fat" aria-hidden="true"></i><span>share</span></button>
                      <button class="art-detail-action art-detail-action--buy" type="button"><i class="ph ph-plus" aria-hidden="true"></i><span>buy</span> 0.004 ETH</button>
                    </div>
                  </div>
                </div>
                <div class="art-detail-pullquote art-detail-pullquote--excerpt">a short excerpt sits here — a paragraph or two of the opening. the leading quotation mark is a Chillax glyph; the border carries the accent.</div>
                <div class="art-detail-description">a short note on the piece, in the artist's own words.</div>
                <div class="art-detail-pullquote art-detail-pullquote--awards"><i class="ph ph-trophy" aria-hidden="true"></i><span>longlisted for the 2026 whiting foundation prize</span></div>
              </div>
            </div>
          </div>
        </div>

        <!-- 7. on-chain purchase hero (owned view) -->
        <div class="design-block" id="design-art-onchain-block">
          <h3>owned view — the media hero <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            <code>renderOnChainMedia(mediaId, loadingEl, contentEl)</code> at
            <code>public/js/art.js:731</code>. the shape the buyer sees — cover
            with a play overlay for audio, title, byline, price, buy or download,
            inline media, collaborators, and the "N collected" line.
          </p>
          <div class="design-card-frame" style="max-width:720px">
            <div class="art-cover" style="position:relative;margin-bottom:1em;max-width:420px">
              <div style="aspect-ratio:1/1;background:color-mix(in srgb, var(--fg) 6%, var(--bg));display:grid;place-items:center;color:var(--dim);font-size:0.75em;border-radius:4px">cover art</div>
              <button class="track-play-btn feed-collected-play-overlay" type="button" style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:56px;height:56px;border-radius:50%;background:rgba(0,0,0,0.6);border:0;color:#fff;font-size:20px;cursor:pointer"><i class="ph ph-play"></i></button>
            </div>
            <h1 class="art-onchain-title" style="margin:0 0 0.3em;font-size:1.8em;font-weight:700;letter-spacing:-0.02em">draft piece</h1>
            <div class="art-meta" style="color:var(--muted);font-size:0.9em;margin-bottom:0.75em">by <a href="#" onclick="return false" class="art-detail-link" style="color:inherit">nappynina.com</a> — <span style="color:var(--fg)">0.002 ETH</span></div>
            <div class="art-action-row" style="display:flex;gap:0.5ch;align-items:center;margin-bottom:1em">
              <button class="feed-card-btn green" type="button">buy</button>
              <a href="#" onclick="return false" class="art-action-ghost" style="color:var(--dim);font-size:0.9em"><i class="ph ph-download-simple"></i> download</a>
            </div>
            <div style="color:var(--dim);font-size:0.9em;margin-bottom:0.75em">
              collaborators: <a href="#" onclick="return false" style="color:var(--fg)">blackmatter.world</a> (40%) <span style="color:var(--dim)">&middot;</span> <a href="#" onclick="return false" style="color:var(--fg)">milesxb.bio</a> (60%)
            </div>
            <div class="art-onchain-supply" style="color:var(--dim);font-size:0.85em;margin-bottom:0.5em">12 collected</div>
            <div class="art-collectors-slot" style="border-top:1px solid var(--border);padding-top:1em">
              <span style="color:var(--dim);font-size:0.8em;text-transform:uppercase;letter-spacing:0.05em">collectors</span>
              <div style="margin-top:0.5em;color:var(--muted);font-size:0.85em;line-height:1.8">
                <a href="#" onclick="return false" class="art-detail-link" style="color:inherit">blackmatter.world</a> ·
                <a href="#" onclick="return false" class="art-detail-link" style="color:inherit">milesxb.bio</a> ·
                <a href="#" onclick="return false" class="art-detail-link" style="color:inherit">nineisgiantess</a>
              </div>
            </div>
          </div>
        </div>

        <!-- 8. cross-artist album (collab) -->
        <div class="design-block" id="design-art-cross-album-block">
          <h3>cross-artist album — a collab <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            <code>renderCrossArtistAlbum(params, loadingEl, contentEl)</code> at
            <code>public/js/art.js:127</code> fetches the collaborator's site, then
            hands off to <code>renderMusicAlbum</code>. the only visible diff is
            the "with artist" attribution under the title; the rest of the shape
            is the full-page album above.
          </p>
          <div class="design-card-frame" style="max-width:560px">
            <div style="display:flex;gap:1em;align-items:flex-start">
              <div style="flex:0 0 120px;aspect-ratio:1/1;background:color-mix(in srgb, var(--fg) 6%, var(--bg));display:grid;place-items:center;color:var(--dim);font-size:0.7em;border-radius:4px">cover</div>
              <div style="flex:1">
                <h1 style="font-size:1.4em;margin:0 0 0.3em;font-weight:700;letter-spacing:-0.02em">draft collab</h1>
                <div style="color:var(--muted);margin-bottom:0.3em;font-size:0.9em">by nappynina.com (2026)</div>
                <div style="color:var(--dim);font-size:0.85em;margin-bottom:0.5em">with <a href="#" onclick="return false" style="color:var(--accent)">blackmatter.world</a></div>
                <div style="display:flex;gap:0.5ch;flex-wrap:wrap">
                  <button class="album-play-btn feed-card-btn" type="button"><i class="ph ph-play"></i> play</button>
                  <button class="feed-buy-btn feed-card-btn green" type="button">buy 0.003 ETH</button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 9. cross-artist item -->
        <div class="design-block" id="design-art-cross-item-block">
          <h3>cross-artist item <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            <code>renderCrossArtistItem(params, loadingEl, contentEl)</code> at
            <code>public/js/art.js:170</code> dispatches to the per-type renderer
            above (gallery, film, video, audio, writing) with the collaborator's
            site.json as the fixture. the shape below is the gallery variant —
            swap the inner body for any of the other four and the surface still fits.
          </p>
          <div class="design-card-frame" style="max-width:560px">
            <div style="aspect-ratio:3/2;background:color-mix(in srgb, var(--fg) 6%, var(--bg));display:grid;place-items:center;color:var(--dim);font-size:0.75em;border-radius:4px;margin-bottom:0.75em">the image</div>
            <h1 class="art-title" style="margin:0 0 0.3em">draft piece</h1>
            <div class="art-meta" style="color:var(--muted);font-size:0.9em;margin-bottom:0.3em">oil on canvas -- 2026</div>
            <div style="color:var(--dim);font-size:0.85em;margin-bottom:0.5em">on nappynina.com, from blackmatter.world</div>
            <button class="track-buy-btn feed-card-btn green" type="button">buy 0.01 ETH</button>
          </div>
        </div>

        <!-- 10. vanity edition marker -->
        <div class="design-block" id="design-art-vanity-block">
          <h3>vanity edition <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            <code>renderVanityItem(vanity, loadingEl, contentEl)</code> at
            <code>public/js/art.js:187</code> walks every module on the tenant,
            finds the item whose slug matches the vanity path, and hands off to
            the right per-type renderer (or <code>renderMusicAlbum</code> for an
            album). the inner page shape is the same as above; the catalog entry
            calls out the slug-matching path so a /some-piece url reads clearly.
          </p>
          <div class="design-card-frame" style="max-width:520px">
            <div style="display:flex;gap:0.5ch;align-items:center;margin-bottom:0.5em">
              <span style="color:var(--dim);font-family:'SF Mono',ui-monospace,monospace;font-size:0.8em">nappynina.com/some-piece</span>
              <span style="color:var(--muted);font-size:0.75em">→ /art?...</span>
            </div>
            <h1 class="art-title" style="margin:0 0 0.3em">draft piece</h1>
            <div class="art-meta" style="color:var(--muted);font-size:0.9em;margin-bottom:0.5em">matched by slug — the inner render is one of the five above</div>
            <div style="color:var(--dim);font-size:0.8em">a short slug lives on the artist's root path. the catalog entry is a pointer; the real surface is whichever per-type renderer the item resolves to.</div>
          </div>
        </div>

        <!-- 11. full blog post view -->
        <div class="design-block" id="design-art-blogpost-block">
          <h3>a full post <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            the post page shape <code>initPost()</code> writes at
            <code>public/js/post.js:305</code> — title, byline + date, the
            actions row (reactions + reply count), the body, then the reply
            thread and the reply form below.
          </p>
          <div class="design-card-frame" style="max-width:640px">
            <header class="post-page-header" style="margin-bottom:1em">
              <h1 class="post-page-title" style="margin:0 0 0.3em;font-size:1.8em;letter-spacing:-0.02em">draft title</h1>
              <div class="post-page-meta" style="color:var(--muted);font-size:0.9em;display:flex;gap:0.75ch;align-items:center">
                <a href="#" onclick="return false" style="color:inherit">milesxb.bio</a>
                <span style="color:var(--dim)"> · </span>
                <time>november 3, 2026</time>
              </div>
              <div class="post-page-actions" style="display:flex;gap:1em;align-items:center;margin-top:0.75em;color:var(--dim);font-size:0.9em">
                <span style="display:inline-flex;gap:0.3ch;align-items:center"><i class="ph ph-heart"></i> 12</span>
                <span style="display:inline-flex;gap:0.3ch;align-items:center"><i class="ph ph-fire"></i> 3</span>
                <span style="display:inline-flex;gap:0.3ch;align-items:center"><i class="ph ph-chat-circle"></i> 2</span>
              </div>
            </header>
            <div class="post-page-body" style="font-size:0.95em;line-height:1.7">
              <h2 style="font-size:1.2em;margin:1em 0 0.5em">a short heading</h2>
              <p>a paragraph of draft body text to show the reading column.</p>
              <p>another paragraph.</p>
            </div>
            <div style="margin-top:2em;border-top:1px solid color-mix(in srgb, var(--fg) 8%, transparent);padding-top:1em">
              <h3 style="color:var(--dim);font-size:0.85em;font-weight:normal;margin-bottom:1em">2 comments</h3>
              <div class="post-reply" style="padding:1.25em 0;border-bottom:1px solid color-mix(in srgb, var(--fg) 5%, transparent)">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.4em">
                  <a href="#" onclick="return false" style="color:var(--muted);font-size:0.85em;text-decoration:none">blackmatter.world</a>
                  <time style="color:var(--dim);font-size:0.8em">nov 3</time>
                </div>
                <div style="color:var(--fg);font-size:0.95em;line-height:1.7">a short reply sits here — one or two lines, in the reader's own words.</div>
              </div>
              <div class="post-reply" style="padding:1.25em 0">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.4em">
                  <a href="#" onclick="return false" style="color:var(--muted);font-size:0.85em;text-decoration:none">nappynina.com</a>
                  <time style="color:var(--dim);font-size:0.8em">nov 3</time>
                </div>
                <div style="color:var(--fg);font-size:0.95em;line-height:1.7">another short reply.</div>
              </div>
            </div>
            <div style="padding-top:1em">
              <textarea placeholder="write a comment..." style="width:100%;background:transparent;border:1px solid color-mix(in srgb, var(--fg) 15%, transparent);color:var(--fg);font-family:inherit;font-size:0.95em;padding:0.75em 1ch;resize:vertical;min-height:4em;line-height:1.7;border-radius:10px;box-sizing:border-box"></textarea>
              <div style="display:flex;justify-content:space-between;align-items:center;margin-top:0.75em">
                <span style="color:var(--muted);font-size:0.85em"></span>
                <button class="buy-btn" style="font-size:0.85em;padding:0.4em 2ch;border-radius:8px">comment</button>
      <!-- ─────────── 24 · templates & player ─────────── -->
      <section class="design-section">
        <h2 class="design-section-title">24 · templates & player</h2>
        <p style="color:var(--dim);font-size:0.9em;margin:0 0 1em;max-width:60ch">
          every template's distinctive top in one scroll, the persistent
          omniplayer bar + queue + PiP video frame, the funding module slot
          that §11 was missing, and each module's empty state.
          hero mocks use the real template classes; every invented label sits
          in a block flagged <code>draft</code>.
        </p>

        <div class="design-btn-row" id="design-tpl-openers">
          <button class="buy-btn" data-open="tpl-player-show">play a test track</button>
          <button class="buy-btn" data-open="tpl-player-queue">toggle the queue sheet</button>
          <button class="buy-btn" data-open="tpl-player-pause">pause</button>
        </div>
        <p style="color:var(--dim);font-size:0.8em;margin:0.25em 0 1.25em">
          the three buttons above drive the live player at the bottom of this
          page. the inline snapshot further down mirrors the same chrome with
          <code>position:static</code> so you can see the bar without leaving
          the top of the catalog.
        </p>

        <!-- ─── template heroes ─── -->

        <div class="design-block">
          <h3>default — identity + modules stack <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            the baseline: profile tag, name, bio, then whatever modules the
            owner enabled. shape from <code>templates/default/index.html</code>.
          </p>
          <div style="max-width:560px;border:1px solid var(--border);border-radius:8px;padding:1.25em 1.5em;background:var(--bg)">
            <header>
              <div class="header-row" style="display:flex;gap:1em;align-items:center">
                <div style="width:60px;height:60px;border-radius:50%;background:color-mix(in srgb, var(--fg) 8%, transparent);flex-shrink:0"></div>
                <div class="header-text">
                  <h1 style="margin:0 0 0.2em;font-size:1.4em">draft name</h1>
                  <p class="bio" style="margin:0;color:var(--muted);font-size:0.9em">a short line about the work.</p>
                </div>
              </div>
            </header>
            <div style="margin-top:1.25em;color:var(--dim);font-size:0.75em;text-transform:uppercase;letter-spacing:0.12em">highlights</div>
            <div style="margin-top:0.5em;color:var(--muted);font-size:0.9em">module stack renders here — music, visual, writing, film — in the order the owner set.</div>
          </div>
        </div>

        <div class="design-block">
          <h3>musician — album grid hero <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            record-shop aesthetic from <code>templates/musician/style.css</code>:
            large name, discography header, album tile with cover thumb.
          </p>
          <div class="artist-header" style="max-width:600px;border:1px solid var(--border);border-radius:8px;padding:1.5em;background:var(--bg);margin:0">
            <h1 class="artist-name" style="margin:0 0 0.2em">draft artist</h1>
            <p class="artist-bio" style="margin:0 0 1em">songs about the walk home.</p>
            <div class="alias-name" style="margin:1em 0 0.75em;padding-bottom:0.4em;border-bottom:1px solid var(--border);color:var(--accent);font-size:0.9em;text-transform:uppercase;letter-spacing:0.12em">draft alias</div>
            <div class="album" style="display:flex;gap:1em;align-items:flex-start;margin-bottom:1em;cursor:default">
              <div style="width:96px;height:96px;background:color-mix(in srgb, var(--fg) 8%, transparent);flex-shrink:0;border-radius:4px"></div>
              <div class="album-info" style="padding-top:0.2em">
                <span class="album-title">draft album</span>
                <span class="album-year" style="color:var(--dim)">(2026)</span>
                <br><span style="color:var(--muted);font-size:0.85em">by draft artist</span>
              </div>
            </div>
          </div>
        </div>

        <!-- 12. post amendments history (3 versions) -->
        <div class="design-block" id="design-art-history-block">
          <h3>post history — three versions <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            <code>renderHistoryView(contentEl, originalPost, amendments, postId)</code> at
            <code>public/js/post.js:611</code> is file-local. the current version
            carries an accent border and full opacity; the earlier two are muted.
            same post already snapshotted in §19 making & writing — here with real
            three-version amendment data so the shape of the full history reads.
          </p>
          <div class="design-card-frame" style="max-width:640px">
            <header class="post-page-header" style="margin-bottom:1em">
              <h1 class="post-page-title" style="margin:0 0 0.3em;font-size:1.6em;letter-spacing:-0.02em">draft title</h1>
              <div class="post-page-meta" style="color:var(--muted);font-size:0.9em">
                <a href="#" onclick="return false" style="color:inherit">milesxb.bio</a>
                <span style="color:var(--dim)"> — </span>
                <a href="#" onclick="return false" style="color:var(--dim)">back</a>
              </div>
            </header>
            <h3 style="color:var(--muted);font-size:0.8em;text-transform:uppercase;letter-spacing:0.1em;margin:1.5em 0 1em">3 versions</h3>

            <div style="border:1px solid var(--border);padding:1.25em;margin-bottom:1em;opacity:0.7">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.75em">
                <span style="font-size:0.8em;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em">original</span>
                <time style="color:var(--dim);font-size:0.8em">november 3, 2026 — 8:14 am</time>
              </div>
              <h3 style="margin-bottom:0.5em">draft title</h3>
              <div class="post-page-body" style="font-size:0.95em">a paragraph of draft body text — the first pass.</div>
            </div>

            <div style="border:1px solid var(--border);padding:1.25em;margin-bottom:1em;opacity:0.7">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.75em">
                <span style="font-size:0.8em;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em">amendment 1</span>
                <time style="color:var(--dim);font-size:0.8em">november 4, 2026 — 6:12 am</time>
              </div>
              <h3 style="margin-bottom:0.5em">draft title</h3>
              <div class="post-page-body" style="font-size:0.95em">a second pass — the body opens up, a line is added.</div>
            </div>

            <div style="border:1px solid var(--accent);padding:1.25em;margin-bottom:1em">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.75em">
                <span style="font-size:0.8em;color:var(--accent);text-transform:uppercase;letter-spacing:0.05em">amendment 2 (current)</span>
                <time style="color:var(--dim);font-size:0.8em">november 4, 2026 — 7:14 am</time>
              </div>
              <h3 style="margin-bottom:0.5em">draft title</h3>
              <div class="post-page-body" style="font-size:0.95em">the version readers land on today — one short heading, two paragraphs.</div>
            </div>
          </div>
        </div>

        <!-- 13. reply thread row -->
        <div class="design-block" id="design-art-reply-block">
          <h3>reply — one row <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            <code>renderReply(r)</code> at <code>public/js/post.js:680</code> is
            a closure inside <code>loadReplies</code>. author on the left (muted,
            small), date on the right (dim, small), the reply body below.
          </p>
          <div class="design-card-frame" style="max-width:560px">
            <div class="post-reply" style="padding:1.25em 0">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.4em">
                <a href="#" onclick="return false" style="color:var(--muted);font-size:0.85em;text-decoration:none">blackmatter.world</a>
                <time style="color:var(--dim);font-size:0.8em">nov 3</time>
              </div>
              <div style="color:var(--fg);font-size:0.95em;line-height:1.7">a short reply sits here — one or two lines, in the reader's own words.</div>
            </div>
          </div>
        </div>

        <!-- 14. reply form (inline, same post) -->
        <div class="design-block" id="design-art-replyform-block">
          <h3>reply form — inline on a post <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            same <code>renderReplyForm(blogAddr, postId)</code> at
            <code>public/js/post.js:1032</code> already snapshotted in §19 making &
            writing — here placed under the post body so the full reading column
            reads in one scroll. the border pulses to the accent color on focus.
          </p>
          <div class="design-card-frame" style="max-width:560px">
            <div style="padding-top:1em">
              <textarea placeholder="write a comment..." style="width:100%;background:transparent;border:1px solid color-mix(in srgb, var(--fg) 15%, transparent);color:var(--fg);font-family:inherit;font-size:0.95em;padding:0.75em 1ch;resize:vertical;min-height:4em;line-height:1.7;border-radius:10px;box-sizing:border-box"></textarea>
              <div style="display:flex;justify-content:space-between;align-items:center;margin-top:0.75em">
                <span style="color:var(--muted);font-size:0.85em"></span>
                <button class="buy-btn" style="font-size:0.85em;padding:0.4em 2ch;border-radius:8px">comment</button>
        <div class="design-block">
          <h3>visual — gallery column hero <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            quiet name, subtle bio, three columns of images — the work carries
            the weight. shape from <code>templates/visual/style.css</code>.
          </p>
          <div style="max-width:600px;border:1px solid var(--border);border-radius:8px;padding:1.5em;background:var(--bg)">
            <h1 style="margin:0 0 0.3em;font-size:1em;text-transform:uppercase;letter-spacing:0.15em;color:var(--dim)">draft name</h1>
            <p class="bio" style="margin:0 0 1.25em;color:var(--muted);font-size:0.85em">paintings, 2018–present.</p>
            <div class="gallery-grid" style="columns:3;column-gap:0.5em">
              <div class="gallery-item" style="break-inside:avoid;margin-bottom:0.5em"><div style="width:100%;aspect-ratio:3/4;background:color-mix(in srgb, var(--fg) 8%, transparent)"></div></div>
              <div class="gallery-item" style="break-inside:avoid;margin-bottom:0.5em"><div style="width:100%;aspect-ratio:1;background:color-mix(in srgb, var(--fg) 10%, transparent)"></div></div>
              <div class="gallery-item" style="break-inside:avoid;margin-bottom:0.5em"><div style="width:100%;aspect-ratio:4/5;background:color-mix(in srgb, var(--fg) 6%, transparent)"></div></div>
              <div class="gallery-item" style="break-inside:avoid;margin-bottom:0.5em"><div style="width:100%;aspect-ratio:1;background:color-mix(in srgb, var(--fg) 9%, transparent)"></div></div>
              <div class="gallery-item" style="break-inside:avoid;margin-bottom:0.5em"><div style="width:100%;aspect-ratio:3/4;background:color-mix(in srgb, var(--fg) 7%, transparent)"></div></div>
              <div class="gallery-item" style="break-inside:avoid;margin-bottom:0.5em"><div style="width:100%;aspect-ratio:5/4;background:color-mix(in srgb, var(--fg) 11%, transparent)"></div></div>
            </div>
          </div>
        </div>

        <div class="design-block">
          <h3>writer — chapbook list hero <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            book-cover title, author statement, bibliography layout. shape from
            <code>templates/writer/style.css</code>.
          </p>
          <div style="max-width:560px;border:1px solid var(--border);border-radius:8px;padding:1.75em 1.75em;background:var(--bg);line-height:1.7">
            <h1 style="margin:0 0 0.3em;font-size:2em;letter-spacing:-0.02em;line-height:1.15">draft name</h1>
            <p class="bio" style="margin:0 0 1.5em;color:var(--fg);font-size:1em;max-width:50ch">essays and short fiction. based somewhere quiet.</p>
            <ul class="post-list" style="list-style:none;padding:0;margin:0">
              <li style="margin-bottom:1.25em;padding-bottom:1em;border-bottom:1px solid var(--border)">
                <time style="display:block;color:var(--dim);font-size:0.75em;letter-spacing:0.05em;margin-bottom:0.2em">march 2026</time>
                <a href="#" onclick="return false" style="font-size:1.05em;color:var(--accent);text-decoration:none">draft essay</a>
              </li>
              <li style="margin-bottom:0;padding-bottom:0">
                <time style="display:block;color:var(--dim);font-size:0.75em;letter-spacing:0.05em;margin-bottom:0.2em">january 2026</time>
                <a href="#" onclick="return false" style="font-size:1.05em;color:var(--accent);text-decoration:none">draft short story</a>
              </li>
            </ul>
          </div>
        </div>

        <div class="design-block">
          <h3>performer — credits-forward hero <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            resume aesthetic: uppercase name, rep line, three-column credits
            table. shape from <code>templates/performer/style.css</code>.
          </p>
          <div style="max-width:620px;border:1px solid var(--border);border-radius:8px;padding:1.75em;background:var(--bg)">
            <div class="artist-header" style="margin:0 0 1.5em;padding-bottom:1em;border-bottom:2px solid var(--fg)">
              <div class="artist-name" style="font-size:1.4em;font-weight:normal;color:var(--accent);letter-spacing:0.03em;text-transform:uppercase;margin-bottom:0.15em">draft name</div>
              <div class="artist-bio" style="color:var(--fg);font-size:0.9em;margin-bottom:0.3em">actor, singer, movement.</div>
              <div class="artist-rep" style="color:var(--dim);font-size:0.8em;font-style:italic">rep: draft agency</div>
            </div>
            <div style="color:var(--dim);font-size:0.75em;text-transform:uppercase;letter-spacing:0.1em;padding-bottom:0.3em;border-bottom:1px solid var(--border);margin-bottom:0.5em">theater</div>
            <div class="credit" style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:1.5ch;padding:0.3em 0;font-size:0.9em">
              <span class="credit-title" style="color:var(--fg);font-style:italic">draft play <span style="font-style:normal;color:var(--dim);font-size:0.85em">2026</span></span>
              <span class="credit-role">lead</span>
              <span class="credit-dir" style="color:var(--muted)">draft theatre</span>
            </div>
            <div class="credit" style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:1.5ch;padding:0.3em 0;font-size:0.9em">
              <span class="credit-title" style="color:var(--fg);font-style:italic">draft play 2 <span style="font-style:normal;color:var(--dim);font-size:0.85em">2025</span></span>
              <span class="credit-role">supporting</span>
              <span class="credit-dir" style="color:var(--muted)">draft venue</span>
            </div>
          </div>
        </div>

        <div class="design-block">
          <h3>filmmaker — reel + filmography hero <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            cinematic 16:9 reel on top, program-style project cards below.
            shape from <code>templates/filmmaker/style.css</code>.
          </p>
          <div style="max-width:620px;border:1px solid var(--border);border-radius:8px;padding:1.5em;background:var(--bg)">
            <div class="artist-header" style="margin-bottom:1.25em;padding-bottom:1em;border-bottom:1px solid var(--border)">
              <div class="artist-name" style="font-size:1.1em;letter-spacing:0.08em;text-transform:uppercase;margin-bottom:0.1em">draft name</div>
              <div class="artist-tagline" style="color:var(--accent);font-size:0.95em;font-style:italic;margin-bottom:0.3em">a line about the work.</div>
              <div class="artist-bio" style="color:var(--muted);font-size:0.85em">director, cinematographer.</div>
            </div>
            <div class="reel-embed" style="position:relative;width:100%;padding-bottom:56.25%;background:color-mix(in srgb, var(--fg) 8%, transparent);margin-bottom:1em"></div>
            <div style="color:var(--dim);font-size:0.7em;text-transform:uppercase;letter-spacing:0.15em;margin-bottom:0.75em">filmography</div>
            <div class="project-card" style="display:grid;grid-template-columns:1fr auto;gap:1ch;padding:0.6em 0;border-bottom:1px solid var(--border)">
              <div>
                <span class="project-title" style="font-size:0.95em">draft short</span>
                <span class="project-role" style="color:var(--accent);font-size:0.85em;margin-left:0.5ch">director</span>
              </div>
              <span class="project-year" style="color:var(--dim);font-size:0.85em;font-variant-numeric:tabular-nums">2025</span>
            </div>
            <div class="project-card" style="display:grid;grid-template-columns:1fr auto;gap:1ch;padding:0.6em 0;border-bottom:1px solid var(--border)">
              <div>
                <span class="project-title" style="font-size:0.95em">draft doc</span>
                <span class="project-role" style="color:var(--accent);font-size:0.85em;margin-left:0.5ch">dp</span>
              </div>
              <span class="project-year" style="color:var(--dim);font-size:0.85em;font-variant-numeric:tabular-nums">2024</span>
            </div>
          </div>
        </div>

        <div class="design-block">
          <h3>organization — slim nav + shared vault chrome <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            org-logo-forward header, roster grid, shared-account badge in the
            top-bar. shape from <code>templates/organization/layout.html</code>
            and <code>style.css</code>.
          </p>
          <div style="max-width:620px;border:1px solid var(--border);border-radius:8px;background:var(--bg);overflow:hidden">
            <header style="display:flex;align-items:center;justify-content:space-between;padding:0.5em 1em;border-bottom:1px solid var(--border);font-size:0.85em">
              <span style="color:var(--fg);opacity:0.7">draft org</span>
              <span style="color:var(--muted);font-size:0.85em">shared account</span>
            </header>
            <div style="padding:1.5em">
              <div class="org-header-row" style="display:flex;gap:1.25em;align-items:center;margin-bottom:1.5em">
                <div class="org-logo" style="width:80px;height:80px;border-radius:12px;background:color-mix(in srgb, var(--fg) 10%, transparent);flex-shrink:0"></div>
                <div style="flex:1;min-width:0">
                  <h1 style="margin:0 0 0.15em;font-size:1.4em;letter-spacing:-0.02em">draft org</h1>
                  <p class="bio" style="margin:0;color:var(--muted);font-size:0.9em">a label, a collective, a crew.</p>
                </div>
              </div>
              <div class="roster-title" style="color:var(--dim);font-size:0.75em;text-transform:uppercase;letter-spacing:0.12em;margin-bottom:0.75em">roster</div>
              <div class="roster-grid" style="display:grid;grid-template-columns:repeat(3, 1fr);gap:0.75em">
                <div class="roster-card" style="padding:0.75em;border:1px solid var(--border);border-radius:12px;display:flex;flex-direction:column;align-items:center;gap:0.4em;font-size:0.8em">
                  <div style="width:40px;height:40px;border-radius:50%;background:color-mix(in srgb, var(--fg) 8%, transparent)"></div>
                  <span class="roster-name" style="color:var(--accent);font-size:0.85em">draft artist a</span>
                </div>
                <div class="roster-card" style="padding:0.75em;border:1px solid var(--border);border-radius:12px;display:flex;flex-direction:column;align-items:center;gap:0.4em;font-size:0.8em">
                  <div style="width:40px;height:40px;border-radius:50%;background:color-mix(in srgb, var(--fg) 8%, transparent)"></div>
                  <span class="roster-name" style="color:var(--accent);font-size:0.85em">draft artist b</span>
                </div>
                <div class="roster-card" style="padding:0.75em;border:1px solid var(--border);border-radius:12px;display:flex;flex-direction:column;align-items:center;gap:0.4em;font-size:0.8em">
                  <div style="width:40px;height:40px;border-radius:50%;background:color-mix(in srgb, var(--fg) 8%, transparent)"></div>
                  <span class="roster-name" style="color:var(--accent);font-size:0.85em">draft artist c</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 15. grouped posts (hub view) -->
        <div class="design-block" id="design-art-grouped-block">
          <h3>posts by collection — the hub view <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            <code>renderGrouped(posts)</code> at <code>public/js/post.js:922</code>
            is file-local — buckets posts by the <code>postCollections</code> map,
            prints each collection as its own section, then "uncategorized" at the
            end. each post card is <code>renderPostItem(p)</code> at
            <code>public/js/post.js:841</code>.
          </p>
          <div class="design-card-frame" style="max-width:640px">
            <div class="blog-collection-group" style="margin-bottom:2em">
              <h3 style="color:var(--muted);font-size:0.85em;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:0.5em">
                <a href="#" onclick="return false" style="color:var(--muted);text-decoration:none">notes</a>
              </h3>
              <ul class="post-list" style="padding:0;margin:0;list-style:none">
                <li style="margin-bottom:0.75em">
                  <a href="#" onclick="return false" style="display:block;text-decoration:none;color:inherit;border:1px solid var(--border);border-radius:6px;overflow:hidden">
                    <div style="padding:0.75em 1em">
                      <div style="font-weight:700;font-size:1.3em;line-height:1.25;letter-spacing:-0.01em;color:var(--fg)">draft title</div>
                      <div style="color:var(--muted);font-size:0.85em;line-height:1.6;margin-top:0.4em">a short preview — the first line or two sits here, then a soft trim.</div>
                      <div style="margin-top:0.5em;display:flex;gap:1.5ch;align-items:center">
                        <time style="color:var(--dim);font-size:0.8em">november 3, 2026</time>
                        <span style="color:var(--dim);font-size:0.8em">2 replies</span>
                      </div>
                    </div>
                  </a>
                </li>
                <li style="margin-bottom:0.75em">
                  <a href="#" onclick="return false" style="display:block;text-decoration:none;color:inherit;border:1px solid var(--border);border-radius:6px;overflow:hidden">
                    <div style="padding:0.75em 1em">
                      <div style="font-weight:700;font-size:1.3em;line-height:1.25;letter-spacing:-0.01em;color:var(--fg)">draft title</div>
                      <div style="color:var(--muted);font-size:0.85em;line-height:1.6;margin-top:0.4em">another short preview.</div>
                      <div style="margin-top:0.5em;display:flex;gap:1.5ch;align-items:center">
                        <time style="color:var(--dim);font-size:0.8em">november 2, 2026</time>
                      </div>
                    </div>
                  </a>
                </li>
              </ul>
            </div>
            <div class="blog-collection-group">
              <h3 style="color:var(--muted);font-size:0.85em;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:0.5em">uncategorized</h3>
              <ul class="post-list" style="padding:0;margin:0;list-style:none">
                <li style="margin-bottom:0.75em">
                  <a href="#" onclick="return false" style="display:block;text-decoration:none;color:inherit;border:1px solid var(--border);border-radius:6px;overflow:hidden">
                    <div style="padding:0.75em 1em">
                      <div style="font-weight:700;font-size:1.3em;line-height:1.25;letter-spacing:-0.01em;color:var(--fg)">draft title</div>
                      <div style="color:var(--muted);font-size:0.85em;line-height:1.6;margin-top:0.4em">a short preview with no collection.</div>
                      <div style="margin-top:0.5em;display:flex;gap:1.5ch;align-items:center">
                        <time style="color:var(--dim);font-size:0.8em">november 1, 2026</time>
                      </div>
                    </div>
                  </a>
                </li>
              </ul>
            </div>
        <div class="design-block">
          <h3>project — funding widget hero <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            minimal top-bar, funding widget is the page. shape from
            <code>templates/project/style.css</code>. hero cover, progress bar,
            tier buttons, single primary action.
          </p>
          <div style="max-width:620px;border:1px solid var(--border);border-radius:8px;background:var(--bg);overflow:hidden">
            <header style="display:flex;align-items:center;justify-content:space-between;padding:0.75em 1em;border-bottom:1px solid var(--border);font-size:0.85em">
              <span style="color:var(--fg);opacity:0.7">draft project</span>
              <span style="color:var(--muted)">praxis</span>
            </header>
            <div class="project-funding-widget" style="margin:1em;border:1px solid var(--border);border-radius:12px;overflow:hidden;background:var(--surface)">
              <div class="funding-hero" style="position:relative;aspect-ratio:16/9;background:color-mix(in srgb, var(--fg) 8%, transparent)">
                <div class="funding-hero-fade" style="position:absolute;inset:0;background:linear-gradient(180deg, transparent 45%, rgba(0,0,0,0.72) 100%)"></div>
                <div class="funding-hero-body" style="position:absolute;left:0;right:0;bottom:0;padding:1em 1.25em;display:flex;flex-direction:column;gap:0.3em">
                  <div class="funding-status-pill" style="align-self:flex-start;font-size:0.65em;text-transform:uppercase;letter-spacing:0.12em;padding:0.15em 0.6em;border:1px solid #fff;border-radius:999px;color:#fff;opacity:0.9">funding</div>
                  <h2 class="funding-title" style="margin:0;font-size:1.3em;font-weight:600;color:#fff">draft project</h2>
                  <p class="funding-blurb" style="margin:0;font-size:0.85em;color:rgba(255,255,255,0.85)">a short line about what the money is for.</p>
                </div>
              </div>
              <div class="funding-progress-wrap" style="padding:1em 1.25em 0.6em">
                <div class="funding-numbers" style="display:flex;align-items:baseline;gap:0.4ch;font-variant-numeric:tabular-nums;margin-bottom:0.5em">
                  <span class="funding-raised" style="font-size:1.2em;color:var(--fg);font-weight:700">$6,400</span>
                  <span class="funding-of" style="color:var(--dim);font-size:0.85em">of</span>
                  <span class="funding-goal" style="color:var(--muted);font-size:0.85em">$10,000</span>
                  <span class="funding-pct" style="margin-left:auto;color:var(--accent);font-weight:700;font-size:1em">64%</span>
                </div>
                <div class="funding-bar" style="height:6px;background:color-mix(in srgb, var(--fg) 8%, transparent);border-radius:3px;overflow:hidden;margin-bottom:0.5em">
                  <div class="funding-bar-fill" style="height:100%;width:64%;background:var(--accent)"></div>
                </div>
                <div class="funding-meta" style="font-size:0.8em;color:var(--muted)">
                  <span>42 backers</span>
                  <span class="funding-meta-dot" style="color:var(--dim)"> — </span>
                  <span>30 days left</span>
                </div>
              </div>
              <div class="funding-cta-row" style="display:flex;gap:1em;align-items:center;padding:0.6em 1.25em 1em">
                <button class="buy-btn funding-cta-btn" style="flex:1;font-size:0.9em">back this project</button>
                <a class="funding-detail-link" href="#" onclick="return false" style="color:var(--muted);text-decoration:none;font-size:0.8em">full detail →</a>
              </div>
            </div>
          </div>
        </div>

        <!-- ─── omniplayer chrome (persistent bar + queue + PiP video) ─── -->

        <div class="design-block">
          <h3>persistent audio bar — full chrome</h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            the live <code>#global-player</code> markup from <code>player.js:9-139</code>,
            pulled inline with <code>position:static</code> so you can see the
            bar without scrolling. in prod it docks to the bottom of every
            page. prev, play/pause, next, repeat, title, scrubber,
            elapsed/total, queue toggle.
          </p>
          <div id="design-player-bar-snapshot" style="position:static;height:48px;background:var(--bg);border:1px solid var(--border);border-radius:6px;display:flex;align-items:center;gap:1ch;padding:0 1.5ch;font-size:0.85em;color:var(--fg);max-width:720px">
            <div style="display:flex;align-items:center;gap:0.25ch;flex-shrink:0">
              <button style="background:none;border:none;color:var(--muted);font-size:1em;cursor:pointer;padding:0.3em;min-width:36px;min-height:36px;display:flex;align-items:center;justify-content:center" aria-label="previous track"><i class="ph ph-skip-back"></i></button>
              <button style="background:rgba(255,255,255,0.1);border:none;border-radius:50%;color:var(--fg);font-size:0.9em;padding:0;cursor:pointer;width:28px;height:28px;display:flex;align-items:center;justify-content:center;flex-shrink:0" aria-label="play"><i class="ph ph-play"></i></button>
              <button style="background:none;border:none;color:var(--muted);font-size:1em;cursor:pointer;padding:0.3em;min-width:36px;min-height:36px;display:flex;align-items:center;justify-content:center" aria-label="next track"><i class="ph ph-skip-forward"></i></button>
              <button style="background:none;border:none;color:var(--border);font-size:1em;cursor:pointer;padding:0.3em;min-width:36px;min-height:36px;display:flex;align-items:center;justify-content:center" aria-label="repeat off" title="repeat off"><i class="ph ph-repeat"></i></button>
            </div>
            <div style="width:32px;height:32px;background:color-mix(in srgb, var(--fg) 10%, transparent);border-radius:2px;flex-shrink:0"></div>
            <a href="#" onclick="return false" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:24ch;color:var(--accent);text-decoration:none;cursor:pointer">track title — artist</a>
            <div style="flex:1;height:6px;background:var(--border);cursor:pointer;position:relative;min-width:40px;border-radius:3px;overflow:hidden">
              <div style="position:absolute;top:0;left:0;height:100%;background:rgba(255,255,255,0.08);width:72%;border-radius:3px"></div>
              <div style="position:absolute;top:0;left:0;height:100%;background:var(--accent);width:42%;border-radius:3px"></div>
            </div>
            <span style="white-space:nowrap;color:var(--muted);font-size:0.85em;flex-shrink:0;font-variant-numeric:tabular-nums">1:28 / 3:24</span>
            <button style="background:none;border:none;color:var(--dim);font-size:1.3em;cursor:pointer;padding:0.3em;min-width:36px;min-height:36px;display:flex;align-items:center;justify-content:center;flex-shrink:0" aria-label="queue" title="queue"><i class="ph ph-playlist"></i></button>
          </div>
        </div>

        <div class="design-block">
          <h3>scrubber — position + elapsed/total</h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            just the progress strip from the bar, pulled wide so you can see
            the fill (accent), the buffer (10% white), and the track (border).
            tabular numbers on the right.
          </p>
          <div style="display:flex;align-items:center;gap:1.5ch;max-width:520px">
            <div style="flex:1;height:6px;background:var(--border);position:relative;border-radius:3px;overflow:hidden">
              <div style="position:absolute;top:0;left:0;height:100%;background:rgba(255,255,255,0.08);width:68%"></div>
              <div style="position:absolute;top:0;left:0;height:100%;background:var(--accent);width:34%"></div>
            </div>
            <span style="color:var(--muted);font-size:0.85em;font-variant-numeric:tabular-nums;white-space:nowrap">1:08 / 3:15</span>
          </div>
        </div>

        <div class="design-block">
          <h3>mediaSession indicator — lockscreen hint <code>draft</code></h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            what the phone shows while the track is playing in the background —
            cover, title, artist, standard transport. a mock of the system UI
            so you can see where the player hands off to the OS.
          </p>
          <div style="max-width:300px;border:1px solid var(--border);border-radius:14px;padding:0.75em;background:color-mix(in srgb, var(--fg) 3%, transparent)">
            <div style="display:flex;align-items:center;gap:0.75ch">
              <div style="width:52px;height:52px;background:color-mix(in srgb, var(--fg) 10%, transparent);border-radius:6px;flex-shrink:0"></div>
              <div style="flex:1;min-width:0">
                <div style="color:var(--fg);font-size:0.9em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">draft track title</div>
                <div style="color:var(--muted);font-size:0.8em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">draft artist</div>
              </div>
            </div>
            <div style="display:flex;justify-content:center;gap:1.5ch;margin-top:0.6em;color:var(--muted)">
              <i class="ph ph-skip-back"></i>
              <i class="ph ph-pause-circle" style="font-size:1.4em;color:var(--fg)"></i>
              <i class="ph ph-skip-forward"></i>
            </div>
          </div>
        </div>

        <div class="design-block">
          <h3>queue panel — live render</h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            calls <code>renderQueueList()</code> into the slot below. in prod
            the panel slides in from the right; here it's static. with an
            empty queue it reads "queue is empty" — click <em>play a test
            track</em> up top to see a row appear.
          </p>
          <div id="design-player-queue-slot" style="max-width:360px;background:var(--bg);border:1px solid var(--border);border-radius:8px;overflow:hidden">
            <div style="display:flex;justify-content:space-between;align-items:center;padding:0.75em 1em;border-bottom:1px solid var(--border)">
              <span style="color:var(--fg);font-size:0.9em;font-weight:bold">queue</span>
              <div style="display:flex;gap:0.75ch;align-items:center">
                <button style="background:none;border:none;color:var(--dim);font-size:0.75em;cursor:pointer;padding:0.2em 0.5ch">clear</button>
                <button style="background:none;border:none;color:var(--dim);font-size:1.2em;cursor:pointer">&times;</button>
              </div>
            </div>
            <div id="gp-queue-list-mirror" style="padding:0.5em 0;min-height:120px"></div>
          </div>
        </div>

        <div class="design-block">
          <h3>omniplayer PiP — inline video frame</h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            when a playing inline video scrolls off, player.js hoists it into
            the bar itself — a 72×40 frame at the left of the title. clicking
            the frame scrolls the viewer back to the source <code>&lt;video&gt;</code>; pausing
            via the bar pauses the inline element. one chrome for audio + video.
          </p>
          <div style="display:flex;align-items:center;gap:1ch;padding:0 1.5ch;height:48px;max-width:720px;background:var(--bg);border:1px solid var(--border);border-radius:6px;font-size:0.85em">
            <div style="display:flex;align-items:center;gap:0.25ch;flex-shrink:0;color:var(--muted)">
              <i class="ph ph-skip-back"></i>
              <i class="ph ph-pause" style="margin:0 0.3ch"></i>
              <i class="ph ph-skip-forward"></i>
            </div>
            <div style="position:relative;width:72px;height:40px;flex-shrink:0;background:#000;border-radius:3px;overflow:hidden;cursor:pointer" title="back to video" aria-label="back to video">
              <div style="width:100%;height:100%;background:color-mix(in srgb, var(--accent) 20%, #000);display:flex;align-items:center;justify-content:center;color:#fff">
                <i class="ph ph-film-strip" style="font-size:1.1em"></i>
              </div>
            </div>
            <span style="color:var(--accent);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">video title</span>
            <div style="flex:1;height:6px;background:var(--border);border-radius:3px;overflow:hidden">
              <div style="height:100%;width:38%;background:var(--accent)"></div>
            </div>
            <span style="color:var(--muted);font-variant-numeric:tabular-nums">0:42 / 1:48</span>
          </div>
        </div>

        <!-- ─── funding module slot (§11 gap) ─── -->

        <div class="design-block">
          <h3>funding module — live <code>renderSection()</code></h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            the one module §11 was missing. the funding module expects
            <code>{ projectId }</code> and renders a server-side shell that
            <code>funding-widget.js</code> hydrates from on-chain state. the
            first slot calls <code>renderSection()</code> with the fixture the
            brief specified (<code>{ projects: [...] }</code>) — the module
            needs <code>projectId</code> so that payload returns empty. the
            second slot passes <code>{ projectId: '1' }</code> so you can see
            the pre-hydration shell shape.
          </p>
          <div style="color:var(--dim);font-size:0.75em;text-transform:uppercase;letter-spacing:0.08em;margin:0.5em 0 0.3em">brief fixture — <code>{ projects: [...] }</code></div>
          <div id="design-mod-funding" class="design-module-slot"></div>
          <div style="color:var(--dim);font-size:0.75em;text-transform:uppercase;letter-spacing:0.08em;margin:1em 0 0.3em">real shape — <code>{ projectId: '1' }</code></div>
          <div id="design-mod-funding-real" class="design-module-slot"></div>
        </div>

        <!-- ─── module empty states (10 blocks) ─── -->

        <div class="design-block">
          <h3>module empty states — 10 modules, no payload</h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">
            each slot calls the real <code>renderSection()</code> with the
            minimum empty fixture (<code>items: []</code>, <code>images: []</code>,
            etc.). most modules fall through to an empty string — the "no
            fallback, section is hidden" behavior the renderer ships with.
            the catalog surfaces that so a drift to visible-when-empty is
            caught here.
          </p>
          <div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(240px, 1fr));gap:1em;max-width:720px">
            <div><div style="color:var(--dim);font-size:0.75em;margin-bottom:0.3em">music</div><div id="design-mod-music-empty" class="design-module-slot" style="min-height:2em"></div></div>
            <div><div style="color:var(--dim);font-size:0.75em;margin-bottom:0.3em">audio</div><div id="design-mod-audio-empty" class="design-module-slot" style="min-height:2em"></div></div>
            <div><div style="color:var(--dim);font-size:0.75em;margin-bottom:0.3em">credits</div><div id="design-mod-credits-empty" class="design-module-slot" style="min-height:2em"></div></div>
            <div><div style="color:var(--dim);font-size:0.75em;margin-bottom:0.3em">gallery</div><div id="design-mod-gallery-empty" class="design-module-slot" style="min-height:2em"></div></div>
            <div><div style="color:var(--dim);font-size:0.75em;margin-bottom:0.3em">writing</div><div id="design-mod-writing-empty" class="design-module-slot" style="min-height:2em"></div></div>
            <div><div style="color:var(--dim);font-size:0.75em;margin-bottom:0.3em">film</div><div id="design-mod-film-empty" class="design-module-slot" style="min-height:2em"></div></div>
            <div><div style="color:var(--dim);font-size:0.75em;margin-bottom:0.3em">video</div><div id="design-mod-video-empty" class="design-module-slot" style="min-height:2em"></div></div>
            <div><div style="color:var(--dim);font-size:0.75em;margin-bottom:0.3em">technology</div><div id="design-mod-technology-empty" class="design-module-slot" style="min-height:2em"></div></div>
            <div><div style="color:var(--dim);font-size:0.75em;margin-bottom:0.3em">education</div><div id="design-mod-education-empty" class="design-module-slot" style="min-height:2em"></div></div>
            <div><div style="color:var(--dim);font-size:0.75em;margin-bottom:0.3em">demos</div><div id="design-mod-demos-empty" class="design-module-slot" style="min-height:2em"></div></div>
          </div>
        </div>
      </section>

      <footer class="design-foot">
        <p>components audit — <span id="design-audit-count">…</span> module surfaces catalogued.</p>
        <p style="color:var(--dim);font-size:0.85em">
          Add a new component? Open <code>public/js/design.js</code>. See
          CLAUDE.md → "Design Catalog — /design (MUST UPDATE)".
        </p>
      </footer>
      </div>
    </div>
  `

  // Wire the sidebar: jumps, URL hash sync, arrow-key nav, mobile drawer.
  try { initCatalogNav(el) } catch (e) { console.warn('[catalog nav] init failed', e) }

  // Live QR in the ticket pass mini so it isn't just a hollow box.
  try {
    const { generateQR } = await import('./qr.js')
    const qrSlot = document.getElementById('design-ticket-qr-slot')
    if (qrSlot) qrSlot.innerHTML = generateQR('praxis:t:1:0:42')
  } catch {}

  // Modal openers — invoke the SAME functions production uses.
  const dispatchOpener = async (btn) => {
    const kind = btn.dataset.open
    const addr = window.getWalletAddress?.() || '0x0000000000000000000000000000000000000dEaD'
    try {
      if (kind === 'send') {
        const mod = await import('./vault.js'); await mod.showSendModal(addr)
      } else if (kind === 'receive') {
        const mod = await import('./vault.js'); await mod.showReceiveModal(addr)
      } else if (kind === 'save') {
        // showSwapModal depends on state initVault computes; hop over.
        window.location.href = '/vault'
      } else if (kind === 'funding') {
        const mod = await import('./pay.js'); await mod.showFundingSheet(addr, 0n)
      } else if (kind === 'onramp') {
        const mod = await import('./ramp.js'); mod.showOnrampModal?.(addr)
      } else if (kind === 'offramp') {
        const mod = await import('./ramp.js'); mod.showOfframpModal?.(addr)
      } else if (kind === 'vault-send') {
        const mod = await import('./vault.js'); await mod.showSendModal(addr)
      } else if (kind === 'vault-receive') {
        const mod = await import('./vault.js'); await mod.showReceiveModal(addr)
      } else if (kind === 'vault-swap') {
        // showSwapModal is file-local in vault.js and depends on state
        // initVault computes (ethBalance, ethPrices, yieldData, chainBalances).
        // Rule 4: hop to /vault where the rendered dashboard's own buttons
        // produce the sub-view.
        window.location.href = '/vault'
      } else if (kind === 'vault-purchase-confirm') {
        const mod = await import('./pay.js')
        // Stub mediaId — showPurchaseConfirmation only reads it for artwork
        // lookup. Missing lookup = no artwork, confirmation still renders.
        await mod.showPurchaseConfirmation('0', '2000000000000000', 'End Credits')
      } else if (kind === 'vault-funding') {
        const mod = await import('./pay.js'); await mod.showFundingSheet(addr, 0n)
      } else if (kind === 'vault-onramp') {
        const mod = await import('./ramp.js'); await mod.showOnrampModal?.(addr, 100)
      } else if (kind === 'vault-offramp') {
        const mod = await import('./ramp.js')
        // 0.1 ETH as the preset cashout size for the catalog preview.
        // showOfframpModal expects amountETH as a string (default '0.01').
        await mod.showOfframpModal?.(addr, '0.1')
      } else if (kind?.startsWith('sandbox-')) {
        await openSandbox(kind, sandbox)
      } else if (kind === 'org-create') {
        const mod = await import('./settings.js')
        if (typeof mod.showCreateOrgModal === 'function') return mod.showCreateOrgModal()
        // showCreateOrgModal is file-local in settings.js; nudge the user to the
        // settings page where the button already calls it.
        window.location.href = '/settings#orgs'
      } else if (kind === 'org-attach') {
        const mod = await import('./settings.js')
        const stubOrg = { id: 0, name: 'example org', orgType: 'collective', admin: addr, wallet: addr }
        if (typeof mod.showAttachOrgSiteModal === 'function') return mod.showAttachOrgSiteModal(stubOrg)
        window.location.href = '/settings#orgs'
      } else if (kind === 'org-migrate') {
        const mod = await import('./settings.js')
        const stub = { orgId: 0, orgName: 'example org', orgDomain: window.location.hostname }
        if (typeof mod.showUpgradeToSafeModal === 'function') return mod.showUpgradeToSafeModal(stub)
        window.location.href = '/settings#orgs'
      } else if (kind === 'org-welcome') {
        await import('./org-welcome.js')
        if (typeof window._orgWelcomePreview === 'function') return window._orgWelcomePreview()
      } else if (kind?.startsWith('auth-')) {
        // Every §14 surface routes here. If a function isn't exposed in
        // this page's state (e.g. no embedded wallet loaded yet), surface
        // a muted fallback instead of silently failing — per the
        // catalog's "needs wallet state" rule.
        const fallbackEl = document.getElementById('design-auth-fallback')
        const miss = (msg) => { if (fallbackEl) fallbackEl.textContent = msg }
        const DEAD = '0x0000000000000000000000000000000000000dEaD'
        const MOCK_PHRASE = 'abandon ability able about above absent absorb abstract absurd abuse access accident'
        if (fallbackEl) fallbackEl.textContent = ''
        if (kind === 'auth-unlock') {
          if (typeof window.showUnlockPrompt !== 'function') return miss('needs wallet state — hit the opener from inside the real app')
          await window.showUnlockPrompt()
        } else if (kind === 'auth-create') {
          if (typeof window.showCreateWalletPrompt !== 'function') return miss('needs wallet state — hit the opener from inside the real app')
          await window.showCreateWalletPrompt()
        } else if (kind === 'auth-recovery-reveal') {
          const mod = await import('./embedded-wallet.js').catch(() => null)
          const fn = mod?.showRecoveryPhraseUI || window.showRecoveryPhraseUI
          if (typeof fn !== 'function') return miss('needs wallet state — hit the opener from inside the real app')
          fn(MOCK_PHRASE, DEAD, () => {})
        } else if (kind === 'auth-recovery') {
          if (typeof window.showRecoveryPrompt !== 'function') return miss('needs wallet state — hit the opener from inside the real app')
          await window.showRecoveryPrompt()
        } else if (kind === 'auth-signin') {
          if (typeof window.showSignInPrompt !== 'function') return miss('needs wallet state — hit the opener from inside the real app')
          await window.showSignInPrompt()
        } else if (kind === 'auth-change-password') {
          if (typeof window.showChangePasswordPrompt !== 'function') return miss('needs wallet state — hit the opener from inside the real app')
          await window.showChangePasswordPrompt()
        } else if (kind === 'auth-unregister') {
          if (typeof window.showUnregisterConfirmation !== 'function') return miss('needs wallet state — hit the opener from inside the real app')
          await window.showUnregisterConfirmation(DEAD)
        } else if (kind === 'auth-audience') {
          if (typeof window.showAudiencePrompt !== 'function') return miss('audience prompt is file-local in wallet.js — hit it from inside the real app on a signed-in page')
          try { await window.showAudiencePrompt(DEAD) } catch { miss('needs wallet state — hit the opener from inside the real app') }
        }
      } else if (kind === 'settings-open') {
        // Fire the same event the gear dock icon dispatches. On a tenant
        // where the viewer is the owner, the settings panel slides in.
        await import('./settings.js')
        window.dispatchEvent(new Event('open-settings'))
      } else if (kind === 'settings-remove-module') {
        // showRemoveModuleModal is file-local to settings.js — not on
        // window. Attempt it anyway so the live app wires it up when
        // settings.js later binds it; otherwise fall back to the panel.
        await import('./settings.js')
        if (typeof window.showRemoveModuleModal === 'function') {
          return window.showRemoveModuleModal('music')
        }
        window.dispatchEvent(new Event('open-settings'))
      } else if (kind === 'msg-page') {
        // Live messages page lives at /messages. Open in a new tab so
        // the catalog stays available for the next surface.
        window.open('/messages', '_blank', 'noopener')
      } else if (kind === 'msg-new') {
        // showDmPicker() is file-local in messages.js — nudge Miles to
        // /messages where the + button in the sidebar header opens it.
        window.open('/messages?compose=dm', '_blank', 'noopener')
      } else if (kind === 'msg-new-group') {
        // showGroupPicker() is file-local — same routing as above.
        window.open('/messages?compose=group', '_blank', 'noopener')
      } else if (kind === 'msg-chat-menu') {
        // No chat-level menu shipped today — scroll Miles to the draft
        // shape block so he can see what we'd ship.
        document.querySelector('#design-msg-openers')?.parentElement
          ?.querySelector('h3')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
      } else if (kind === 'msg-emoji') {
        // No emoji picker shipped — same routing to the draft shape.
        document.querySelector('#design-msg-openers')?.parentElement
          ?.querySelector('h3')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
      } else if (kind === 'msg-toast') {
        // showMsgToast() is file-local; hand toast() the same shape it
        // would after resolving the sender.
        const { toast } = await import('./toast.js')
        toast(`<strong style="color:var(--accent)">nappynina.com</strong> a new message`, {
          type: 'message', html: true, duration: 6000,
        })
      } else if (kind === 'msg-typing') {
        // Live showTypingIndicator() is file-local (messages.js:1846).
        // Inject the same markup into the mock chat DOM.
        const msgs = document.getElementById('design-messages-slot-msgs')
        if (msgs) {
          let el = msgs.parentElement.querySelector('.design-msg-cat-typing')
          if (!el) {
            el = document.createElement('div')
            el.className = 'dm-typing-indicator design-msg-cat-typing'
            el.style.cssText = 'color:var(--muted);font-size:0.8em;font-style:italic;padding:0.4em 1ch'
            msgs.parentElement.insertBefore(el, msgs.nextSibling)
          }
          el.textContent = 'nappynina is typing...'
          el.style.display = ''
          clearTimeout(window.__designMsgTypingTimer)
          window.__designMsgTypingTimer = setTimeout(() => { el.style.display = 'none' }, 3500)
        }
      } else if (kind === 'make-compose-blog') {
        // openComposeModal (write.js:964) redirects to /write. open there
        // in a new tab so the catalog view stays alongside, matching the
        // same new-tab policy §17's msg-page / msg-new use.
        window.open('/write', '_blank', 'noopener')
      } else if (kind === 'make-compose-amend') {
        // same opener with amendPostId=42, plus draft prefills, exercising
        // the amend branch of openComposeModal.
        const params = new URLSearchParams({
          amend: '42',
          prefillTitle: 'draft title',
          prefillContent: 'draft body — amend-mode fixture.',
        })
        window.open('/write?' + params.toString(), '_blank', 'noopener')
      } else if (kind === 'make-reply' || kind === 'make-history' ||
                 kind === 'make-journal-unlock' || kind === 'make-journal-editor' ||
                 kind === 'make-script-editor' || kind === 'make-autocomplete') {
        // mirrored-shape surfaces: the live renderer is file-local, so the
        // opener scrolls to the catalog block that holds its snapshot.
        const map = {
          'make-reply': 'design-make-reply-block',
          'make-history': 'design-make-history-block',
          'make-journal-unlock': 'design-make-journal-unlock-block',
          'make-journal-editor': 'design-make-journal-editor-block',
          'make-script-editor': 'design-make-script-editor-block',
          'make-autocomplete': 'design-make-autocomplete-block',
        }
        document.getElementById(map[kind])?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
      } else if (kind?.startsWith('art-')) {
        // §23 art & post detail — every renderMusic*/renderGallery*/
        // renderFilm*/renderVideo*/renderAudio*/renderWriting*/
        // renderOnChain*/renderHistoryView/renderReply/renderReplyForm/
        // renderGrouped is file-local in art.js or post.js. the opener
        // scrolls to the catalog block that holds its snapshot.
        const map = {
          'art-album':        'design-art-album-block',
          'art-gallery':      'design-art-gallery-block',
          'art-film':         'design-art-film-block',
          'art-video':        'design-art-video-block',
          'art-audio':        'design-art-audio-block',
          'art-writing':      'design-art-writing-block',
          'art-onchain':      'design-art-onchain-block',
          'art-cross-album':  'design-art-cross-album-block',
          'art-cross-item':   'design-art-cross-item-block',
          'art-vanity':       'design-art-vanity-block',
          'art-blogpost':     'design-art-blogpost-block',
          'art-history':      'design-art-history-block',
          'art-reply':        'design-art-reply-block',
          'art-replyform':    'design-art-replyform-block',
          'art-grouped':      'design-art-grouped-block',
        }
        document.getElementById(map[kind])?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
      } else if (kind?.startsWith('money-method-')) {
        // §20 — swap the active chip in the method-picker snapshot + re-render
        // the matching payment-details placeholder. The main wizard openers
        // live in §15; these just drive the sub-view slots in-place.
        _moneyMethod = kind.slice('money-method-'.length)
        _renderMoneyMethods?.()
        _renderMoneyDetails?.()
      } else if (kind?.startsWith('money-chain-')) {
        // §20 — swap the selected row in the chain-picker snapshot.
        _moneyChain = parseInt(kind.slice('money-chain-'.length), 10)
        _renderMoneyChains?.()
      } else if (kind === 'prim-toast-default') {
        const { toast } = await import('./toast.js'); toast('your post was published')
      } else if (kind === 'prim-toast-success') {
        const { toast } = await import('./toast.js'); toast.success('invite sent')
      } else if (kind === 'prim-toast-error') {
        const { toast } = await import('./toast.js'); toast.error("something didn't go through")
      } else if (kind === 'prim-toast-message') {
        const { toast } = await import('./toast.js'); toast.message('new message from nappynina')
      } else if (kind === 'prim-modal' || kind === 'prim-sheet' || kind === 'prim-confirm') {
        // Dummy modal shell — vanilla .praxis-modal-overlay / .praxis-modal-dialog.
        // Not calling any real opener; this is the primitive itself, demo-only.
        const overlay = document.createElement('div')
        overlay.className = 'praxis-modal-overlay'
        const isSheet = kind === 'prim-sheet'
        const isConfirm = kind === 'prim-confirm'
        if (isSheet) { overlay.style.alignItems = 'flex-end'; overlay.style.padding = '0' }
        const dialog = document.createElement('div')
        dialog.className = 'praxis-modal-dialog'
        if (isSheet) {
          dialog.style.width = '100%'
          dialog.style.maxWidth = '640px'
          dialog.style.borderRadius = '16px 16px 0 0'
          dialog.style.margin = '0 auto'
        }
        const close = () => {
          overlay.classList.add('is-closing')
          setTimeout(() => overlay.remove(), 220)
        }
        const title = isConfirm ? 'delete this draft' : isSheet ? 'name this draft' : 'name this draft'
        const body = isConfirm
          ? "this can't be undone."
          : 'you can change it later.'
        dialog.innerHTML = `
          <div style="display:flex;justify-content:space-between;align-items:start;gap:1ch;margin-bottom:0.75em">
            <h3 style="margin:0">${escapeHtml(title)}</h3>
            <button type="button" aria-label="close" data-prim-close style="background:transparent;border:0;color:var(--muted);font-size:1.4em;line-height:1;cursor:pointer;padding:0 0.2em">x</button>
          </div>
          <p style="color:var(--muted);margin:0 0 1.25em">${escapeHtml(body)}</p>
          <div style="display:flex;justify-content:flex-end;gap:0.6ch">
            <button type="button" class="buy-btn" data-prim-close style="background:transparent;border:1px solid var(--border);color:var(--fg)">cancel</button>
            ${isConfirm
              ? '<button type="button" class="buy-btn" data-prim-close style="background:#e24a4a;border-color:#e24a4a;color:#fff">delete</button>'
              : '<button type="button" class="buy-btn" data-prim-close>save</button>'}
          </div>
        `
        overlay.appendChild(dialog)
        overlay.addEventListener('click', (e) => {
          if (e.target === overlay || e.target.closest('[data-prim-close]')) close()
        })
        document.body.appendChild(overlay)
      } else if (kind === 'prim-copy') {
        const { copyToClipboard } = await import('./utils.js')
        const { toast } = await import('./toast.js')
        const ok = await copyToClipboard('praxis — your copy landed')
        if (ok) toast.success('copied')
        else toast.error("couldn't copy")
      } else if (kind?.startsWith('proj-')) {
        // §21 — project-detail.js renderers run on their own page, so the
        // openers here scroll to the matching snapshot block instead of
        // calling a live modal. Each state + shared-surface id below is
        // seeded on the block in the §21 markup above.
        const idMap = {
          'proj-proposed': 'design-proj-state-proposed',
          'proj-funded': 'design-proj-state-funded',
          'proj-delivered': 'design-proj-state-delivered',
          'proj-finalized': 'design-proj-state-finalized',
          'proj-disputed': 'design-proj-state-disputed',
          'proj-cancelled': 'design-proj-state-cancelled',
          'proj-tiers': 'design-proj-tiers',
          'proj-comments': 'design-proj-comments',
          'proj-checkin': 'design-proj-checkin',
          'proj-dispute': 'design-proj-dispute',
          'proj-finalize': 'design-proj-finalize',
        }
        const target = document.getElementById(idMap[kind])
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' })
      } else if (kind?.startsWith('net-')) {
        // §22 network & profile — each opener wires to the function the
        // real surface calls. All five of these live file-local in their
        // host module (network.js, profile.js, wallet.js) and are not
        // exposed on window today, so if window.<fn> isn't there we
        // surface a muted fallback noting the opener is file-local.
        const fallbackEl = document.getElementById('design-net-fallback')
        const miss = (msg) => { if (fallbackEl) fallbackEl.textContent = msg }
        const DEAD = '0x0000000000000000000000000000000000000dEaD'
        if (fallbackEl) fallbackEl.textContent = ''
        if (kind === 'net-invites') {
          if (typeof window.openInvitesModal !== 'function') return miss('openInvitesModal is file-local in network.js:1183 — open /network to hit it live')
          const { getPublicClient } = await import('./utils.js').catch(() => ({}))
          const pc = getPublicClient ? getPublicClient() : null
          try { await window.openInvitesModal(addr, pc) } catch { miss('needs wallet + public client state — hit it from /network') }
        } else if (kind === 'net-deploy-options') {
          if (typeof window.showDeployOptions !== 'function') return miss('showDeployOptions is file-local in network.js:1876 — fires after a fresh deploy')
          try { window.showDeployOptions('milesxb.bio', DEAD, '0xdeaf', false) } catch { miss('needs post-deploy state — hit it from /network') }
        } else if (kind === 'net-block') {
          if (typeof window.showBlockConfirmModal !== 'function') return miss('showBlockConfirmModal is file-local in profile.js:416 — open a profile and tap block to hit it live')
          try { await window.showBlockConfirmModal() } catch { miss('block confirm threw — hit it from a profile page') }
        } else if (kind === 'net-connections-followers' || kind === 'net-connections-following') {
          if (typeof window.showConnectionsModal !== 'function') return miss('showConnectionsModal is file-local in profile.js:627 — open a profile and tap the follow counts to hit it live')
          const type = kind === 'net-connections-followers' ? 'followers' : 'following'
          try { await window.showConnectionsModal(type, DEAD, mockResolve) } catch { miss('needs ponder state — hit it from a profile page') }
        } else if (kind === 'net-audience-prompt') {
          if (typeof window.showAudiencePrompt !== 'function') return miss('showAudiencePrompt is file-local in wallet.js:848 — fires for a signed-in visitor who has not registered as audience yet')
          try { await window.showAudiencePrompt(DEAD) } catch { miss('needs wallet state — hit it signed-in on a tenant') }
        }
      }
    } catch (e) { console.warn('design catalog opener failed:', kind, e) }
  }

  // §20 money in & out — state + renderers for the sub-view snapshots.
  // Declared BEFORE any listener is attached so dispatchOpener never hits
  // a TDZ. Mirrors PAYMENT_METHODS at ramp.js:51, PAYMENT_DETAIL_PLACEHOLDERS
  // at ramp.js:116, and CHAINS at relay-bridge.js:11 — hand-synced because
  // each helper is file-local.
  const _MONEY_METHODS = [
    { id: 'wise', label: 'Wise', icon: 'ph-arrows-left-right' },
    { id: 'revolut', label: 'Revolut', icon: 'ph-currency-circle-dollar' },
    { id: 'cashapp', label: 'Cash App', icon: 'ph-currency-dollar' },
    { id: 'venmo', label: 'Venmo', icon: 'ph-venmo-logo', disabled: true, disabledReason: 'coming soon' },
  ]
  const _MONEY_PLACEHOLDERS = {
    wise: 'your email address',
    revolut: 'your Revolut tag (e.g. @your-tag)',
    cashapp: 'your Cash App $cashtag',
    venmo: 'your Venmo username (e.g. @your-name)',
  }
  const _MONEY_CHAINS = [
    { chainId: 1, name: 'Ethereum' },
    { chainId: 42161, name: 'Arbitrum' },
    { chainId: 10, name: 'Optimism' },
    { chainId: 8453, name: 'Base' },
    { chainId: 137, name: 'Polygon' },
    { chainId: 324, name: 'zkSync Era' },
  ]
  let _moneyMethod = 'wise'
  let _moneyChain = 10
  const _renderMoneyMethods = () => {
    const slot = document.getElementById('design-money-methods-slot')
    if (!slot) return
    slot.innerHTML = _MONEY_METHODS.map(m => {
      const active = m.id === _moneyMethod && !m.disabled
      const dim = m.disabled
      return `<button type="button" class="ramp-method-btn" ${m.disabled ? 'disabled' : ''} style="display:flex;align-items:center;gap:0.5ch;padding:0.4em 0.8em;background:${active ? 'var(--accent)' : 'none'};color:${active ? '#000' : dim ? 'var(--muted)' : 'var(--fg)'};border:1px solid ${active ? 'var(--accent)' : 'var(--border)'};cursor:${dim ? 'not-allowed' : 'pointer'};font-family:inherit;font-size:0.85em;opacity:${dim ? '0.4' : '1'}"><i class="ph ${m.icon}" style="font-size:1em"></i>${escapeHtml(m.label)}${dim ? ` <span style="font-size:0.75em">(${escapeHtml(m.disabledReason || 'soon')})</span>` : ''}</button>`
    }).join('')
  }
  const _renderMoneyDetails = () => {
    const slot = document.getElementById('design-money-details-slot')
    if (!slot) return
    const placeholder = _MONEY_PLACEHOLDERS[_moneyMethod] || 'your payment handle or email'
    slot.innerHTML = `
      <label style="color:var(--dim);font-size:0.8em;display:block;margin-bottom:0.3em">your ${escapeHtml(_moneyMethod)} details</label>
      <input type="text" placeholder="${escapeHtml(placeholder)}" style="width:100%;padding:0.5em;background:var(--bg);color:var(--fg);border:1px solid var(--border);font-family:inherit;font-size:0.9em;box-sizing:border-box" />
    `
  }
  const _renderMoneyChains = () => {
    const slot = document.getElementById('design-money-chains-slot')
    if (!slot) return
    slot.innerHTML = _MONEY_CHAINS.map(c => {
      const sel = c.chainId === _moneyChain
      return `<button type="button" class="vault-chain-row${sel ? ' vault-chain-row-selected' : ''}" style="display:flex;align-items:center;gap:0.75ch;width:100%;padding:0.6em 0.9em;background:${sel ? 'color-mix(in srgb,var(--accent) 10%,transparent)' : 'transparent'};color:var(--fg);border:0;border-bottom:1px solid var(--border);font-family:inherit;font-size:0.9em;cursor:pointer;text-align:left"><span class="vault-chain-icon" aria-hidden="true" style="color:var(--dim)">◆</span><span class="vault-chain-name" style="flex:1">${escapeHtml(c.name)}</span>${sel ? '<span class="vault-chain-check" style="color:var(--accent)">✓</span>' : '<span class="vault-chain-bal vault-chain-bal-empty" style="color:var(--dim);font-size:0.78em">no ETH</span>'}</button>`
    }).join('')
  }
  _renderMoneyMethods()
  _renderMoneyDetails()
  _renderMoneyChains()
  // Paint the stripe + zkp2p QR panes with the SAME qrcode() helper
  // ramp.js:_renderQrCode uses, so the catalog shows a real SVG of the
  // same shape, not a fake grid.
  try {
    const { qrcode } = await import('./vendor.js')
    const _paintQr = (id, payload) => {
      const target = document.getElementById(id)
      if (!target) return
      const qr = qrcode(0, 'L')
      qr.addData(payload)
      qr.make()
      target.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 6, scalable: true })
      const svg = target.querySelector('svg')
      if (svg) { svg.style.width = '140px'; svg.style.height = '140px'; svg.style.display = 'block' }
    }
    _paintQr('design-money-qr-stripe', 'https://checkout.stripe.com/pay/mock-add-funds-100')
    _paintQr('design-money-qr-zkp2p', 'https://cash.app/$nappy-nina/100')
  } catch (e) { console.warn('design catalog §20 QR render failed', e) }

  document.getElementById('design-modal-openers')?.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-open]')
    if (btn) dispatchOpener(btn)
  })

  // Workshop openers — scoped to the #dw-workshop-root. Clicks on
  // button[data-dw-open] inside the workshop open a .dw-modal /
  // .dw-sheet / .dw-confirm or fire a .dw-toast via design-workshop.js.
  // Never touches any modal or toast outside the workshop surface.
  try { DW.wireDwOpeners?.(document.getElementById('dw-workshop-root') || document) } catch (e) { console.warn('wireDwOpeners:', e) }
  document.getElementById('design-org-openers')?.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-open]')
    if (btn) dispatchOpener(btn)
  })
  document.getElementById('design-auth-openers')?.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-open]')
    if (btn) dispatchOpener(btn)
  })
  document.getElementById('design-vault-openers')?.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-open]')
    if (btn) dispatchOpener(btn)
  })
  document.getElementById('design-settings-openers')?.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-open]')
    if (btn) dispatchOpener(btn)
  })
  document.getElementById('design-msg-openers')?.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-open]')
    if (btn) dispatchOpener(btn)
  })
  document.getElementById('design-make-openers')?.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-open]')
    if (btn) dispatchOpener(btn)
  })
  document.getElementById('design-money-openers')?.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-open]')
    if (btn) dispatchOpener(btn)
  })
  document.getElementById('design-proj-openers')?.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-open]')
    if (btn) dispatchOpener(btn)
  })

  // §14 biometric card — renderBiometricCard is file-local to settings.js,
  // so the two states are mirrored here as static snapshots matching the
  // live markup at settings.js:587. Copy stays as-is from the shipped card.
  const bioOffSlot = document.getElementById('design-auth-bio-off-slot')
  if (bioOffSlot) {
    bioOffSlot.innerHTML = `
      <div class="settings-status-card">
        <div class="status-body">
          <div class="status-title"><span class="status-dot off"></span>biometric confirmation <span style="color:var(--muted);margin-left:0.4em">off</span></div>
          <div class="status-desc">Add Face ID / fingerprint as a second factor before any transaction or unlock. Recommended.</div>
        </div>
        <div class="status-action">
          <button class="buy-btn" style="font-size:0.8em;padding:0.4em 1.2ch">enable</button>
        </div>
      </div>
    `
  }
  const bioOnSlot = document.getElementById('design-auth-bio-on-slot')
  if (bioOnSlot) {
    bioOnSlot.innerHTML = `
      <div class="settings-status-card">
        <div class="status-body">
          <div class="status-title"><span class="status-dot on"></span>biometric confirmation <strong style="color:#4ade80;font-weight:normal;margin-left:0.4em">on</strong></div>
          <div class="status-desc">Face ID / fingerprint required to confirm transactions and unlock your wallet on this device.</div>
        </div>
        <div class="status-action">
          <button class="buy-btn" style="font-size:0.8em;padding:0.4em 1.2ch;color:#a44;border-color:#a44">disable</button>
        </div>
      </div>
    `
  }

  // §15 vault dashboard slot — attempt the live renderVault against a dense
  // fixture. renderVault is file-local in vault.js today, so the attempt
  // falls back to a short note. The sub-view snapshots below the slot keep
  // every shape visible for Miles's pass either way.
  const VAULT_FIXTURE = {
    ethBalance: 1234567890000000000n, // ~1.234 ETH
    chainBalances: [
      { chain: 'optimism', balance: 1234567890000000000n, usd: 4567.89 },
      { chain: 'base', balance: 234000000000000000n, usd: 870.12 },
      { chain: 'ethereum', balance: 0n, usd: 0 },
    ],
    boldBalance: 1250n * 10n**18n, // 1250 BOLD
    spDeposits: [{ amount: 500n * 10n**18n, apr: 0.082, chain: 'ethereum' }],
    unclaimed: { total: 42000000000000000n, byToken: [{ symbol: 'ETH', amount: 42000000000000000n }] },
    earned: 892000000000000000n,
    contributed: 1400000000000000000n,
    ethPrices: { optimism: 3700, base: 3700, ethereum: 3700 },
  }
  const vaultSlot = document.getElementById('design-vault-dashboard-slot')
  if (vaultSlot) {
    try {
      const vmod = await import('./vault.js')
      if (typeof vmod.renderVault === 'function') {
        vmod.renderVault(vaultSlot, VAULT_FIXTURE)
      } else {
        vaultSlot.innerHTML = '<p style="color:var(--muted);font-size:0.85em;padding:1em;border:1px dashed var(--border);border-radius:6px"><code>renderVault</code> is file-local in <code>public/js/vault.js</code> — not callable from the catalog until it is exported. See <a href="/vault" style="color:var(--accent)">/vault</a> for the live surface, or the sub-view snapshots below.</p>'
      }
    } catch (e) {
      vaultSlot.innerHTML = `<p style="color:var(--muted);font-size:0.85em;padding:1em">vault.js failed to load: ${escapeHtml(e?.message || String(e))}</p>`
    }
  }

  // §16 settings & CMS — slot-fill each tab / card renderer. The fns
  // are file-local to settings.js (not exported, not on window), so a
  // dynamic import gets us the module with only its exports. If a
  // renderer isn't reachable, show a muted "needs wallet state" line
  // where the real surface would land — per the catalog's rule 5.
  try {
    const S = await import('./settings.js').catch(() => ({}))
    const fallback = `<p style="color:var(--muted);font-size:0.85em;margin:0.25em 0">needs wallet state — hit from inside the real app</p>`

    const fillSlot = (slotId, label, invoke) => {
      const slot = document.getElementById(slotId)
      if (!slot) return
      try {
        const ok = invoke(slot)
        if (!ok) slot.innerHTML = fallback
      } catch (e) {
        slot.innerHTML = `<p style="color:var(--muted);font-size:0.85em;margin:0.25em 0">${label} threw: ${escapeHtml(e?.message || String(e))}</p>`
      }
    }

    fillSlot('design-settings-identity-slot', 'renderIdentityTab', (slot) => {
      if (typeof S.renderIdentityTab === 'function') { S.renderIdentityTab(slot); return true }
      return false
    })
    fillSlot('design-settings-modules-slot', 'renderModulesTab', (slot) => {
      if (typeof S.renderModulesTab === 'function') { S.renderModulesTab(slot); return true }
      return false
    })
    fillSlot('design-settings-theme-slot', 'renderThemeTab', (slot) => {
      if (typeof S.renderThemeTab === 'function') { S.renderThemeTab(slot); return true }
      return false
    })
    fillSlot('design-settings-biometric-slot', 'renderBiometricCard', (slot) => {
      if (typeof S.renderBiometricCard === 'function') {
        slot.innerHTML = S.renderBiometricCard(true) || ''
        return true
      }
      return false
    })
    fillSlot('design-settings-sell-slot', 'renderSellWidget', (slot) => {
      if (typeof S.renderSellWidget === 'function') {
        const mockItem = { cid: 'ipfs://test', title: 'draft album', price: 0n, tier: 1, src: 'ipfs://test' }
        slot.innerHTML = S.renderSellWidget(mockItem, 'design-sell-mock') || ''
        return true
      }
      return false
    })
    fillSlot('design-settings-blog-slot', 'renderBlogCollectionsSection', (slot) => {
      if (typeof S.renderBlogCollectionsSection === 'function') {
        slot.innerHTML = S.renderBlogCollectionsSection() || ''
        return true
      }
      return false
    })
    fillSlot('design-settings-module-editor-slot', 'renderModuleEditor', (slot) => {
      if (typeof S.renderModuleEditor === 'function') {
        S.renderModuleEditor(slot, { name: 'music', type: 'music', items: [], data: {} })
        return true
      }
      return false
    })
  } catch (e) {
    console.warn('design catalog §16 slot-fill failed', e)
  }

  // §17 messages — hydrate the 2-col layout slot + install-limit view.
  // Live renderMessages() in dm.js / messages.js both require a mounted
  // XMTP client, so we mirror the build.js:712 markup 1:1 with three
  // seed contacts + a sample open chat. Wrapped in try/catch so a DOM
  // drift shows a muted fallback instead of blanking the catalog.
  try {
    const slot = document.getElementById('design-messages-slot')
    if (slot) {
      const seedContacts = [
        { domain: 'nappynina.com', preview: 'got the mix back — listening on the train', time: 'now', unread: true, initial: 'N', bg: '#4a4' },
        { domain: 'blackmatter.world', preview: 'the shoot runs long — grab dinner after?', time: '2h', unread: false, initial: 'B', bg: '#44a' },
        { domain: 'milesxb.bio', preview: 'sent the draft — read when you can', time: '1d', unread: false, initial: 'M', bg: '#a44' },
      ]
      const contactsHtml = seedContacts.map((c, i) => `
        <div class="msg-convo-item${i === 0 ? ' active' : ''}">
          <div class="msg-convo-avatar" style="background:${c.bg}">${c.initial}</div>
          <div class="msg-convo-body">
            <div class="msg-convo-peer">${c.unread ? '<span class="msg-unread-dot" style="display:inline-block;width:6px;height:6px;background:#ef4444;border-radius:50%;margin-right:0.5ch;vertical-align:middle"></span>' : ''}${c.domain}</div>
            <div class="msg-convo-preview">${c.preview}</div>
            <div class="msg-convo-time">${c.time}</div>
          </div>
        </div>`).join('')
      slot.innerHTML = `
        <div class="messages-container" style="display:flex;height:480px;margin:0;overflow:hidden">
          <div class="messages-sidebar" style="width:240px;min-width:240px;border-right:1px solid var(--border);display:flex;flex-direction:column;overflow:hidden">
            <div class="messages-sidebar-header" style="display:flex;align-items:center;justify-content:space-between;padding:1em;color:var(--accent);font-size:0.9em">
              <span>messages</span>
              <span style="display:flex;align-items:center;gap:0.25em">
                <button style="background:none;border:none;color:var(--fg);cursor:pointer;padding:0"><i class="ph ph-plus-circle" style="font-size:1.2em"></i></button>
                <button style="background:none;border:none;color:var(--muted);cursor:pointer;padding:0"><i class="ph ph-gear" style="font-size:1.2em"></i></button>
              </span>
            </div>
            <div id="design-messages-slot-list" style="flex:1;overflow-y:auto;min-height:0">${contactsHtml}</div>
          </div>
          <div class="messages-chat" style="flex:1;display:flex;flex-direction:column;overflow:hidden;min-height:0">
            <div class="messages-chat-header" style="display:flex;justify-content:space-between;align-items:center;padding:0.75em 1.5em;border-bottom:1px solid var(--border);color:var(--accent);font-size:0.9em">
              <span>nappynina.com</span>
              <span style="color:var(--muted);font-size:0.85em">&middot;&middot;&middot;</span>
            </div>
            <div id="design-messages-slot-msgs" class="messages-msgs" style="flex:1;overflow-y:auto;padding:1.5em;display:flex;flex-direction:column;gap:0.5em">
              <div class="dm-msg dm-msg-theirs">
                <div class="dm-bubble">got the mix back — listening on the train</div>
                <div class="dm-time">8:14 AM</div>
              </div>
              <div class="dm-msg dm-msg-mine">
                <div class="dm-bubble">on my way home, i&#39;ll put it on</div>
                <div class="dm-time">8:21 AM</div>
              </div>
              <div class="dm-msg dm-msg-theirs">
                <div class="dm-bubble">no rush. one more pass tonight if it needs it.</div>
                <div class="dm-time">8:22 AM</div>
                <div class="msg-reaction" style="font-size:0.85em;margin-top:0.25em;display:flex;gap:0.3em">
                  <span style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:0.1em 0.5em;font-size:0.9em">&#x2764;</span>
                </div>
              </div>
            </div>
            <form class="messages-send-form" style="display:flex;gap:0.5em;padding:0.75em 1.5em;align-items:center;border-top:1px solid var(--border)">
              <textarea rows="1" placeholder="type a message..." style="flex:1;resize:none;overflow-y:hidden;min-height:1.8em;max-height:8em;line-height:1.4;border-radius:20px;padding:0.5em 1em;background:var(--surface);border:1px solid var(--border);color:var(--fg);font-family:inherit"></textarea>
              <button type="button" class="dock-btn" title="attach" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:1em"><i class="ph ph-paperclip"></i></button>
              <button type="button" class="dock-btn" title="send money" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:1em"><i class="ph ph-money"></i></button>
            </form>
          </div>
        </div>`
    }
  } catch (e) {
    const slot = document.getElementById('design-messages-slot')
    if (slot) slot.innerHTML = `<p style="color:var(--muted);padding:1em;font-size:0.85em">messages layout regressed: ${escapeHtml(e?.message || String(e))}</p>`
  }

  // §17 messages — install-limit recovery view. renderStaticInstallations
  // is file-local in messages.js (line 3749); mirror its HTML with 10
  // stub installations so Miles can see all ten revoke rows at once.
  try {
    const instEl = document.getElementById('design-xmtp-installs')
    if (instEl) {
      const stubInboxId = '0123456789abcdef0123456789abcdef'
      const stubInstalls = Array.from({ length: 10 }, (_, i) => {
        // 64 hex chars so the regex guard in renderStaticInstallations
        // would accept the id if it were ever handed real data.
        const id = ('a' + String(i).repeat(2)).padEnd(64, (i % 2 === 0 ? '0' : 'f'))
        return id
      })
      instEl.innerHTML = `
        <div style="color:var(--dim);font-size:0.8em;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:0.5em">installations (${stubInstalls.length}/10)</div>
        <div style="font-family:monospace;font-size:0.75em;color:var(--dim);margin-bottom:0.75em;word-break:break-all">inbox: ${stubInboxId.slice(0, 24)}...</div>
        ${stubInstalls.map((idStr) => `
          <div style="padding:0.4em 0;border-bottom:1px solid var(--border);font-size:0.85em;display:flex;align-items:center;justify-content:space-between">
            <span style="font-family:monospace;color:var(--muted)">${idStr.slice(0, 20)}...</span>
            <button style="background:none;border:1px solid #ef4444;color:#ef4444;font-family:inherit;font-size:0.75em;padding:0.15em 0.75ch;cursor:pointer">revoke</button>
          </div>`).join('')}
        <p style="color:var(--muted);font-size:0.85em;margin-top:0.5em">revoke old sessions, then try again.</p>
      `
    }
  } catch (e) {
    console.warn('design catalog: install-limit mirror failed', e)
  }
  document.getElementById('design-primitives-openers')?.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-open]')
    if (btn) dispatchOpener(btn)
  })
  document.getElementById('design-net-openers')?.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-open]')
    if (btn) dispatchOpener(btn)
  })
  document.getElementById('design-art-openers')?.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-open]')
    if (btn) dispatchOpener(btn)
  })

  // §22 network & profile — probe-import the four file-local renderers.
  // Each is defined without an export in its host module, so the probe is
  // expected to miss; the fallback snapshot keeps the shape visible. If
  // one is later exported, the probe picks it up with no catalog change.
  try {
    const stubPurchase = { cid: 'ipfs://test', title: 'album 1', artist: 'nappynina.com', time: Date.now() - 3600000, mediaId: '1' }
    const tileSlot = document.getElementById('design-net-masonry-tile-slot')
    if (tileSlot) {
      let drew = false
      try {
        const sh = await import('./supporter-home.js').catch(() => null)
        if (sh && typeof sh.renderMasonryTile === 'function') {
          const html = sh.renderMasonryTile(stubPurchase)
          if (html) { tileSlot.innerHTML = html; drew = true }
        }
      } catch {}
      if (!drew) {
        tileSlot.innerHTML = `
          <a href="#" class="masonry-tile" onclick="return false" style="display:block;position:relative;border:1px solid var(--border);border-radius:6px;overflow:hidden;background:var(--bg);text-decoration:none;color:var(--fg)">
            <div style="aspect-ratio:1/1;background:color-mix(in srgb, var(--fg) 6%, var(--bg));display:grid;place-items:center;color:var(--dim);font-size:0.7em">cover art</div>
            <div class="masonry-tile-overlay" style="position:absolute;inset:auto 0 0 0;padding:0.6em 0.75ch;background:linear-gradient(transparent, rgba(0,0,0,0.6));color:#fff">
              <div style="font-size:0.85em;font-weight:600">album 1</div>
              <div style="font-size:0.7em;color:#ccc">nappynina.com</div>
            </div>
          </a>
          <p style="color:var(--dim);font-size:0.7em;margin:0.4em 0 0">probe missed — renderMasonryTile is file-local; snapshot stands in.</p>`
      }
    }

    const albumSlot = document.getElementById('design-net-album-tile-slot')
    if (albumSlot) {
      let drew = false
      try {
        const sh = await import('./supporter-home.js').catch(() => null)
        if (sh && typeof sh.renderAlbumTile === 'function') {
          const html = sh.renderAlbumTile('mcid-stub', [{ mediaId: '1' }, { mediaId: '2' }])
          if (html) { albumSlot.innerHTML = html; drew = true }
        }
      } catch {}
      if (!drew) {
        albumSlot.innerHTML = `
          <a href="#" class="masonry-tile" onclick="return false" style="display:block;position:relative;border:1px solid var(--border);border-radius:6px;overflow:hidden;background:var(--bg);text-decoration:none;color:var(--fg)">
            <div style="aspect-ratio:1/1;background:color-mix(in srgb, var(--fg) 6%, var(--bg));display:grid;place-items:center;color:var(--dim);font-size:0.7em">cover art</div>
            <span style="position:absolute;top:0.5em;right:0.5em;background:rgba(0,0,0,0.7);color:#fff;font-size:0.65em;padding:0.15em 0.6ch;border-radius:2px">6 tracks</span>
            <div class="masonry-tile-overlay" style="position:absolute;inset:auto 0 0 0;padding:0.6em 0.75ch;background:linear-gradient(transparent, rgba(0,0,0,0.6));color:#fff">
              <div style="font-size:0.85em;font-weight:600">end credits</div>
              <div style="font-size:0.7em;color:#ccc">nappynina.com</div>
            </div>
          </a>
          <p style="color:var(--dim);font-size:0.7em;margin:0.4em 0 0">probe missed — renderAlbumTile is file-local; snapshot stands in.</p>`
      }
    }

    const credsSlot = document.getElementById('design-net-credentials-slot')
    if (credsSlot) {
      let drew = false
      try {
        const pr = await import('./profile.js').catch(() => null)
        if (pr && typeof pr.renderCredentials === 'function') {
          const html = pr.renderCredentials(
            [{ projectId: '10' }, { projectId: '11' }],
            [{ projectId: '12' }],
          )
          if (html) { credsSlot.innerHTML = html; drew = true }
        }
      } catch {}
      if (!drew) {
        credsSlot.innerHTML = `
          <div style="display:flex;flex-direction:column;gap:0.3em">
            <div class="credential-item" style="font-size:0.85em;color:var(--fg)">
              <span class="credential-role" style="color:var(--muted)">contributor</span>
              <span class="credential-project">live at elsewhere</span>
              <span class="credential-type" style="color:var(--dim);font-size:0.75em">event</span>
            </div>
            <div class="credential-item" style="font-size:0.85em;color:var(--fg)">
              <span class="credential-role" style="color:var(--muted)">contributor</span>
              <span class="credential-project">film score — backlot</span>
              <span class="credential-type" style="color:var(--dim);font-size:0.75em">film</span>
            </div>
            <div class="credential-item" style="font-size:0.85em;color:var(--fg)">
              <span class="credential-role" style="color:var(--muted)">producer</span>
              <span class="credential-project">end credits</span>
              <span class="credential-type" style="color:var(--dim);font-size:0.75em">album</span>
            </div>
          </div>
          <p style="color:var(--dim);font-size:0.7em;margin:0.4em 0 0">probe missed — renderCredentials is file-local; snapshot stands in.</p>`
      }
    }

    const postSlot = document.getElementById('design-net-postcard-slot')
    if (postSlot) {
      let drew = false
      try {
        const pr = await import('./profile.js').catch(() => null)
        if (pr && typeof pr.renderPostCard === 'function') {
          const html = pr.renderPostCard({
            id: 'draft-1', title: 'notes from the booth',
            timestamp: Math.floor((Date.now() - 86400000 * 2) / 1000),
            content: 'a short line from the piece — the kind of thing you glance at and keep moving.',
          })
          if (html) { postSlot.innerHTML = html; drew = true }
        }
      } catch {}
      if (!drew) {
        postSlot.innerHTML = `
          <a href="#" class="profile-post-card" onclick="return false" style="display:block;padding:0.75em 1em;border:1px solid var(--border);border-radius:8px;background:var(--bg);text-decoration:none;color:var(--fg)">
            <div style="display:flex;justify-content:space-between;align-items:baseline">
              <span class="profile-post-title" style="font-size:0.95em;color:var(--fg)">notes from the booth</span>
              <span class="profile-post-date" style="font-size:0.75em;color:var(--dim)">Nov 2</span>
            </div>
            <span class="profile-post-preview" style="font-size:0.85em;color:var(--muted)">a short line from the piece — the kind of thing you glance at and keep moving.</span>
          </a>
          <p style="color:var(--dim);font-size:0.7em;margin:0.4em 0 0">probe missed — renderPostCard is file-local; snapshot stands in.</p>`
      }
    }
  } catch (e) {
    console.warn('design catalog §22 probe failed', e)
  }

  // §19 making & writing — hydrate the three slots that depend on live
  // code: the journal preview inside the prose editor mirror, the
  // screenplay live preview (fountainToHtml), and the fountain primitives
  // breakdown (parseFountain). Each is wrapped in its own try/catch so a
  // single regression in fountain.js surfaces as a muted note instead of
  // blanking the section.
  try {
    const fountainSample = `INT. ROOM - DAY
the morning light comes in slowly.

MILES
(nervous)
here we go.

NINA ^
always.

CUT TO:`
    const F = await import('./fountain.js').catch(() => null)

    const previewSlot = document.getElementById('design-make-fountain-preview-slot')
    if (previewSlot) {
      try {
        if (typeof F?.fountainToHtml === 'function') {
          previewSlot.innerHTML = F.fountainToHtml(fountainSample)
        } else {
          previewSlot.innerHTML = `<p style="color:var(--muted);font-size:0.85em;padding:1em"><code>fountainToHtml</code> is not exported from <code>public/js/fountain.js</code>. live preview unavailable in the catalog until the function is restored.</p>`
        }
      } catch (e) {
        previewSlot.innerHTML = `<p style="color:var(--muted);font-size:0.85em;padding:1em">fountainToHtml threw: ${escapeHtml(e?.message || String(e))}</p>`
      }
    }

    const journalPreviewSlot = document.getElementById('design-journal-preview-slot')
    if (journalPreviewSlot) {
      try {
        if (typeof F?.fountainToHtml === 'function') {
          journalPreviewSlot.innerHTML = F.fountainToHtml(fountainSample)
          journalPreviewSlot.style.color = ''
        } else {
          journalPreviewSlot.textContent = 'live preview unavailable — fountainToHtml not exported.'
        }
      } catch (e) {
        journalPreviewSlot.textContent = `preview threw: ${e?.message || String(e)}`
      }
    }

    const primitivesSlot = document.getElementById('design-make-fountain-primitives-slot')
    if (primitivesSlot) {
      try {
        if (typeof F?.parseFountain === 'function') {
          const rows = F.parseFountain(fountainSample).map((item) => {
            const label = `${item.type}${item.dualDialogue ? ' ^' : ''}`
            const text = item.text ? escapeHtml(item.text) : '<span style="color:var(--dim)">·</span>'
            return `<div style="display:flex;gap:1ch;padding:0.3em 0;border-bottom:1px solid color-mix(in srgb, var(--fg) 4%, transparent);font-size:0.9em">
              <span style="flex:0 0 12ch;color:var(--dim);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:0.75em;text-transform:uppercase;letter-spacing:0.08em">${escapeHtml(label)}</span>
              <span style="color:var(--fg);white-space:pre-wrap">${text}</span>
            </div>`
          }).join('')
          primitivesSlot.innerHTML = `<div style="padding:0.5em 1em">${rows}</div>`
        } else {
          primitivesSlot.innerHTML = `<p style="color:var(--muted);font-size:0.85em;padding:1em"><code>parseFountain</code> is not exported — primitives breakdown unavailable.</p>`
        }
      } catch (e) {
        primitivesSlot.innerHTML = `<p style="color:var(--muted);font-size:0.85em;padding:1em">parseFountain threw: ${escapeHtml(e?.message || String(e))}</p>`
      }
    }
  } catch (e) {
    console.warn('design catalog §19 fountain slots failed', e)
  }

  // Signer panel snapshot — three mock co-owners so the shape is visible
  // without a live Safe. Mirrors the inline HTML _renderSignersPanel
  // writes at settings.js:1392 (kept in sync by hand).
  const signersSlot = document.getElementById('design-org-signers-slot')
  if (signersSlot) {
    const mockOwners = [
      '0x0000000000000000000000000000000000000AA1',
      '0x0000000000000000000000000000000000000BB2',
      '0x0000000000000000000000000000000000000CC3',
    ]
    const mockSafe = '0x0000000000000000000000000000000000000dEaD'
    const rows = mockOwners.map((o, i) => `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:0.5em;padding:0.35em 0;border-bottom:1px solid color-mix(in srgb, var(--fg) 5%, transparent)">
        <span style="font-family:'SF Mono',monospace;font-size:0.8em;color:var(--fg)">${o.slice(0, 6)}…${o.slice(-4)}</span>
        <span style="display:flex;align-items:center;gap:0.75ch">${i === 0 ? '<span style="font-size:0.7em;color:var(--dim)">you</span>' : ''}<button class="buy-btn" style="font-size:0.7em;padding:0.15em 0.9ch;border-color:var(--dim);color:var(--dim)">remove</button></span>
      </div>`).join('')
    signersSlot.innerHTML = `
      <p style="font-size:0.75em;color:var(--muted);margin:0 0 0.5em;text-transform:uppercase;letter-spacing:0.05em">co-owners</p>
      ${rows}
      <div style="display:flex;justify-content:space-between;align-items:center;gap:0.5em;margin-top:0.75em">
        <label style="font-size:0.8em;color:var(--muted)">signatures required</label>
        <span style="display:flex;align-items:center;gap:0.5ch">
          <input type="number" value="2" min="1" max="3" style="width:4ch;font-size:0.85em;padding:0.15em 0.4ch;background:transparent;border:1px solid var(--border);color:var(--fg);text-align:center">
          <span style="font-size:0.8em;color:var(--dim)">of 3</span>
          <button class="buy-btn" style="font-size:0.7em;padding:0.15em 0.9ch">save</button>
        </span>
      </div>
      <div style="margin-top:0.75em">
        <label style="font-size:0.75em;color:var(--muted);display:block;margin-bottom:0.25em">add co-owner</label>
        <div style="display:flex;gap:0.5ch;align-items:center">
          <input type="text" placeholder="0x…" class="project-input" style="flex:1;font-size:0.85em;font-family:'SF Mono',monospace">
          <button class="buy-btn" style="font-size:0.75em;padding:0.25em 1ch">add</button>
        </div>
      </div>
      <p style="font-size:0.7em;color:var(--dim);margin:0.6em 0 0;line-height:1.5">changes take effect after your wallet confirms. on a shared account requiring more than one signature, other co-owners will need to co-sign before the change goes live.</p>
    `
  }

  // Reveal the sandbox section + render its status pane when ?sandbox=1
  // is set. The section is hidden by default so the ordinary /design
  // view is unchanged.
  if (sandbox?.isSandbox?.()) {
    const section = document.getElementById('design-sandbox-section')
    if (section) section.style.display = ''
    renderSandboxStatus(sandbox).catch(() => {})
  }

  // §11 modules — hydrate each module slot with its live renderer.
  // Fixtures use terse structural strings ('track 1', 'scene 1') so the
  // catalog never implies invented artistic content. If a module throws
  // or returns empty, the slot shows the raw empty state — part of QA.
  try {
    const { MODULE_REGISTRY } = await import('/modules/index.js')
    const MOD_FIXTURES = {
      music: { aliases: [{ name: 'alias 1', albums: [{ title: 'album 1', artist: 'alias 1', tracks: [{ title: 'track 1', src: '' }, { title: 'track 2', src: '' }] }] }] },
      audio: { items: [{ title: 'audio 1', year: 2026, description: 'structural fixture.' }] },
      credits: { items: [{ title: 'credit 1', role: 'role', org: 'org', year: 2026, category: 'theater' }, { title: 'credit 2', role: 'role', org: 'org', year: 2025, category: 'film' }] },
      gallery: { images: [{ src: '/favicon.png', title: 'image 1', medium: 'medium', year: 2026 }], exhibitions: [{ title: 'exhibition 1', venue: 'venue', year: 2026 }] },
      writing: { publications: [{ title: 'publication 1', publication: 'journal', year: 2026, type: 'essay' }] },
      film: { works: [{ title: 'film 1', role: 'director', year: 2026, description: 'structural fixture.' }], festivals: [{ festival: 'festival 1', film: 'film 1', year: 2026, result: 'selected' }] },
      video: { items: [{ title: 'video 1', year: 2026, description: 'structural fixture.' }] },
      technology: { projects: [{ name: 'project 1', description: 'structural fixture.' }] },
      education: { events: [{ title: 'workshop 1', role: 'facilitator', org: 'org', year: 2026, type: 'workshop' }] },
      demos: { items: [{ title: 'demo 1', year: 2026, status: 'in-progress', description: 'structural fixture.' }] },
    }
    for (const key of Object.keys(MOD_FIXTURES)) {
      const slot = document.getElementById(`design-mod-${key}`)
      const mod = MODULE_REGISTRY[key]
      if (!slot || !mod?.renderSection) continue
      try {
        slot.innerHTML = mod.renderSection(MOD_FIXTURES[key]) || '<p style="color:var(--muted);font-size:0.85em">empty — fixture rendered to nothing</p>'
      } catch (e) {
        slot.innerHTML = `<p style="color:var(--muted);font-size:0.85em">renderer threw: ${(e?.message || e)}</p>`
      }
    }
  } catch (e) {
    console.warn('design catalog: module registry load failed', e)
  }

  // §24 templates & player — hydrate the funding slot (both the brief's
  // mis-shaped fixture and the real { projectId } shape so the shell is
  // visible), each module's empty-payload renderSection, and mirror the
  // player queue list into the inline snapshot slot. The §24 "play a
  // test track" / "toggle queue" / "pause" openers below drive the live
  // player at the bottom of the page.
  try {
    const { MODULE_REGISTRY } = await import('/modules/index.js')

    // Funding slot — call renderSection with the two fixtures described
    // in the §24 block prose. The first is the brief's { projects: [...] }
    // which the real module (modules/funding.js) does not accept and
    // returns '' for; that empty state is itself useful signal.
    const fundingMod = MODULE_REGISTRY.funding
    if (fundingMod?.renderSection) {
      const slotBrief = document.getElementById('design-mod-funding')
      if (slotBrief) {
        try {
          const brief = { projects: [{ title: 'draft project', goal: 10000, raised: 6400, contributors: 42 }] }
          const out = fundingMod.renderSection(brief)
          slotBrief.innerHTML = out || '<p style="color:var(--muted);font-size:0.85em">empty — the module takes <code>{ projectId }</code>, not <code>{ projects }</code>. renderSection returned <code>&quot;&quot;</code>.</p>'
        } catch (e) {
          slotBrief.innerHTML = `<p style="color:var(--muted);font-size:0.85em">renderer threw: ${escapeHtml(e?.message || String(e))}</p>`
        }
      }
      const slotReal = document.getElementById('design-mod-funding-real')
      if (slotReal) {
        try {
          slotReal.innerHTML = fundingMod.renderSection({ projectId: '1' }) || '<p style="color:var(--muted);font-size:0.85em">empty — real shape returned nothing.</p>'
        } catch (e) {
          slotReal.innerHTML = `<p style="color:var(--muted);font-size:0.85em">renderer threw: ${escapeHtml(e?.message || String(e))}</p>`
        }
      }
    }

    // Empty-state variants — ten content modules, minimum empty payload.
    // Most modules return '' when there's nothing to render, so the slot
    // is deliberately collapsed to "empty — section is hidden" instead of
    // a loud placeholder. The slot still prints when the renderer throws.
    const EMPTY_FIXTURES = {
      music: { aliases: [] },
      audio: { items: [] },
      credits: { items: [] },
      gallery: { images: [], exhibitions: [] },
      writing: { publications: [] },
      film: { works: [], festivals: [] },
      video: { items: [] },
      technology: { projects: [] },
      education: { events: [] },
      demos: { items: [] },
    }
    for (const key of Object.keys(EMPTY_FIXTURES)) {
      const slot = document.getElementById(`design-mod-${key}-empty`)
      const mod = MODULE_REGISTRY[key]
      if (!slot || !mod?.renderSection) continue
      try {
        const out = mod.renderSection(EMPTY_FIXTURES[key])
        slot.innerHTML = out || '<span style="color:var(--dim);font-size:0.8em">empty — section is hidden</span>'
      } catch (e) {
        slot.innerHTML = `<span style="color:var(--muted);font-size:0.8em">renderer threw: ${escapeHtml(e?.message || String(e))}</span>`
      }
    }
  } catch (e) {
    console.warn('design catalog §24 funding + empty-state hydration failed', e)
  }

  // Queue snapshot mirror — pull the live queue list element content
  // into the §24 inline snapshot so you can see queue state without
  // opening the actual sheet. Re-runs when any §24 opener fires.
  const mirrorQueue = () => {
    const src = document.getElementById('gp-queue-list')
    const dst = document.getElementById('gp-queue-list-mirror')
    if (!src || !dst) return
    dst.innerHTML = src.innerHTML
      || '<div style="color:var(--dim);padding:2em 1em;text-align:center;font-size:0.85em">queue is empty</div>'
  }
  mirrorQueue()

  document.getElementById('design-tpl-openers')?.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-open]')
    if (!btn) return
    const kind = btn.dataset.open
    try {
      if (kind === 'tpl-player-show') {
        // Feed the live player a short public-domain tone so the chrome
        // comes to life. Any src works — the catalog cares about chrome,
        // not audio content.
        const src = 'https://upload.wikimedia.org/wikipedia/commons/8/85/Example.ogg'
        window.playTrack?.(src, 'draft track', 'draft artist', '')
      } else if (kind === 'tpl-player-queue') {
        document.getElementById('gp-queue-btn')?.click()
      } else if (kind === 'tpl-player-pause') {
        window.pauseTrack?.()
      }
    } catch (e) {
      console.warn('design catalog §24 opener failed', kind, e)
    }
    // Reflect the new queue state in the inline snapshot after the click.
    setTimeout(mirrorQueue, 100)
  })

  const openerCount = document.querySelectorAll('#design-modal-openers button[data-open]').length
  const blockCount = document.querySelectorAll('.design-block').length
  const feedCardCount = document.querySelectorAll('.design-cards-grid > .design-block').length
  const countEl = document.getElementById('design-audit-count')
  if (countEl) countEl.textContent = `${openerCount} modal openers, ${blockCount - feedCardCount} primitives, ${feedCardCount} feed cards`
}

// ─── catalog sidebar wiring ──────────────────────────────────────────
// Click → smooth scroll + hash update. IntersectionObserver → highlight
// as the user scrolls. Arrow keys → cycle sections (not when typing).
// Honors prefers-reduced-motion and URL hash on load. Scoped to the
// catalog page — no listener outlives this view.
function initCatalogNav(root) {
  const nav = root.querySelector('#dw-catalog-nav')
  if (!nav) return

  // Attach stable IDs to the 24 existing sections by matching the
  // number prefix in their h2 ("3 · money modals" → sec-money-modals).
  // Idempotent — only assigns when the section has no id yet.
  root.querySelectorAll('.design-section').forEach(sec => {
    if (sec.id) return
    const title = sec.querySelector('.design-section-title')?.textContent || ''
    const num = title.match(/^\s*(\d+)/)?.[1]
    if (num && CATALOG_SECTION_IDS[num]) sec.id = CATALOG_SECTION_IDS[num]
  })

  const items = Array.from(nav.querySelectorAll('.dw-catalog-nav__item'))
  const targets = items
    .map(a => ({ id: a.dataset.dwNavTarget, link: a, el: document.getElementById(a.dataset.dwNavTarget) }))
    .filter(t => t.el)

  const reducedMotion = () =>
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches

  const setActive = (id) => {
    for (const a of items) {
      if (a.dataset.dwNavTarget === id) a.setAttribute('aria-current', 'true')
      else a.removeAttribute('aria-current')
    }
    try {
      const nextHash = id ? `#${id}` : ''
      if (location.hash !== nextHash) {
        // Replace, don't push — one stack entry per visit, not per section.
        history.replaceState(null, '', nextHash || location.pathname + location.search)
      }
    } catch {}
  }

  const scrollToId = (id) => {
    const target = document.getElementById(id)
    if (!target) return
    const behavior = reducedMotion() ? 'auto' : 'smooth'
    target.scrollIntoView({ behavior, block: 'start' })
  }

  // Mobile drawer open/close.
  const trigger = nav.querySelector('.dw-catalog-nav__trigger')
  const openDrawer = () => {
    nav.classList.add('is-open')
    trigger?.setAttribute('aria-expanded', 'true')
  }
  const closeDrawer = () => {
    nav.classList.remove('is-open')
    trigger?.setAttribute('aria-expanded', 'false')
  }
  trigger?.addEventListener('click', () => {
    if (nav.classList.contains('is-open')) closeDrawer()
    else openDrawer()
  })
  // Close drawer when clicking outside the sidebar (mobile only).
  document.addEventListener('click', (ev) => {
    if (!nav.classList.contains('is-open')) return
    if (nav.contains(ev.target)) return
    closeDrawer()
  })

  // Sidebar click: jump + set active + close drawer.
  nav.addEventListener('click', (ev) => {
    const a = ev.target.closest('.dw-catalog-nav__item')
    if (!a) return
    const id = a.dataset.dwNavTarget
    if (!id || !document.getElementById(id)) return
    ev.preventDefault()
    scrollToId(id)
    setActive(id)
    closeDrawer()
  })

  // Scroll-driven active state. Band sits between 45% and 50% of the
  // viewport so the "active" entry is whatever the reader's eye is on.
  const observer = new IntersectionObserver((entries) => {
    const visible = entries.filter(e => e.isIntersecting)
    if (!visible.length) return
    visible.sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
    const id = visible[0].target.id
    if (id) setActive(id)
  }, {
    rootMargin: '-45% 0px -50% 0px',
    threshold: 0,
  })
  for (const t of targets) observer.observe(t.el)

  // Keyboard: arrow keys cycle sections; ? opens help. Scoped: ignored
  // when focus is in an editable surface. Self-cleans on SPA navigate.
  const isInEditable = (el) => {
    if (!el) return false
    const tag = el.tagName
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
  }
  const findActiveIndex = () => {
    const cur = location.hash.slice(1)
    const idx = targets.findIndex(t => t.id === cur)
    return idx === -1 ? 0 : idx
  }
  const keyHandler = async (ev) => {
    // If the catalog is no longer in the DOM (SPA navigated away),
    // detach ourselves — one-shot cleanup, no leaking listeners.
    if (!document.getElementById('dw-catalog-nav')) {
      document.removeEventListener('keydown', keyHandler)
      observer.disconnect()
      return
    }
    if (isInEditable(document.activeElement)) return
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault()
      const delta = ev.key === 'ArrowDown' ? 1 : -1
      const next = Math.max(0, Math.min(targets.length - 1, findActiveIndex() + delta))
      const target = targets[next]
      if (target) {
        scrollToId(target.id)
        setActive(target.id)
      }
    } else if (ev.key === '?') {
      ev.preventDefault()
      try {
        const DW = await import('./design-workshop.js')
        DW.openDwModal({
          kind: 'modal',
          title: 'keyboard shortcuts',
          body: 'arrow down — next section. arrow up — previous. enter — follow the current link. ? — open this help. esc — close any dialog.',
          confirmLabel: 'got it',
          cancelLabel: 'close',
        })
      } catch (e) { console.warn('[catalog nav] help overlay failed', e) }
    }
  }
  document.addEventListener('keydown', keyHandler)

  // Draft marker demote — walk every .design-block / .dw-block whose
  // h3 contains <code>draft</code> and flag it with .is-draft. The CSS
  // then draws a quiet left-edge accent bar and hides the old uppercase
  // DRAFT chip inline. The <code>draft</code> stays in the DOM so Miles
  // can still grep for it; it just stops shouting. Idempotent.
  try {
    const blocks = document.querySelectorAll('.design-page .design-block, .design-page .dw-block')
    blocks.forEach(block => {
      const h3 = block.querySelector(':scope > h3')
      if (!h3) return
      const codes = h3.querySelectorAll('code')
      for (const c of codes) {
        if ((c.textContent || '').trim().toLowerCase() === 'draft') {
          block.classList.add('is-draft')
          break
        }
      }
    })
  } catch (e) { console.warn('[catalog] draft marker walk failed', e) }

  // Honor URL hash on load. Deferred so the heavy sections below have
  // a chance to hydrate (feed cards, module slots) before we jump.
  const initialHash = location.hash.slice(1)
  if (initialHash && document.getElementById(initialHash)) {
    setTimeout(() => {
      scrollToId(initialHash)
      setActive(initialHash)
    }, 250)
  } else if (targets.length) {
    setActive(targets[0].id)
  }
}
