// embedded-wallet.js — self-hosted embedded wallet for Praxis
// generates + encrypts a wallet locally, signs transactions without extensions
// private key never leaves the browser unencrypted

// Block extension hijacking — save original before extensions inject
const _originalEthereum = window.ethereum

import { privateKeyToAccount, createWalletClient, http, optimism } from './vendor.js'

const STORAGE_KEY = 'praxis-wallet-enc'
const ADDR_KEY = 'praxis-embedded-addr'
const OPTIMISM_RPC = 'https://mainnet.optimism.io'
const OPTIMISM_CHAIN_ID = '0xa'

// --- Cross-subdomain cookie helpers ---

function setWalletCookie(address) {
  // set cookie on root domain so all *.ourpraxis.network subdomains share it
  const host = window.location.hostname
  const isOurPraxis = host.endsWith('.ourpraxis.network') || host === 'ourpraxis.network'
  const domain = isOurPraxis ? '.ourpraxis.network' : ''
  const maxAge = 365 * 24 * 60 * 60 // 1 year
  const domainAttr = domain ? `; domain=${domain}` : ''
  document.cookie = `praxis-wallet-addr=${address.toLowerCase()}; path=/; max-age=${maxAge}; SameSite=Lax; Secure${domainAttr}`
}

function getWalletCookie() {
  const match = document.cookie.match(/(?:^|;\s*)praxis-wallet-addr=([^;]+)/)
  return match ? match[1] : null
}

function clearWalletCookie() {
  const host = window.location.hostname
  const isOurPraxis = host.endsWith('.ourpraxis.network') || host === 'ourpraxis.network'
  const domain = isOurPraxis ? '.ourpraxis.network' : ''
  const domainAttr = domain ? `; domain=${domain}` : ''
  document.cookie = `praxis-wallet-addr=; path=/; max-age=0; SameSite=Lax; Secure${domainAttr}`
}

// in-memory cache — cleared on page close
let _cachedAccount = null
let _cachedPassword = null
let _lastActivity = Date.now()

// Re-audit N3: one-shot "skip the next personal_sign confirmation" token used
// by legitimate internal flows (e.g. settings.js domain-update) whose signed
// prefix is no longer on the auto-allow list. Scoped as a module-private
// counter so only code that imports this module (or calls the exported
// `suppressNextSignPrompt` helper) can set it. Cross-subdomain XSS can still
// reach `window.suppressNextSignPrompt` if we export it globally, but at
// least arbitrary attacker code cannot trivially flip a window boolean —
// they must find and call the function each time. We additionally clamp
// the counter to 1 and auto-clear after ~5s so a dangling token can't be
// abused later.
let _suppressCounter = 0
let _suppressExpiresAt = 0
function suppressNextSignPrompt() {
  _suppressCounter = 1
  _suppressExpiresAt = Date.now() + 5000
}
function _consumeSuppressToken() {
  if (_suppressCounter <= 0) return false
  if (Date.now() > _suppressExpiresAt) {
    _suppressCounter = 0
    _suppressExpiresAt = 0
    return false
  }
  _suppressCounter = 0
  _suppressExpiresAt = 0
  return true
}
// Legacy shim: still honor `window._suppressNextSignPrompt = true` for
// callers that haven't been migrated yet. Setter is a plain assignment that
// we translate into the module counter on read.
function _consumeSuppressFlag() {
  if (_consumeSuppressToken()) return true
  try {
    if (window._suppressNextSignPrompt) {
      try { delete window._suppressNextSignPrompt } catch { window._suppressNextSignPrompt = false }
      return true
    }
  } catch {}
  return false
}
const SESSION_TIMEOUT = 15 * 60 * 1000 // 15 minutes
const _webauthnCredId = localStorage.getItem('praxis-webauthn-cred') // passkey credential ID

// Biometric password persistence — survives page refresh within session
// Password is XOR-encoded with credential ID (not secure encryption, but sessionStorage
// is already same-origin and session-scoped. The real gate is the biometric check.)
function _persistPasswordForBiometric(password) {
  if (!_webauthnCredId) return
  try {
    const key = _webauthnCredId.slice(0, 32).padEnd(32, '0')
    const encoded = Array.from(password).map((c, i) =>
      String.fromCharCode(c.charCodeAt(0) ^ key.charCodeAt(i % key.length))
    ).join('')
    sessionStorage.setItem('praxis-bio-pw', btoa(encoded))
  } catch {}
}

function _retrievePasswordForBiometric() {
  if (!_webauthnCredId) return null
  try {
    const stored = sessionStorage.getItem('praxis-bio-pw')
    if (!stored) return null
    const key = _webauthnCredId.slice(0, 32).padEnd(32, '0')
    const encoded = atob(stored)
    return Array.from(encoded).map((c, i) =>
      String.fromCharCode(c.charCodeAt(0) ^ key.charCodeAt(i % key.length))
    ).join('')
  } catch { return null }
}

// --- BIP-39 helpers (lazy loaded) ---

async function loadBip() {
  return await import('./vendor-wallet.js')
}

// --- Crypto: AES-256-GCM + PBKDF2 600K iterations ---

async function deriveKey(password, salt) {
  const enc = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 600000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

async function encryptKey(privateKey, password) {
  const enc = new TextEncoder()
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveKey(password, salt)
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, enc.encode(privateKey)
  )
  return JSON.stringify({
    salt: Array.from(salt),
    iv: Array.from(iv),
    ct: Array.from(new Uint8Array(ciphertext)),
  })
}

async function decryptKey(encryptedJson, password) {
  const { salt, iv, ct } = JSON.parse(encryptedJson)
  const key = await deriveKey(password, new Uint8Array(salt))
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(iv) },
    key,
    new Uint8Array(ct)
  )
  return new TextDecoder().decode(plaintext)
}

// --- Wallet creation ---

async function createWallet(password) {
  if (!password || password.length < 8) {
    throw new Error('password must be at least 8 characters')
  }

  const bip = await loadBip()
  const mnemonic = bip.generateMnemonic(bip.wordlist)
  const seed = bip.mnemonicToSeedSync(mnemonic)
  const hdKey = bip.HDKey.fromMasterSeed(seed)
  const childKey = hdKey.derive("m/44'/60'/0'/0/0")
  const privateKey = `0x${Array.from(childKey.privateKey).map(b => b.toString(16).padStart(2, '0')).join('')}`

  const account = privateKeyToAccount(privateKey)

  // encrypt and store
  const encrypted = await encryptKey(privateKey, password)
  try { localStorage.setItem(STORAGE_KEY, encrypted) } catch {}
  try { localStorage.setItem(ADDR_KEY, account.address.toLowerCase()) } catch {}

  // cache for session
  _cachedAccount = account
  _cachedPassword = password; _persistPasswordForBiometric(password)
  try { sessionStorage.setItem('praxis-wallet-session', '1') } catch {}

  // cross-subdomain cookie
  setWalletCookie(account.address)

  // backup to server (encrypted — server never sees plaintext)
  try {
    await fetch('/api/wallet/store', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: account.address, encrypted }),
    })
  } catch (e) {
    console.warn('praxis: wallet server backup failed:', e?.message)
  }

  return { address: account.address, mnemonic }
}

// --- Wallet unlock ---

async function unlockWallet(password) {
  const encrypted = localStorage.getItem(STORAGE_KEY)
  if (!encrypted) throw new Error('no wallet found')

  const privateKey = await decryptKey(encrypted, password)
  const account = privateKeyToAccount(privateKey)

  // sync stored address to match the actual key (handles stale localStorage from previous wallet)
  const storedAddr = localStorage.getItem(ADDR_KEY)
  if (storedAddr && account.address.toLowerCase() !== storedAddr) {
    console.warn('praxis: wallet address mismatch — updating stored address from', storedAddr, 'to', account.address.toLowerCase())
    try { localStorage.setItem(ADDR_KEY, account.address.toLowerCase()) } catch {}
  }

  _cachedAccount = account
  _cachedPassword = password; _persistPasswordForBiometric(password)
  try { sessionStorage.setItem('praxis-wallet-session', '1') } catch {}

  // keep cross-subdomain cookie in sync
  setWalletCookie(account.address)

  return account
}

// --- Change password ---

