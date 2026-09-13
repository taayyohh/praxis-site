// Praxis chain constants. Consolidated here so a chain-id, USDC address,
// or RPC route change happens in exactly one place. Import from here
// instead of redeclaring locally.

import { OPTIMISM_CHAIN_ID, BASE_CHAIN_ID, USDC_BASE } from './contracts.js'

// Chain IDs
export const ETHEREUM_CHAIN_ID = 1
export const ARBITRUM_CHAIN_ID = 42161
export const POLYGON_CHAIN_ID = 137
export const ZKSYNC_CHAIN_ID = 324
export { OPTIMISM_CHAIN_ID, BASE_CHAIN_ID }

// Hex-encoded siblings for wallet_switchEthereumChain / EIP-1193 payloads.
export const OPTIMISM_CHAIN_ID_HEX = '0xa'
export const BASE_CHAIN_ID_HEX = '0x2105'
export const ETHEREUM_CHAIN_ID_HEX = '0x1'
export const ARBITRUM_CHAIN_ID_HEX = '0xa4b1'
export const POLYGON_CHAIN_ID_HEX = '0x89'
export const ZKSYNC_CHAIN_ID_HEX = '0x144'

// USDC contracts (6-decimal on every chain)
export const USDC_OPTIMISM = '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85'
export const USDC_ETHEREUM = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
export const USDC_ARBITRUM = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'
export const USDC_POLYGON = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'
export { USDC_BASE }

export const USDC_DECIMALS = 6
export const ETH_DECIMALS = 18

// EVM native-ETH sentinel address (used by Peer.xyz / Relay quote APIs).
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
// Alias for readability at call sites: "ETH_NATIVE" reads as sentinel intent,
// "ZERO_ADDRESS" reads as address literal — same value, both exported.
export const ETH_NATIVE = ZERO_ADDRESS

// Basis-points denominator (10_000 = 100.00% at 2-decimal precision).
export const BPS_DENOMINATOR = 10000n

// Viem-compatible native-currency descriptor. Every "define a viem chain"
// helper copies this object literal; centralize the noise.
export const ETH_NATIVE_CURRENCY = Object.freeze({ name: 'ETH', symbol: 'ETH', decimals: 18 })

// Praxis's server-side RPC proxy. All chains route through `/api/rpc/<chainId>`.
// Callers should build viem `http(...)` transports around this helper so the
// hardcoded path lives in one place.
export function rpcUrlFor(chainId) {
  return `/api/rpc/${chainId}`
}
