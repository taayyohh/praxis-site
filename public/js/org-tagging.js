// Org tagging affordance — attaches to a work card and lets the artist
// (owner of the media) publish/unpublish it to any of their orgs. Reads
// the current tag state from Ponder (orgWorks) and writes tagWork /
// untagWork transactions to PraxisOrganization. Routes through the
// inline unlock so the security prompt renders in the same panel.
import { escapeHtml, getPublicClient, getWalletProvider } from './utils.js'
import { ORG_ADDRESS, ORG_ABI, getMediaAddress } from './contracts.js'

// Cache the artist's org memberships + per-media tag state so opening
// multiple work menus doesn't re-fetch the world. Keyed by artist addr
// (memberships) and by mediaId (tag state per work).
const _memberOrgsCache = new Map()   // artistLower -> [{ id, name }]
const _tagStateCache = new Map()     // `${mediaId}` -> Set of orgIds

// The tagWork/untagWork functions live in the PraxisOrganization contract
// version that ships with the #93 redeploy. Until that redeploy, the
// currently-deployed contract has no such functions and a tag transaction
// would revert on submit — worse UX than not showing the affordance at all.
// Probe once at first use by calling isWorkTagged as a view; if the ABI
// isn't there yet the call rejects and we treat tagging as unavailable.
let _tagWorkAvailability = null // Promise<boolean>
function _checkTagWorkAvailable() {
  if (_tagWorkAvailability) return _tagWorkAvailability
  _tagWorkAvailability = (async () => {
    try {
      const pc = await getPublicClient()
      await pc.readContract({
        address: ORG_ADDRESS,
        abi: ORG_ABI,
        functionName: 'isWorkTagged',
        args: [0n, '0x0000000000000000000000000000000000000000', 0n],
      })
      return true
    } catch {
      return false
    }
  })()
  return _tagWorkAvailability
}

async function _fetchMemberOrgs(artist) {
  const key = artist.toLowerCase()
  if (_memberOrgsCache.has(key)) return _memberOrgsCache.get(key)
  try {
    const res = await fetch(`/api/orgs/by-member/${encodeURIComponent(artist)}`)
    if (!res.ok) throw new Error('http')
    const data = await res.json()
    const orgs = (data.orgs || []).filter(o => !o.dissolved)
    _memberOrgsCache.set(key, orgs)
    return orgs
  } catch {
    _memberOrgsCache.set(key, [])
    return []
  }
}

async function _fetchTagState(mediaId) {
  const key = String(mediaId)
  if (_tagStateCache.has(key)) return _tagStateCache.get(key)
  try {
    // orgWorks entries are keyed on (orgId, mediaContract, mediaId). We
    // look up every row for this mediaId and let the caller cross-check
    // against their own memberships. mediaContract varies per redeploy so
    // filter by mediaId alone; membership scoping happens client-side.
    const gql = `query WorkTags($mediaId: BigInt!) {
      orgWorks(where: { mediaId: $mediaId }, limit: 50) { items { orgId } }
    }`
    const res = await fetch('/api/feed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: gql, variables: { mediaId: String(mediaId) } }),
    })
    const data = await res.json()
    const rows = data?.data?.orgWorks?.items || []
    const set = new Set(rows.map(r => String(r.orgId)))
    _tagStateCache.set(key, set)
    return set
  } catch {
    const empty = new Set()
    _tagStateCache.set(key, empty)
    return empty
  }
}

export function invalidateTagCache(mediaId) {
  if (mediaId != null) _tagStateCache.delete(String(mediaId))
}
export function invalidateMemberCache(addr) {
  if (addr) _memberOrgsCache.delete(String(addr).toLowerCase())
}

/**
 * Attach a "publish to organization" affordance to a work card. Renders
 * a button that toggles a small panel with a checkbox per org. Each
 * toggle fires tagWork / untagWork on PraxisOrganization.
 * @param {HTMLElement} cardEl — the .works-card container
 * @param {{ mediaId: string|number|bigint, artist: string, title?: string }} media
 */