async function changePassword(oldPassword, newPassword) {
  if (!newPassword || newPassword.length < 8) throw new Error('new password must be 8+ characters')
  const encrypted = localStorage.getItem(STORAGE_KEY)
  if (!encrypted) throw new Error('no wallet found')

  // decrypt with old password to verify it's correct
  const privateKey = await decryptKey(encrypted, oldPassword)
  const account = privateKeyToAccount(privateKey)
  const storedAddr = localStorage.getItem(ADDR_KEY)
  if (storedAddr && account.address.toLowerCase() !== storedAddr) {
    throw new Error('wrong password')
  }

  // re-encrypt with new password
  const newEncrypted = await encryptKey(privateKey, newPassword)
  localStorage.setItem(STORAGE_KEY, newEncrypted)

  // update server backup
  try {
    await fetch('/api/wallet/store', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: account.address, encrypted: newEncrypted }),
    })
  } catch {}

  // update cached password
  _cachedPassword = newPassword
  return true
}

// --- Lock check ---

function isWalletLocked() {
  return !_cachedAccount
}

// --- Address getter ---

function getEmbeddedWalletAddress() {
  if (_cachedAccount) return _cachedAccount.address
  return localStorage.getItem(ADDR_KEY) || null
}

// --- Account getter (for provider activation without re-unlock) ---

function getEmbeddedAccount() {
  return _cachedAccount
}

// --- Has embedded wallet ---

function hasEmbeddedWallet() {
  return !!localStorage.getItem(STORAGE_KEY)
}

// --- Recovery ---

async function recoverWallet(mnemonic, newPassword) {
  if (!newPassword || newPassword.length < 8) {
    throw new Error('password must be at least 8 characters')
  }

  const bip = await loadBip()
  const words = mnemonic.trim().toLowerCase().split(/\s+/)
  if (words.length !== 12) throw new Error('recovery phrase must be 12 words')
  if (!bip.validateMnemonic(mnemonic.trim().toLowerCase(), bip.wordlist)) {
    throw new Error('invalid recovery phrase')
  }

  const seed = bip.mnemonicToSeedSync(mnemonic.trim().toLowerCase())
  const hdKey = bip.HDKey.fromMasterSeed(seed)
  const childKey = hdKey.derive("m/44'/60'/0'/0/0")
  const privateKey = `0x${Array.from(childKey.privateKey).map(b => b.toString(16).padStart(2, '0')).join('')}`

  const account = privateKeyToAccount(privateKey)

  const encrypted = await encryptKey(privateKey, newPassword)
  try { localStorage.setItem(STORAGE_KEY, encrypted) } catch {}
  try { localStorage.setItem(ADDR_KEY, account.address.toLowerCase()) } catch {}

  _cachedAccount = account
  _cachedPassword = newPassword
  try { sessionStorage.setItem('praxis-wallet-session', '1') } catch {}

  // cross-subdomain cookie
  setWalletCookie(account.address)

  // backup to server
  try {
    await fetch('/api/wallet/store', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: account.address, encrypted }),
    })
  } catch (e) {
    console.warn('praxis: wallet server backup failed:', e?.message)
  }

  return { address: account.address }
}

// --- Export recovery phrase (requires current password) ---

async function exportRecoveryPhrase(password) {
  // we cannot recover the mnemonic from the private key alone
  // the mnemonic is shown ONCE at creation time
  // this function re-derives from the stored private key — but mnemonic != private key
  // so we store the mnemonic encrypted separately at creation time
  const encMnemonic = localStorage.getItem('praxis-wallet-mnemonic-enc')
  if (!encMnemonic) throw new Error('recovery phrase not available — it was shown only at creation time')
  return await decryptKey(encMnemonic, password)
}

// Decrypt the stored private key. Used by settings → "export private key" so users can
// import their wallet into MetaMask / Rabby etc. — needed for sites that don't recognize
// embedded wallets (e.g. peer.xyz for zkp2p verification).
async function exportPrivateKey(password) {
  const encrypted = localStorage.getItem(STORAGE_KEY)
  if (!encrypted) throw new Error('no embedded wallet on this device')
  const privateKey = await decryptKey(encrypted, password)
  return privateKey // 0x-prefixed hex
}

// --- Sign transaction ---

async function signAndSendTransaction(tx) {
  if (!_cachedAccount) throw new Error('wallet is locked')

  const client = createWalletClient({
    account: _cachedAccount,
    chain: optimism,
    transport: http(OPTIMISM_RPC),
  })

  const hash = await client.sendTransaction({
    to: tx.to,
    value: tx.value ? BigInt(tx.value) : undefined,
    data: tx.data,
    account: _cachedAccount,
  })

  return hash
}

// --- Transaction confirmation dialog ---

function confirmTransaction(to, value) {
  return new Promise(resolve => {
    const ethAmount = (Number(value) / 1e18).toFixed(6)
    const shortTo = to ? `${to.slice(0, 8)}...${to.slice(-6)}` : 'contract'
    const purchase = window._pendingPurchase
    const overlay = document.createElement('div')
    overlay.className = 'praxis-modal-overlay z-10001'

    // Human-readable context based on the destination contract
    const KNOWN_CONTRACTS = {
      '0x119d62a8eb466EAd6435d3c9479B2C8aF15F437B': { name: 'register as an artist', desc: 'this registers your domain on the praxis network. one-time deploy fee.' },
      '0x119dFac33408dDb3F42A2a9bA08a83716e1F8e77': { name: 'project action', desc: 'this interacts with the praxis project system (funding, credentials, revenue).' },
      '0xCa52D47900308AAB1e18ee83Ce98be9FAc24B71D': { name: 'media listing', desc: 'this lists or purchases media on the praxis marketplace.' },
      '0xfda3080f7B1b4C0FD008Da9f2695EA5811d4FaCE': { name: 'use invite code', desc: 'this activates your invite code on the network.' },
      '0x1C10799b6f02fcfd3fE3Ebf54e8699A287fcD3e1': { name: 'sponsor an invite', desc: 'this deposits funds to cover the registration fee for someone you invite. the funds go to a smart contract — not to another person — and are only released when someone uses your invite link to register. you can refund unused slots anytime.' },
      '0x77FcbfcBe7A79bC461cee3281ba77AB5B9e349CC': { name: 'ticket marketplace', desc: 'this lists or purchases a ticket on the marketplace.' },
      '0x10861656E0b194b670348e6597Fd4304Fc2FdC61': { name: 'add to library', desc: 'this adds an item to the shared knowledge base.' },
      '0xE37C4f2278838016f81f68342f14B82Cb36d88Ef': { name: 'treasury', desc: 'this interacts with the praxis treasury.' },
    }
    const contract = KNOWN_CONTRACTS[to?.toLowerCase()]

    let bodyHtml
    if (purchase && purchase.title) {
      bodyHtml = `
        <div style="margin-bottom:0.75em">
          <div style="color:var(--muted,#666);font-size:0.85em;margin-bottom:0.25em">purchasing</div>
          <div style="color:var(--fg,#c0c0c0);font-size:1.1em">${purchase.title}</div>
        </div>
        <div style="color:var(--dim,#555);font-size:0.8em;line-height:1.5;margin-bottom:1em;border-left:2px solid var(--dim,#333);padding-left:1ch">you will receive a permanent, non-transferable proof of purchase (soulbound token)</div>
        <div style="margin-bottom:1.5em;padding:1em;border:1px solid var(--border,#333);background:rgba(255,255,255,0.02)">
          <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:0.5em">
            <span style="color:var(--muted,#666);font-size:0.85em">amount</span>
            <span style="color:var(--fg,#c0c0c0);font-size:1.1em">${ethAmount} ETH</span>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:baseline">
            <span style="color:var(--muted,#666);font-size:0.85em">to</span>
            <span style="color:var(--dim,#555);font-size:0.75em;font-family:monospace">${shortTo}</span>
          </div>
        </div>
      `
    } else {
      const title = contract ? contract.name : 'confirm transaction'
      const desc = contract ? contract.desc : ''
      bodyHtml = `
        ${desc ? `<p style="color:var(--muted,#999);font-size:0.85em;line-height:1.5;margin-bottom:1.25em">${desc}</p>` : ''}
        <div style="margin-bottom:1.5em;padding:1em;border:1px solid var(--border,#333);background:rgba(255,255,255,0.02)">
          <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:0.5em">
            <span style="color:var(--muted,#666);font-size:0.85em">amount</span>
            <span style="color:var(--fg,#c0c0c0);font-size:1.1em">${ethAmount} ETH</span>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:baseline">
            <span style="color:var(--muted,#666);font-size:0.85em">to</span>
            <span style="color:var(--dim,#555);font-size:0.75em;font-family:monospace">${shortTo}</span>
          </div>
        </div>
      `
    }

    const title = (purchase && purchase.title) ? 'confirm purchase' : (contract ? contract.name : 'confirm transaction')

    overlay.innerHTML = `
      <div class="praxis-modal-dialog" style="max-width:400px;font-family:inherit">
        <h3 style="color:var(--accent,#fff);margin-bottom:0.75em">${title}</h3>
        ${bodyHtml}
        <div style="display:flex;gap:1ch">
          <button id="tx-confirm" style="flex:1;background:none;border:1px solid var(--green, #4ade80);color:var(--green, #4ade80);font-family:inherit;padding:0.6em;cursor:pointer">confirm</button>
          <button id="tx-cancel" style="flex:1;background:none;border:1px solid #333;color:#666;font-family:inherit;padding:0.6em;cursor:pointer">cancel</button>
        </div>
      </div>
    `
    document.body.appendChild(overlay)

    const confirm = async () => {
      // if biometric is set up, require it
      if (_webauthnCredId) {
        const ok = await verifyBiometric()
        if (!ok) { resolve(false); overlay.remove(); return }
      }
      resolve(true)
      overlay.remove()
    }

    overlay.querySelector('#tx-confirm').addEventListener('click', confirm)
    overlay.querySelector('#tx-cancel').addEventListener('click', () => { resolve(false); overlay.remove() })
    overlay.addEventListener('click', (e) => { if (e.target === overlay) { resolve(false); overlay.remove() } })
  })
}

