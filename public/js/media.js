// PraxisMedia — list, purchase, and manage media on-chain
import { F } from './fragments.js'
import { createWalletClient, custom, formatEther, parseEther } from './vendor.js'
import { optimism } from './vendor.js'
import { query } from './ponder.js'
import { ipfsUrl, escapeHtml, ensureWallet, ensureFundsForPurchase, formatTxError, getPublicClient , getWalletProvider } from './utils.js'
import { t } from './i18n.js'

import { MEDIA_ABI, getMediaAddress } from './contracts.js'

// getPublicClient imported from utils.js

// Create wallet client on demand — must be called AFTER ensureAuthorized
// so window.ethereum is the correct provider (embedded or MetaMask).
// Not cached because provider can change between calls.
function getWalletClient() {
  return createWalletClient({ chain: optimism, transport: custom(getWalletProvider()) })
}

// --- Exported contract interactions ---

export async function listMedia(title, ipfsCid, metadataCid, price, maxSupply, collaborators, splits) {
  const address = getMediaAddress()
  if (!address) throw new Error('media contract not configured')

  const addr = await ensureWallet()
  if (!addr) throw new Error(t('status.connectWallet'))
  await window.ensureOptimism?.()

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
    try { return log.topics[0] === '0x4d24da2b70562743cabea6cd760eed0904274271969048edfc6f65e0b556d038' } catch { return false }
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
  await window.ensureOptimism?.()

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

  const BATCH_MAX = 20
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
    const listedTopic = '0x4d24da2b70562743cabea6cd760eed0904274271969048edfc6f65e0b556d038'
    const batchIds = receipt.logs
      .filter(log => { try { return log.topics[0] === listedTopic } catch { return false } })
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

  const BATCH_MAX = 20

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
  await window.ensureOptimism?.()
  const { parseEther } = await import('./vendor.js')
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
  await window.ensureOptimism?.()
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
    : [BigInt(mediaId), 2n ** 128n] // price so high it's effectively unpurchasable
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
  await window.ensureOptimism?.()

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

export async function getPendingWithdrawals(addr) {
  const address = getMediaAddress()
  if (!address) return 0n
  const pc = await getPublicClient()
  return await pc.readContract({ address, abi: MEDIA_ABI, functionName: 'pendingWithdrawals', args: [addr] })
}

// --- Owner badges ---

export async function renderOwnerBadges() {
  const el = document.getElementById('owner-badges')
  if (!el) return

  const ownerAddr = document.body.dataset.owner
  if (!ownerAddr) return

  try {
    const parts = []

    // query media count from Ponder
    const mediaAddress = getMediaAddress()
    if (mediaAddress) {
      try {
        const mediaData = await query(`
          query OwnerMedia($artist: String!) {
            mediaListings(where: { artist: $artist }, limit: 200) {
              items { id ipfsCid }
            }
          }
        `, { artist: ownerAddr.toLowerCase() })
        // Dedup by ipfsCid (same content listed multiple times counts as 1 work)
        const allListings = mediaData.mediaListings?.items || []
        const uniqueCids = new Set(allListings.map(l => l.ipfsCid).filter(Boolean))
        const mediaCount = uniqueCids.size || allListings.length
        if (mediaCount > 0) {
          parts.push(`<a href="/works" style="color:var(--muted);text-decoration:none;border-bottom:1px solid var(--border)">${mediaCount} ${mediaCount === 1 ? t('badges.work') : t('badges.works')}</a>`)
        }
      } catch (e) {
        console.warn('badges media query error:', e)
      }
    }

    // query credentials from Ponder (CONTRIBUTOR=3, PRODUCER=2)
    try {
      const credData = await query(`
        query OwnerCreds($holder: String!) {
          contributors: credentials(where: { holder: $holder, tokenType: 3 }, limit: 1) {
            totalCount
          }
          producers: credentials(where: { holder: $holder, tokenType: 2 }, limit: 1) {
            totalCount
          }
        }
      `, { holder: ownerAddr.toLowerCase() })

      const contributorCount = credData.contributors?.totalCount || 0
      const producerCount = credData.producers?.totalCount || 0

      if (contributorCount > 0) {
        parts.push(`<a href="/collection?tab=credentials" style="color:var(--muted);text-decoration:none;border-bottom:1px solid var(--border)">${contributorCount} ${t('badges.completed')}</a>`)
      }
      if (producerCount > 0) {
        parts.push(`<a href="/collection?tab=credentials" style="color:var(--muted);text-decoration:none;border-bottom:1px solid var(--border)">${producerCount} ${t('badges.produced')}</a>`)
      }
    } catch (e) {
      console.warn('badges credentials query error:', e)
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
    const orgs = await res.json()
    if (!orgs?.length) { el.innerHTML = ''; return }

    const orgId = orgs[0]
    const orgRes = await fetch(`/api/org/${orgId}`)
    if (!orgRes.ok) return
    const org = await orgRes.json()
    if (!org.members?.length) { el.innerHTML = ''; return }

    const addrs = org.members.map(m => m.wallet || m)
    let domainMap = {}
    try {
      const r = await fetch('/api/artists/resolve', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ addresses: addrs }),
      })
      if (r.ok) domainMap = await r.json()
    } catch {}

    el.innerHTML = `
      <div class="roster-title">roster</div>
      <div class="roster-grid">
        ${addrs.map(a => {
          const w = a.toLowerCase()
          const domain = domainMap[w]
          const display = domain ? escapeHtml(domain) : `${w.slice(0, 6)}...${w.slice(-4)}`
          const href = domain ? `https://${escapeHtml(domain)}` : '#'
          return `<a href="${href}" class="roster-card" target="_blank">
            <div class="roster-name">${display}</div>
            <div class="roster-domain">${w.slice(0, 10)}...</div>
          </a>`
        }).join('')}
      </div>
    `
  } catch (e) {
    console.warn('org roster:', e?.message)
  }
}

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
