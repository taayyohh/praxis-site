// PraxisMedia — list, purchase, and manage media on-chain
import { F } from './fragments.js'
import { parseEther } from './vendor.js'
import { query } from './ponder.js'
import { ipfsUrl, escapeHtml, ensureWallet, ensureFundsForPurchase, getPublicClient, getWalletProvider, getWalletClient, getProfilePic, getArtistName, classifyContentType } from './utils.js'
import { t } from './i18n.js'
import { formatPriceFiatOnly, getEthPrices } from './fiat.js'

import { MEDIA_ABI, getMediaAddress } from './contracts.js'

const BATCH_MAX = 20
const MEDIA_LISTED_TOPIC = '0x4d24da2b70562743cabea6cd760eed0904274271969048edfc6f65e0b556d038'

// --- Exported contract interactions ---

export async function listMedia(title, ipfsCid, metadataCid, price, maxSupply, collaborators, splits) {
  const address = getMediaAddress()
  if (!address) throw new Error('media contract not configured')

  const addr = await ensureWallet()
  if (!addr) throw new Error(t('status.connectWallet'))
  if (!await window.ensureOptimism?.()) return

  const currentAccount = await window.ensureAuthorized?.() || addr
  const wc = getWalletClient()

  const pc = await getPublicClient()

  // validate params before contract call (viem gives useless errors)
  if (!title) throw new Error('title is empty')
  if (!ipfsCid) throw new Error('IPFS CID is empty')
  if (!currentAccount || !currentAccount.startsWith('0x')) throw new Error('wallet not connected')
  if (!address || !address.startsWith('0x')) throw new Error('media contract address missing')
  const priceWei = parseEther(String(price))
  const supply = BigInt(maxSupply)

  // verify artist is registered on-chain before attempting list
  try {
    const { REGISTRY_ABI, getRegistryAddress } = await import('./contracts.js')
    const regAddr = getRegistryAddress()
    if (regAddr) {
      const artist = await pc.readContract({ address: regAddr, abi: REGISTRY_ABI, functionName: 'artists', args: [currentAccount] })
      if (!artist[1] || artist[1] === 0n) throw new Error('wallet not registered on-chain — check you are using the right wallet')
    }
  } catch (e) {
    if (e.message.includes('not registered') || e.message.includes('right wallet')) throw e
  }

  // Always use 7-arg version (viem can't disambiguate overloaded functions)
  // Empty arrays = contract defaults to 100% artist revenue
  const collabAddrs = collaborators?.length > 0 ? collaborators : []
  const collabSplits = collaborators?.length > 0 ? splits.map(s => BigInt(s)) : []

  const hash = await wc.writeContract({
    address,
    abi: MEDIA_ABI,
    functionName: 'list',
    args: [title, ipfsCid, metadataCid, priceWei, supply, collabAddrs, collabSplits],
    account: currentAccount,
  })

  // extract mediaId from Listed event in receipt
  const receipt = await pc.waitForTransactionReceipt({ hash })
  const listedLog = receipt.logs.find(log => {
    try { return log.topics[0] === MEDIA_LISTED_TOPIC } catch { return false }
  })
  if (listedLog?.topics?.[1]) {
    return BigInt(listedLog.topics[1]).toString()
  }
  // fallback: read mediaCount - 1
  const count = await pc.readContract({ address, abi: MEDIA_ABI, functionName: 'mediaCount' })
  return (count - 1n).toString()
}

export async function purchaseMedia(mediaId, price) {
  const address = getMediaAddress()
  if (!address) throw new Error('media contract not configured')

  const addr = await ensureFundsForPurchase(price)
  if (!addr) throw new Error(t('status.connectWallet'))

  const purchaseAccount = await window.ensureAuthorized?.() || addr
  const wc = getWalletClient()
  const hash = await wc.writeContract({
    address,
    abi: MEDIA_ABI,
    functionName: 'purchase',
    args: [BigInt(mediaId)],
    value: BigInt(price), // price is already in wei
    account: purchaseAccount,
  })
  const pc = await getPublicClient()
  await pc.waitForTransactionReceipt({ hash })
  // Invalidate collection cache so new purchase shows immediately
  try {
    const { invalidate } = await import('./cache.js')
    invalidate('collection-data:')
  } catch {}
  return hash
}