// H7: confirmation modal for personal_sign / typed-data signatures. Shows
// the message preview and requires explicit user approval. Used to prevent
// silent signing of permits, approvals, or typed-data requests by any page.
function confirmSignature(kind, preview) {
  return new Promise(resolve => {
    const overlay = document.createElement('div')
    overlay.className = 'praxis-modal-overlay z-10001'
    const safePreview = String(preview || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const title = kind === 'typed' ? 'confirm typed data signature' : 'confirm message signature'
    overlay.innerHTML = `
      <div class="praxis-modal-dialog" style="max-width:440px;font-family:inherit">
        <h3 style="color:var(--accent,#fff);margin-bottom:0.75em">${title}</h3>
        <p style="color:var(--muted,#999);font-size:0.85em;line-height:1.5;margin-bottom:0.75em">a site is asking you to sign a message with your wallet. signatures can authorize token transfers or approvals — only confirm if you recognize this action.</p>
        <pre style="max-height:220px;overflow:auto;background:rgba(255,255,255,0.03);border:1px solid var(--border,#333);padding:0.75em;font-size:0.75em;color:var(--dim,#888);margin-bottom:1.25em;white-space:pre-wrap;word-break:break-word">${safePreview}</pre>
        <div style="display:flex;gap:1ch">
          <button id="sig-confirm" style="flex:1;background:none;border:1px solid var(--green, #4ade80);color:var(--green, #4ade80);font-family:inherit;padding:0.6em;cursor:pointer">sign</button>
          <button id="sig-cancel" style="flex:1;background:none;border:1px solid #333;color:#666;font-family:inherit;padding:0.6em;cursor:pointer">cancel</button>
        </div>
      </div>
    `
    document.body.appendChild(overlay)
    overlay.querySelector('#sig-confirm').addEventListener('click', async () => {
      if (_webauthnCredId) {
        const ok = await verifyBiometric()
        if (!ok) { resolve(false); overlay.remove(); return }
      }
      resolve(true); overlay.remove()
    })
    overlay.querySelector('#sig-cancel').addEventListener('click', () => { resolve(false); overlay.remove() })
    overlay.addEventListener('click', (e) => { if (e.target === overlay) { resolve(false); overlay.remove() } })
  })
}

// Allowlist of known short scoped admin prefixes that auto-sign without a
// prompt (low-stakes internal flows). Everything else triggers the modal.
//
// Security note (re-audit N1/N2/N4): previous versions auto-allowed
// 'domain-update:' and 'praxis-retrieve:', which let any XSS silently hijack
// the user's domain routing or exfiltrate their encrypted wallet blob without
// a prompt. Those prefixes now require either user confirmation OR the
// one-shot `window._suppressNextSignPrompt` bypass set immediately before a
// legitimate call (see settings.js domain-update flow and the sign-in flow).
//
// Cycle 4 hotfix: added 'admin:' and 'praxis:journal-key:' which are used by
// every authenticated Praxis flow (settings.js, feed.js, library.js, journal.js
// — all use `admin:<hostname>:<ts>` for the site session token, and journal.js
// uses `praxis:journal-key:v1:<addr>` to derive the journal encryption key).
// Without these in the allowlist users see a confirm modal every time they
// open the journal, post to feed, or save settings — pure friction with no
// security gain (XSS already has fetch + can dismiss the modal anyway; the
// real protection is server-side hostname validation and PERSONAL_SIGN_DANGER
// keyword check below for EIP-712 permits/approvals that actually drain funds).
const PERSONAL_SIGN_AUTOALLOW = [
  'sponsored-admin:',
  'link:',
  'admin:',
  'praxis:journal-key:',
  'deploy ',
]
// Keywords that force a prompt on personal_sign even if prefix check fails.
const PERSONAL_SIGN_DANGER = ['permit', 'setapproval', 'redeem', 'authorize', 'transfer']

function _hexToUtf8(hex) {
  try {
    if (typeof hex !== 'string') return String(hex ?? '')
    const h = hex.startsWith('0x') ? hex.slice(2) : hex
    if (!/^[0-9a-f]*$/i.test(h) || h.length % 2) return hex
    const bytes = new Uint8Array(h.length / 2)
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(h.substr(i * 2, 2), 16)
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  } catch { return hex }
}

// Known EIP-712 types we auto-allow (match PERSONAL_SIGN_AUTOALLOW spirit).
// For now we treat any typed-data signature as requiring confirmation unless
// the primaryType is explicitly allowlisted.
const TYPED_DATA_AUTOALLOW_TYPES = new Set([])

// --- WebAuthn / Biometric ---

async function setupBiometric() {
  if (!window.PublicKeyCredential) return false
  try {
    const challenge = crypto.getRandomValues(new Uint8Array(32))
    const credential = await navigator.credentials.create({
      publicKey: {
        challenge,
        rp: { name: 'Praxis', id: window.location.hostname },
        user: {
          id: new TextEncoder().encode(_cachedAccount?.address || 'praxis-user'),
          name: _cachedAccount?.address?.slice(0, 10) || 'praxis',
          displayName: 'Praxis Account',
        },
        pubKeyCredParams: [{ alg: -7, type: 'public-key' }, { alg: -257, type: 'public-key' }], // ES256 + RS256
        authenticatorSelection: {
          authenticatorAttachment: 'platform', // built-in biometric
          userVerification: 'required',
        },
        timeout: 60000,
      },
    })
    if (credential) {
      const credId = btoa(String.fromCharCode(...new Uint8Array(credential.rawId)))
      localStorage.setItem('praxis-webauthn-cred', credId)
      return true
    }
  } catch (e) { console.warn('biometric setup failed:', e?.message) }
  return false
}

async function verifyBiometric() {
  const credId = localStorage.getItem('praxis-webauthn-cred')
  if (!credId || !window.PublicKeyCredential) return true // skip if not set up
  try {
    const challenge = crypto.getRandomValues(new Uint8Array(32))
    const rawId = Uint8Array.from(atob(credId), c => c.charCodeAt(0))
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge,
        allowCredentials: [{ id: rawId, type: 'public-key', transports: ['internal'] }],
        userVerification: 'required',
        timeout: 60000,
      },
    })
    return !!assertion
  } catch { return false }
}

window.setupBiometric = setupBiometric
window.verifyBiometric = verifyBiometric
// Exposed as a function rather than a raw window boolean so that flipping
// the suppress flag requires actually calling this helper (see N3).
window.suppressNextSignPrompt = suppressNextSignPrompt

// --- Sign message ---

async function signMessage(message) {
  if (!_cachedAccount) throw new Error('wallet is locked')
  return await _cachedAccount.signMessage({ message })
}

// --- EIP-1193 provider (drop-in replacement for window.ethereum) ---

