import { createPublicClient, createWalletClient, custom, parseEther, encodeFunctionData, http } from './vendor.js'
import { optimism } from './vendor.js'
import { showOnrampModal, showOfframpModal } from './ramp.js'
import { getWalletProvider, escapeHtml } from './utils.js'
import { getEthPrices } from './fiat.js'
import { t } from './i18n.js'

const ERC20_ABI = [
  {
    name: 'transfer',
    type: 'function',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    name: 'balanceOf',
    type: 'function',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
]

const publicClient = createPublicClient({
  chain: optimism,
  transport: http(),
})

// Chain metadata for the funding sheet — includes Optimism (destination) + all bridge sources
const FUNDING_CHAINS = [
  { chainId: 10, name: 'Optimism', icon: 'O' },
  { chainId: 1, name: 'Ethereum', icon: 'E' },
  { chainId: 42161, name: 'Arbitrum', icon: 'A' },
  { chainId: 8453, name: 'Base', icon: 'B' },
  { chainId: 137, name: 'Polygon', icon: 'P' },
  { chainId: 324, name: 'zkSync Era', icon: 'Z' },
]

const FIAT_METHODS = [
  { id: 'stripe', label: 'Card / Apple Pay', icon: 'ph-credit-card' },
  // Peer methods disabled until finalized
  // { id: 'wise', label: 'Wise', icon: 'ph-arrows-left-right' },
  // { id: 'revolut', label: 'Revolut', icon: 'ph-currency-circle-dollar' },
  // { id: 'cashapp', label: 'Cash App', icon: 'ph-currency-dollar' },
]

const OPTIMISM_CHAIN_ID = 10
const GAS_BUFFER_FACTOR = 1.25
const GAS_RESERVE_ETH = 0.001
const ETH_USD_FALLBACK = 2500
const BRIDGE_POLL_DELAYS = [3000, 8000, 15000, 30000, 60000]

// Optimism onramp for deploy payments — native modal + auto Relay bridge Base->Optimism
async function onrampOptimism(address, amountUsd) {
  return showOnrampModal(address, amountUsd)
}

// Offramp: native modal — Relay bridge Optimism->Base, then zkp2p sell on Base
async function offrampOptimism(address, amountEth) {
  return showOfframpModal(address, amountEth)
}

// expose for deploy flow and claim flow
window.peerOnrampOptimism = onrampOptimism
window.peerOfframpOptimism = offrampOptimism

async function checkBalance(address, currency, priceRaw) {
  try {
    if (currency === 'ETH') {
      const balance = await publicClient.getBalance({ address })
      return balance >= parseEther(priceRaw)
    }
    const balance = await publicClient.readContract({
      address: currency,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [address],
    })
    return balance >= BigInt(priceRaw)
  } catch {
    return true // if balance check fails, let the tx attempt proceed
  }
}

// --- Purchase confirmation modal ---
// Shows item, price, confirm/cancel. Handles funding if needed.
export async function showPurchaseConfirmation(mediaId, priceWei, title, opts = {}) {
  const overlay = document.createElement('div')
  overlay.className = 'wizard-overlay'
  overlay.style.cssText = 'z-index:10001;align-items:center;justify-content:center'
  // Two-column wrapper: item details left, stripe right (stacks on mobile)
  const wrapper = document.createElement('div')
  wrapper.className = 'purchase-wrapper'
  wrapper.style.cssText = 'display:flex;gap:2.5em;max-width:440px;width:100%;padding:2em;align-items:flex-start'
  const dialog = document.createElement('div')
  dialog.style.cssText = 'width:100%;flex:1;min-width:0'

  const priceEth = (Number(BigInt(priceWei)) / 1e18).toFixed(4)
  let fiatStr = ''
  let _fiatRate = 0, _fiatCurrency = 'usd', _formatFiat = null
  try {
    const prices = await getEthPrices()
    const fiatMod = await import('./fiat.js')
    _formatFiat = fiatMod.formatFiat
    _fiatCurrency = fiatMod.getUserCurrency()
    _fiatRate = prices?.[_fiatCurrency] || prices?.usd || 0
    if (_fiatRate) fiatStr = _formatFiat(parseFloat(priceEth) * _fiatRate, _fiatCurrency)
  } catch {}

  // Check balance proactively
  let balance = 0n
  let needsFunding = false
  try {
    const addr = window.getWalletAddress?.()
    if (addr) {
      balance = await publicClient.getBalance({ address: addr })
      needsFunding = balance < BigInt(priceWei)
    }
  } catch {}
  const balEth = (Number(balance) / 1e18).toFixed(4)
  const balFiat = (_fiatRate && _formatFiat) ? _formatFiat(parseFloat(balEth) * _fiatRate, _fiatCurrency) : ''
  const shortfallWei = needsFunding ? BigInt(priceWei) - balance : 0n
  const shortfallEth = Number(shortfallWei) / 1e18
  const shortfallUsd = _fiatRate ? Math.ceil(shortfallEth * _fiatRate * GAS_BUFFER_FACTOR) : 0 // 25% buffer for gas + bridge fees
  const shortfallFiat = (_fiatRate && _formatFiat) ? _formatFiat(shortfallEth * _fiatRate, _fiatCurrency) : ''

  // Find artwork — check feed card (listed or collected), art detail page, or fallback
  const firstId = mediaId.split(',')[0]
  const buyBtn = document.querySelector(`.feed-buy-btn[data-media-id="${mediaId}"], .feed-buy-btn[data-media-id="${firstId}"]`)
  const feedCard = buyBtn?.closest('.feed-media-card') || buyBtn?.closest('.feed-collected-card')
  const feedArt = feedCard?.querySelector('.feed-media-card-art img, .feed-collected-art-wrap img')
  const worksArt = document.querySelector(`.works-card[data-media-id="${firstId}"] .works-card-art img`)
  const pageArt = document.querySelector('#art-content img, .art-cover img, [id="art-loading"] ~ * img')
  // Also check video elements and video thumbnails
  const feedVideo = feedCard?.querySelector('video')
  const videoThumb = feedVideo?.poster || feedVideo?.getAttribute('data-poster') || ''
  const artSrc = feedArt?.src || worksArt?.src || pageArt?.src || videoThumb || opts.artSrc || ''

  dialog.innerHTML = `
    ${artSrc ? `<div style="margin:0 0 1.25em;overflow:hidden;display:flex;justify-content:center;border-radius:6px"><img src="${escapeHtml(artSrc)}" style="max-width:100%;max-height:300px;object-fit:contain;display:block"></div>` : ''}
    <h3 style="color:var(--accent);margin:0 0 0.5em;font-size:1.1em">${escapeHtml(title)}</h3>
    <p style="color:var(--dim);font-size:0.8em;margin:0 0 1.25em;line-height:1.5">${t('pay.desc')}</p>
    <div style="display:flex;justify-content:space-between;align-items:center;padding:0.75em 0;border-top:1px solid var(--border);border-bottom:1px solid var(--border)">
      <span style="color:var(--muted);font-size:0.9em">${t('pay.price')}</span>
      <div style="text-align:right">
        <div style="color:var(--fg);font-size:1.1em;font-weight:600">${fiatStr || priceEth + ' ETH'}</div>
        <div style="color:var(--dim);font-size:0.8em">${priceEth} ETH</div>
      </div>
    </div>
    <div style="margin-top:1em;padding:0.75em;border:1px solid var(--border);font-size:0.85em">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span style="color:var(--muted)">${t('pay.balance')}</span>
        <div style="text-align:right">
          <div style="color:var(--fg)">${balFiat || balEth + ' ETH'}</div>
          <div style="color:var(--dim);font-size:0.8em">${balEth} ETH</div>
        </div>
      </div>
    </div>
    ${needsFunding ? `
    <div style="margin-top:1.5em;text-align:center">
      <div style="color:var(--muted);font-size:0.8em;margin-bottom:0.75em">select amount to add</div>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:0.5em">
        <button class="purchase-amount-btn selected" data-amount="${shortfallUsd}">${shortfallFiat || '$' + shortfallUsd}</button>
        <button class="purchase-amount-btn" data-amount="10">$10</button>
        <button class="purchase-amount-btn" data-amount="25">$25</button>
        <button class="purchase-amount-btn" data-amount="50">$50</button>
      </div>
      <button class="purchase-continue-btn" data-amount="${shortfallUsd}" style="width:100%;margin-top:1em;background:var(--accent);color:var(--bg);border:none;font-family:inherit;font-size:1em;padding:0.75em 1em;cursor:pointer;font-weight:600;border-radius:6px">add funds + buy</button>
      <p style="color:var(--dim);font-size:0.7em;text-align:center;margin-top:0.75em;line-height:1.5">${t('pay.balanceDesc')}</p>
    </div>
    ` : `
    <div style="display:flex;gap:0.75em;margin-top:1.25em">
      <button id="purchase-confirm-btn" style="flex:1;background:var(--accent);color:var(--bg);border:none;font-family:inherit;font-size:0.95em;padding:0.7em 1em;cursor:pointer;font-weight:600">${t('pay.buy')}</button>
      <button id="purchase-cancel-btn" style="background:none;border:1px solid var(--border);color:var(--muted);font-family:inherit;font-size:0.9em;padding:0.7em 1em;cursor:pointer">${t('pay.cancel')}</button>
    </div>`}
    ${needsFunding ? `<button id="purchase-cancel-btn" style="width:100%;background:none;border:1px solid var(--border);color:var(--muted);font-family:inherit;font-size:0.85em;padding:0.5em 1em;cursor:pointer;margin-top:0.75em">${t('pay.cancel')}</button>` : ''}
    <p id="purchase-status" style="color:var(--muted);font-size:0.85em;margin-top:0.75em;min-height:1.2em"></p>
  `
  wrapper.appendChild(dialog)
  overlay.appendChild(wrapper)
  document.body.appendChild(overlay)

  const cleanup = () => {
    sessionStorage.removeItem('praxis-pending-purchase')
    overlay.classList.add('closing')
    overlay.addEventListener('animationend', () => overlay.remove(), { once: true })
  }
  // Close button top-right
  const closeBtn = document.createElement('button')
  closeBtn.className = 'wizard-close'
  closeBtn.textContent = '\u00d7'
  closeBtn.addEventListener('click', cleanup)
  overlay.appendChild(closeBtn)
  dialog.querySelector('#purchase-cancel-btn').addEventListener('click', cleanup)

  // Wire amount buttons (funding path) or confirm button (sufficient balance path)
  async function loadStripeOnramp(amountUsd) {
    const status = dialog.querySelector('#purchase-status')
    // Disable all amount buttons
    status.textContent = t('pay.redirecting')
    try {
      const addr = window.getWalletAddress?.()
      if (!addr) { status.textContent = t('pay.signInFirst'); return }

      // Save purchase intent so we can auto-complete after funding
      const usdNeeded = Math.min(500, Math.max(10, amountUsd))
      sessionStorage.setItem('praxis-pending-purchase', JSON.stringify({ mediaId, priceWei: String(priceWei), title }))

      // Redirect to ourpraxis.network/fund (Stripe Link/WebAuthn needs consistent domain)
      const returnUrl = window.location.href.split('?')[0] + '?funded=1'
      // Find artwork to show on the fund page
      const feedArt = document.querySelector(`.feed-buy-btn[data-media-id="${mediaId}"]`)?.closest('.feed-media-card')?.querySelector('.feed-media-card-art img')
      const pageArt = document.querySelector('#art-content img, .art-cover img, [id="art-loading"] ~ * img')
      const artParam = feedArt?.src || pageArt?.src || ''
      let fundUrl = `https://ourpraxis.network/fund?wallet=${encodeURIComponent(addr)}&amount=${usdNeeded}&return=${encodeURIComponent(returnUrl)}&title=${encodeURIComponent(title)}`
      if (artParam) fundUrl += `&art=${encodeURIComponent(artParam)}`
      window.location.href = fundUrl
    } catch (e) {
      status.textContent = e.message?.slice(0, 60) || 'funding failed'
      dialog.querySelectorAll('.purchase-amount-btn').forEach(b => { b.disabled = false; b.style.opacity = '1' })
      const amountBtnRow = dialog.querySelector('.purchase-amount-btn')?.parentElement
      if (amountBtnRow) amountBtnRow.style.display = ''
    }
  }

  if (needsFunding) {
    let _selectedAmount = shortfallUsd
    // Wire amount selection
    dialog.querySelectorAll('.purchase-amount-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        _selectedAmount = parseInt(btn.dataset.amount)
        dialog.querySelectorAll('.purchase-amount-btn').forEach(b => b.classList.remove('selected'))
        btn.classList.add('selected')
        const contBtn = dialog.querySelector('.purchase-continue-btn')
        if (contBtn) {
          contBtn.dataset.amount = _selectedAmount
          contBtn.textContent = `add $${_selectedAmount} + buy`
        }
      })
    })
    // Wire continue button to load Stripe
    dialog.querySelector('.purchase-continue-btn')?.addEventListener('click', () => {
      loadStripeOnramp(_selectedAmount)
    })
  }

  // Confirm button (sufficient balance path)
  const confirmBtn = dialog.querySelector('#purchase-confirm-btn')
  if (confirmBtn) {
    confirmBtn.addEventListener('click', async () => {
      const status = dialog.querySelector('#purchase-status')
      confirmBtn.disabled = true
      try {
        // Ensure user is authenticated (may show sign-in/create account modal)
        await window.ensureAuthorized?.()
        // Ensure user is registered as supporter (handle selection)
        const { requireUser } = await import('./utils.js')
        await requireUser('purchase')
        // Now show confirming state
        confirmBtn.textContent = t('pay.confirming')
        // One-time approval token — expires in 30s, consumed on first use, non-forgeable nonce
        window._praxisTxApprovalToken = { nonce: crypto.randomUUID(), ts: Date.now(), used: false }
        const ids = String(mediaId).split(',').filter(Boolean)
        if (ids.length > 1) {
          // Album: single batch transaction for all tracks
          const { purchaseBatchMedia } = await import('./media.js')
          await purchaseBatchMedia(ids.map(id => BigInt(id)), priceWei)
        } else {
          const { purchaseMedia } = await import('./media.js')
          await purchaseMedia(mediaId, priceWei)
        }
        confirmBtn.textContent = t('pay.collected')
        confirmBtn.style.background = 'var(--green)'
        confirmBtn.style.color = '#000'
        setTimeout(cleanup, 2000)
      } catch (e) {
        status.textContent = e.code === 4001 ? t('pay.cancelled') : (e.shortMessage || e.message || t('pay.buy')).slice(0, 60)
        confirmBtn.textContent = t('pay.buy')
        confirmBtn.disabled = false
        setTimeout(() => { status.textContent = '' }, 3000)
      }
    })
  }
}

