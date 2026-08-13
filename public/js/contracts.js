// Shared contract ABIs and addresses — single source of truth
// All client-side modules import from here instead of defining inline

// --- Contract Addresses (Optimism L2, chain 10) ---
// All 9 contracts redeployed to Optimism 2026-04-10.
export const PRAXIS_ADDR = '0x8f5B0D0f0073a1573f17e37746811672aeDDE2F8'
export const INVITES_ADDR = '0x23289c228cA0867122dC8855613858C8C3dc707c'
export const TICKET_MARKET_ADDR = '0x1781666673b6fB22f59229fb120F14bD97d2EdC6'
export const ARTIST_SPONSOR_ADDR = '0xb7A66e7ad464495D22B3A39140BD8d7F10Afb3f7'
export const LIBRARY_ADDR = '0x5CdDD64f20C69fC2007868476788BC3766C28A0A'
export const TREASURY_ADDR = '0x5CF9E88417A7cE08028D32C44F9b63bc3d960b21'
export const TREASURY_ADMIN_ADDR = '0x46db55AD42dA6bA3c29a3C1522EBBF8e16960725'

// Dynamic addresses (from HTML data attributes)
export function getMediaAddress() {
  return document.body.dataset.media || ''
}
export function getRegistryAddress() {
  return document.body.dataset.registry || document.querySelector('[data-registry]')?.dataset?.registry || ''
}

// --- ABIs ---

// ArtistRegistry — follow, unfollow, register, unregister, lookup
export const REGISTRY_ABI = [
  { name: 'follow', type: 'function', inputs: [{ name: 'target', type: 'address' }], outputs: [], stateMutability: 'nonpayable' },
  { name: 'unfollow', type: 'function', inputs: [{ name: 'target', type: 'address' }], outputs: [], stateMutability: 'nonpayable' },
  { name: 'register', type: 'function', inputs: [{ name: 'domain', type: 'string' }, { name: 'signature', type: 'bytes' }], outputs: [], stateMutability: 'payable' },
  { name: 'unregister', type: 'function', inputs: [], outputs: [], stateMutability: 'nonpayable' },
  { name: 'artists', type: 'function', inputs: [{ name: '', type: 'address' }], outputs: [{ name: 'domain', type: 'string' }, { name: 'registeredAt', type: 'uint256' }], stateMutability: 'view' },
  { name: 'updateDomain', type: 'function', inputs: [{ name: 'newDomain', type: 'string' }, { name: 'signature', type: 'bytes' }], outputs: [], stateMutability: 'nonpayable' },
]