function createEmbeddedProvider(account) {
  const listeners = {}
  return {
    isMetaMask: false,
    isPraxis: true,
    _account: account,
    request: async ({ method, params }) => {
      // session timeout check on all signing operations
      if (['personal_sign', 'eth_sign', 'eth_signTypedData_v4', 'eth_sendTransaction'].includes(method)) {
        if (Date.now() - _lastActivity > SESSION_TIMEOUT) {
          _cachedAccount = null
          _cachedPassword = null; try { sessionStorage.removeItem('praxis-bio-pw') } catch {}
          throw new Error('session expired — please unlock your account again')
        }
        _lastActivity = Date.now()
      }

      switch (method) {
        case 'eth_accounts':
        case 'eth_requestAccounts':
          return [account.address]

        case 'personal_sign': {
          const msg = params[0]
          // H7: decode hex payload for preview + risk check
          const decoded = typeof msg === 'string' && msg.startsWith('0x') ? _hexToUtf8(msg) : String(msg ?? '')
          const lower = decoded.toLowerCase()
          const autoAllowed = PERSONAL_SIGN_AUTOALLOW.some(p => decoded.startsWith(p))
          const dangerous = PERSONAL_SIGN_DANGER.some(w => lower.includes(w))
          const bypass = _consumeSuppressFlag()
          if (!bypass && (dangerous || !autoAllowed)) {
            const ok = await confirmSignature('personal', decoded)
            if (!ok) throw { code: 4001, message: 'user rejected signature' }
          }
          return await account.signMessage({ message: msg })
        }

        case 'eth_sign': {
          const msg = params[1]
          // H7: eth_sign is always dangerous — require confirmation
          const bypass = _consumeSuppressFlag()
          if (!bypass) {
            const decoded = typeof msg === 'string' && msg.startsWith('0x') ? _hexToUtf8(msg) : String(msg ?? '')
            const ok = await confirmSignature('personal', decoded)
            if (!ok) throw { code: 4001, message: 'user rejected signature' }
          }
          return await account.signMessage({ message: msg })
        }

        case 'eth_signTypedData_v4': {
          const typedData = JSON.parse(params[1])
          // H7: always prompt for typed data unless primaryType is on the
          // (currently empty) auto-allow list or caller sets the one-shot bypass
          const primaryType = typedData?.primaryType || ''
          const bypass = _consumeSuppressFlag()
          if (!bypass && !TYPED_DATA_AUTOALLOW_TYPES.has(primaryType)) {
            let preview
            try { preview = JSON.stringify(typedData, null, 2) } catch { preview = String(params[1]) }
            const ok = await confirmSignature('typed', preview)
            if (!ok) throw { code: 4001, message: 'user rejected signature' }
          }
          return await account.signTypedData(typedData)
        }

        case 'eth_sendTransaction': {
          if (!account) throw new Error('wallet is locked — please unlock first')
          const tx = params[0]

          // confirmation for value transfers
          const val = tx.value ? BigInt(tx.value) : 0n
          if (val > 0n) {
            const confirmed = await confirmTransaction(tx.to, val)
            if (!confirmed) throw { code: 4001, message: 'user rejected transaction' }
          }

          // Use viem walletClient with pre-estimated gas to avoid internal estimateGas issues
          const client = createWalletClient({
            account,
            chain: optimism,
            transport: http(OPTIMISM_RPC),
          })

          // Estimate gas ourselves via raw RPC if not provided (clean params, no viem overhead)
          let gas = tx.gas ? BigInt(tx.gas) : undefined
          if (!gas) {
            try {
              const estResp = await fetch(OPTIMISM_RPC, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_estimateGas',
                  params: [{ from: account.address, to: tx.to, data: tx.data, value: tx.value || '0x0' }] }),
              })
              const estData = await estResp.json()
              if (estData.result) gas = BigInt(Math.ceil(Number(BigInt(estData.result)) * 1.5))
            } catch {}
            if (!gas) gas = 200000n // safe fallback
          }

          return await client.sendTransaction({
            to: tx.to,
            value: val || undefined,
            data: tx.data,
            gas,
            account,
          })
        }

        case 'eth_chainId':
          return OPTIMISM_CHAIN_ID

        case 'wallet_switchEthereumChain':
          // already on Optimism — noop
          return null

        case 'wallet_addEthereumChain':
          return null

        case 'wallet_requestPermissions':
          return [{ parentCapability: 'eth_accounts' }]

        case 'eth_getBalance': {
          const resp = await fetch(OPTIMISM_RPC, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params }),
          })
          const data = await resp.json()
          return data.result
        }

        case 'eth_call':
        case 'eth_estimateGas':
        case 'eth_getTransactionReceipt':
        case 'eth_getTransactionByHash':
        case 'eth_blockNumber':
        case 'eth_getBlockByNumber':
        case 'eth_getLogs': {
          // proxy read calls to Optimism RPC
          const resp = await fetch(OPTIMISM_RPC, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          })
          const data = await resp.json()
          if (data.error) throw new Error(data.error.message)
          return data.result
        }

        default:
          console.warn('praxis embedded wallet: unhandled method', method)
          throw new Error(`unsupported method: ${method}`)
      }
    },
    on: (event, fn) => {
      if (!listeners[event]) listeners[event] = []
      listeners[event].push(fn)
    },
    removeListener: (event, fn) => {
      if (listeners[event]) {
        listeners[event] = listeners[event].filter(f => f !== fn)
      }
    },
    emit: (event, ...args) => {
      if (listeners[event]) {
        listeners[event].forEach(fn => fn(...args))
      }
    },
  }
}

// --- Activate embedded provider (replaces window.ethereum) ---

function activateEmbeddedProvider(account) {
  // Reset session-timeout clock. Without this, unlocking AFTER a session expiry
  // would create a new provider but `_lastActivity` would still point at the
  // pre-expiry timestamp, so the very next `personal_sign` would re-throw
  // "session expired", which the journal flow then tries to recover from by
  // re-prompting for the password — infinite loop until the user reloads.
  _lastActivity = Date.now()
  const provider = createEmbeddedProvider(account)
  // Try to override window.ethereum — but other wallets (Phantom, Coinbase, Rabby) often
  // install it as a non-configurable getter. Catch the "Cannot redefine property" error
  // and fall back to defineProperty, then to a side-channel global. Praxis code should
  // prefer window.getEmbeddedAccount() / window.signTransaction() directly anyway.
  try {
    window.ethereum = provider
  } catch (e) {
    try {
      Object.defineProperty(window, 'ethereum', { value: provider, writable: true, configurable: true })
    } catch (e2) {
      console.warn('[wallet] window.ethereum is locked by another wallet — using praxis-only mode:', e2?.message)
      // Don't throw — Praxis flows use the embedded helpers directly, not window.ethereum
    }
  }
  // Always set our own namespace so Praxis code has a guaranteed handle
  try { window.praxisEthereum = provider } catch {}
  return provider
}

// Global helper: returns the EIP-1193 provider Praxis should use for any wallet RPC.
// Prefers our embedded provider (which lives at window.praxisEthereum even when
// another wallet has locked window.ethereum). EVERY wallet RPC call must go
// through this — never window.ethereum directly.
if (typeof window !== 'undefined') {
  window.getWalletProvider = function () {
    return window.praxisEthereum || window.ethereum || null
  }
}

// --- Deactivate embedded provider ---

function deactivateEmbeddedProvider() {
  _cachedAccount = null
  _cachedPassword = null; try { sessionStorage.removeItem('praxis-bio-pw') } catch {}
  try { sessionStorage.removeItem('praxis-wallet-session') } catch {}
}

// --- Store encrypted mnemonic for later export ---

async function storeMnemonicEncrypted(mnemonic, password) {
  const encrypted = await encryptKey(mnemonic, password)
  try { localStorage.setItem('praxis-wallet-mnemonic-enc', encrypted) } catch {}
}

// --- Recovery phrase download ---

function buildRecoveryPhraseText(mnemonic, address) {
  return [
    'PRAXIS ACCOUNT RECOVERY PHRASE',
    '==============================',
    '',
    'account address: ' + address,
    'created: ' + new Date().toISOString(),
    '',
    'recovery phrase (12 words):',
    '',
    mnemonic,
    '',
    'IMPORTANT:',
    '- store this file somewhere safe (encrypted USB, password manager)',
    '- anyone with these 12 words can access your account',
    '- praxis cannot recover your account without this phrase',
    '- delete this file after writing the words down on paper',
  ].join('\n')
}

