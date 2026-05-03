// vendor-wallet-src.js — BIP-39/BIP-32 for embedded wallet
// bundles @scure/bip39 + @scure/bip32 (already transitive deps of viem)

export { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39'
export { wordlist } from '@scure/bip39/wordlists/english'
export { HDKey } from '@scure/bip32'