// Praxis — project lifecycle, funding, revenue, confirmations, operator approval
export const PRAXIS_ABI = [
  // v2: proposeProject takes a single ProposeProjectArgs tuple. Encoders MUST pass
  // a single object {title, description, projectType, collaborators, splits, ...}
  // matching the field order below — viem encodes tuples positionally by component order.
  { name: 'proposeProject', type: 'function', inputs: [{ name: 'args', type: 'tuple', components: [
    { name: 'title', type: 'string' },
    { name: 'description', type: 'string' },
    { name: 'projectType', type: 'string' },
    { name: 'metadataCid', type: 'string' },
    { name: 'collaborators', type: 'address[]' },
    { name: 'splits', type: 'uint256[]' },
    { name: 'fundingGoal', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'tierNames', type: 'string[]' },
    { name: 'tierPrices', type: 'uint256[]' },
    { name: 'tierMaxSupplies', type: 'uint256[]' },
    { name: 'tierTransferable', type: 'bool[]' },
    { name: 'tierMetadataCids', type: 'string[]' },
    { name: 'tierEventDates', type: 'uint256[]' },
    { name: 'tierLocations', type: 'uint128[]' },
    { name: 'revenueSharePercent', type: 'uint256' },
    { name: 'location', type: 'uint128' },
    { name: 'disputeWindowDays', type: 'uint256' },
    { name: 'autoComplete', type: 'bool' },
    { name: 'confirmationMode', type: 'uint8' },
    { name: 'milestoneDescriptions', type: 'string[]' },
    { name: 'milestoneBps', type: 'uint256[]' },
  ]}], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'nonpayable' },
  // v2: pull-pattern invite claim — replaces auto-push on finalize/autoComplete
  { name: 'claimCompletionInvites', type: 'function', inputs: [{ type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { name: 'completionInviteClaimed', type: 'function', inputs: [{ type: 'uint256' }, { type: 'address' }], outputs: [{ type: 'bool' }], stateMutability: 'view' },
  { name: 'getFunderSerials', type: 'function', inputs: [{ type: 'uint256' }, { type: 'uint256' }, { type: 'address' }], outputs: [{ type: 'uint256[]' }], stateMutability: 'view' },
  { name: 'cancelProject', type: 'function', inputs: [{ type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { name: 'confirmProject', type: 'function', inputs: [{ type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { name: 'completeProject', type: 'function', inputs: [{ type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { name: 'finalizeProject', type: 'function', inputs: [{ type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { name: 'dispute', type: 'function', inputs: [{ type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { name: 'submitMilestone', type: 'function', inputs: [{ type: 'uint256' }, { type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { name: 'disputeMilestone', type: 'function', inputs: [{ type: 'uint256' }, { type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { name: 'releaseMilestone', type: 'function', inputs: [{ type: 'uint256' }, { type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { name: 'milestoneCount', type: 'function', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { name: 'getMilestone', type: 'function', inputs: [{ type: 'uint256' }, { type: 'uint256' }], outputs: [{ name: 'description', type: 'string' }, { name: 'bps', type: 'uint256' }, { name: 'status', type: 'uint8' }, { name: 'submittedAt', type: 'uint256' }], stateMutability: 'view' },
  { name: 'releasedFunds', type: 'function', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { name: 'getDisputeWindowDays', type: 'function', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { name: 'deployerCancel', type: 'function', inputs: [{ type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { name: 'fundTier', type: 'function', inputs: [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], outputs: [], stateMutability: 'payable' },
  { name: 'claimFunds', type: 'function', inputs: [], outputs: [], stateMutability: 'nonpayable' },
  { name: 'claimRefund', type: 'function', inputs: [{ type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { name: 'hasConfirmed', type: 'function', inputs: [{ type: 'uint256' }, { type: 'address' }], outputs: [{ type: 'bool' }], stateMutability: 'view' },
  { name: 'distributeRevenue', type: 'function', inputs: [{ type: 'uint256' }], outputs: [], stateMutability: 'payable' },
  { name: 'claimRevenue', type: 'function', inputs: [{ type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { name: 'pendingRevenueFor', type: 'function', inputs: [{ type: 'uint256' }, { type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { name: 'revenueShareBps', type: 'function', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { name: 'totalRevenue', type: 'function', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { name: 'contributions', type: 'function', inputs: [{ type: 'uint256' }, { type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { name: 'pendingWithdrawals', type: 'function', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { name: 'setOperator', type: 'function', inputs: [{ type: 'address' }, { type: 'bool' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' },
  { name: 'isOperator', type: 'function', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'bool' }], stateMutability: 'view' },
  { name: 'balanceOf', type: 'function', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { name: 'updateProject', type: 'function', inputs: [{ name: 'projectId', type: 'uint256' }, { name: 'title', type: 'string' }, { name: 'description', type: 'string' }, { name: 'projectType', type: 'string' }, { name: 'metadataCid', type: 'string' }], outputs: [], stateMutability: 'nonpayable' },
  { name: 'updateTier', type: 'function', inputs: [{ name: 'projectId', type: 'uint256' }, { name: 'tierId', type: 'uint256' }, { name: 'name', type: 'string' }, { name: 'metadataCid', type: 'string' }, { name: 'eventDate', type: 'uint256' }, { name: 'location', type: 'uint128' }], outputs: [], stateMutability: 'nonpayable' },
  { name: 'checkIn', type: 'function', inputs: [{ name: 'projectId', type: 'uint256' }, { name: 'tokenId', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { name: 'checkedIn', type: 'function', inputs: [{ name: '', type: 'uint256' }], outputs: [{ type: 'bool' }], stateMutability: 'view' },
  { name: 'timeoutProject', type: 'function', inputs: [{ name: 'projectId', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { name: 'migrateProject', type: 'function', inputs: [{ name: 'args', type: 'tuple', components: [
    { name: 'proposer', type: 'address' },
    { name: 'title', type: 'string' },
    { name: 'description', type: 'string' },
    { name: 'projectType', type: 'string' },
    { name: 'metadataCid', type: 'string' },
    { name: 'status', type: 'uint8' },
    { name: 'collaborators', type: 'address[]' },
    { name: 'splits', type: 'uint256[]' },
    { name: 'fundingGoal', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'createdAt', type: 'uint256' },
    { name: 'tierEventDates', type: 'uint256[]' },
    { name: 'tierLocations', type: 'uint128[]' },
  ]}], outputs: [], stateMutability: 'nonpayable' },
  { name: 'migrationLocked', type: 'function', inputs: [], outputs: [{ type: 'bool' }], stateMutability: 'view' },
  { name: 'lockMigration', type: 'function', inputs: [], outputs: [], stateMutability: 'nonpayable' },
]

// BlogRegistry — post, postWithRef
export const BLOG_ABI = [
  { name: 'post', type: 'function', inputs: [{ name: 'title', type: 'string' }, { name: 'content', type: 'string' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'nonpayable' },
  { name: 'postWithRef', type: 'function', inputs: [{ name: 'title', type: 'string' }, { name: 'content', type: 'string' }, { name: 'refType', type: 'uint8' }, { name: 'refId', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'nonpayable' },
]

// PraxisMedia — list, purchase, manage, withdraw
export const MEDIA_ABI = [
  { name: 'list', type: 'function', inputs: [{ name: 'title', type: 'string' }, { name: 'ipfsCid', type: 'string' }, { name: 'metadataCid', type: 'string' }, { name: 'price', type: 'uint256' }, { name: 'maxSupply', type: 'uint256' }, { name: 'collaborators', type: 'address[]' }, { name: 'splits', type: 'uint256[]' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'nonpayable' },
  { name: 'purchase', type: 'function', inputs: [{ name: 'mediaId', type: 'uint256' }], outputs: [], stateMutability: 'payable' },
  { name: 'setPrice', type: 'function', inputs: [{ name: 'mediaId', type: 'uint256' }, { name: 'newPrice', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { name: 'withdraw', type: 'function', inputs: [], outputs: [], stateMutability: 'nonpayable' },
  { name: 'media', type: 'function', inputs: [{ name: 'mediaId', type: 'uint256' }], outputs: [{ name: 'artist', type: 'address' }, { name: 'title', type: 'string' }, { name: 'ipfsCid', type: 'string' }, { name: 'metadataCid', type: 'string' }, { name: 'price', type: 'uint256' }, { name: 'maxSupply', type: 'uint256' }, { name: 'totalMinted', type: 'uint256' }], stateMutability: 'view' },
  { name: 'getMediaByArtist', type: 'function', inputs: [{ name: 'artist', type: 'address' }], outputs: [{ name: '', type: 'uint256[]' }], stateMutability: 'view' },
  { name: 'getCollaborators', type: 'function', inputs: [{ name: 'mediaId', type: 'uint256' }], outputs: [{ name: '', type: 'address[]' }, { name: '', type: 'uint256[]' }], stateMutability: 'view' },
  { name: 'balanceOf', type: 'function', inputs: [{ name: 'owner', type: 'address' }, { name: 'id', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { name: 'pendingWithdrawals', type: 'function', inputs: [{ name: 'addr', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { name: 'mediaCount', type: 'function', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { name: 'setMaxSupply', type: 'function', inputs: [{ name: 'mediaId', type: 'uint256' }, { name: 'newMax', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { name: 'listBatch', type: 'function', inputs: [{ name: 'entries', type: 'tuple[]', components: [
    { name: 'title', type: 'string' },
    { name: 'ipfsCid', type: 'string' },
    { name: 'metadataCid', type: 'string' },
    { name: 'price', type: 'uint256' },
    { name: 'maxSupply', type: 'uint256' },
    { name: 'collaborators', type: 'address[]' },
    { name: 'splits', type: 'uint256[]' },
  ]}], outputs: [{ name: 'ids', type: 'uint256[]' }], stateMutability: 'nonpayable' },
  { name: 'purchaseBatch', type: 'function', inputs: [{ name: 'mediaIds', type: 'uint256[]' }], outputs: [], stateMutability: 'payable' },
]

// PraxisInvites v2 — orchestrator-signed useInvite, Merkle migration claim
export const INVITES_ABI = [
  // v2: useInvite now requires (code, expiry, nonce, orchSig) — orchestrator signs
  // an EIP-712 authorization binding (codeHash, msg.sender, expiry, nonce). The
  // orchestrator service exposes this via /api/sign-use-invite.
  { name: 'useInvite', type: 'function', inputs: [
    { name: 'code', type: 'string' },
    { name: 'expiry', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
    { name: 'orchSig', type: 'bytes' },
  ], outputs: [], stateMutability: 'nonpayable' },
  { name: 'invitesRemaining', type: 'function', inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  // v2: trustless one-time self-claim of `invitesPerRegistration` invites for any
  // registered artist. Frontend auto-calls this immediately after register().
  { name: 'claimInitialInvites', type: 'function', inputs: [], outputs: [], stateMutability: 'nonpayable' },
  { name: 'initialClaimed', type: 'function', inputs: [{ type: 'address' }], outputs: [{ type: 'bool' }], stateMutability: 'view' },
  { name: 'createInvite', type: 'function', inputs: [{ name: 'codeHash', type: 'bytes32' }], outputs: [], stateMutability: 'nonpayable' },
  { name: 'createInvites', type: 'function', inputs: [{ name: 'codeHashes', type: 'bytes32[]' }], outputs: [], stateMutability: 'nonpayable' },
  { name: 'inviteCodeOwner', type: 'function', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { name: 'codeUsed', type: 'function', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'bool' }], stateMutability: 'view' },
  { name: 'invitedBy', type: 'function', inputs: [{ type: 'address' }], outputs: [{ type: 'address' }], stateMutability: 'view' },
  // v2: Merkle migration of v1 invitesRemaining balances. Anyone can submit a proof
  // on any artist's behalf — the balance lands in the artist's mapping. Window closes
  // 7 days after deploy at `migrationDeadline`.
  { name: 'claimMigration', type: 'function', inputs: [
    { name: 'artist', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'proof', type: 'bytes32[]' },
  ], outputs: [], stateMutability: 'nonpayable' },
  { name: 'migrationClaimed', type: 'function', inputs: [{ type: 'address' }], outputs: [{ type: 'bool' }], stateMutability: 'view' },
  { name: 'migrationRoot', type: 'function', inputs: [], outputs: [{ type: 'bytes32' }], stateMutability: 'view' },
  { name: 'migrationDeadline', type: 'function', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { name: 'paused', type: 'function', inputs: [], outputs: [{ type: 'bool' }], stateMutability: 'view' },
  { name: 'DOMAIN_SEPARATOR', type: 'function', inputs: [], outputs: [{ type: 'bytes32' }], stateMutability: 'view' },
]

// PraxisTicketMarket — list, purchase, cancel, withdraw
export const TICKET_MARKET_ABI = [
  { name: 'list', type: 'function', inputs: [{ type: 'uint256' }, { type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { name: 'purchase', type: 'function', inputs: [{ type: 'uint256' }], outputs: [], stateMutability: 'payable' },
  { name: 'cancel', type: 'function', inputs: [{ type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { name: 'updatePrice', type: 'function', inputs: [{ type: 'uint256' }, { type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { name: 'withdraw', type: 'function', inputs: [], outputs: [], stateMutability: 'nonpayable' },
  { name: 'listings', type: 'function', inputs: [{ type: 'uint256' }], outputs: [{ name: 'seller', type: 'address' }, { name: 'price', type: 'uint256' }, { name: 'active', type: 'bool' }], stateMutability: 'view' },
  { name: 'pendingWithdrawals', type: 'function', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { name: 'listingCount', type: 'function', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
]

// ArtistSponsoredInvites v3 — orchestrator-signed redeem + optional per-slot domain budget
export const ARTIST_SPONSOR_ABI = [
  { name: 'deposit', type: 'function', inputs: [
    { name: 'count', type: 'uint256' },
    { name: 'domainBudgetPerSlot', type: 'uint256' },
  ], outputs: [], stateMutability: 'payable' },
  { name: 'sponsorInvite', type: 'function', inputs: [{ name: 'codeHash', type: 'bytes32' }], outputs: [], stateMutability: 'nonpayable' },
  { name: 'sponsorInvites', type: 'function', inputs: [{ name: 'codeHashes', type: 'bytes32[]' }], outputs: [], stateMutability: 'nonpayable' },
  // v2: redeem now requires (code, expiry, nonce, orchSig) — orchestrator signs an EIP-712
  // authorization binding (codeHash, msg.sender, expiry, nonce). Recipient front-running
  // is impossible because the signature locks msg.sender. Get the sig from
  // /api/sign-sponsor-redeem on the orchestrator.
  { name: 'redeem', type: 'function', inputs: [
    { name: 'code', type: 'string' },
    { name: 'expiry', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
    { name: 'orchSig', type: 'bytes' },
  ], outputs: [], stateMutability: 'nonpayable' },
  { name: 'refundSlots', type: 'function', inputs: [{ name: 'count', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { name: 'revokeInvite', type: 'function', inputs: [{ name: 'codeHash', type: 'bytes32' }], outputs: [], stateMutability: 'nonpayable' },
  { name: 'availableSlots', type: 'function', inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { name: 'sponsorOf', type: 'function', inputs: [{ name: '', type: 'bytes32' }], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' },
  { name: 'redeemed', type: 'function', inputs: [{ name: '', type: 'bytes32' }], outputs: [{ name: '', type: 'bool' }], stateMutability: 'view' },
  { name: 'activeSponsor', type: 'function', inputs: [{ name: 'codeHash', type: 'bytes32' }], outputs: [{ name: 'sponsor', type: 'address' }], stateMutability: 'view' },
  { name: 'sponsorAmount', type: 'function', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { name: 'gasBuffer', type: 'function', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { name: 'paused', type: 'function', inputs: [], outputs: [{ type: 'bool' }], stateMutability: 'view' },
  // v3: per-slot domain budget cap (deployer-settable). Frontend reads to compute UX cap.
  { name: 'maxDomainBudget', type: 'function', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { name: 'depositedSponsorAmount', type: 'function', inputs: [{ name: '', type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { name: 'setMaxDomainBudget', type: 'function', inputs: [{ name: '_max', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { name: 'DOMAIN_SEPARATOR', type: 'function', inputs: [], outputs: [{ type: 'bytes32' }], stateMutability: 'view' },
]

// PraxisOrganization — orgs, members, management
export const ORG_ADDRESS = '0x23045DF374874274497541cCF34945069447e01F'
export const ORG_ABI = [
  // Lifecycle
  { name: 'createOrg', type: 'function', inputs: [{ name: 'name', type: 'string' }, { name: 'metadataCid', type: 'string' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'nonpayable' },
  { name: 'dissolveOrg', type: 'function', inputs: [{ name: 'orgId', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  // Bidirectional consent membership
  { name: 'inviteMember', type: 'function', inputs: [{ name: 'orgId', type: 'uint256' }, { name: 'wallet', type: 'address' }], outputs: [], stateMutability: 'nonpayable' },
  { name: 'revokeInvite', type: 'function', inputs: [{ name: 'orgId', type: 'uint256' }, { name: 'wallet', type: 'address' }], outputs: [], stateMutability: 'nonpayable' },
  { name: 'acceptInvite', type: 'function', inputs: [{ name: 'orgId', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { name: 'declineInvite', type: 'function', inputs: [{ name: 'orgId', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { name: 'leaveOrg', type: 'function', inputs: [{ name: 'orgId', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { name: 'removeMember', type: 'function', inputs: [{ name: 'orgId', type: 'uint256' }, { name: 'wallet', type: 'address' }], outputs: [], stateMutability: 'nonpayable' },
  // Metadata + admin
  { name: 'updateMetadata', type: 'function', inputs: [{ name: 'orgId', type: 'uint256' }, { name: 'newCid', type: 'string' }], outputs: [], stateMutability: 'nonpayable' },
  { name: 'updateDomain', type: 'function', inputs: [{ name: 'orgId', type: 'uint256' }, { name: 'domain', type: 'string' }], outputs: [], stateMutability: 'nonpayable' },
  { name: 'transferAdmin', type: 'function', inputs: [{ name: 'orgId', type: 'uint256' }, { name: 'newAdmin', type: 'address' }], outputs: [], stateMutability: 'nonpayable' },
  // Views
  { name: 'orgs', type: 'function', inputs: [{ name: '', type: 'uint256' }], outputs: [{ name: 'name', type: 'string' }, { name: 'domain', type: 'string' }, { name: 'metadataCid', type: 'string' }, { name: 'admin', type: 'address' }, { name: 'createdAt', type: 'uint256' }, { name: 'dissolved', type: 'bool' }], stateMutability: 'view' },
  { name: 'getMembers', type: 'function', inputs: [{ name: 'orgId', type: 'uint256' }], outputs: [{ name: '', type: 'address[]' }], stateMutability: 'view' },
  { name: 'memberCount', type: 'function', inputs: [{ name: 'orgId', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { name: 'isMember', type: 'function', inputs: [{ name: '', type: 'uint256' }, { name: '', type: 'address' }], outputs: [{ name: '', type: 'bool' }], stateMutability: 'view' },
  { name: 'isInvited', type: 'function', inputs: [{ name: '', type: 'uint256' }, { name: '', type: 'address' }], outputs: [{ name: '', type: 'bool' }], stateMutability: 'view' },
  { name: 'orgCount', type: 'function', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { name: 'getOrgsByMember', type: 'function', inputs: [{ name: 'wallet', type: 'address' }], outputs: [{ name: '', type: 'uint256[]' }], stateMutability: 'view' },
]

export const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
export const WETH_BASE = '0x4200000000000000000000000000000000000006'
export const BASE_CHAIN_ID = 8453
export const OPTIMISM_CHAIN_ID = 10

// LibraryRegistry — addItem, tagItem
export const LIBRARY_ABI = [
  { name: 'addItem', type: 'function', inputs: [{ name: 'title', type: 'string' }, { name: 'author', type: 'string' }, { name: 'ipfsCid', type: 'string' }, { name: 'url', type: 'string' }, { name: 'tags', type: 'string' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'nonpayable' },
  { name: 'tagItem', type: 'function', inputs: [{ name: 'itemId', type: 'uint256' }, { name: 'tags', type: 'string' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'nonpayable' },
]