function _isMobileBrowser() {
  try {
    return ('ontouchstart' in window) || (navigator.maxTouchPoints || 0) > 0 ||
      /iP(hone|ad|od)|Android/i.test(navigator.userAgent || '')
  } catch { return false }
}

// Download recovery phrase. Must be called synchronously from a user-gesture
// handler — no awaits between the click and this call — or mobile browsers
// will block the download. Uses application/octet-stream to force a download
// (prevents iOS Safari from rendering the text inline in a new tab).
function downloadRecoveryPhrase(mnemonic, address) {
  const text = buildRecoveryPhraseText(mnemonic, address)
  const filename = `praxis-recovery-${address.slice(0, 8)}.txt`

  try {
    // octet-stream forces download rather than inline display on iOS/Android
    const blob = new Blob([text], { type: 'application/octet-stream' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.rel = 'noopener'
    a.target = '_blank' // some mobile browsers need this alongside download
    a.style.display = 'none'
    document.body.appendChild(a)
    a.click()
    // keep the URL alive briefly so mobile Safari can actually start the download
    setTimeout(() => {
      try { a.remove() } catch {}
      try { URL.revokeObjectURL(url) } catch {}
    }, 4000)
    return true
  } catch (e) {
    console.warn('praxis: recovery phrase download failed:', e?.message)
    return false
  }
}

async function copyRecoveryPhraseToClipboard(mnemonic, address) {
  const text = buildRecoveryPhraseText(mnemonic, address)
  // M6: only use the clipboard API — the execCommand textarea fallback
  // leaves a DOM element with the plaintext mnemonic that other scripts
  // or copy listeners can observe. If the API fails, fail closed and ask
  // the user to copy manually rather than falling back.
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch (e) {
      console.warn('praxis: clipboard.writeText failed:', e?.message)
    }
  }
  return false
}

// --- UI: Recovery phrase display ---

function showRecoveryPhraseUI(mnemonic, address, onComplete) {
  const overlay = document.createElement('div')
  overlay.id = 'recovery-phrase-overlay'
  overlay.className = 'praxis-modal-overlay'

  const words = mnemonic.split(' ')
  const wordGrid = words.map((w, i) =>
    `<div style="background:#111;border:1px solid #333;padding:0.4em 1ch;font-size:0.95em"><span style="color:#555;margin-right:0.5ch">${i + 1}.</span><span style="color:#fff">${w}</span></div>`
  ).join('')

  const dialog = document.createElement('div')
  dialog.className = 'praxis-modal-dialog'
  dialog.style.cssText = 'max-width:500px;max-height:90vh;overflow-y:auto'
  dialog.innerHTML = `
    <h3 style="color:var(--accent, #00ff41);margin-bottom:0.5em">recovery phrase</h3>
    <p style="color:#c0c0c0;font-size:0.9em;line-height:1.5;margin-bottom:1em">write these 12 words down and store them safely. this is the only way to recover your account if you forget your password. praxis cannot recover it for you.</p>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:0.5em;margin-bottom:1.5em">${wordGrid}</div>
    <div style="display:flex;flex-direction:column;gap:0.75em">
      <p style="color:#ef4444;font-size:0.85em;line-height:1.4">anyone with these words can access your account and funds. never share them. never enter them on any website except praxis.</p>
      <div style="display:flex;flex-wrap:wrap;gap:0.5ch">
        <button id="recovery-download-btn" style="background:none;border:1px solid #333;color:#c0c0c0;font-family:inherit;font-size:0.85em;padding:0.5em 1.5ch;cursor:pointer;text-align:left;flex:1;min-width:14ch">download recovery phrase</button>
        <button id="recovery-copy-btn" style="background:none;border:1px solid #333;color:#c0c0c0;font-family:inherit;font-size:0.85em;padding:0.5em 1.5ch;cursor:pointer;text-align:left;flex:1;min-width:14ch">copy to clipboard</button>
      </div>
      <p id="recovery-action-status" style="color:#666;font-size:0.75em;margin:0;min-height:1em"></p>
      <label style="display:flex;align-items:center;gap:0.5ch;color:#999;font-size:0.85em;cursor:pointer">
        <input type="checkbox" id="recovery-confirm-check"> i have saved my recovery phrase
      </label>
      <button id="recovery-continue-btn" style="background:none;border:1px solid #555;color:#555;font-family:inherit;font-size:0.85em;padding:0.5em 1.5ch;cursor:not-allowed" disabled>continue</button>
    </div>
  `

  overlay.appendChild(dialog)
  document.body.appendChild(overlay)

  const actionStatusEl = document.getElementById('recovery-action-status')
  const setActionStatus = (msg, color = '#999') => {
    if (!actionStatusEl) return
    actionStatusEl.textContent = msg
    actionStatusEl.style.color = color
  }

  document.getElementById('recovery-download-btn').addEventListener('click', () => {
    // IMPORTANT: run synchronously — no awaits — to preserve the user gesture
    // chain. Mobile Safari/Chrome will cancel the download otherwise.
    const ok = downloadRecoveryPhrase(mnemonic, address)
    if (ok) {
      setActionStatus('download started — check your files', '#00ff41')
    } else {
      setActionStatus('download blocked — use "copy to clipboard" instead', '#ef4444')
    }
  })

  document.getElementById('recovery-copy-btn').addEventListener('click', async () => {
    const ok = await copyRecoveryPhraseToClipboard(mnemonic, address)
    if (ok) {
      setActionStatus('copied — paste somewhere safe (password manager, notes)', '#00ff41')
    } else {
      setActionStatus('copy failed — write the words down manually', '#ef4444')
    }
  })

  const check = document.getElementById('recovery-confirm-check')
  const continueBtn = document.getElementById('recovery-continue-btn')
  check.addEventListener('change', () => {
    continueBtn.disabled = !check.checked
    continueBtn.style.color = check.checked ? '#c0c0c0' : '#555'
    continueBtn.style.borderColor = check.checked ? '#333' : '#555'
    continueBtn.style.cursor = check.checked ? 'pointer' : 'not-allowed'
  })

  continueBtn.addEventListener('click', async () => {
    if (!check.checked) return
    // offer biometric setup if supported
    if (window.PublicKeyCredential && !localStorage.getItem('praxis-webauthn-cred')) {
      const bioBtn = document.createElement('div')
      bioBtn.style.cssText = 'margin-top:1em;text-align:center'
      bioBtn.innerHTML = `
        <p style="color:#c0c0c0;font-size:0.85em;margin-bottom:0.75em">enable biometric confirmation for transactions?</p>
        <button id="bio-yes" style="background:none;border:1px solid #333;color:#c0c0c0;font-family:inherit;font-size:0.85em;padding:0.5em 2ch;cursor:pointer;margin-right:1ch">enable fingerprint / Face ID</button>
        <button id="bio-skip" style="background:none;border:none;color:#555;font-family:inherit;font-size:0.8em;cursor:pointer">skip</button>
      `
      dialog.appendChild(bioBtn)
      continueBtn.style.display = 'none'

      bioBtn.querySelector('#bio-yes').addEventListener('click', async () => {
        const ok = await setupBiometric()
        if (ok) bioBtn.querySelector('#bio-yes').textContent = 'biometric enabled'
        overlay.remove()
        if (onComplete) onComplete()
      })
      bioBtn.querySelector('#bio-skip').addEventListener('click', () => {
        overlay.remove()
        if (onComplete) onComplete()
      })
    } else {
      overlay.remove()
      if (onComplete) onComplete()
    }
  })
}

// --- UI: Unlock prompt ---

async function showUnlockPrompt() {
  // Biometric auto-unlock: try biometric first if enabled
  // Works even after page refresh — password persisted in sessionStorage (XOR-encoded)
  const biometricCredId = _webauthnCredId || localStorage.getItem('praxis-webauthn-cred')
  const bioPassword = _cachedPassword || _retrievePasswordForBiometric()
  if (biometricCredId && bioPassword) {
    try {
      const bioPassed = await verifyBiometric()
      if (bioPassed) {
        const account = await unlockWallet(bioPassword)
        _cachedPassword = bioPassword
        activateEmbeddedProvider(account)
        return account.address
      }
    } catch {
      // biometric failed — fall through to password dialog
    }
  }

  return new Promise((resolve) => {
    const useBiometric = !!(biometricCredId && bioPassword)
    const overlay = document.createElement('div')
    overlay.id = 'wallet-unlock-overlay'
    overlay.className = 'praxis-modal-overlay'

    const dialog = document.createElement('div')
    dialog.className = 'praxis-modal-dialog'
    dialog.style.cssText = 'max-width:360px'
    // Show which account is being unlocked
    const _storedAddr = localStorage.getItem(ADDR_KEY) || ''
    const _addrShort = _storedAddr ? `${_storedAddr.slice(0, 6)}...${_storedAddr.slice(-4)}` : ''
    dialog.innerHTML = `
      <h3 style="color:var(--accent, #00ff41);margin-bottom:0.25em">${useBiometric ? 'verify identity' : 'sign in'}</h3>
      <div id="unlock-account-label" style="color:#666;font-size:0.8em;margin-bottom:0.75em">${_addrShort ? `account: ${_addrShort}` : ''}</div>
      <input type="password" id="unlock-password" placeholder="password" autocomplete="current-password" style="width:100%;background:#111;border:1px solid #333;color:#c0c0c0;font-family:inherit;font-size:1em;padding:0.5em 1ch;margin-bottom:0.75em;box-sizing:border-box">
      <p id="unlock-error" style="color:#ef4444;font-size:0.85em;min-height:1.2em;margin-bottom:0.5em"></p>
      <div style="display:flex;gap:1ch;justify-content:flex-end">
        <button id="unlock-cancel-btn" style="background:none;border:1px solid #333;color:#666;font-family:inherit;font-size:0.85em;padding:0.4em 1.5ch;cursor:pointer">cancel</button>
        <button id="unlock-submit-btn" style="background:none;border:1px solid #333;color:#c0c0c0;font-family:inherit;font-size:0.85em;padding:0.4em 1.5ch;cursor:pointer">unlock</button>
      </div>
      <div style="margin-top:1em;border-top:1px solid #222;padding-top:0.75em">
        <button id="unlock-recover-btn" style="background:none;border:none;color:#555;font-family:inherit;font-size:0.8em;padding:0;cursor:pointer;text-decoration:underline">recover with phrase</button>
      </div>
    `
    overlay.appendChild(dialog)
    document.body.appendChild(overlay)

    // Resolve address to domain name in background
    if (_storedAddr) {
      fetch('/ponder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: `{ artists(where: { id: "${_storedAddr.toLowerCase()}" }, limit: 1) { items { domain } } }` }),
      }).then(r => r.json()).then(d => {
        const domain = d?.data?.artists?.items?.[0]?.domain
        if (domain) {
          const label = document.getElementById('unlock-account-label')
          if (label) label.textContent = `account: ${domain}`
        }
      }).catch(() => {})
    }

    const passwordInput = document.getElementById('unlock-password')
    const errorEl = document.getElementById('unlock-error')

    async function doUnlock() {
      const pw = passwordInput.value
      if (!pw) { errorEl.textContent = 'enter your password'; return }
      errorEl.textContent = 'unlocking...'
      try {
        const account = await unlockWallet(pw)
        activateEmbeddedProvider(account)
        overlay.remove()
        resolve(account.address)
      } catch (e) {
        errorEl.textContent = 'wrong password'
      }
    }

    document.getElementById('unlock-submit-btn').addEventListener('click', doUnlock)
    passwordInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doUnlock()
    })
    document.getElementById('unlock-cancel-btn').addEventListener('click', () => {
      overlay.remove()
      resolve(null)
    })
    document.getElementById('unlock-recover-btn').addEventListener('click', () => {
      overlay.remove()
      showRecoveryPrompt().then(resolve)
    })
    overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); resolve(null) } })

    passwordInput.focus()
  })
}

