// Zod schemas for server-side request body validation
import { z } from 'zod'

const ethAddress = z.string({ error: 'address required' }).regex(/^0x[0-9a-fA-F]{40}$/, 'invalid address')
const hexSig = z.string({ error: 'signature required' }).min(1, 'signature required')

// --- Wallet routes ---
export const WalletStoreSchema = z.object({
  address: ethAddress,
  encrypted: z.string({ error: 'address and encrypted required' }).min(1, 'encrypted required'),
})

// /api/wallet/retrieve accepts three auth modes:
// (a) signed challenge `{ address, message, signature }` — caller has the key
// (b) HMAC restore token `{ address, restoreToken }` — cross-Praxis bridge flow
// (c) address-only `{ address }` — user signing in for the first time, rate-limited
// All auth fields are optional. Address is the only required field.
// Security for mode (c) relies on: rate limiting (3/min + 20/day per IP) +
// AES-256-GCM encryption on the blob (password IS the auth).
export const WalletRetrieveSchema = z.object({
  address: ethAddress,
  message: z.string().min(1).optional(),
  signature: hexSig.optional(),
  restoreToken: z.string().min(1).max(512).optional(),
})

// /api/wallet/restore-token issues a short-lived HMAC token used by the
// wallet-bridge iframe to authorize cross-Praxis wallet restore. Strict
// origin check + rate limit make this bot-resistant.
export const WalletRestoreTokenSchema = z.object({
  address: ethAddress,
})

export const WalletLinkSchema = z.object({
  primary: ethAddress,
  secondary: ethAddress,
  primarySig: hexSig,
  secondarySig: hexSig,
})

// --- Auth ---
export const AuthSchema = z.object({
  address: z.string({ error: 'missing address, signature, or message' }).min(1, 'missing address, signature, or message'),
  signature: z.string({ error: 'missing address, signature, or message' }).min(1, 'missing address, signature, or message'),
  message: z.string({ error: 'missing address, signature, or message' }).min(1, 'missing address, signature, or message'),
})

// --- Journal ---
export const JournalPostSchema = z.object({
  filename: z.string({ error: 'missing filename or content' }).min(1, 'missing filename or content').max(255, 'filename too long'),
  content: z.string({ error: 'missing filename or content' }).min(1, 'missing filename or content'),
})

export const JournalPutSchema = z.object({
  content: z.string({ error: 'content required' }).min(1, 'content required'),
})

export const JournalPatchSchema = z.object({
  archived: z.boolean({ error: 'archived must be a boolean' }),
})

export const BookmarksPutSchema = z.object({
  data: z.string({ error: 'missing data' }).min(1, 'missing data'),
})

// --- Blog ---
export const BlogPostSchema = z.object({
  filename: z.string({ error: 'filename required' }).min(1, 'filename required').max(255, 'filename too long'),
  content: z.string({ error: 'content required' }).min(1, 'content required'),
})

export const BlogPutSchema = z.object({
  content: z.string({ error: 'content required' }).min(1, 'content required'),
})

export const ReadingPutSchema = z.array(z.object({
  title: z.string().max(500).optional(),
  author: z.string().max(200).optional(),
  url: z.string().max(2000).optional(),
}).passthrough()).max(500) // reading list: array of items, max 500 entries