// Batch list up to 20 items per transaction. entries = [{ title, ipfsCid, metadataCid, price, maxSupply, collaborators, splits }]
// If >20 entries, splits into multiple txs automatically. Returns array of all media IDs.
export async function listBatchMedia(entries) {
  const address = getMediaAddress()
  if (!address) throw new Error('media contract not configured')

  const addr = await ensureWallet()
  if (!addr) throw new Error(t('status.connectWallet'))
  if (!await window.ensureOptimism?.()) return

  const currentAccount = await window.ensureAuthorized?.() || addr
  const wc = getWalletClient()
  const pc = await getPublicClient()

  if (!currentAccount || !currentAccount.startsWith('0x')) throw new Error('wallet not connected')
  if (!address || !address.startsWith('0x')) throw new Error('media contract address missing')

  // verify artist is registered on-chain
  try {
    const { REGISTRY_ABI, getRegistryAddress } = await import('./contracts.js')
    const regAddr = getRegistryAddress()
    if (regAddr) {
      const artist = await pc.readContract({ address: regAddr, abi: REGISTRY_ABI, functionName: 'artists', args: [currentAccount] })
      if (!artist[1] || artist[1] === 0n) throw new Error('wallet not registered on-chain — check you are using the right wallet')
    }
  } catch (e) {
    if (e.message.includes('not registered') || e.message.includes('right wallet')) throw e
  }

  const allIds = []

  // Process in chunks of 20
  for (let i = 0; i < entries.length; i += BATCH_MAX) {
    const chunk = entries.slice(i, i + BATCH_MAX)
    const tuples = chunk.map(e => ({
      title: e.title || 'untitled',
      ipfsCid: e.ipfsCid || '',
      metadataCid: e.metadataCid || '',
      price: parseEther(String(e.price || '0')),
      maxSupply: BigInt(e.maxSupply || 0),
      collaborators: e.collaborators?.length > 0 ? e.collaborators : [],
      splits: e.collaborators?.length > 0 ? e.splits.map(s => BigInt(s)) : [],
    }))

    const hash = await wc.writeContract({
      address,
      abi: MEDIA_ABI,
      functionName: 'listBatch',
      args: [tuples],
      account: currentAccount,
    })

    const receipt = await pc.waitForTransactionReceipt({ hash })

    // Extract media IDs from Listed events in receipt
    const batchIds = receipt.logs
      .filter(log => { try { return log.topics[0] === MEDIA_LISTED_TOPIC } catch { return false } })
      .map(log => BigInt(log.topics[1]).toString())

    if (batchIds.length > 0) {
      allIds.push(...batchIds)
    } else {
      // fallback: read mediaCount and compute IDs
      const count = await pc.readContract({ address, abi: MEDIA_ABI, functionName: 'mediaCount' })
      for (let j = chunk.length - 1; j >= 0; j--) {
        allIds.push((count - BigInt(j) - 1n).toString())
      }
    }
  }

  return allIds
}

// Batch purchase up to 20 items per transaction.
// If >20 mediaIds, splits into multiple txs. totalPrice is in wei (BigInt or string).
export async function purchaseBatchMedia(mediaIds, totalPrice) {
  const address = getMediaAddress()
  if (!address) throw new Error('media contract not configured')

  const addr = await ensureFundsForPurchase(totalPrice)
  if (!addr) throw new Error(t('status.connectWallet'))

  const purchaseAccount = await window.ensureAuthorized?.() || addr
  const wc = getWalletClient()
  const pc = await getPublicClient()

  if (mediaIds.length <= BATCH_MAX) {
    // Single batch tx
    const hash = await wc.writeContract({
      address,
      abi: MEDIA_ABI,
      functionName: 'purchaseBatch',
      args: [mediaIds.map(id => BigInt(id))],
      value: BigInt(totalPrice),
      account: purchaseAccount,
    })
    await pc.waitForTransactionReceipt({ hash })
    return hash
  }

  // Multiple batch txs — need to compute per-chunk price
  // Read individual prices to split correctly
  const calls = mediaIds.map(id => ({
    address, abi: MEDIA_ABI, functionName: 'media', args: [BigInt(id)],
  }))
  const results = await pc.multicall({ contracts: calls, allowFailure: true })
  const prices = results.map(r => r.status === 'success' ? BigInt(r.result[4]) : 0n)

  let lastHash
  for (let i = 0; i < mediaIds.length; i += BATCH_MAX) {
    const chunkIds = mediaIds.slice(i, i + BATCH_MAX)
    const chunkPrices = prices.slice(i, i + BATCH_MAX)
    const chunkTotal = chunkPrices.reduce((sum, p) => sum + p, 0n)

    const hash = await wc.writeContract({
      address,
      abi: MEDIA_ABI,
      functionName: 'purchaseBatch',
      args: [chunkIds.map(id => BigInt(id))],
      value: chunkTotal,
      account: purchaseAccount,
    })
    await pc.waitForTransactionReceipt({ hash })
    lastHash = hash
  }
  return lastHash
}

