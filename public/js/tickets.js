// PraxisTicketMarket — list, purchase, cancel, and manage ticket resale on-chain
import { parseEther } from './vendor.js'
import { query } from './ponder.js'
import { ensureWallet, ensureFundsForPurchase, formatTxError, getPublicClient, getWalletProvider, getWalletClient } from './utils.js'
import { t } from './i18n.js'

import { TICKET_MARKET_ADDR, TICKET_MARKET_ABI, PRAXIS_ADDR, PRAXIS_ABI } from './contracts.js'
const PRAXIS_APPROVAL_ABI = PRAXIS_ABI

// --- Exported contract interactions ---

export async function listTicket(tokenId, priceWei) {
  const addr = await ensureWallet()
  if (!addr) throw new Error(t('status.connectWallet'))
  if (!await window.ensureOptimism?.()) return

  const pc = await getPublicClient()
  const currentAccount = await window.ensureAuthorized?.() || addr
  const wc = getWalletClient()

  // check operator approval
  const approved = await pc.readContract({
    address: PRAXIS_ADDR, abi: PRAXIS_APPROVAL_ABI,
    functionName: 'isOperator', args: [currentAccount, TICKET_MARKET_ADDR],
  })

  if (!approved) {
    // prompt setOperator approval
    const approveHash = await wc.writeContract({
      address: PRAXIS_ADDR, abi: PRAXIS_APPROVAL_ABI,
      functionName: 'setOperator', args: [TICKET_MARKET_ADDR, true],
      account: currentAccount,
    })
    await pc.waitForTransactionReceipt({ hash: approveHash })
  }

  const hash = await wc.writeContract({
    address: TICKET_MARKET_ADDR, abi: TICKET_MARKET_ABI,
    functionName: 'list', args: [BigInt(tokenId), BigInt(priceWei)],
    account: currentAccount,
  })
  await pc.waitForTransactionReceipt({ hash })
  return hash
}

export async function purchaseTicket(tokenId, priceWei) {
  const addr = await ensureFundsForPurchase(priceWei)
  if (!addr) throw new Error(t('status.connectWallet'))

  const purchaseAccount = await window.ensureAuthorized?.() || addr
  const wc = getWalletClient()
  const hash = await wc.writeContract({
    address: TICKET_MARKET_ADDR, abi: TICKET_MARKET_ABI,
    functionName: 'purchase', args: [BigInt(tokenId)],
    value: BigInt(priceWei),
    account: purchaseAccount,
  })
  const pc = await getPublicClient()
  await pc.waitForTransactionReceipt({ hash })
  return hash
}

export async function cancelTicketListing(tokenId) {
  const addr = await ensureWallet()
  if (!addr) throw new Error(t('status.connectWallet'))
  if (!await window.ensureOptimism?.()) return

  const cancelAccount = await window.ensureAuthorized?.() || addr
  const wc = getWalletClient()
  const hash = await wc.writeContract({
    address: TICKET_MARKET_ADDR, abi: TICKET_MARKET_ABI,
    functionName: 'cancel', args: [BigInt(tokenId)],
    account: cancelAccount,
  })
  const pc = await getPublicClient()
  await pc.waitForTransactionReceipt({ hash })
  return hash
}

export async function withdrawTicketEarnings() {
  const addr = await ensureWallet()
  if (!addr) throw new Error(t('status.connectWallet'))
  if (!await window.ensureOptimism?.()) return

  const withdrawAccount = await window.ensureAuthorized?.() || addr
  const wc = getWalletClient()
  const hash = await wc.writeContract({
    address: TICKET_MARKET_ADDR, abi: TICKET_MARKET_ABI,
    functionName: 'withdraw', args: [],
    account: withdrawAccount,
  })
  const pc = await getPublicClient()
  await pc.waitForTransactionReceipt({ hash })
  return hash
}

export async function getTicketPendingWithdrawals(addr) {
  const pc = await getPublicClient()
  return await pc.readContract({
    address: TICKET_MARKET_ADDR, abi: TICKET_MARKET_ABI,
    functionName: 'pendingWithdrawals', args: [addr],
  })
}

export async function getTicketListingsForProject(projectId) {
  const pc = await getPublicClient()

  // query Ponder for credentials where projectId matches and tokenType=1 (TICKET)
  try {
    const data = await query(`
      query TicketCredentials($projectId: BigInt!) {
        credentials(where: { projectId: $projectId, tokenType: 1 }, limit: 100) {
          items { id projectId tierId holder amount tokenId }
        }
      }
    `, { projectId: String(projectId) })

    const creds = (data.credentials?.items || []).filter(c => c.tokenId) // only creds with resolved tokenId
    if (creds.length === 0) return []

    // check on-chain listing status for each tokenId
    const calls = creds.map(c => ({
      address: TICKET_MARKET_ADDR, abi: TICKET_MARKET_ABI,
      functionName: 'listings', args: [BigInt(c.tokenId)],
    }))
    const results = await pc.multicall({ contracts: calls, allowFailure: true })

    const listings = []
    for (let i = 0; i < creds.length; i++) {
      const r = results[i]
      if (r.status !== 'success') continue
      const [seller, price, active] = r.result
      if (active) {
        listings.push({
          tokenId: creds[i].tokenId,
          seller,
          price,
          holder: creds[i].holder,
        })
      }
    }
    return listings
  } catch (e) {
    console.warn('getTicketListingsForProject error:', e)
    return []
  }
}

export { TICKET_MARKET_ADDR, TICKET_MARKET_ABI, PRAXIS_ADDR, PRAXIS_APPROVAL_ABI }