// --- Unified funding bottom sheet ---
// Shows all chain balances + fiat options in a single view.
// Returns a promise that resolves to true (funded) or false (cancelled).

export async function showFundingSheet(address, amountWei, options = {}) {
  const { statusEl } = options
  const neededWei = BigInt(amountWei)
  const neededEth = Number(neededWei) / 1e18
  const neededDisplay = neededEth.toFixed(4).replace(/\.?0+$/, '')

  // create overlay + dialog using existing modal pattern
  const overlay = document.createElement('div')
  overlay.className = 'praxis-modal-overlay funding-sheet-overlay'
  overlay.setAttribute('data-testid', 'funding-sheet-overlay')

  const dialog = document.createElement('div')
  dialog.className = 'praxis-modal-dialog funding-sheet'
  dialog.setAttribute('data-testid', 'funding-sheet')
  overlay.appendChild(dialog)

  let _destroyed = false
  let _resolve = null
  let _bridgeInFlight = false

  function escHandler(e) {
    if (e.key === 'Escape') cleanup(false)
  }

  function cleanup(result) {
    if (_destroyed) return
    _destroyed = true
    document.removeEventListener('keydown', escHandler)
    overlay.remove()
    if (_resolve) _resolve(result)
  }

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) cleanup(false)
  })

  document.addEventListener('keydown', escHandler)

  // Show sheet immediately — load balances async inside
  let chainBalances = []
  let optimismBalance = 0n

  document.body.appendChild(overlay)

  // _bridgeState: null | {phase: 'pending'|'confirming'|'success'|'error', chainId, message, txHash}
  let _bridgeState = null

  // _showAllChains: when false (default), hide chains with zero balance
  let _showAllChains = false

  // Render sheet right away with "..." balances, then update
  function renderSheet(statusMsg, statusClass) {
    // Build chain entries with normalized balances
    const allChains = FUNDING_CHAINS.map(chain => {
      const entry = chainBalances.find(b => b.chainId === chain.chainId)
      const isOptimism = chain.chainId === OPTIMISM_CHAIN_ID
      let balance = 0n
      if (isOptimism) balance = optimismBalance
      else if (entry) balance = typeof entry.balance === 'bigint' ? entry.balance : BigInt(entry.balance || '0')
      return { ...chain, balance, isOptimism }
    })
    const loading = chainBalances.length === 0
    const visibleChains = _showAllChains ? allChains : allChains.filter(c => c.balance > 0n || c.isOptimism)
    const hiddenCount = allChains.length - visibleChains.length

    const chainRows = visibleChains.map(chain => {
      const balEth = Number(chain.balance) / 1e18
      const balDisplay = loading ? '…' : (balEth >= 0.0001 ? balEth.toFixed(4).replace(/\.?0+$/, '') + ' ETH' : '0 ETH')
      const hasFunds = chain.balance > 0n && !chain.isOptimism
      const optimismReady = chain.isOptimism && neededWei > 0n && chain.balance >= neededWei
      const isBridging = _bridgeState?.chainId === chain.chainId && _bridgeState.phase !== 'success' && _bridgeState.phase !== 'error'
      // Show gas-adjusted max as default (conservative estimate — exact calc happens on bridge click)
      const gasReserveEth = chain.chainId === 1 ? 0.005 : (chain.chainId === 137 ? GAS_RESERVE_ETH : GAS_RESERVE_ETH)
      const safeMax = Math.max(0, balEth - gasReserveEth)
      const valueAttr = safeMax >= 0.0001 ? safeMax.toFixed(4).replace(/\.?0+$/, '') : '0'
      const sublabel = chain.isOptimism ? 'your account' : (hasFunds ? 'available to move' : '')
      return `<div class="funding-chain-row${hasFunds || chain.isOptimism ? '' : ' no-balance'}">
        <div class="funding-chain-info">
          <span class="funding-chain-name"><span style="display:inline-block;width:1.4em;text-align:center;color:var(--dim);margin-right:0.4ch">${chain.icon}</span>${chain.name}</span>
          ${sublabel ? `<span style="font-size:0.7em;color:var(--dim);margin-left:0.4ch">${sublabel}</span>` : ''}
        </div>
        <span class="funding-chain-balance${optimismReady ? ' sufficient' : ''}" data-eth-wei="${chain.balance}">${optimismReady ? '✓ ready' : balDisplay}</span>
        ${hasFunds ? `<span style="display:inline-flex;align-items:center;gap:0.3ch">
          <input type="text" class="funding-bridge-amt" data-chain-id="${chain.chainId}" data-max="${chain.balance}" value="${valueAttr}" ${isBridging ? 'disabled' : ''}>
          <button class="funding-bridge-btn" data-chain-id="${chain.chainId}" ${isBridging ? 'disabled' : ''}>${isBridging ? '…' : 'move →'}</button>
        </span>` : ''}
      </div>`
    }).join('')

    // Big primary fiat buttons (fewer cognitive choices for non-crypto users)
    const fiatBtns = FIAT_METHODS.map((m, i) => {
      const primary = i === 0 // first one (Wise) styled as primary
      return `<button class="funding-fiat-btn ${primary ? 'primary' : ''}" data-method="${m.id}"><i class="ph ${m.icon}"></i>${m.label}</button>`
    }).join('')

    // Active bridge progress banner
    let progressHtml = ''
    if (_bridgeState) {
      if (_bridgeState.phase === 'success') {
        progressHtml = `<div class="funding-progress success"><i class="ph ph-check-circle"></i><span>${_bridgeState.message || 'bridge complete'}${_bridgeState.txHash ? ` <a href="https://optimistic.etherscan.io/tx/${_bridgeState.txHash}" target="_blank" rel="noopener" style="color:inherit;text-decoration:underline">view tx</a>` : ''}</span></div>`
      } else if (_bridgeState.phase === 'error') {
        progressHtml = `<div class="funding-progress error"><i class="ph ph-warning-circle"></i><span>${_bridgeState.message || 'bridge failed'}</span></div>`
      } else {
        progressHtml = `<div class="funding-progress"><i class="ph ph-spinner"></i><span>${_bridgeState.message || 'bridging…'}</span></div>`
      }
    } else if (statusMsg) {
      progressHtml = `<div class="funding-progress ${statusClass || ''}">${statusMsg}</div>`
    }

    // Lead with fiat for non-crypto users; bury chain rows under "Already have crypto?"
    dialog.innerHTML = `
      <div class="funding-sheet-header">
        <h3>add funds</h3>
        ${neededWei > 0n ? `<span class="funding-sheet-needed">need ${neededDisplay} ETH</span>` : ''}
      </div>
      ${progressHtml}

      <div class="funding-section-label">buy with cash</div>
      <p class="funding-help">Pay with your existing app — funds arrive in seconds.</p>
      <div class="funding-fiat-grid">${fiatBtns}</div>

      <details class="funding-advanced" ${visibleChains.some(c => c.balance > 0n && !c.isOptimism) ? 'open' : ''}>
        <summary>Already have crypto on another chain?</summary>
        <p class="funding-help" style="margin-top:0.6em">${loading ? 'Checking your wallets…' : (visibleChains.some(c => c.balance > 0n && !c.isOptimism) ? 'We found ETH on these chains. Move it to Optimism to use it here.' : 'No funds detected on other chains.')}</p>
        <div class="funding-chains">${chainRows || '<div class="funding-help" style="text-align:center;padding:0.5em">No balances to show.</div>'}</div>
        ${hiddenCount > 0 ? `<button class="funding-show-all">+ show ${hiddenCount} other chain${hiddenCount === 1 ? '' : 's'}</button>` : ''}
      </details>

      <button class="funding-cancel-btn">${_bridgeState?.phase === 'success' ? 'done' : 'close'}</button>
    `

    // wire up events
    dialog.querySelector('.funding-cancel-btn')?.addEventListener('click', () => cleanup(false))
    dialog.querySelector('.funding-show-all')?.addEventListener('click', () => { _showAllChains = true; renderSheet() })
    dialog.querySelectorAll('.funding-bridge-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (_bridgeInFlight) return
        _bridgeInFlight = true
        btn.disabled = true
        const chainId = parseInt(btn.dataset.chainId)
        const chainName = FUNDING_CHAINS.find(c => c.chainId === chainId)?.name || 'chain'
        const amtInput = dialog.querySelector(`.funding-bridge-amt[data-chain-id="${chainId}"]`)
        const amtEth = parseFloat(amtInput?.value || '0')
        if (isNaN(amtEth) || amtEth <= 0) {
          _bridgeInFlight = false
          _bridgeState = { phase: 'error', chainId, message: 'enter a valid amount' }
          renderSheet()
          setTimeout(() => { _bridgeState = null; renderSheet() }, 2000)
          return
        }
        const maxBal = BigInt(amtInput?.dataset.max || '0')
        let amtWei = BigInt(Math.floor(amtEth * 1e18))
        // Clamp to actual balance (display rounding can overshoot by a few wei)
        if (amtWei > maxBal) amtWei = maxBal
        if (amtWei <= 0n) {
          _bridgeInFlight = false
          _bridgeState = { phase: 'error', chainId, message: 'enter a valid amount' }
          renderSheet()
          setTimeout(() => { _bridgeState = null; renderSheet() }, 2000)
          return
        }
        // Reserve gas when bridging full balance — fetch live gas price for accurate estimate
        let gasReserve = BigInt(GAS_RESERVE_ETH * 1e18) // 0.001 ETH fallback
        try {
          const gasResp = await fetch(`/api/rpc/${chainId}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_gasPrice', params: [] }),
          })
          const gasData = await gasResp.json()
          if (gasData.result) {
            const gasPrice = BigInt(gasData.result)
            gasReserve = gasPrice * 80000n * 3n // 80k gas limit * 3x safety margin
          }
        } catch {}
        let bridgeWei = amtWei
        if (amtWei >= maxBal) {
          bridgeWei = maxBal > gasReserve ? maxBal - gasReserve : maxBal
        }
        console.log('[funding-sheet] bridging', { chainId, address, bridgeWei: bridgeWei.toString(), amtEth })
        _bridgeState = { phase: 'pending', chainId, message: `getting quote for ${amtEth} ETH from ${chainName}…` }
        renderSheet()
        try {
          // Ensure wallet is unlocked before bridge tx
          await window.ensureAuthorized?.()
          const { bridgeToOptimism } = await import('./relay-bridge.js')
          await bridgeToOptimism(chainId, address, bridgeWei, (msg) => {
            if (_destroyed) return
            _bridgeState = { phase: 'pending', chainId, message: msg }
            renderSheet()
          })
          _bridgeState = { phase: 'success', chainId, message: `bridged ${amtEth} ETH to Optimism` }
          renderSheet()
          // Invalidate multichain cache so fresh balance is fetched
          try { sessionStorage.removeItem(`praxis-multichain-${address.toLowerCase()}`) } catch {}
          window.dispatchEvent(new CustomEvent('wallet-balance-changed'))
          // Poll for balance update — bridge funds can take 10-60s to arrive on Optimism
          const { getMultichainBalances } = await import('./relay-bridge.js')
          const refreshDelays = BRIDGE_POLL_DELAYS
          for (const delay of refreshDelays) {
            await new Promise(r => setTimeout(r, delay))
            if (_destroyed) break
            try {
              sessionStorage.removeItem(`praxis-multichain-${address.toLowerCase()}`)
              chainBalances = await getMultichainBalances(address)
              const optimismEntry = chainBalances.find(b => b.chainId === OPTIMISM_CHAIN_ID)
              if (optimismEntry) optimismBalance = optimismEntry.balance
              renderSheet()
              window.dispatchEvent(new CustomEvent('wallet-balance-changed'))
            } catch {}
          }
        } catch (e) {
          console.error('[funding-sheet] bridge failed:', e)
          const errMsg = e?.shortMessage || e?.message || 'bridge failed'
          _bridgeState = { phase: 'error', chainId, message: errMsg }
          renderSheet()
        } finally {
          _bridgeInFlight = false
        }
      })
    })
    dialog.querySelectorAll('.funding-fiat-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const method = btn.dataset.method
        if (method === 'stripe') {
          // Redirect to ourpraxis.network/fund (consistent domain for Stripe Link/WebAuthn)
          try {
            const prices = await getEthPrices()
            const ethUsd = prices?.usd || ETH_USD_FALLBACK
            const neededUsd = Math.min(500, Math.max(10, Math.ceil(neededEth * ethUsd)))
            const returnUrl = window.location.href.split('?')[0] + '?funded=1'
            // Save a generic funding intent (no specific media purchase)
            sessionStorage.setItem('praxis-pending-purchase', JSON.stringify({ type: 'fund-only' }))
            window.location.href = `https://ourpraxis.network/fund?wallet=${encodeURIComponent(address)}&amount=${neededUsd}&return=${encodeURIComponent(returnUrl)}&title=${encodeURIComponent('add funds')}`
            return
          } catch (e) {
            btn.textContent = 'Card / Apple Pay'
            btn.disabled = false
          }
        } else {
          cleanup(false)
          try { await showOnrampModal(address, 20) } catch {}
        }
      })
    })
  }

  // Initial render with empty balances
  renderSheet()

  // Load balances async then re-render
  try {
    const { getMultichainBalances } = await import('./relay-bridge.js')
    const balances = await getMultichainBalances(address)
    chainBalances = balances
    const optimismEntry = balances.find(b => b.chainId === OPTIMISM_CHAIN_ID)
    optimismBalance = optimismEntry ? optimismEntry.balance : 0n
  } catch (e) {
    console.warn('[funding-sheet] balance check failed:', e?.message)
  }

  if (optimismBalance === 0n) {
    try {
      const { getCachedBalance } = await import('./utils.js')
      optimismBalance = await getCachedBalance(address)
    } catch {}
  }

  if (_destroyed) return false
  renderSheet()

  // check if already funded (Optimism balance is sufficient) — only if a specific amount was requested
  if (neededWei > 0n && optimismBalance >= neededWei) {
    cleanup(true)
    return true
  }

  renderSheet('', '')

  return new Promise((resolve) => {
    _resolve = resolve
  })
}

