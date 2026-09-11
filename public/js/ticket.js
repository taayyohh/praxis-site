// Buyer-facing event ticket — the page you present at the door.
//
// Mounts on /ticket?token=<tokenId>. Decodes the tokenId into its
// (type, projectId, tierId, serial) components, looks up the project +
// tier data from Ponder, resolves the artist's domain for the header,
// and renders a full-screen Apple-Wallet-style pass with a scannable QR.
//
// The QR encodes `praxis:t:<projectId>:<tierId>:<serial>` — a compact
// self-describing payload the artist's scanner (project-detail.js
// check-in section) decodes back to the tokenId. Project ID travels in
// the QR so a scan can validate the ticket belongs to the correct event
// before hitting the on-chain checkIn().
//
// Design philosophy per docs/design-philosophy.md: content earns its
// size — event title is the hero (biggest number/name on the page), QR
// is functional and lives at the bottom, no decorative chrome. One
// story: "here is the ticket."

import { escapeHtml, registerPage, resolveAddresses, resolveDomain } from './utils.js'
import { query } from './ponder.js'
import { F } from './fragments.js'
import { t, whenReady as i18nReady } from './i18n.js'

registerPage('ticket-page', initTicket)

const TYPE_TICKET = 1

// tokenId layout (Praxis.sol L456-458):
//   [type 8 | projectId 64 | tierId 32 | serial 152]
function decodeTokenId(tokenIdStr) {
  const t = BigInt(tokenIdStr)
  const serial = t & ((1n << 152n) - 1n)
  const tierId = (t >> 152n) & ((1n << 32n) - 1n)
  const projectId = (t >> 184n) & ((1n << 64n) - 1n)
  const tokenType = Number((t >> 248n) & 0xffn)
  return { tokenType, projectId, tierId, serial }
}

// Format a unix-seconds timestamp as "Friday, September 12 · 8:00 PM"
// (locale-aware). Falls back to a plain date on Invalid.
function formatEventDate(unixSeconds) {
  const n = Number(unixSeconds)
  if (!Number.isFinite(n) || n <= 0) return ''
  const d = new Date(n * 1000)
  if (isNaN(d.getTime())) return ''
  const day = d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return `${day} · ${time}`
}