export async function getArtistMedia(artistAddress, cursor = null) {
  try {
    const data = await query(`
      query ArtistMedia($artist: String!, $after: String) {
        mediaListings(where: { artist: $artist }, orderBy: "timestamp", orderDirection: "desc", limit: 50, after: $after) {
          items { ${F.mediaListingFull} }
          ${F.pageInfo}
        }
      }
    `, { artist: artistAddress.toLowerCase(), after: cursor })
    const items = data.mediaListings?.items || []
    return {
      items,
      cursor: data.mediaListings?.pageInfo?.endCursor || null,
      hasMore: data.mediaListings?.pageInfo?.hasNextPage || false,
    }
  } catch (e) {
    console.warn('getArtistMedia error:', e)
    // fallback to direct contract read (returns all, no pagination)
    const address = getMediaAddress()
    if (!address) return { items: [], cursor: null, hasMore: false }
    const pc = await getPublicClient()
    const ids = await pc.readContract({ address, abi: MEDIA_ABI, functionName: 'getMediaByArtist', args: [artistAddress] })
    if (ids.length === 0) return { items: [], cursor: null, hasMore: false }
    const calls = ids.map(id => ({ address, abi: MEDIA_ABI, functionName: 'media', args: [id] }))
    const results = await pc.multicall({ contracts: calls, allowFailure: true })
    const items = []
    for (let i = 0; i < ids.length; i++) {
      const r = results[i]
      if (r.status !== 'success') continue
      const [artist, title, ipfsCid, metadataCid, price, maxSupply, totalMinted] = r.result
      items.push({ mediaId: ids[i].toString(), artist, title, ipfsCid, metadataCid, price: price.toString(), maxSupply: maxSupply.toString(), totalMinted: totalMinted.toString() })
    }
    return { items, cursor: null, hasMore: false }
  }
}

export async function getCollection(ownerAddress, cursor = null) {
  try {
    const data = await query(`
      query Collection($buyer: String!, $after: String) {
        mediaPurchases(where: { buyer: $buyer }, orderBy: "timestamp", orderDirection: "desc", limit: 50, after: $after) {
          items { ${F.mediaPurchaseFull} }
          ${F.pageInfo}
        }
      }
    `, { buyer: ownerAddress.toLowerCase(), after: cursor })
    const items = data.mediaPurchases?.items || []
    return {
      items,
      cursor: data.mediaPurchases?.pageInfo?.endCursor || null,
      hasMore: data.mediaPurchases?.pageInfo?.hasNextPage || false,
    }
  } catch (e) {
    console.warn('getCollection error:', e)
    return { items: [], cursor: null, hasMore: false }
  }
}

// Centralized cached ownership checker — used by all modules
if (!window._getOwnedMediaIds) {
  let _ownedCache = null
  let _ownedCacheTime = 0
  window._getOwnedMediaIds = async function(addr) {
    if (!addr) return []
    const now = Date.now()
    // check sessionStorage first
    const cached = sessionStorage.getItem(`praxis-owned-${addr}`)
    if (cached && _ownedCacheTime && now - _ownedCacheTime < 30000) return new Set(JSON.parse(cached))
    // fresh fetch
    try {
      const result = await getCollection(addr)
      const ids = new Set((result.items || result).map(p => String(p.mediaId)))
      _ownedCache = ids
      _ownedCacheTime = now
      try { sessionStorage.setItem(`praxis-owned-${addr}`, JSON.stringify([...ids])) } catch {}
      return ids
    } catch { return _ownedCache || new Set() }
  }
  window.addEventListener('wallet-connected', () => { _ownedCache = null; _ownedCacheTime = 0 })
}

export async function setMediaPrice(mediaId, priceEth) {
  const address = getMediaAddress()
  if (!address) throw new Error('media contract not configured')
  const addr = await ensureWallet()
  if (!addr) throw new Error('connect wallet')
  if (!await window.ensureOptimism?.()) return
  const priceAccount = await window.ensureAuthorized?.() || addr
  const wc = getWalletClient()
  const hash = await wc.writeContract({
    address, abi: MEDIA_ABI, functionName: 'setPrice',
    args: [BigInt(mediaId), parseEther(String(priceEth))],
    account: priceAccount,
  })
  const pc = await getPublicClient()
  await pc.waitForTransactionReceipt({ hash })
  return hash
}

export async function delistMedia(mediaId) {
  const address = getMediaAddress()
  if (!address) throw new Error('media contract not configured')
  const addr = await ensureWallet()
  if (!addr) throw new Error('connect wallet')
  if (!await window.ensureOptimism?.()) return
  const pc = await getPublicClient()
  // read current totalMinted to set maxSupply = totalMinted (no more purchases)
  // if totalMinted is 0, maxSupply=0 means unlimited, so use setPrice to max uint instead
  const media = await pc.readContract({
    address, abi: MEDIA_ABI, functionName: 'media', args: [BigInt(mediaId)],
  })
  const totalMinted = media[6] || 0n
  const account = await window.ensureAuthorized?.() || addr
  const wc = getWalletClient()
  const fn = totalMinted > 0n ? 'setMaxSupply' : 'setPrice'
  const args = totalMinted > 0n
    ? [BigInt(mediaId), BigInt(totalMinted)]
    : [BigInt(mediaId), DELIST_PRICE_SENTINEL]
  const hash = await wc.writeContract({
    address, abi: MEDIA_ABI, functionName: fn, args, account,
  })
  await pc.waitForTransactionReceipt({ hash })
  return hash
}

export async function withdrawEarnings() {
  const address = getMediaAddress()
  if (!address) throw new Error('media contract not configured')

  const addr = await ensureWallet()
  if (!addr) throw new Error(t('status.connectWallet'))
  if (!await window.ensureOptimism?.()) return

  const withdrawAccount = await window.ensureAuthorized?.() || addr
  const wc = getWalletClient()
  const hash = await wc.writeContract({
    address,
    abi: MEDIA_ABI,
    functionName: 'withdraw',
    args: [],
    account: withdrawAccount,
  })
  const pc = await getPublicClient()
  await pc.waitForTransactionReceipt({ hash })
  return hash
}

