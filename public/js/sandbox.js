// /design sandbox mode.
//
// Flips when the page is loaded with `?sandbox=1`. In sandbox mode:
//
//   1. A red bar is pinned to the top of the page: SANDBOX — test
//      ethereum, no real value. Non-dismissable so the operator never
//      forgets they're in a dry-run.
//
//   2. Every fetch to `/api/rpc/<chainId>` gets `?fork=anvil` appended.
//      The server-side RPC proxy picks that up and routes requests to
//      the locally-running anvil fork (http://localhost:8545) instead
//      of Alchemy mainnet. Addresses stay unchanged — anvil forks the
//      optimism mainnet state at a recent block, so every real contract
//      is at its real address, just living on a disposable chain.
//
//   3. A burner wallet is minted per visitor on page load, pre-funded
//      via anvil cheat codes (see scripts/sandbox-seed.js). The private
//      key is stored in sessionStorage so refreshes keep the same
//      wallet.
//
// Sandbox mode is additive — every file that imports from here keeps
// working with `isSandbox() === false`. Nothing in production ever
// flips this on; the server also refuses `?fork=anvil` outside of
// development mode.
//
// Keep this module import-safe (no top-level side effects) so pages
// that don't call initSandbox() aren't affected.

const SANDBOX_FORK_URL = 'http://localhost:8545'
const SANDBOX_WALLET_KEY = 'praxis.sandbox.burnerPk'
const SANDBOX_SEED_URL = '/api/sandbox-seed'

let _initialized = false
let _seed = null

export function isSandbox() {
  try {
    const q = new URLSearchParams(window.location.search)
    return q.get('sandbox') === '1'
  } catch { return false }
}

// Pin a non-dismissable banner. Visible on every scroll position so the
// operator can't miss what they're in. Deliberately lowercase to match
// the rest of Praxis voice.
function mountBanner() {
  if (document.getElementById('sandbox-banner')) return
  const bar = document.createElement('div')
  bar.id = 'sandbox-banner'
  bar.setAttribute('role', 'status')
  bar.textContent = 'sandbox — test ethereum, no real value'
  Object.assign(bar.style, {
    position: 'fixed', top: '0', left: '0', right: '0',
    zIndex: '9999',
    background: '#b91c1c', color: '#fff',
    textAlign: 'center',
    padding: '0.5em 1em',
    fontSize: '0.85em',
    fontWeight: '600',
    letterSpacing: '0.03em',
    fontFamily: 'inherit',
    boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
    pointerEvents: 'none',
  })
  document.body.appendChild(bar)
  // Push the page content down so the banner doesn't cover the header.
  document.body.style.paddingTop = '2em'
}

// Rewrite /api/rpc/<n> fetches to append ?fork=anvil. The server-side
// proxy at server.js:2641 reads this param and, in development, points
// the upstream URL at SANDBOX_FORK_URL instead of Alchemy.
function patchFetchForFork() {
  if (window.__praxisSandboxFetchPatched) return
  window.__praxisSandboxFetchPatched = true
  const origFetch = window.fetch.bind(window)
  window.fetch = function sandboxFetch(input, init) {
    try {
      let url = typeof input === 'string' ? input : (input?.url || '')
      if (url && url.startsWith('/api/rpc/')) {
        const sep = url.includes('?') ? '&' : '?'
        const rewritten = `${url}${sep}fork=anvil`
        if (typeof input === 'string') return origFetch(rewritten, init)
        return origFetch(new Request(rewritten, input), init)
      }
    } catch {}
    return origFetch(input, init)
  }
}

// Fetch the operator's seed file. If the file is missing, we return
// null and surface the error in the catalog — the operator needs to
// run scripts/sandbox-seed.js first.
async function loadSeed() {
  try {
    const r = await fetch(SANDBOX_SEED_URL, { cache: 'no-store' })
    if (!r.ok) return null
    const data = await r.json()
    _seed = data
    return data
  } catch { return null }
}

export function getSandboxSeed() { return _seed }

// Returns {privateKey, address} for the current session's burner.
// Minted once per browser tab (sessionStorage), so a refresh keeps the
// same wallet and anvil balance.
export async function getSandboxWallet() {
  let pk = null
  try { pk = sessionStorage.getItem(SANDBOX_WALLET_KEY) } catch {}
  if (!pk) {
    const buf = new Uint8Array(32)
    crypto.getRandomValues(buf)
    pk = '0x' + Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('')
    try { sessionStorage.setItem(SANDBOX_WALLET_KEY, pk) } catch {}
    // Immediately fund the burner via anvil cheat codes so the first
    // tx has gas and a USDC balance. If the fork isn't reachable we
    // just log and continue — the catalog will show a clear error
    // when the modal eventually tries to use it.
    try { await fundBurner(pk) } catch (e) { console.warn('[sandbox] fund failed:', e?.message) }
  }
  const vendor = await import('./vendor.js')
  const account = vendor.privateKeyToAccount(pk)
  return { privateKey: pk, address: account.address, account }
}

// Call anvil cheats to pre-fund the burner wallet. Idempotent — if the
// balance is already set, this is a no-op from anvil's perspective.
// Uses the fork proxy path so dev mode doesn't need a direct connection.
async function fundBurner(pk) {
  const vendor = await import('./vendor.js')
  const account = vendor.privateKeyToAccount(pk)
  const addr = account.address
  // 10 ETH
  const tenEth = '0x8ac7230489e80000'
  await rpc('anvil_setBalance', [addr, tenEth])
  // 1000 USDC — storage slot write. Operator seed script computes the
  // slot; here we fall back to re-requesting from the seed file.
  const seed = _seed || await loadSeed()
  if (seed?.usdcGrant?.slot) {
    const slot = seed.usdcGrant.slotForAddress?.(addr) || seed.usdcGrant.slot
    const value = seed.usdcGrant.value
    try { await rpc('anvil_setStorageAt', [seed.usdcAddr, slot, value]) } catch {}
  }
}

async function rpc(method, params) {
  const r = await fetch('/api/rpc/10', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  if (!r.ok) throw new Error(`rpc ${method} ${r.status}`)
  const j = await r.json()
  if (j.error) throw new Error(`rpc ${method}: ${j.error.message}`)
  return j.result
}

// Enter sandbox mode: patches fetch, mounts the banner, loads the
// seed file. Safe to call more than once — subsequent calls no-op.
export async function initSandbox() {
  if (_initialized) return
  _initialized = true
  patchFetchForFork()
  mountBanner()
  await loadSeed()
  // Mint the burner lazily so the page isn't blocked on anvil.
  getSandboxWallet().catch(() => {})
}
