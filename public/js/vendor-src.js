// vendor-src.js — source file for esbuild bundling
// bundles viem imports into a single local vendor.js
// run: node scripts/bundle-vendor.js

export {
  createPublicClient,
  createWalletClient,
  custom,
  encodeFunctionData,
  formatEther,
  http,
  keccak256,
  parseEther,
  toBytes,
} from 'viem'

export { privateKeyToAccount } from 'viem/accounts'

export { scroll, mainnet, arbitrum, optimism, base, polygon } from 'viem/chains'

// QR code generator (~5KB) — used by ramp.js for Cash App / Wise / Revolut payment QR codes
export { default as qrcode } from 'qrcode-generator'