// --- Site ---
export const SitePutSchema = z.object({
  name: z.string({ error: 'name is required and must be a non-empty string' }).min(1, 'name is required and must be a non-empty string'),
  handle: z.string({ error: 'handle is required and must be a non-empty string' }).min(1, 'handle is required and must be a non-empty string'),
  domain: z.string({ error: 'domain is required and must be a non-empty string' }).min(1, 'domain is required and must be a non-empty string'),
  wallet: ethAddress,
  bio: z.string().optional(),
  nav: z.any().optional(),
  network: z.any().optional(),
  media: z.any().optional(),
  theme: z.object({
    bg: z.string().regex(/^#[0-9a-fA-F]{3,8}$/).optional(),
    fg: z.string().regex(/^#[0-9a-fA-F]{3,8}$/).optional(),
    accent: z.string().regex(/^#[0-9a-fA-F]{3,8}$/).optional(),
    font: z.string().regex(/^[a-zA-Z0-9\s,'\-]+$/).max(200).optional(),
  }).passthrough().optional(),
  modules: z.array(z.object({
    type: z.string().regex(/^[a-z]+$/).max(30),
  }).passthrough()).max(30).optional(),
  highlights: z.any().optional(),
  template: z.string().optional(),
  links: z.any().optional(),
  inviteCode: z.string().optional(),
  supporterMode: z.boolean().optional(),
  supporter: z.boolean().optional(),
  xmtp: z.any().optional(),
  cv: z.any().optional(),
  collaboration: z.any().optional(),
  music: z.any().optional(),
}).passthrough()

// --- Feed (POST body) ---
export const FeedPostSchema = z.object({
  query: z.string({ error: 'query required' }).min(1, 'query required'),
  variables: z.record(z.any()).optional(),
})

// --- Materialized endpoints ---
export const ArtistsResolveSchema = z.object({
  addresses: z.array(z.string(), { error: 'addresses array required' }).min(1, 'addresses array required').max(200, 'max 200 addresses'),
})

export const FeedTimelineSchema = z.object({
  authors: z.array(z.string(), { error: 'authors array required' }).min(1, 'authors array required').max(100, 'max 100 authors'),
  after: z.string().nullable().optional(),
})

// --- Project groups ---
export const ProjectGroupSchema = z.object({
  groupId: z.string().optional(),
  teamGroupId: z.string().optional(),
  communityGroupId: z.string().optional(),
}).refine(d => d.groupId || d.teamGroupId || d.communityGroupId, 'at least one group ID required')

// --- Collaborations ---
export const CollaborationCreateSchema = z.object({
  itemType: z.string({ error: 'itemType required' }).min(1, 'itemType required').max(50),
  itemTitle: z.string({ error: 'itemTitle required' }).min(1, 'itemTitle required').max(500),
  itemData: z.record(z.any()).optional(),
  collaboratorDomain: z.string({ error: 'collaboratorDomain required' }).min(1, 'collaboratorDomain required').max(253),
})

export const CollaborationUpdateSchema = z.object({
  status: z.enum(['accepted', 'dismissed'], { error: 'status must be "accepted" or "dismissed"' }),
})

// --- Reload tenant ---
export const ReloadTenantSchema = z.object({
  handle: z.string({ error: 'invalid handle' }).regex(/^[a-z0-9_-]+$/, 'invalid handle'),
})

// --- Orchestrator ---
export const OrchestratorDeploySchema = z.object({
  wallet: ethAddress,
  domain: z.string({ error: 'missing required fields: wallet, domain' }).min(1, 'missing required fields: wallet, domain'),
  handle: z.string().optional(),
  name: z.string().optional(),
  bio: z.string().optional(),
  txHash: z.string().optional(),
  signature: z.string().optional(),
  message: z.string().optional(),
  template: z.string().optional(),
})

export const OrchestratorDomainsRegisterSchema = z.object({
  domain: z.string({ error: 'missing required fields' }).min(1, 'missing required fields'),
  wallet: ethAddress,
  contactInfo: z.any().optional(),
  name: z.string().optional(),
  bio: z.string().optional(),
  signature: z.string({ error: 'missing signature or message' }).min(1, 'missing signature or message'),
  message: z.string({ error: 'missing signature or message' }).min(1, 'missing signature or message'),
  template: z.string().optional(),
})

export const OrchestratorSponsorDeploySchema = z.object({
  wallet: z.string({ error: 'missing or invalid wallet' }).regex(/^0x[a-fA-F0-9]{40}$/, 'missing or invalid wallet'),
  code: z.string({ error: 'missing code' }).min(1, 'missing code'),
  domainCostEth: z.string().optional(),
})

export const OrchestratorRenewSchema = z.object({
  domain: z.string({ error: 'missing required fields: domain, txHash, address' }).min(1, 'missing required fields: domain, txHash, address'),
  txHash: z.string({ error: 'missing required fields: domain, txHash, address' }).min(1, 'missing required fields: domain, txHash, address'),
  address: z.string({ error: 'missing required fields: domain, txHash, address' }).min(1, 'missing required fields: domain, txHash, address'),
})

export const OrchestratorVerifyPaymentSchema = z.object({
  txHash: z.string({ error: 'missing txHash' }).min(1, 'missing txHash'),
})

export const OrchestratorSupporterSetupSchema = z.object({
  handle: z.string({ error: 'missing or invalid handle/wallet' }).min(1, 'missing or invalid handle/wallet'),
  wallet: z.string({ error: 'missing or invalid handle/wallet' }).regex(/^0x[a-fA-F0-9]{40}$/, 'missing or invalid handle/wallet'),
})

export const OrchestratorSponsorGasSchema = z.object({
  wallet: z.string({ error: 'missing or invalid wallet' }).regex(/^0x[a-fA-F0-9]{40}$/, 'missing or invalid wallet'),
  handle: z.string().optional(),
})

export const OrchestratorSponsoredInvitesSchema = z.object({
  codes: z.array(z.string().min(3), { error: 'codes must be a non-empty array' }).min(1, 'codes must be a non-empty array'),
  maxUses: z.number().int().positive().optional(),
})

// v2 EIP-712 signing endpoints — orchestrator signs (codeHash, recipient, expiry, nonce)
// to bind a redemption to a specific msg.sender, blocking mempool front-running.
export const OrchestratorSignUseInviteSchema = z.object({
  code: z.string({ error: 'missing code' }).min(1, 'missing code').max(256, 'code too long'),
  invitee: z.string({ error: 'missing or invalid invitee' }).regex(/^0x[a-fA-F0-9]{40}$/, 'missing or invalid invitee'),
})

export const OrchestratorSignSponsorRedeemSchema = z.object({
  code: z.string({ error: 'missing code' }).min(1, 'missing code').max(256, 'code too long'),
  recipient: z.string({ error: 'missing or invalid recipient' }).regex(/^0x[a-fA-F0-9]{40}$/, 'missing or invalid recipient'),
})

// Helper: run safeParse and return { data } or { error, status }
export function validate(schema, data) {
  const result = schema.safeParse(data)
  if (!result.success) {
    return { error: result.error.issues[0]?.message || 'invalid input', status: 400 }
  }
  return { data: result.data }
}
