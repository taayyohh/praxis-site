// vendor-cash-src.js — bundles @zkp2p/cash (Peer Cash offramp SDK)
// plus @relayprotocol/relay-sdk. Loaded lazily by cashout.js the
// first time a user opens the sheet.
//
// Both are re-exported so the sheet can build a "bare" RelayClient
// (source undefined) and inject it via `relay: { client }` into
// createCashClient. This bypasses Relay's UNAUTHORIZED_QUOTE gate on
// named referrers — the default Peer SDK sends `referrer: "peer-
// cash"`, which Relay 401s unless a Relay API key is provided, and
// our integrator key is a Peer/ZKP2P key, not a Relay one. Anonymous
// (no-referrer) requests are still ungated. Long-term the right fix
// is Peer.xyz publishing a Relay key with their SDK; this ships us
// today.
export * from '@zkp2p/cash'
export { createClient as createRelayClient, MAINNET_RELAY_API } from '@relayprotocol/relay-sdk'