// expose globally for ensureFundsForPurchase
window.showFundingSheet = showFundingSheet

async function buyItem(button) {
  const address = window.getWalletAddress()
  if (!address) {
    await window.connectWallet()
    if (!window.getWalletAddress()) return
  }

  const { id, price, currency, recipient } = button.dataset
  if (!recipient) {
    button.textContent = 'no recipient set'
    return
  }

  button.disabled = true
  button.textContent = 'checking balance...'

  const hasEnough = await checkBalance(address, currency, price)

  if (!hasEnough) {
    button.textContent = 'funding wallet...'
    const funded = await showFundingSheet(address, price)
    if (!funded) {
      button.textContent = 'buy'
      button.disabled = false
      return
    }
  }

  button.textContent = 'confirming...'

  try {
    const payAccount = await window.ensureAuthorized?.() || window.getWalletAddress()
    const walletClient = createWalletClient({
      chain: optimism,
      transport: custom(getWalletProvider()),
    })

    let hash

    if (currency === 'ETH') {
      if (!await window.ensureOptimism?.()) return
      hash = await walletClient.sendTransaction({
        account: payAccount,
        to: recipient,
        value: parseEther(price),
      })
    } else {
      if (!await window.ensureOptimism?.()) return
      hash = await walletClient.sendTransaction({
        account: payAccount,
        to: currency,
        data: encodeFunctionData({
          abi: ERC20_ABI,
          functionName: 'transfer',
          args: [recipient, BigInt(price)],
        }),
      })
    }

    button.textContent = `tx: ${hash.slice(0, 10)}...`
    button.title = hash
  } catch (e) {
    button.textContent = e.code === 4001 ? 'cancelled' : 'error'
    setTimeout(() => {
      button.textContent = 'buy'
      button.disabled = false
    }, 2000)
  }
}

// bind buy buttons via event delegation (works with SPA navigation + lazy loading)
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.buy-btn[data-id]')
  if (btn) buyItem(btn)
})
