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

import { registerPage, escapeHtml } from './utils.js'

registerPage('design-page', initDesign)

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

async function initDesign() {
  const el = document.getElementById('design-content')
  if (!el) return

  // Import the real render surface — same functions the /network,
  // /projects, /supporter-home, and other feed-driven views call.
  let F = {}
  try { F = await import('./feed-cards.js') } catch (e) { console.warn('feed-cards import:', e) }

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
  }

  el.innerHTML = `
    <div class="design-catalog">
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
        <div class="design-cards-grid">
          ${renderCardSafely('media card — audio', () => F.renderMediaCard(m.audioCard, mockResolve))}
          ${renderCardSafely('media card — video', () => F.renderMediaCard(m.videoCard, mockResolve))}
          ${renderCardSafely('media card — image', () => F.renderMediaCard(m.imageCard, mockResolve))}
          ${renderCardSafely('batch card — album', () => F.renderBatchCard(m.batchCard, mockResolve))}
          ${renderCardSafely('follow card', () => F.renderFollowCard(m.followCard, mockResolve))}
          ${renderCardSafely('joined card', () => F.renderJoinedCard(m.joinedCard, mockResolve))}
          ${renderCardSafely('project card', () => F.renderProjectCard(m.projectCard, mockResolve))}
          ${renderCardSafely('funded card', () => F.renderFundedCard(m.fundedCard, mockResolve))}
          ${renderCardSafely('purchase card', () => F.renderPurchaseCard(m.purchaseCard, mockResolve))}
          ${renderCardSafely('purchase batch card', () => F.renderPurchaseBatchCard(m.purchaseBatchCard, mockResolve))}
          ${renderCardSafely('supporter card', () => F.renderSupporterCard(m.supporterCard, mockResolve))}
          ${renderCardSafely('ticket listed card', () => F.renderTicketListedCard(m.ticketListedCard, mockResolve))}
          ${renderCardSafely('ticket purchased card', () => F.renderTicketPurchasedCard(m.ticketPurchasedCard, mockResolve))}
          ${renderCardSafely('transfer card', () => F.renderTransferCard(m.transferCard, mockResolve))}
          ${renderCardSafely('referral card', () => F.renderReferralCard(m.referralCard, mockResolve))}
          ${renderCardSafely('project completed', () => F.renderProjectCompletedCard(m.projectCompletedCard, mockResolve))}
          ${renderCardSafely('project confirmed', () => F.renderProjectConfirmedCard(m.projectConfirmedCard, mockResolve))}
          ${renderCardSafely('project completing', () => F.renderProjectCompletingCard(m.projectCompletingCard, mockResolve))}
          ${renderCardSafely('project disputed', () => F.renderProjectDisputedCard(m.projectDisputedCard, mockResolve))}
          ${renderCardSafely('project cancelled', () => F.renderProjectCancelledCard(m.projectCancelledCard, mockResolve))}
          ${renderCardSafely('project timed out', () => F.renderProjectTimedOutCard(m.projectTimedOutCard, mockResolve))}
          ${renderCardSafely('org created', () => F.renderOrgCreatedCard(m.orgCreatedCard, mockResolve))}
          ${renderCardSafely('credential card', () => F.renderCredentialCard(m.credentialCard, mockResolve))}
          ${renderCardSafely('revenue distributed', () => F.renderRevenueDistributedCard(m.revenueDistributedCard, mockResolve))}
        </div>
      </section>

      <!-- ─────────── 5 · media + collection cards ─────────── -->
      <section class="design-section">
        <h2 class="design-section-title">5 · media + collection</h2>

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
          <h3>dock (mobile) — icon strip</h3>
          <p style="color:var(--dim);font-size:0.85em;margin:0 0 0.5em">Static mock; the live dock lives at the bottom of every route.</p>
          <div style="display:flex;justify-content:space-around;padding:0.75em 1em;background:color-mix(in srgb,var(--fg) 4%,transparent);border:1px solid var(--border);border-radius:12px;max-width:340px">
            <a style="display:flex;flex-direction:column;align-items:center;gap:0.15em;color:var(--fg)"><i class="ph ph-house" style="font-size:1.25em"></i><span style="font-size:0.6em">portfolio</span></a>
            <a style="display:flex;flex-direction:column;align-items:center;gap:0.15em;color:var(--dim)"><i class="ph ph-bookmark" style="font-size:1.25em"></i><span style="font-size:0.6em">collection</span></a>
            <a style="display:flex;flex-direction:column;align-items:center;gap:0.15em;color:var(--dim)"><i class="ph ph-chat-circle" style="font-size:1.25em"></i><span style="font-size:0.6em">messages</span></a>
            <a style="display:flex;flex-direction:column;align-items:center;gap:0.15em;color:var(--dim)"><i class="ph ph-pencil-simple" style="font-size:1.25em"></i><span style="font-size:0.6em">write</span></a>
            <a style="display:flex;flex-direction:column;align-items:center;gap:0.15em;color:var(--dim)"><i class="ph ph-notebook" style="font-size:1.25em"></i><span style="font-size:0.6em">journal</span></a>
          </div>
        </div>
      </section>

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

      <footer class="design-foot">
        <p>components audit — <span id="design-audit-count">…</span> module surfaces catalogued.</p>
        <p style="color:var(--dim);font-size:0.85em">
          Add a new component? Open <code>public/js/design.js</code>. See
          CLAUDE.md → "Design Catalog — /design (MUST UPDATE)".
        </p>
      </footer>
    </div>
  `

  // Live QR in the ticket pass mini so it isn't just a hollow box.
  try {
    const { generateQR } = await import('./qr.js')
    const qrSlot = document.getElementById('design-ticket-qr-slot')
    if (qrSlot) qrSlot.innerHTML = generateQR('praxis:t:1:0:42')
  } catch {}

  // Modal openers — invoke the SAME functions production uses.
  document.getElementById('design-modal-openers')?.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button[data-open]')
    if (!btn) return
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
      }
    } catch (e) { console.warn('design catalog opener failed:', kind, e) }
  })

  const openerCount = document.querySelectorAll('#design-modal-openers button[data-open]').length
  const blockCount = document.querySelectorAll('.design-block').length
  const feedCardCount = document.querySelectorAll('.design-cards-grid > .design-block').length
  const countEl = document.getElementById('design-audit-count')
  if (countEl) countEl.textContent = `${openerCount} modal openers · ${blockCount - feedCardCount} primitives · ${feedCardCount} feed cards`
}