async function initTicket() {
  const contentEl = document.getElementById('ticket-content')
  if (!contentEl) return

  await i18nReady()

  const url = new URL(window.location.href)
  const tokenIdStr = url.searchParams.get('token') || url.searchParams.get('t')
  if (!tokenIdStr) {
    contentEl.innerHTML = `<p style="color:var(--muted);text-align:center;padding:2em">no ticket in this link</p>`
    return
  }

  let decoded
  try { decoded = decodeTokenId(tokenIdStr) }
  catch { contentEl.innerHTML = `<p style="color:var(--muted);text-align:center;padding:2em">that ticket id doesn't look right</p>`; return }
  const { tokenType, projectId, tierId, serial } = decoded
  if (tokenType !== TYPE_TICKET) {
    contentEl.innerHTML = `<p style="color:var(--muted);text-align:center;padding:2em">this token isn't a ticket</p>`
    return
  }

  try {
    // One round trip: project data + all tiers for this project.
    // Tiers indexed by tierId within a project; we pick the matching one.
    const data = await query(`
      query TicketBundle($projectId: BigInt!) {
        project(id: $projectId) { ${F.projectDetail} }
        tiers(where: { projectId: $projectId }, limit: 20) { items { ${F.tier} } }
      }
    `, { projectId: String(projectId) })

    const project = data?.project
    if (!project) {
      contentEl.innerHTML = `<p style="color:var(--muted);text-align:center;padding:2em">event not found</p>`
      return
    }
    const tier = (data.tiers?.items || []).find(x => String(x.tierId) === String(tierId))

    // Resolve the artist's handle for the header — falls back to the
    // shortened 0x if we can't reach the resolver.
    const domainMap = await resolveAddresses(query, [project.proposer]).catch(() => ({}))
    const artistDomain = domainMap[project.proposer.toLowerCase()] || resolveDomain(domainMap, project.proposer)

    // QR payload — projectId.tierId.serial keeps the string short so
    // v1-v4 QR fits comfortably (see public/js/qr.js note on version cap).
    const qrPayload = `praxis:t:${projectId}:${tierId}:${serial}`
    let qrSvg = ''
    try {
      const { generateQR } = await import('./qr.js')
      qrSvg = generateQR(qrPayload)
    } catch (e) { console.warn('QR gen failed', e) }

    const eventDateStr = tier?.eventDate ? formatEventDate(tier.eventDate) : ''
    const tierName = tier?.name || 'ticket'
    const location = tier?.location || project.location || ''

    // The pass. Structured like an Apple Wallet ticket: eyebrow (artist
    // handle) → event title (hero) → primary fields (date + tier) →
    // secondary field (location) → serial → QR. Nothing else on the
    // page competes; this is one story.
    contentEl.innerHTML = `
      <article class="ticket-pass">
        <header class="ticket-pass-head">
          <div class="ticket-pass-eyebrow">${escapeHtml(artistDomain)}</div>
          <h1 class="ticket-pass-title">${escapeHtml(project.title)}</h1>
        </header>

        <div class="ticket-pass-fields">
          ${eventDateStr ? `<div class="ticket-pass-field">
            <div class="ticket-pass-field-label">when</div>
            <div class="ticket-pass-field-value">${escapeHtml(eventDateStr)}</div>
          </div>` : ''}
          <div class="ticket-pass-field">
            <div class="ticket-pass-field-label">tier</div>
            <div class="ticket-pass-field-value">${escapeHtml(tierName)}</div>
          </div>
          ${location ? `<div class="ticket-pass-field ticket-pass-field-wide">
            <div class="ticket-pass-field-label">where</div>
            <div class="ticket-pass-field-value">${escapeHtml(String(location))}</div>
          </div>` : ''}
        </div>

        <div class="ticket-pass-perforation" aria-hidden="true">
          <span></span><span></span><span></span><span></span><span></span>
          <span></span><span></span><span></span><span></span><span></span>
          <span></span><span></span><span></span><span></span><span></span>
        </div>

        <div class="ticket-pass-code">
          <div class="ticket-pass-qr">${qrSvg}</div>
          <div class="ticket-pass-serial">
            <span class="ticket-pass-field-label">ticket</span>
            <span class="ticket-pass-field-value">#${serial}</span>
          </div>
        </div>

        <footer class="ticket-pass-foot">
          <a id="ticket-add-wallet" href="/api/ticket/pkpass?token=${escapeHtml(tokenIdStr)}" class="ticket-wallet-btn"><i class="ph ph-wallet"></i> add to Apple Wallet</a>
          <p class="ticket-pass-footnote">Show this to the door. Screenshotting is fine — one scan per ticket.</p>
        </footer>
      </article>
    `

    // If the pkpass endpoint isn't configured (no cert), the click will
    // land on a 501. We swap the button's action to open a helpful
    // fallback instead of dumping the raw JSON on the buyer.
    document.getElementById('ticket-add-wallet')?.addEventListener('click', async (ev) => {
      ev.preventDefault()
      const btn = ev.currentTarget
      const orig = btn.innerHTML
      btn.innerHTML = `<i class="ph ph-spinner ph-spin"></i> preparing…`
      try {
        const res = await fetch(btn.getAttribute('href'), { method: 'GET' })
        if (res.ok) {
          // Trigger download of the .pkpass
          const blob = await res.blob()
          const dlUrl = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = dlUrl
          a.download = `praxis-ticket-${projectId}-${serial}.pkpass`
          document.body.appendChild(a); a.click(); a.remove()
          URL.revokeObjectURL(dlUrl)
        } else if (res.status === 501) {
          // Server not configured with Apple cert — surface a
          // one-line explanation instead of a blank error. The
          // buyer still has the QR on this page, so nothing is lost.
          btn.innerHTML = `<i class="ph ph-info"></i> Apple Wallet not set up yet — use the QR above`
          setTimeout(() => { btn.innerHTML = orig }, 4000)
          return
        } else {
          btn.innerHTML = `<i class="ph ph-warning"></i> couldn't prepare the pass`
          setTimeout(() => { btn.innerHTML = orig }, 3000)
        }
      } catch {
        btn.innerHTML = `<i class="ph ph-warning"></i> couldn't prepare the pass`
        setTimeout(() => { btn.innerHTML = orig }, 3000)
      }
      btn.innerHTML = orig
    })
  } catch (e) {
    console.warn('ticket load error', e)
    contentEl.innerHTML = `<p style="color:var(--muted);text-align:center;padding:2em">couldn't load the ticket. try again in a moment.</p>`
  }
}