// --- Owner badges ---

export async function renderOwnerBadges() {
  const el = document.getElementById('owner-badges')
  if (!el) return

  const ownerAddr = document.body.dataset.owner
  if (!ownerAddr) return

  try {
    const parts = []

    const mediaAddress = getMediaAddress()
    const [mediaData, credData] = await Promise.all([
      mediaAddress ? query(`
        query OwnerMedia($artist: String!) {
          mediaListings(where: { artist: $artist }, limit: 200) {
            items { id ipfsCid }
          }
        }
      `, { artist: ownerAddr.toLowerCase() }).catch(e => { console.warn('badges media query error:', e); return null }) : Promise.resolve(null),
      query(`
        query OwnerCreds($holder: String!) {
          contributors: credentials(where: { holder: $holder, tokenType: 3 }, limit: 1) {
            totalCount
          }
          producers: credentials(where: { holder: $holder, tokenType: 2 }, limit: 1) {
            totalCount
          }
        }
      `, { holder: ownerAddr.toLowerCase() }).catch(e => { console.warn('badges credentials query error:', e); return null }),
    ])

    if (mediaData) {
      const allListings = mediaData.mediaListings?.items || []
      const uniqueCids = new Set(allListings.map(l => l.ipfsCid).filter(Boolean))
      const mediaCount = uniqueCids.size || allListings.length
      if (mediaCount > 0) {
        parts.push(`<a href="/works" style="color:var(--muted);text-decoration:none;border-bottom:1px solid var(--border)">${mediaCount} ${mediaCount === 1 ? t('badges.work') : t('badges.works')}</a>`)
      }
    }

    if (credData) {
      const contributorCount = credData.contributors?.totalCount || 0
      const producerCount = credData.producers?.totalCount || 0
      if (contributorCount > 0) {
        parts.push(`<a href="/collection?tab=credentials" style="color:var(--muted);text-decoration:none;border-bottom:1px solid var(--border)">${contributorCount} ${t('badges.completed')}</a>`)
      }
      if (producerCount > 0) {
        parts.push(`<a href="/collection?tab=credentials" style="color:var(--muted);text-decoration:none;border-bottom:1px solid var(--border)">${producerCount} ${t('badges.produced')}</a>`)
      }
    }

    if (parts.length > 0) {
      el.innerHTML = parts.join(' <span style="color:var(--dim)">\u00b7</span> ')
      el.style.color = 'var(--muted)'
      el.style.fontSize = '0.85em'
      el.style.marginTop = '0.3em'
    }
  } catch (e) {
    console.warn('renderOwnerBadges error:', e)
  }
}

// --- Relisting annotation ---

// Sentinel price used by delistMedia() when totalMinted=0 (item never sold,
// so we can't shrink maxSupply to disable purchases — instead set price to
// 2^128 wei which is "effectively unpurchasable"). Any item at or above this
// threshold should be treated as delisted by every UI surface that lists media.
// Bug 2026-04-08: works.js was rendering this raw as "340282366920938... ETH"
// because there was no client-side filter for the sentinel.
export const DELIST_PRICE_SENTINEL = 2n ** 128n

export function isDelisted(item) {
  if (!item) return false
  if (item.delisted === true) return true
  try {
    return BigInt(item.price ?? 0) >= DELIST_PRICE_SENTINEL
  } catch {
    return false
  }
}

// Groups listings by (artist, ipfsCid). In each group, the highest id is the
// active listing and all older ones are marked superseded. Also marks items
// at the delist sentinel price as `delisted = true` so callers can filter
// them. Mutates items in place and returns the same array for convenience.
export function annotateRelistings(listings) {
  // Tag delisted items first so callers can filter on a clean boolean
  for (const item of listings) {
    if (isDelisted(item)) item.delisted = true
  }
  const groups = {}
  for (const item of listings) {
    const key = `${(item.artist || '').toLowerCase()}-${item.ipfsCid}`
    if (!groups[key]) groups[key] = []
    groups[key].push(item)
  }
  for (const items of Object.values(groups)) {
    if (items.length < 2) continue
    items.sort((a, b) => Number(b.id) - Number(a.id))
    items[0].superseded = false
    items[0].activeListingId = items[0].id
    for (let i = 1; i < items.length; i++) {
      items[i].superseded = true
      items[i].activeListingId = items[0].id
    }
  }
  return listings
}

// --- Shared buy button delegation ---