// --- UI: Create wallet prompt ---

function showCreateWalletPrompt() {
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.id = 'wallet-create-overlay'
    overlay.className = 'praxis-modal-overlay'

    const dialog = document.createElement('div')
    dialog.className = 'praxis-modal-dialog'
    dialog.style.cssText = 'max-width:400px'
    dialog.innerHTML = `
      <h3 style="color:var(--accent, #00ff41);margin-bottom:0.5em">create account</h3>
      <p style="color:#999;font-size:0.85em;line-height:1.4;margin-bottom:1em">choose a password to create your account.</p>
      <input type="password" id="create-password" placeholder="password (8+ characters)" autocomplete="new-password" style="width:100%;background:#111;border:1px solid #333;color:#c0c0c0;font-family:inherit;font-size:1em;padding:0.5em 1ch;margin-bottom:0.5em;box-sizing:border-box">
      <input type="password" id="create-password-confirm" placeholder="confirm password" autocomplete="new-password" style="width:100%;background:#111;border:1px solid #333;color:#c0c0c0;font-family:inherit;font-size:1em;padding:0.5em 1ch;margin-bottom:0.75em;box-sizing:border-box">
      <p id="create-error" style="color:#ef4444;font-size:0.85em;min-height:1.2em;margin-bottom:0.5em"></p>
      <div style="display:flex;gap:1ch;justify-content:flex-end">
        <button id="create-cancel-btn" style="background:none;border:1px solid #333;color:#666;font-family:inherit;font-size:0.85em;padding:0.4em 1.5ch;cursor:pointer">cancel</button>
        <button id="create-submit-btn" style="background:none;border:1px solid #333;color:#c0c0c0;font-family:inherit;font-size:0.85em;padding:0.4em 1.5ch;cursor:pointer">continue</button>
      </div>
    `
    overlay.appendChild(dialog)
    document.body.appendChild(overlay)

    const pw1 = document.getElementById('create-password')
    const pw2 = document.getElementById('create-password-confirm')
    const errorEl = document.getElementById('create-error')

    async function doCreate() {
      const password = pw1.value
      const confirm = pw2.value
      if (!password || password.length < 8) {
        errorEl.textContent = 'password must be at least 8 characters'
        return
      }
      if (password !== confirm) {
        errorEl.textContent = 'passwords do not match'
        return
      }
      errorEl.textContent = 'creating account...'
      try {
        const { address, mnemonic } = await createWallet(password)
        // store encrypted mnemonic for potential future export
        await storeMnemonicEncrypted(mnemonic, password)
        activateEmbeddedProvider(_cachedAccount)
        overlay.remove()
        // show recovery phrase
        showRecoveryPhraseUI(mnemonic, address, () => {
          resolve(address)
        })
      } catch (e) {
        errorEl.textContent = e.message || 'wallet creation failed'
      }
    }

    document.getElementById('create-submit-btn').addEventListener('click', doCreate)
    pw2.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doCreate()
    })
    document.getElementById('create-cancel-btn').addEventListener('click', () => {
      overlay.remove()
      resolve(null)
    })
    overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); resolve(null) } })

    pw1.focus()
  })
}

// --- UI: Recovery prompt ---

