// GraphQL fragments — centralized field selections for Ponder queries
// Inspired by Relay's fragment pattern. Import and compose into queries.
// When a schema field is added/removed, update here once — all queries update.

// --- Entity fragments ---

export const F = {
  // artist (from artist table)
  artist: 'id domain',
  artistFull: 'id domain registeredAt followerCount followingCount',

  // supporter (from supporter table)
  supporter: 'id handle registeredAt followerCount followingCount',

  // project (from project table)
  projectSummary: 'id proposer title projectType status fundingGoal totalFunded deadline createdAt location',
  projectDetail: 'id proposer title description projectType status fundingGoal totalFunded deadline createdAt completedAt location disputeDeadline',
  projectFull: 'id proposer title description projectType status fundingGoal totalFunded deadline createdAt completedAt revenueShareBps totalRevenue location disputeDeadline',

  // collaborator
  collaborator: 'projectId artist split',

  // tier
  tier: 'id projectId tierId name price maxSupply sold transferable',

  // funding
  funding: 'projectId funder amount timestamp',
  fundingFull: 'projectId funder amount blockNumber timestamp',

  // blog post
  post: 'id author title content timestamp refType refId',
  postSummary: 'id author title content timestamp refType refId',

  // follow
  followOut: 'followed',
  followIn: 'follower',
  followTimestamp: 'follower followed timestamp',

  // credential
  credential: 'id tokenType projectId tierId holder amount tokenId',

  // media listing
  mediaListing: 'id artist title price totalMinted',
  mediaListingFull: 'id artist title ipfsCid metadataCid price maxSupply totalMinted timestamp contentType',

  // media purchase
  mediaPurchase: 'mediaId buyer price timestamp',
  mediaPurchaseFull: 'id mediaId buyer tokenId price timestamp',

  // feed entry (materialized)
  feedEntry: 'id author eventType refId title timestamp',

  // notification (materialized)
  notification: 'id recipient eventType refId fromAddr title amount timestamp read',

  // ticket listing
  ticketListing: 'id tokenId seller price active timestamp',

  // ticket sale
  ticketSale: 'id tokenId seller buyer price timestamp',

  // edge (graph)
  edge: 'id source target type projectId',

  // library item
  libraryItem: 'id contributor title author ipfsCid url tags timestamp',

  // page info (cursor pagination)
  pageInfo: 'pageInfo { endCursor hasNextPage }',
}

// --- Query builders ---

// Build a paginated query with fragment fields
export function paginatedQuery(table, fields, where = '', vars = '', orderBy = 'timestamp', direction = 'desc') {
  const whereClause = where ? `where: { ${where} }` : ''
  const varDecl = vars ? `(${vars}, $after: String)` : '($after: String)'
  return `query ${table}Query${varDecl} {
    ${table}(${whereClause}${whereClause ? ', ' : ''}limit: 100, after: $after, orderBy: "${orderBy}", orderDirection: "${direction}") {
      items { ${fields} }
      ${F.pageInfo}
    }
  }`
}

// Build a simple list query (no pagination)
export function listQuery(table, fields, where = '', vars = '', limit = 50, orderBy = '', direction = 'desc') {
  const whereClause = where ? `where: { ${where} }` : ''
  const orderClause = orderBy ? `, orderBy: "${orderBy}", orderDirection: "${direction}"` : ''
  const varDecl = vars ? `(${vars})` : ''
  return `query ${table}Query${varDecl} {
    ${table}(${whereClause}, limit: ${limit}${orderClause}) {
      items { ${fields} }
    }
  }`
}

// Build an id_in query for batch lookups
export function batchQuery(table, fields, idField = 'id') {
  return `query ${table}Batch($ids: [BigInt!]!) {
    ${table}(where: { ${idField}_in: $ids }, limit: 100) {
      items { ${fields} }
    }
  }`
}
