// Safe-backed XMTP signer — lets an org (Safe multisig) hold its own
// XMTP inbox. XMTP verifies smart-contract signatures via EIP-1271
// (Safe.isValidSignature). When XMTP asks us to sign a message, we
// personal_sign it with the connected EOA (a Safe owner) and format
// the signature bytes so Safe.checkSignatures accepts them.
//
// Signature format for Safe when the underlying signature came from
// personal_sign (eth_sign flow):
//   [r (32)] [s (32)] [v + 4 (1)]
// Safe sees v > 30, re-prefixes the hash with "\x19Ethereum Signed
// Message:\n32" and recovers the signer with ecrecover, then checks
// the signer is an owner. That's exactly what personal_sign produces
// on the wallet side, so the recovered address will match.
//
// This ships the 1-of-1 case. Multi-sig Safes will need a pending-
// signature aggregation flow (each owner signs; we concatenate their
// r/s/v triples sorted by owner address). Queued as a follow-up.

import { getPublicClient, getWalletProvider } from './utils.js'

const OPTIMISM_CHAIN_ID = 10n

// Build an XMTP SCW-type signer that identifies as `safeAddress` and
// signs by asking the connected EOA (which must be a Safe owner) to
// personal_sign each XMTP request. Returns the signer object the XMTP
// browser SDK expects.
//
// Throws at signMessage time if the connected wallet isn't a Safe
// owner — XMTP retries on failure, so a wrong-signer state surfaces
// as a clear rejection rather than silent breakage.
export async function createSafeXmtpSigner({ safeAddress, ownerAddress, sdk }) {
  if (!safeAddress || !/^0x[0-9a-fA-F]{40}$/.test(safeAddress)) {
    throw new Error('createSafeXmtpSigner: bad safeAddress')
  }
  if (!ownerAddress || !/^0x[0-9a-fA-F]{40}$/.test(ownerAddress)) {
    throw new Error('createSafeXmtpSigner: bad ownerAddress')
  }
  if (!sdk?.IdentifierKind) {
    throw new Error('createSafeXmtpSigner: need XMTP sdk reference')
  }

  return {
    type: 'SCW',
    getIdentifier: () => ({
      identifier: safeAddress,
      identifierKind: sdk.IdentifierKind.Ethereum,
    }),
    getChainId: () => OPTIMISM_CHAIN_ID,
    getBlockNumber: async () => {
      // XMTP verifies the EIP-1271 signature against Safe state at a
      // specific block, so this number matters. Do NOT swallow RPC
      // errors and return 0n — verification against block 0 asks
      // XMTP to prove ownership before the Safe existed and fails
      // opaquely. Propagate the error so XMTP retries and the user
      // sees a real signal that RPC is unreachable.
      const pc = await getPublicClient()
      return pc.getBlockNumber()
    },
    signMessage: async (message) => {
      const provider = getWalletProvider()
      if (!provider) throw new Error('wallet unavailable')
      // XMTP hands us a string; personal_sign wants the same string.
      // The wallet prefixes with "\x19Ethereum Signed Message:\n<len>"
      // before hashing + ECDSA-signing. Safe's checkSignatures with
      // v > 30 re-applies that prefix on the verify side.
      const sigHex = await provider.request({
        method: 'personal_sign',
        params: [message, ownerAddress],
      })
      return _packSafeSignature(sigHex)
    },
  }
}

// Convert a personal_sign hex signature to the byte layout Safe's
// checkSignatures accepts for the eth_sign flow: r + s + (v + 4).
// personal_sign returns 65 hex bytes ordered r || s || v; we adjust
// only v so Safe knows to re-prefix the hash before ecrecover.
function _packSafeSignature(sigHex) {
  if (!sigHex || typeof sigHex !== 'string') throw new Error('bad signature')
  const clean = sigHex.startsWith('0x') ? sigHex.slice(2) : sigHex
  if (clean.length !== 130) throw new Error(`bad signature length: ${clean.length}`)
  const r = clean.slice(0, 64)
  const s = clean.slice(64, 128)
  const vHex = clean.slice(128, 130)
  const v = parseInt(vHex, 16)
  if (Number.isNaN(v)) throw new Error(`bad v byte: ${vHex}`)
  const adjustedV = (v + 4).toString(16).padStart(2, '0')
  // Return as Uint8Array — XMTP SDK expects bytes, not hex.
  const packed = r + s + adjustedV
  const bytes = new Uint8Array(65)
  for (let i = 0; i < 65; i++) {
    bytes[i] = parseInt(packed.substr(i * 2, 2), 16)
  }
  return bytes
}

// Utility: is the connected wallet a signer on this Safe? Same helper
// safe-org.js has, re-exported so messages.js can guard the SCW-signer
// branch without duplicating the ABI or the code.
export async function isSafeSigner(safeAddress, wallet) {
  if (!safeAddress || !wallet) return false
  if (!/^0x[0-9a-fA-F]{40}$/.test(safeAddress)) return false
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) return false
  const { isSafeSigner: check } = await import('./safe-org.js')
  return check(safeAddress, wallet)
}