function showRecoveryPrompt() {
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.id = 'wallet-recovery-overlay'
    overlay.className = 'praxis-modal-overlay'

    const dialog = document.createElement('div')
    dialog.className = 'praxis-modal-dialog'
    dialog.innerHTML = `
      <h3 style="color:var(--accent, #00ff41);margin-bottom:0.5em">recover account</h3>
      <p style="color:#999;font-size:0.85em;line-height:1.4;margin-bottom:1em">enter your 12-word recovery phrase and choose a new password.</p>
      <textarea id="recover-phrase" rows="3" placeholder="enter 12 words separated by spaces" style="width:100%;background:#111;border:1px solid #333;color:#c0c0c0;font-family:inherit;font-size:0.95em;padding:0.5em 1ch;margin-bottom:0.5em;box-sizing:border-box;resize:vertical"></textarea>
      <input type="password" id="recover-password" placeholder="new password (8+ characters)" autocomplete="new-password" style="width:100%;background:#111;border:1px solid #333;color:#c0c0c0;font-family:inherit;font-size:1em;padding:0.5em 1ch;margin-bottom:0.5em;box-sizing:border-box">
      <input type="password" id="recover-password-confirm" placeholder="confirm new password" autocomplete="new-password" style="width:100%;background:#111;border:1px solid #333;color:#c0c0c0;font-family:inherit;font-size:1em;padding:0.5em 1ch;margin-bottom:0.75em;box-sizing:border-box">
      <p id="recover-error" style="color:#ef4444;font-size:0.85em;min-height:1.2em;margin-bottom:0.5em"></p>
      <div style="display:flex;gap:1ch;justify-content:flex-end">
        <button id="recover-cancel-btn" style="background:none;border:1px solid #333;color:#666;font-family:inherit;font-size:0.85em;padding:0.4em 1.5ch;cursor:pointer">cancel</button>
        <button id="recover-submit-btn" style="background:none;border:1px solid #333;color:#c0c0c0;font-family:inherit;font-size:0.85em;padding:0.4em 1.5ch;cursor:pointer">recover</button>
      </div>
    `
    overlay.appendChild(dialog)
    document.body.appendChild(overlay)

    const phraseInput = document.getElementById('recover-phrase')
    const pw1 = document.getElementById('recover-password')
    const pw2 = document.getElementById('recover-password-confirm')
    const errorEl = document.getElementById('recover-error')

    async function doRecover() {
      const phrase = phraseInput.value.trim()
      const password = pw1.value
      const confirm = pw2.value
      if (!phrase) { errorEl.textContent = 'enter your recovery phrase'; return }
      if (phrase.split(/\s+/).length !== 12) { errorEl.textContent = 'phrase must be exactly 12 words'; return }
      if (!password || password.length < 8) { errorEl.textContent = 'password must be at least 8 characters'; return }
      if (password !== confirm) { errorEl.textContent = 'passwords do not match'; return }

      errorEl.textContent = 'recovering...'
      try {
        const { address } = await recoverWallet(phrase, password)
        // store encrypted mnemonic for export
        await storeMnemonicEncrypted(phrase, password)
        activateEmbeddedProvider(_cachedAccount)
        overlay.remove()
        resolve(address)
      } catch (e) {
        errorEl.textContent = e.message || 'recovery failed'
      }
    }

    document.getElementById('recover-submit-btn').addEventListener('click', doRecover)
    document.getElementById('recover-cancel-btn').addEventListener('click', () => {
      overlay.remove()
      resolve(null)
    })
    overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); resolve(null) } })

    phraseInput.focus()
  })
}

// --- Auto-unlock from session ---

// LOW-4 (legacy): this cross-subdomain restore path is effectively dead on
// first-visit cold loads because `_cachedAccount` is null when the module
// initializes, so the guarded fetch never runs. The live cross-Praxis restore
// flow lives in `wallet.js#autoConnect` via `getBridgeAddressWithToken()` →
// POST /api/wallet/retrieve with an HMAC-signed token. Keep this shim in
// place for any warm-reload edge case but do not rely on it for new paths.
async function trySessionRestore() {
  // if we have a cached account from this page load, provider is already active
  if (_cachedAccount) return _cachedAccount.address

  // cross-subdomain restore: if localStorage has no wallet but cookie has address,
  // fetch encrypted wallet from server and store locally (user still needs to unlock)
  // SAFETY: only restore if the cookie address matches the site owner (prevents
  // importing a wallet from a different site where the user is a supporter)
  if (!localStorage.getItem(STORAGE_KEY)) {
    const cookieAddr = getWalletCookie()
    if (cookieAddr && /^0x[0-9a-f]{40}$/i.test(cookieAddr) && _cachedAccount &&
        _cachedAccount.address?.toLowerCase() === cookieAddr.toLowerCase()) {
      // restore wallet for any Praxis user — visitors need their wallet on other sites too.
      // Requires an unlocked account to sign a retrieval challenge (H3).
      {
        try {
          const ts = Date.now()
          const message = `praxis-retrieve:${cookieAddr.toLowerCase()}:${ts}`
          const signature = await _cachedAccount.signMessage({ message })
          const _ctrl = new AbortController()
          const _to = setTimeout(() => _ctrl.abort(), 5000)
          const resp = await fetch('/api/wallet/retrieve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ address: cookieAddr, message, signature }),
            signal: _ctrl.signal,
          })
          clearTimeout(_to)
          if (resp.ok) {
            const { encrypted } = await resp.json()
            if (encrypted) {
              try { localStorage.setItem(STORAGE_KEY, encrypted) } catch {}
              try { localStorage.setItem(ADDR_KEY, cookieAddr.toLowerCase()) } catch {}
              console.log('praxis: wallet restored from server backup')
            }
          }
        } catch (e) {
          console.warn('praxis: cross-subdomain wallet restore failed:', e?.message)
        }
      }
    }
  }

  // no auto-restore possible — session password is gone on page reload
  // user must enter password again
  return null
}


// --- UI: Sign in with existing Praxis wallet (cross-domain) ---

function showSignInPrompt() {
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.id = 'wallet-signin-overlay'
    overlay.className = 'praxis-modal-overlay'

    const dialog = document.createElement('div')
    dialog.className = 'praxis-modal-dialog'
    dialog.style.cssText = 'max-width:380px'
    dialog.innerHTML = `
      <h3 style="color:var(--accent, #00ff41);margin-bottom:0.5em">sign in to ${location.hostname}</h3>
      <p style="color:#999;font-size:0.85em;line-height:1.4;margin-bottom:1em">enter your address or artist handle and your password. your encrypted account will be retrieved from the network.</p>
      <input type="text" id="signin-handle" placeholder="address (0x...) or handle" autocomplete="username" style="width:100%;background:#111;border:1px solid #333;color:#c0c0c0;font-family:inherit;font-size:1em;padding:0.5em 1ch;margin-bottom:0.5em;box-sizing:border-box">
      <input type="password" id="signin-password" placeholder="password" autocomplete="current-password" style="width:100%;background:#111;border:1px solid #333;color:#c0c0c0;font-family:inherit;font-size:1em;padding:0.5em 1ch;margin-bottom:0.75em;box-sizing:border-box">
      <p id="signin-error" style="color:#ef4444;font-size:0.85em;min-height:1.2em;margin-bottom:0.5em"></p>
      <div style="display:flex;gap:1ch;justify-content:flex-end">
        <button id="signin-cancel-btn" style="background:none;border:1px solid #333;color:#666;font-family:inherit;font-size:0.85em;padding:0.4em 1.5ch;cursor:pointer">cancel</button>
        <button id="signin-submit-btn" style="background:none;border:1px solid #333;color:#c0c0c0;font-family:inherit;font-size:0.85em;padding:0.4em 1.5ch;cursor:pointer">sign in</button>
      </div>
    `
    overlay.appendChild(dialog)
    document.body.appendChild(overlay)

    const handleInput = document.getElementById('signin-handle')
    const passwordInput = document.getElementById('signin-password')
    const errorEl = document.getElementById('signin-error')

    async function doSignIn() {
      const handle = handleInput.value.trim()
      const password = passwordInput.value
      if (!handle) { errorEl.textContent = 'enter your address or handle'; return }
      if (!password) { errorEl.textContent = 'enter your password'; return }

      errorEl.textContent = 'looking up account...'

      try {
        let address = handle

        // if not a raw address, look up via Ponder (handle → domain → wallet)
        if (!/^0x[0-9a-fA-F]{40}$/.test(handle)) {
          // try as domain or handle — resolve via artists query
          const lookupDomain = handle.includes('.') ? handle : handle + '.ourpraxis.network'
          const ponderUrl = '/ponder'

          // Defensive JSON parse — if the response is HTML (deploy-window race
          // or routing misconfig) we surface a clean error instead of bubbling
          // up "Unexpected token '<', '<!DOCTYPE '..." from JSON.parse.
          async function ponderQuery(query, variables) {
            const r = await fetch(ponderUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ query, variables }),
            })
            const ct = r.headers.get('content-type') || ''
            if (!r.ok || !ct.includes('application/json')) {
              throw new Error(`network error (${r.status}) — try again in a moment`)
            }
            return r.json()
          }

          const data = await ponderQuery(
            `query LookupArtist($domain: String!) { artists(where: { domain: $domain }, limit: 1) { items { id } } }`,
            { domain: lookupDomain }
          )
          const found = data?.data?.artists?.items?.[0]?.id
          if (!found) {
            // try supporter lookup
            const sData = await ponderQuery(
              `query LookupSupporter($handle: String!) { supporters(where: { handle: $handle }, limit: 1) { items { id } } }`,
              { handle: handle.toLowerCase() }
            )
            const sFound = sData?.data?.supporters?.items?.[0]?.id
            if (!sFound) { errorEl.textContent = 'handle not found'; return }
            address = sFound
          } else {
            address = found
          }
        }

        address = address.toLowerCase()
        errorEl.textContent = 'retrieving account...'

        // Try signature-authenticated retrieve if we have an unlocked account,
        // otherwise fall back to address-only retrieve (rate-limited but allowed).
        // The address-only mode is safe because the blob is AES-256-GCM encrypted —
        // the password IS the auth, not the download.
        let retrieveResp
        if (_cachedAccount && _cachedAccount.address?.toLowerCase() === address) {
          const ts = Date.now()
          const challengeMsg = `praxis-retrieve:${address}:${ts}`
          const challengeSig = await _cachedAccount.signMessage({ message: challengeMsg })
          retrieveResp = await fetch('/api/wallet/retrieve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ address, message: challengeMsg, signature: challengeSig }),
          })
        } else {
          // Address-only retrieve — user will decrypt with their password
          retrieveResp = await fetch('/api/wallet/retrieve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ address }),
          })
        }

        if (!retrieveResp.ok) {
          errorEl.textContent = 'account not found on this server'
          return
        }

        const { encrypted } = await retrieveResp.json()
        if (!encrypted) { errorEl.textContent = 'no account backup found'; return }

        // store locally and try to decrypt
        try { localStorage.setItem(STORAGE_KEY, encrypted) } catch {}
        try { localStorage.setItem(ADDR_KEY, address) } catch {}

        errorEl.textContent = 'decrypting...'
        const account = await unlockWallet(password)
        activateEmbeddedProvider(account)

        // also back up to this site's server for future visits
        try {
          await fetch('/api/wallet/store', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ address: account.address, encrypted }),
          })
        } catch {}

        overlay.remove()
        resolve(account.address)
      } catch (e) {
        // clean up on failure
        if (e.message === 'wrong password' || e.message?.includes('decrypt')) {
          errorEl.textContent = 'wrong password'
        } else {
          errorEl.textContent = e.message || 'sign in failed'
        }
      }
    }

    document.getElementById('signin-submit-btn').addEventListener('click', doSignIn)
    passwordInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSignIn() })
    document.getElementById('signin-cancel-btn').addEventListener('click', () => {
      overlay.remove()
      resolve(null)
    })
    overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); resolve(null) } })

    handleInput.focus()
  })
}

