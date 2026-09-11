// Living UI catalog — /design.
//
// Bird's-eye view of every visual primitive + interaction surface in
// Praxis, on one page. NOT a Storybook — instead of duplicating a
// stripped-down copy of each component, this page calls the SAME
// window-level module functions the app calls in production (e.g.
// showSendModal, showReceiveModal, showFundingSheet), so what you see
// in the catalog is exactly what a real user sees. If a component drifts
// in prod, it drifts here too — no staleness, no maintenance debt.
//
// Sections, top-to-bottom:
//   1. Foundation — colors, typography, spacing tokens
//   2. Buttons + inputs
//   3. Money modals (send / receive / save / funding / ticket)
//   4. Cards + rows (activity, tickets, pd-glass, feed-collected)
//   5. Navigation (dock, wallet dropdown mockup, tab strip)
//   6. Media (track-play-btn, mini-player affordance)
//   7. Status states (loader, error, empty, success)
//   8. Print / mobile previews (noted where applicable)
//
// Not linked from any nav. Anyone can hit /design but it's noindex.

import { registerPage, escapeHtml } from './utils.js'

registerPage('design-page', initDesign)

async function initDesign() {
  const el = document.getElementById('design-content')
  if (!el) return

  el.innerHTML = `
    <div class="design-catalog">
      <header class="design-lead">
        <div class="design-eyebrow">praxis · living UI catalog</div>
        <h1>every component, on one page</h1>
        <p class="design-lead-sub">
          Buttons open the real modals — the ones users actually see. If
          it looks wrong here, it looks wrong in prod. See
          <a href="/docs/design-philosophy.md" style="color:var(--accent)">docs/design-philosophy.md</a>
          for the principles this catalog is meant to hold accountable.
        </p>
      </header>

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
            <p style="margin:0">body text — sits at the reader's default size for the artist tenant. Lorem ipsum sits at ease.</p>
            <p style="margin:0;color:var(--dim);font-size:0.9em">dim text — captions + secondary meta</p>
            <p style="margin:0;color:var(--muted);font-size:0.85em">muted text — hint copy</p>
            <p style="margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:0.85em">monospace 0x46db55ad42da6ba3c29a3c1522ebbf8e16960725</p>
          </div>
        </div>
      </section>

      <section class="design-section">
        <h2 class="design-section-title">2 · buttons + inputs</h2>

        <div class="design-block">
          <h3>buttons</h3>
          <div class="design-btn-row">
            <button class="vault-save-btn" style="width:auto;padding:0.75em 1.5em">primary — vault-save-btn</button>
            <button class="buy-btn">buy-btn</button>
            <button class="vault-verb">vault-verb</button>
            <button class="vault-recv-copy"><i class="ph ph-copy"></i> ghost — vault-recv-copy</button>
            <button class="vault-save-btn vault-save-btn-done" style="width:auto;padding:0.75em 1.5em"><i class="ph ph-check"></i> success — btn-done</button>
            <button class="vault-save-btn" disabled style="width:auto;padding:0.75em 1.5em">disabled</button>
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

      <section class="design-section">
        <h2 class="design-section-title">3 · money modals</h2>
        <p style="color:var(--dim);font-size:0.9em;margin:0 0 1em">
          Each opens the LIVE modal — same function every route calls. Close and reopen at will.
        </p>
        <div class="design-btn-row" id="design-modal-openers">
          <button class="buy-btn" data-open="send">send</button>
          <button class="buy-btn" data-open="receive">receive</button>
          <button class="buy-btn" data-open="save">save to BOLD</button>
          <button class="buy-btn" data-open="funding">funding sheet</button>
          <button class="buy-btn" data-open="onramp">onramp — buy with card</button>
          <button class="buy-btn" data-open="offramp">offramp — cash out</button>
        </div>
      </section>

      <section class="design-section">
        <h2 class="design-section-title">4 · cards + rows</h2>

        <div class="design-block">
          <h3>vault total (mini)</h3>
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
          <h3>activity row</h3>
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

        <div class="design-block">
          <h3>ticket pass (mini)</h3>
          <p style="color:var(--dim);font-size:0.9em">Open the full page at <a href="/ticket?token=1000000000000000000000000000000000000000000000000000000000000000000000000000005" target="_blank" style="color:var(--accent)">/ticket?token=…</a> — the tokenId here is invalid on purpose so the page shows its "no such event" branch.</p>
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

      <section class="design-section">
        <h2 class="design-section-title">5 · navigation</h2>

        <div class="design-block">
          <h3>wallet dropdown row (owner view)</h3>
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
          <p style="color:var(--dim);font-size:0.9em;margin:0 0 0.5em">Same tabs the /network + /projects + /library pages share.</p>
          <nav style="display:flex;gap:0.5em;flex-wrap:wrap">
            <a class="tab-btn tab-btn-active">network</a>
            <a class="tab-btn">projects</a>
            <a class="tab-btn">library</a>
          </nav>
        </div>
      </section>

      <section class="design-section">
        <h2 class="design-section-title">6 · media</h2>
        <div class="design-block">
          <h3>track play buttons</h3>
          <div style="display:flex;gap:1.5em;align-items:center">
            <button class="track-play-btn" data-track-src="/api/ipfs-proxy/QmFake" data-track-title="Untitled" data-track-artist="artist">play</button>
            <span style="color:var(--dim);font-size:0.9em">click to test the persistent player pipeline</span>
          </div>
        </div>
      </section>

      <section class="design-section">
        <h2 class="design-section-title">7 · status states</h2>
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
          Add a new component? Open this file
          (<code>public/js/design.js</code>) and either drop in a live example
          or a "data-open" button that triggers its real module function.
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

  // Modal openers — invoke the SAME functions production uses. Fail
  // gracefully with a hint if the module isn't loaded yet (rare — spa.js
  // auto-lazies most routes but some are dock-triggered only).
  document.getElementById('design-modal-openers')?.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button[data-open]')
    if (!btn) return
    const kind = btn.dataset.open
    const addr = window.getWalletAddress?.() || '0x0000000000000000000000000000000000000dEaD'
    try {
      if (kind === 'send') {
        const m = await import('./earnings.js')
        await m.showSendModal(addr)
      } else if (kind === 'receive') {
        const m = await import('./earnings.js')
        await m.showReceiveModal(addr)
      } else if (kind === 'save') {
        // showSwapModal isn't a plain export — it depends on state
        // computed by initVault. Hop to /vault where it's wired up.
        window.location.href = '/vault'
      } else if (kind === 'funding') {
        const m = await import('./pay.js')
        // 0 amount → the "add funds" open path (no purchase-hint copy).
        await m.showFundingSheet(addr, 0n)
      } else if (kind === 'onramp') {
        const m = await import('./ramp.js')
        m.showOnrampModal?.(addr)
      } else if (kind === 'offramp') {
        const m = await import('./ramp.js')
        m.showOfframpModal?.(addr)
      }
    } catch (e) {
      console.warn('design catalog opener failed:', kind, e)
    }
  })

  // Rough count of "how many surfaces did we catalog" so a maintainer can
  // spot when something got added upstream but not represented here.
  const openerCount = document.querySelectorAll('#design-modal-openers button[data-open]').length
  const blockCount = document.querySelectorAll('.design-block').length
  const countEl = document.getElementById('design-audit-count')
  if (countEl) countEl.textContent = `${openerCount} modal openers · ${blockCount} static blocks`
}