export function wireMediaBuyButtons() {
  if (window._mediaBuyDelegated) return
  window._mediaBuyDelegated = true

  document.addEventListener('click', (e) => {
    const buyBtn = e.target.closest('.track-buy-btn[data-media-id]')
    if (buyBtn && !buyBtn.disabled) {
      e.stopPropagation()
      const mediaId = parseInt(buyBtn.dataset.mediaId)
      const price = buyBtn.dataset.price || '0'
      const title = buyBtn.dataset.title || ''
      const priceEth = Number(price) / 1e18
      window._pendingPurchase = { title, type: 'media', price: priceEth }
      buyBtn.textContent = 'confirming...'
      buyBtn.disabled = true
      purchaseMedia(mediaId, price).then(() => {
        buyBtn.textContent = 'owned'
        buyBtn.style.borderColor = 'var(--accent)'
        buyBtn.style.color = 'var(--accent)'
      }).catch(err => {
        buyBtn.textContent = err.code === 4001 ? 'cancelled' : 'error'
        buyBtn.disabled = false
        setTimeout(() => {
          const p = Number(price) / 1e18
          buyBtn.textContent = p > 0 ? p + ' ETH' : 'free'
          if (p > 0) {
            buyBtn.dataset.ethWei = String(price)
            delete buyBtn.dataset.fiatApplied
          }
        }, 2000)
      }).finally(() => {
        delete window._pendingPurchase
      })
    }
  })

  async function checkOwned() {
    try {
      const ids = await window._getOwnedMediaIds?.()
      if (!ids) return
      document.querySelectorAll('.track-buy-btn[data-media-id]').forEach(btn => {
        if (ids.has(String(btn.dataset.mediaId))) {
          btn.textContent = 'owned'
          btn.style.borderColor = 'var(--accent)'
          btn.style.color = 'var(--accent)'
          btn.disabled = true
        }
      })
    } catch {}
  }
  checkOwned()
  if (!window._mediaBadgeListenersBound) {
    window._mediaBadgeListenersBound = true
    window.addEventListener('wallet-connected', checkOwned)
    window.addEventListener('spa-navigate', () => setTimeout(checkOwned, 100))
  }
}