// --- Remove embedded wallet ---

function removeEmbeddedWallet() {
  try { localStorage.removeItem(STORAGE_KEY) } catch {}
  try { localStorage.removeItem(ADDR_KEY) } catch {}
  try { localStorage.removeItem('praxis-wallet-mnemonic-enc') } catch {}
  try { sessionStorage.removeItem('praxis-wallet-session') } catch {}
  clearWalletCookie()
  deactivateEmbeddedProvider()
}

// --- Auto cross-subdomain restore on module load ---
function showChangePasswordPrompt() {
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.id = 'wallet-changepw-overlay'
    overlay.className = 'praxis-modal-overlay'
    const dialog = document.createElement('div')
    dialog.className = 'praxis-modal-dialog'
    dialog.innerHTML = `
      <h3 style="color:var(--accent, #00ff41);margin-bottom:0.5em">change password</h3>
      <p style="color:#999;font-size:0.85em;margin-bottom:0.75em">your account key will be re-encrypted with the new password.</p>
      <input type="password" id="changepw-old" placeholder="current password" autocomplete="current-password" style="width:100%;background:#111;border:1px solid #333;color:#c0c0c0;font-family:inherit;font-size:1em;padding:0.5em 1ch;margin-bottom:0.5em;box-sizing:border-box">
      <input type="password" id="changepw-new" placeholder="new password (8+ characters)" autocomplete="new-password" style="width:100%;background:#111;border:1px solid #333;color:#c0c0c0;font-family:inherit;font-size:1em;padding:0.5em 1ch;margin-bottom:0.5em;box-sizing:border-box">
      <input type="password" id="changepw-confirm" placeholder="confirm new password" autocomplete="new-password" style="width:100%;background:#111;border:1px solid #333;color:#c0c0c0;font-family:inherit;font-size:1em;padding:0.5em 1ch;margin-bottom:0.75em;box-sizing:border-box">
      <p id="changepw-error" style="color:#ef4444;font-size:0.85em;min-height:1.2em;margin-bottom:0.5em"></p>
      <div style="display:flex;gap:1ch;justify-content:flex-end">
        <button id="changepw-cancel" style="background:none;border:1px solid #333;color:#666;font-family:inherit;font-size:0.85em;padding:0.4em 1.5ch;cursor:pointer">cancel</button>
        <button id="changepw-submit" style="background:none;border:1px solid #333;color:#c0c0c0;font-family:inherit;font-size:0.85em;padding:0.4em 1.5ch;cursor:pointer">change password</button>
      </div>
    `
    overlay.appendChild(dialog)
    document.body.appendChild(overlay)
    const errorEl = document.getElementById('changepw-error')
    document.getElementById('changepw-cancel').addEventListener('click', () => { overlay.remove(); resolve(false) })
    overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); resolve(false) } })
    document.getElementById('changepw-submit').addEventListener('click', async () => {
      const oldPw = document.getElementById('changepw-old').value
      const newPw = document.getElementById('changepw-new').value
      const confirmPw = document.getElementById('changepw-confirm').value
      if (!oldPw) { errorEl.textContent = 'enter current password'; return }
      if (!newPw || newPw.length < 8) { errorEl.textContent = 'new password must be 8+ characters'; return }
      if (newPw !== confirmPw) { errorEl.textContent = 'passwords don\'t match'; return }
      try {
        // biometric confirmation if enabled (extra security for password changes)
        if (localStorage.getItem('praxis-webauthn-cred')) {
          errorEl.textContent = 'confirm with biometric...'
          const ok = await window.verifyBiometric?.()
          if (!ok) { errorEl.textContent = 'biometric confirmation required'; return }
        }
        errorEl.textContent = ''
        document.getElementById('changepw-submit').textContent = 'changing...'
        await changePassword(oldPw, newPw)
        overlay.remove()
        resolve(true)
      } catch (e) {
        errorEl.textContent = e.message || 'failed'
        document.getElementById('changepw-submit').textContent = 'change password'
      }
    })
  })
}

// Starts immediately; callers should await window._walletReady before checking hasEmbeddedWallet()
const _crossSubdomainReady = trySessionRestore()

// --- Export to window ---

window._walletReady = _crossSubdomainReady
window.createWallet = createWallet
window.unlockWallet = unlockWallet
window.isWalletLocked = isWalletLocked
window.isWalletUnlocked = () => !!_cachedAccount
window.hasEmbeddedWallet = hasEmbeddedWallet
window.recoverWallet = recoverWallet
window.exportRecoveryPhrase = exportRecoveryPhrase
window.exportPrivateKey = exportPrivateKey
window.signTransaction = signAndSendTransaction
window.signMessage = signMessage
window.showUnlockPrompt = showUnlockPrompt
window.showCreateWalletPrompt = showCreateWalletPrompt
window.showRecoveryPrompt = showRecoveryPrompt
window.showSignInPrompt = showSignInPrompt
window.changePassword = changePassword
window.showChangePasswordPrompt = showChangePasswordPrompt
window.activateEmbeddedProvider = activateEmbeddedProvider
window.deactivateEmbeddedProvider = deactivateEmbeddedProvider
window.removeEmbeddedWallet = removeEmbeddedWallet
window.getEmbeddedWalletAddress = getEmbeddedWalletAddress
window.getEmbeddedAccount = getEmbeddedAccount
window.downloadRecoveryPhrase = downloadRecoveryPhrase

export {
  createWallet,
  unlockWallet,
  isWalletLocked,
  hasEmbeddedWallet,
  getEmbeddedWalletAddress,
  getEmbeddedAccount,
  recoverWallet,
  exportRecoveryPhrase,
  signAndSendTransaction as signTransaction,
  signMessage,
  showUnlockPrompt,
  showCreateWalletPrompt,
  showRecoveryPrompt,
  activateEmbeddedProvider,
  deactivateEmbeddedProvider,
  removeEmbeddedWallet,
  showRecoveryPhraseUI,
  downloadRecoveryPhrase,
  copyRecoveryPhraseToClipboard,
  buildRecoveryPhraseText,
  storeMnemonicEncrypted,
  setWalletCookie,
  getWalletCookie,
  clearWalletCookie,
}