export async function attachOrgTagger(cardEl, media) {
  if (!cardEl || cardEl.dataset.orgTaggerBound === '1') return
  cardEl.dataset.orgTaggerBound = '1'

  // Guard against showing an affordance the deployed contract can't fulfill:
  // tagWork/untagWork only exist after the #93 redeploy. Until then the
  // artist would click, sign, and get a revert. Hide the button entirely
  // rather than surface that failure.
  const available = await _checkTagWorkAvailable()
  if (!available) return

  const artistAddr = String(media.artist || '').toLowerCase()
  const [orgs, tagged] = await Promise.all([
    _fetchMemberOrgs(artistAddr),
    _fetchTagState(media.mediaId),
  ])
  if (!orgs.length) return  // nothing to tag to

  const actions = cardEl.querySelector('.works-card-actions')
  if (!actions) return

  const trigger = document.createElement('button')
  trigger.className = 'org-tag-trigger'
  trigger.type = 'button'
  trigger.style.cssText = 'background:none;border:1px solid var(--border);color:var(--dim);font-family:inherit;font-size:0.75em;padding:0.2em 0.9ch;cursor:pointer;border-radius:2px;white-space:nowrap'
  const _labelFor = () => {
    const activeCount = orgs.filter(o => tagged.has(String(o.id))).length
    return activeCount > 0 ? `in ${activeCount} org${activeCount === 1 ? '' : 's'}` : 'publish'
  }
  trigger.textContent = _labelFor()
  actions.appendChild(trigger)

  let panel = null
  const closePanel = () => { if (panel) { panel.remove(); panel = null } }
  document.addEventListener('click', (e) => {
    if (panel && !panel.contains(e.target) && e.target !== trigger) closePanel()
  })

  trigger.addEventListener('click', (e) => {
    e.stopPropagation()
    if (panel) { closePanel(); return }
    panel = document.createElement('div')
    panel.className = 'org-tag-panel'
    panel.style.cssText = 'position:absolute;right:0;top:100%;margin-top:0.3em;background:var(--bg,#0a0a0a);border:1px solid var(--border);padding:0.5em 0.6em;z-index:20;min-width:220px;max-width:280px;box-shadow:0 4px 12px rgba(0,0,0,0.4)'
    panel.innerHTML = `
      <p style="font-size:0.7em;color:var(--muted);margin:0 0 0.4em;text-transform:uppercase;letter-spacing:0.05em">publish to organization</p>
      <div class="org-tag-list"></div>
      <p class="org-tag-status" style="font-size:0.75em;color:var(--muted);min-height:1em;margin:0.4em 0 0"></p>
      <div class="org-tag-unlock-slot"></div>
    `
    const list = panel.querySelector('.org-tag-list')
    for (const o of orgs) {
      const isTagged = tagged.has(String(o.id))
      const row = document.createElement('label')
      row.className = 'publish-toggle-row'
      row.innerHTML = `
        <span class="publish-toggle-name">${escapeHtml(o.name)}</span>
        <span class="publish-toggle-state">${isTagged ? 'published' : 'not published'}</span>
        <span class="publish-toggle-switch">
          <input type="checkbox" ${isTagged ? 'checked' : ''} data-org-id="${escapeHtml(String(o.id))}">
          <span class="publish-toggle-track"></span>
        </span>
      `
      list.appendChild(row)
    }
    actions.style.position = 'relative'
    actions.appendChild(panel)
    _wireCheckboxes(panel, media, orgs, tagged, trigger, _labelFor)
  })
}

function _wireCheckboxes(panel, media, orgs, tagged, trigger, labelFn) {
  const statusEl = panel.querySelector('.org-tag-status')
  const unlockSlot = panel.querySelector('.org-tag-unlock-slot')
  const boxes = panel.querySelectorAll('input[type="checkbox"][data-org-id]')

  boxes.forEach(box => {
    box.addEventListener('change', async (e) => {
      e.stopPropagation()
      const orgId = box.dataset.orgId
      const org = orgs.find(o => String(o.id) === orgId)
      const wantTagged = box.checked
      const label = org?.name || `org #${orgId}`

      // Roll back checkbox on any failure; assume success optimistically.
      const prevCheckedState = !wantTagged
      const fail = (msg) => {
        box.checked = prevCheckedState
        statusEl.style.color = '#ef4444'
        statusEl.textContent = msg
      }

      try {
        boxes.forEach(b => { b.disabled = true })
        statusEl.style.color = ''
        statusEl.textContent = wantTagged ? `publishing to ${label}…` : `removing from ${label}…`

        // Ensure wallet unlocked, inline into the panel so the security
        // prompt renders here instead of stacking as a separate modal.
        if (window.isWalletUnlocked && !window.isWalletUnlocked()) {
          const ok = await window.ensureAuthorized?.({ target: unlockSlot })
          if (!ok) { fail('cancelled'); return }
        }

        if (!await window.ensureOptimism?.()) { fail('wallet not connected'); return }

        const { createWalletClient, custom, optimism } = await import('./vendor.js')
        const provider = getWalletProvider()
        const wc = createWalletClient({ chain: optimism, transport: custom(provider) })
        const addr = window.getWalletAddress?.()
        const mediaContract = getMediaAddress()
        if (!mediaContract || !/^0x[0-9a-fA-F]{40}$/.test(mediaContract)) {
          fail('media contract not configured'); return
        }
        const fn = wantTagged ? 'tagWork' : 'untagWork'
        const hash = await wc.writeContract({
          address: ORG_ADDRESS, abi: ORG_ABI, functionName: fn,
          args: [BigInt(orgId), mediaContract, BigInt(media.mediaId)],
          account: window.getEmbeddedAccount?.() || addr,
        })
        statusEl.textContent = 'waiting for confirmation…'
        const pc = await getPublicClient()
        await pc.waitForTransactionReceipt({ hash })

        // Success: update the shared tag-state cache + label.
        if (wantTagged) tagged.add(orgId); else tagged.delete(orgId)
        _tagStateCache.set(String(media.mediaId), tagged)
        trigger.textContent = labelFn()
        // Update the row's state label so the reader sees the new
        // status inline without waiting for the panel to re-render.
        const stateLbl = box.closest('.publish-toggle-row')?.querySelector('.publish-toggle-state')
        if (stateLbl) stateLbl.textContent = wantTagged ? 'published' : 'not published'
        statusEl.style.color = 'var(--green,#4a4)'
        statusEl.textContent = wantTagged ? `published to ${label}` : `removed from ${label}`
      } catch (err) {
        fail(err?.code === 4001 ? 'cancelled' : `error: ${(err?.shortMessage || err?.message || '').slice(0, 80)}`)
      } finally {
        boxes.forEach(b => { b.disabled = false })
      }
    })
  })
}