async function renderOrgRoster() {
  const el = document.getElementById('org-roster')
  if (!el) return
  const ownerAddr = document.body.dataset.owner
  if (!ownerAddr) return

  try {
    const res = await fetch(`/api/orgs/by-member/${ownerAddr}`)
    if (!res.ok) return
    const data = await res.json()
    const orgs = data.orgs || data || []
    if (!orgs?.length) { el.innerHTML = ''; return }

    const orgId = orgs[0].id ?? orgs[0]
    const orgRes = await fetch(`/api/org/${orgId}`)
    if (!orgRes.ok) return
    const org = await orgRes.json()
    if (!org.members?.length) { el.innerHTML = ''; return }

    const adminAddr = (org.admin || ownerAddr || '').toLowerCase()
    const addrs = org.members.map(m => (m.wallet || m).toLowerCase()).filter(a => a !== adminAddr)
    let domainMap = {}
    let pics = {}
    let names = {}
    try {
      const r = await fetch('/api/artists/resolve', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ addresses: addrs }),
      })
      if (r.ok) {
        const resolved = await r.json()
        domainMap = resolved.addresses || resolved
        pics = resolved.profilePics || {}
        names = resolved.names || {}
      }
    } catch {}

    _homeDomainMap = domainMap
    const orgType = org.metadata?.orgType || window._siteData?.orgType || 'collective'
    const rosterLabel = { label: 'artists', gallery: 'represented', company: 'company', publisher: 'authors', collective: 'roster' }[orgType] || 'roster'
    el.innerHTML = `
      <div class="roster-title">${escapeHtml(rosterLabel)}</div>
      <div class="roster-grid">
        ${addrs.map(a => {
          const w = a.toLowerCase()
          const domain = domainMap[w]
          const name = names[w] || getArtistName(w)
          const pic = pics[w] || getProfilePic(w)
          const display = name ? escapeHtml(name) : (domain ? escapeHtml(domain.split('.')[0]) : `${w.slice(0, 6)}...${w.slice(-4)}`)
          const href = domain ? `https://${escapeHtml(domain)}` : '#'
          const picHtml = pic ? `<img src="${escapeHtml(pic)}" class="roster-pic" style="width:80px;height:80px;border-radius:50%;object-fit:cover" loading="lazy" onerror="this.style.display='none'">` : `<div class="roster-pic" style="width:80px;height:80px;border-radius:50%;background:var(--dim,#333)"></div>`
          return `<a href="${href}" class="roster-card" target="_blank">
            ${picHtml}
            <div class="roster-name">${display}</div>
          </a>`
        }).join('')}
      </div>
    `

    // Load catalog below roster
    renderOrgCatalog(el, orgId, orgType)
  } catch (e) {
    console.warn('org roster:', e?.message)
  }
}

let _pdfThumbObs = null
const _pdfThumbDone = new Map()
const _PDF_THUMB_MAX = 200
function _initCatalogThumbs(container) {
  if (!_pdfThumbObs) {
    _pdfThumbObs = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const el = entry.target
        _pdfThumbObs.unobserve(el)
        const url = el.dataset.pdfThumb
        if (!url || _pdfThumbDone.has(url)) continue
        if (_pdfThumbDone.size >= _PDF_THUMB_MAX) { const k = _pdfThumbDone.keys().next().value; if (k !== undefined) _pdfThumbDone.delete(k) }
        _pdfThumbDone.set(url, 1)
        const slot = el.querySelector('.feed-pdf-thumb-slot')
        if (!slot) continue
        const img = document.createElement('img')
        img.src = `/api/pdf-thumb?url=${encodeURIComponent(url)}`
        img.style.cssText = 'width:100%;max-height:200px;object-fit:cover;object-position:top;display:block;border-radius:6px 6px 0 0;cursor:pointer'
        img.loading = 'lazy'
        img.addEventListener('click', () => { const link = el.querySelector('.feed-library-open'); if (link) link.click() })
        img.onerror = () => { slot.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:80px;background:var(--surface,#1a1a1a);border-radius:6px 6px 0 0"><i class="ph ph-file-pdf" style="font-size:2em;color:var(--dim)"></i></div>' }
        slot.innerHTML = ''
        slot.appendChild(img)
        slot.style.display = 'block'
      }
    }, { rootMargin: '300px' })
  }
  container.querySelectorAll('[data-pdf-thumb]:not([data-pdf-init])').forEach(el => {
    el.dataset.pdfInit = '1'
    _pdfThumbObs.observe(el)
  })
}

let _homeCatalogCursor = null
let _homeCatalogLoading = false
let _homeCatalogObserver = null
let _homeCatalogItems = []
let _homeCatalogViewMode = 'grouped'
let _homeCatalogPrices = null

function _classifyType(item) {
  const type = classifyContentType(item.contentType, item.title)
  if (type !== 'other') return type
  if (item.metadataCid) return 'audio'
  return 'unknown'
}

function _renderCatalogCard(item) {
  const title = escapeHtml(item.title || `#${item.id}`)
  const priceDisplay = formatPriceFiatOnly(item.price, _homeCatalogPrices)
  const type = _classifyType(item)
  const artDetailUrl = `/art?media=${item.id}`
  const ipfsCidUrl = item.ipfsCid ? ipfsUrl(item.ipfsCid) : ''
  const artistName = item.artistName || getArtistName(item.artist?.toLowerCase()) || ''

  let coverImgHtml = ''
  if (type === 'pdf' && ipfsCidUrl) {
    coverImgHtml = `<img loading="lazy" src="/api/pdf-thumb?url=${encodeURIComponent(ipfsCidUrl)}" onerror="this.outerHTML='<i class=\\'ph ph-file-pdf\\' style=\\'font-size:3em;color:var(--dim)\\'></i>'">`
  } else if (type === 'video' && ipfsCidUrl) {
    coverImgHtml = `<img loading="lazy" src="/api/video-thumb?cid=${encodeURIComponent(item.ipfsCid)}" onerror="this.outerHTML='<span style=\\'color:var(--dim);font-size:0.7em\\'>video</span>'">`
  } else if (type === 'image' && ipfsCidUrl) {
    coverImgHtml = `<img loading="lazy" src="/api/img?url=${encodeURIComponent(ipfsCidUrl)}&w=400">`
  } else if (item.albumArt) {
    coverImgHtml = `<img loading="lazy" src="/api/img?url=${encodeURIComponent(item.albumArt)}&w=400">`
  } else if (item.metadataCid) {
    coverImgHtml = `<img loading="lazy" src="/api/img?url=${encodeURIComponent(ipfsUrl(item.metadataCid))}&w=400">`
  } else if (item.ipfsCid) {
    coverImgHtml = `<img loading="lazy" src="/api/video-thumb?cid=${encodeURIComponent(item.ipfsCid)}" onerror="this.src='/api/img?url=${encodeURIComponent(ipfsCidUrl)}&w=400';this.onerror=function(){this.outerHTML='<span style=\\'color:var(--dim);font-size:0.7em\\'>${type}</span>'}">`
  } else {
    coverImgHtml = `<span style="color:var(--dim);font-size:0.8em">${type}</span>`
  }

  let artOverlay = ''
  if (type === 'video' && ipfsCidUrl) {
    artOverlay = `<div class="video-lazy works-card-video-overlay" data-src="${ipfsCidUrl}" data-title="${title}"><button class="media-play-overlay media-play-overlay--video works-card-play"><i class="ph ph-play"></i></button></div>`
  } else if (type === 'audio' && ipfsCidUrl) {
    artOverlay = `<button class="track-play-btn media-play-overlay" data-track-src="${ipfsCidUrl}" data-track-title="${title}" data-track-artist="${escapeHtml(artistName)}"><i class="ph ph-play"></i></button>`
  }

  const buyBtn = `<button class="works-buy-btn feed-card-btn green" data-media-id="${item.id}" data-price="${item.price}">buy</button>`
  return `<div class="works-card" data-media-id="${item.id}" data-type="${type}">
    <div class="works-card-art"><a href="${artDetailUrl}" style="display:block;width:100%;height:100%">${coverImgHtml}</a>${artOverlay}</div>
    <div class="works-card-info">
      ${artistName ? `<span class="works-card-artist">${escapeHtml(artistName)}</span>` : ''}
      <a href="${artDetailUrl}" class="works-card-title">${title}</a>
      <div class="works-card-actions">${buyBtn}</div>
    </div>
  </div>`
}

