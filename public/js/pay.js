import { createPublicClient, createWalletClient, custom, parseEther, encodeFunctionData, http } from './vendor.js'
import { optimism } from './vendor.js'
import { showOnrampModal, showOfframpModal } from './ramp.js'
import { getWalletProvider } from './utils.js'

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
  { chainId: 10, name: 'Optimism', icon: 'O' },
  { chainId: 137, name: 'Polygon', icon: 'P' },
  { chainId: 324, name: 'zkSync Era', icon: 'Z' },
]

const FIAT_METHODS = [
  { id: 'wise', label: 'Wise', icon: 'ph-arrows-left-right' },
  { id: 'revolut', label: 'Revolut', icon: 'ph-currency-circle-dollar' },
  { id: 'cashapp', label: 'Cash App', icon: 'ph-currency-dollar' },
  // Venmo requires taker registration (per zkp2p team) — skipped until supported
  // PayPal, Zelle hidden until Reclaim provider IDs are set up
]

const OPTIMISM_CHAIN_ID = 10

async function onramp(address, amount) {
  return showOnrampModal(address, amount)
}

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

  function cleanup(result) {
    if (_destroyed) return
    _destroyed = true
    overlay.remove()
    if (_resolve) _resolve(result)
  }

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) cleanup(false)
  })

  document.addEventListener('keydown', function escHandler(e) {
    if (e.key === 'Escape') {
      cleanup(false)
      document.removeEventListener('keydown', escHandler)
    }
  })

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
      const valueAttr = balEth.toFixed(4).replace(/\.?0+$/, '')
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
        const chainId = parseInt(btn.dataset.chainId)
        const chainName = FUNDING_CHAINS.find(c => c.chainId === chainId)?.name || 'chain'
        const amtInput = dialog.querySelector(`.funding-bridge-amt[data-chain-id="${chainId}"]`)
        const amtEth = parseFloat(amtInput?.value || '0')
        if (isNaN(amtEth) || amtEth <= 0) {
          _bridgeState = { phase: 'error', chainId, message: 'enter a valid amount' }
          renderSheet()
          setTimeout(() => { _bridgeState = null; renderSheet() }, 2000)
          return
        }
        const maxBal = BigInt(amtInput?.dataset.max || '0')
        const amtWei = BigInt(Math.floor(amtEth * 1e18))
        if (amtWei > maxBal) {
          _bridgeState = { phase: 'error', chainId, message: 'amount exceeds balance' }
          renderSheet()
          setTimeout(() => { _bridgeState = null; renderSheet() }, 2000)
          return
        }
        console.log('[funding-sheet] bridging', { chainId, address, amtWei: amtWei.toString(), amtEth })
        _bridgeState = { phase: 'pending', chainId, message: `getting quote for ${amtEth} ETH from ${chainName}…` }
        renderSheet()
        try {
          const { bridgeToOptimism } = await import('./relay-bridge.js')
          await bridgeToOptimism(chainId, address, amtWei, (msg) => {
            if (_destroyed) return
            _bridgeState = { phase: 'pending', chainId, message: msg }
            renderSheet()
          })
          _bridgeState = { phase: 'success', chainId, message: `bridged ${amtEth} ETH to Optimism — funds will appear shortly` }
          renderSheet()
          // Refresh balances after success
          try {
            const { getMultichainBalances, getCachedBalance } = await import('./relay-bridge.js')
            chainBalances = await getMultichainBalances(address)
            const optimismEntry = chainBalances.find(b => b.chainId === OPTIMISM_CHAIN_ID)
            if (optimismEntry) optimismBalance = optimismEntry.balance
            renderSheet()
          } catch {}
        } catch (e) {
          console.error('[funding-sheet] bridge failed:', e)
          const errMsg = e?.shortMessage || e?.message || 'bridge failed'
          _bridgeState = { phase: 'error', chainId, message: errMsg }
          renderSheet()
        }
      })
    })
    dialog.querySelectorAll('.funding-fiat-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        cleanup(false)
        try { await showOnrampModal(address, 20) } catch {}
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
      await window.ensureOptimism?.()
      hash = await walletClient.sendTransaction({
        account: payAccount,
        to: recipient,
        value: parseEther(price),
      })
    } else {
      await window.ensureOptimism?.()
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