function _renderCatalogAlbumCard(albumId, items) {
  items.sort((a, b) => (a.trackIndex ?? 9999) - (b.trackIndex ?? 9999))
  const first = items[0] || {}
  const albumTitle = first.albumTitle || first.title || 'untitled'
  const albumArtSrc = first.albumArt
    ? `/api/img?url=${encodeURIComponent(first.albumArt)}&w=400`
    : (first.metadataCid ? `/api/img?url=${encodeURIComponent(ipfsUrl(first.metadataCid))}&w=400` : '')
  const trackCount = items.length
  const artistName = first.artistName || getArtistName(first.artist?.toLowerCase()) || ''
  let totalPrice = 0n
  for (const item of items) { try { totalPrice += BigInt(item.price || 0) } catch {} }
  const priceDisplay = formatPriceFiatOnly(totalPrice.toString(), _homeCatalogPrices)
  const mediaIds = items.map(i => i.id).join(',')

  const queueTracks = items.filter(i => i.ipfsCid).map(i => ({
    src: ipfsUrl(i.ipfsCid), title: i.title || '', artist: artistName, art: albumArtSrc
  }))
  const queueData = escapeHtml(encodeURIComponent(JSON.stringify(queueTracks)))
  const playOverlay = queueTracks.length > 0
    ? `<button class="album-play-btn media-play-overlay" data-queue="${queueData}"><i class="ph ph-play"></i></button>`
    : ''
  const coverHtml = albumArtSrc ? `<img loading="lazy" src="${albumArtSrc}" onerror="this.style.display='none'">` : `<span style="color:var(--dim);font-size:0.8em">album</span>`

  return `<div class="works-card works-album-card" data-album-id="${escapeHtml(albumId)}">
    <div class="works-card-art">${coverHtml}
      <span class="works-album-badge">${trackCount} tracks</span>
      ${playOverlay}
    </div>
    <div class="works-card-info">
      ${artistName ? `<span class="works-card-artist">${escapeHtml(artistName)}</span>` : ''}
      <span class="works-card-title">${escapeHtml(albumTitle)}</span>
      <div class="works-card-actions"><button class="works-buy-album-btn feed-card-btn green" data-media-ids="${mediaIds}" data-total-price="${totalPrice.toString()}">buy album</button></div>
    </div>
  </div>`
}

function _renderCatalogGrid(items) {
  if (_homeCatalogViewMode === 'grouped') {
    const albumGroups = new Map()
    const singles = []
    for (const item of items) {
      if (item.albumId) {
        if (!albumGroups.has(item.albumId)) albumGroups.set(item.albumId, [])
        albumGroups.get(item.albumId).push(item)
      } else {
        singles.push(item)
      }
    }
    let html = ''
    for (const [albumId, group] of albumGroups) {
      html += group.length >= 2 ? _renderCatalogAlbumCard(albumId, group) : _renderCatalogCard(group[0])
    }
    for (const item of singles) html += _renderCatalogCard(item)
    return html
  }
  return items.map(i => _renderCatalogCard(i)).join('')
}

async function renderOrgCatalog(rosterEl, orgId, orgType) {
  if (_homeCatalogLoading) return
  _homeCatalogLoading = true

  if (!_homeCatalogPrices) {
    try { _homeCatalogPrices = await getEthPrices() } catch {}
  }

  let catalogEl = document.getElementById('org-home-catalog')
  let sentinel = document.getElementById('org-home-sentinel')

  if (!catalogEl) {
    const wrapper = document.createElement('div')
    wrapper.style.cssText = 'margin:2em 0 3em'
    const title = document.createElement('div')
    title.className = 'roster-title'
    const catLabel = { label: 'catalog', gallery: 'collection', company: 'productions', publisher: 'catalog', collective: 'works' }[orgType] || 'works'
    title.textContent = catLabel

    const toggle = document.createElement('div')
    toggle.id = 'org-catalog-toggle'
    toggle.style.cssText = 'display:flex;gap:0.5ch;margin-bottom:1em;align-items:center'
    toggle.innerHTML = `
      <span style="color:var(--dim);font-size:0.75em;margin-right:0.5ch">view:</span>
      <button class="org-cat-view-btn active" data-mode="grouped" style="background:var(--surface);border:1px solid var(--accent);color:var(--accent);font-family:inherit;font-size:0.8em;padding:0.3em 1ch;cursor:pointer;border-radius:2px">releases</button>
      <button class="org-cat-view-btn" data-mode="individual" style="background:none;border:1px solid var(--border);color:var(--muted);font-family:inherit;font-size:0.8em;padding:0.3em 1ch;cursor:pointer;border-radius:2px">items</button>
    `
    catalogEl = document.createElement('div')
    catalogEl.id = 'org-home-catalog'
    catalogEl.className = 'works-grid'
    sentinel = document.createElement('div')
    sentinel.id = 'org-home-sentinel'
    sentinel.style.height = '1px'
    wrapper.appendChild(title)
    wrapper.appendChild(toggle)
    wrapper.appendChild(catalogEl)
    wrapper.appendChild(sentinel)
    rosterEl.after(wrapper)

    toggle.addEventListener('click', (e) => {
      const btn = e.target.closest('.org-cat-view-btn')
      if (!btn) return
      _homeCatalogViewMode = btn.dataset.mode
      toggle.querySelectorAll('.org-cat-view-btn').forEach(b => {
        const active = b.dataset.mode === _homeCatalogViewMode
        b.style.background = active ? 'var(--surface)' : 'none'
        b.style.borderColor = active ? 'var(--accent)' : 'var(--border)'
        b.style.color = active ? 'var(--accent)' : 'var(--muted)'
        b.classList.toggle('active', active)
      })
      catalogEl.innerHTML = _renderCatalogGrid(_homeCatalogItems)
      _attachCatalogBuyHandlers(catalogEl)
    })
  }

  try {
    const url = `/api/org/${orgId}/catalog?limit=50${_homeCatalogCursor ? `&after=${_homeCatalogCursor}` : ''}`
    const res = await fetch(url)
    if (!res.ok) return
    const data = await res.json()
    const items = data.items || []
    if (!items.length && !_homeCatalogCursor) { catalogEl.innerHTML = '<p style="color:var(--dim);font-size:0.85em">no works yet</p>'; return }

    for (const item of items) {
      const addr = item.artist?.toLowerCase()
      if (item.artistDomain) _homeDomainMap[addr] = item.artistDomain
      if (item.artistName) try { sessionStorage.setItem(`name:${addr}`, item.artistName) } catch {}
      if (item.artistPic) try { sessionStorage.setItem(`pfp:${addr}`, item.artistPic) } catch {}
    }

    annotateRelistings(items)
    const fresh = items.filter(i => !i.superseded && !i.delisted)
    _homeCatalogItems = _homeCatalogItems.concat(fresh)
    catalogEl.innerHTML = _renderCatalogGrid(_homeCatalogItems)
    _attachCatalogBuyHandlers(catalogEl)

    if (data.pageInfo?.hasNextPage) {
      _homeCatalogCursor = data.pageInfo.endCursor
      if (sentinel && !_homeCatalogObserver) {
        _homeCatalogObserver = new IntersectionObserver(entries => {
          if (entries[0].isIntersecting && !_homeCatalogLoading) renderOrgCatalog(rosterEl, orgId, orgType)
        }, { rootMargin: '400px' })
        _homeCatalogObserver.observe(sentinel)
      }
    } else if (_homeCatalogObserver) {
      _homeCatalogObserver.disconnect()
    }
  } catch (e) {
    console.warn('org catalog:', e?.message)
  } finally {
    _homeCatalogLoading = false
  }
}

function _attachCatalogBuyHandlers(container) {
  container.querySelectorAll('.works-buy-btn:not([data-bound])').forEach(btn => {
    btn.dataset.bound = '1'
    btn.addEventListener('click', async () => {
      const mediaId = btn.dataset.mediaId
      const price = btn.dataset.price
      const orig = btn.textContent
      btn.textContent = 'buying...'
      btn.disabled = true
      try {
        const { purchaseMedia } = await import('./media.js')
        await purchaseMedia(BigInt(mediaId), BigInt(price))
        btn.textContent = 'owned'
      } catch (e) {
        btn.textContent = e.message?.includes('rejected') ? orig : 'error'
        btn.disabled = false
        if (!e.message?.includes('rejected')) setTimeout(() => { btn.textContent = orig; btn.disabled = false }, 2000)
      }
    })
  })
  container.querySelectorAll('.works-buy-album-btn:not([data-bound])').forEach(btn => {
    btn.dataset.bound = '1'
    btn.addEventListener('click', async () => {
      const ids = btn.dataset.mediaIds.split(',')
      const totalPrice = btn.dataset.totalPrice || '0'
      const orig = btn.textContent
      btn.textContent = 'buying...'
      btn.disabled = true
      try {
        const { purchaseBatchMedia } = await import('./media.js')
        await purchaseBatchMedia(ids, BigInt(totalPrice))
        btn.textContent = 'owned'
      } catch (e) {
        btn.textContent = e.message?.includes('rejected') ? orig : 'error'
        btn.disabled = false
        if (!e.message?.includes('rejected')) setTimeout(() => { btn.textContent = orig; btn.disabled = false }, 2000)
      }
    })
  })
}

let _homeDomainMap = {}

// auto-init badges on page load
if (document.getElementById('owner-badges')) {
  renderOwnerBadges()
}
if (document.getElementById('org-roster')) {
  renderOrgRoster()
}

// re-init badges on SPA navigation
window.addEventListener('spa-navigate', () => {
  if (document.getElementById('owner-badges')) renderOwnerBadges()
  if (document.getElementById('org-roster')) renderOrgRoster()
})
