// Post page — renders a single on-chain blog post from Ponder
import { F } from './fragments.js'
import { query } from './ponder.js'
import { escapeHtml, resolveAddresses, rewriteIpfsUrls, renderMarkdown, getPublicClient, registerPage, isBlocked , getWalletProvider, slugify } from './utils.js'
import { t, whenReady as i18nReady } from './i18n.js'

// Sanitize script HTML: only allow <p> with fountain-*/stageplay-* classes
function _sanitizeScriptHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const div = doc.body
  const allowed = /^(fountain|stageplay)-/
  const out = []
  for (const node of div.childNodes) {
    if (node.nodeType === 3) { out.push(escapeHtml(node.textContent)); continue }
    if (node.nodeType !== 1) continue
    if (node.tagName === 'P' && allowed.test(node.className)) {
      out.push(`<p class="${escapeHtml(node.className)}">${escapeHtml(node.textContent)}</p>`)
    } else {
      out.push(escapeHtml(node.textContent))
    }
  }
  return out.join('\n')
}

// --- Bookmark helpers (same localStorage key as feed.js) ---
function _localBookmarkKey() {
  const addr = window.getWalletAddress?.()?.toLowerCase()
  return addr ? `praxis:bookmarks:${addr}` : null
}

function _getBookmarks() {
  const key = _localBookmarkKey()
  if (!key) return []
  try { return JSON.parse(localStorage.getItem(key) || '[]') } catch { return [] }
}

function _setBookmarks(bookmarks) {
  const key = _localBookmarkKey()
  if (!key) return
  try { localStorage.setItem(key, JSON.stringify(bookmarks)) } catch {}
}

function _isBookmarked(itemId) {
  return _getBookmarks().some(b => b.id === itemId)
}

function _saveBookmark(item) {
  const bookmarks = _getBookmarks()
  if (bookmarks.some(b => b.id === item.id)) return
  bookmarks.push({ ...item, savedAt: Date.now() })
  _setBookmarks(bookmarks)
}

function _removeBookmark(itemId) {
  const bookmarks = _getBookmarks().filter(b => b.id !== itemId)
  _setBookmarks(bookmarks)
}

registerPage('post-page', initPost)

async function _resolvePostSlug(slug, loadingEl) {
  try {
    const siteResp = await fetch('/site.json')
    if (!siteResp.ok) { loadingEl.textContent = 'could not load site data'; return null }
    const site = await siteResp.json()
    const wallet = site.wallet?.toLowerCase()
    if (!wallet) { loadingEl.textContent = 'post not found'; return null }
    // Batch: fetch posts + all amendments in 2 parallel queries
    const [postsData, amendsData] = await Promise.all([
      query(`query SlugPosts($author: String!) {
        blogPosts(where: { author: $author, refType: 0 }, orderBy: "timestamp", orderDirection: "desc", limit: 200) {
          items { id title }
        }
      }`, { author: wallet }),
      query(`query SlugAmends($author: String!) {
        blogPosts(where: { author: $author, refType: 5 }, orderBy: "timestamp", orderDirection: "desc", limit: 200) {
          items { title refId }
        }
      }`, { author: wallet })
    ])
    const posts = postsData?.blogPosts?.items || []
    const amendMap = new Map()
    for (const a of (amendsData?.blogPosts?.items || [])) {
      const key = String(a.refId)
      if (!amendMap.has(key)) amendMap.set(key, a)
    }
    for (const p of posts) {
      const amended = amendMap.get(String(p.id))
      const currentTitle = amended?.title || p.title
      const currentSlug = slugify(currentTitle)
      if (slugify(p.title) === slug || currentSlug === slug) {
        if (currentSlug !== slug) {
          window.location.replace('/post/' + currentSlug)
          return null
        }
        return String(p.id)
      }
    }
    loadingEl.textContent = 'post not found'
    return null
  } catch (e) {
    console.warn('post slug resolve error:', e)
    loadingEl.textContent = 'post not found'
    return null
  }
}

async function initPost() {
  const el = document.getElementById('post-page')
  if (!el) return
  const loadingEl = document.getElementById('post-loading')
  const contentEl = document.getElementById('post-content')
  const url = new URL(window.location.href)
  let postId = url.searchParams.get('id')
  const showHistory = url.searchParams.get('history') === '1'

  // Vanity slug: /post/<slug> — resolve to post ID
  if (!postId) {
    const segs = window.location.pathname.split('/').filter(Boolean)
    if (segs.length >= 2 && segs[0] === 'post') {
      const slug = decodeURIComponent(segs[1])
      postId = await _resolvePostSlug(slug, loadingEl)
      if (!postId) return
    }
  }

  if (!postId) {
    loadingEl.textContent = 'no post id'
    return
  }

  await i18nReady()

  try {
    let data = await query(`
      query Post($id: BigInt!) {
        blogPost(id: $id) {
          ${F.post}
        }
      }
    `, { id: postId })

    let post = data.blogPost
    if (!post) {
      loadingEl.textContent = 'post not found'
      return
    }

    // If viewing an amendment directly, redirect to the original post
    if (post.refType === 5 && post.refId) {
      const origId = String(post.refId)
      window.history.replaceState(null, '', `/post?id=${origId}${showHistory ? '&history=1' : ''}`)
      postId = origId
      // Re-fetch the original post
      data = await query(`
        query Post($id: BigInt!) {
          blogPost(id: $id) {
            ${F.post}
          }
        }
      `, { id: postId })
      post = data.blogPost
      if (!post) {
        loadingEl.textContent = 'post not found'
        return
      }
    }

    // Parallel: fetch amendments + parent post (if reply) in one round-trip
    const isReplyPost = post.refType > 0 && post.refType !== 5 && post.refId
    const isReply = isReplyPost && post.refType === 3
    const [amendData, parentData] = await Promise.all([
      query(`
        query Amendments($refId: BigInt!) {
          blogPosts(where: { refType: 5, refId: $refId }, orderBy: "timestamp", orderDirection: "desc", limit: 100) {
            items { ${F.post} }
          }
        }
      `, { refId: postId }),
      isReply
        ? query(`query ParentPost($id: BigInt!) { blogPost(id: $id) { ${F.post} } }`, { id: String(post.refId) }).catch(() => null)
        : Promise.resolve(null)
    ])

    const amendments = amendData?.blogPosts?.items || []
    const latestAmendment = amendments[0] || null
    const displayPost = latestAmendment || post

    loadingEl.style.display = 'none'

    // Handle history view
    if (showHistory && amendments.length > 0) {
      await renderHistoryView(contentEl, post, amendments, postId)
      return
    }

    // Batch resolve: post author + parent author (if reply) in one call
    const parent = parentData?.blogPost || null
    const addressesToResolve = [post.author]
    if (parent && parent.author.toLowerCase() !== post.author.toLowerCase()) {
      addressesToResolve.push(parent.author)
    }
    const domainMap = await resolveAddresses(query, addressesToResolve).catch(() => ({}))
    const domain = domainMap[post.author.toLowerCase()] || `${post.author.slice(0, 6)}...${post.author.slice(-4)}`
    const date = new Date(Number(displayPost.timestamp) * 1000)
    const dateStr = date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })

    // check for script content (published from script mode — screenplay or stage play)
    const isScreenplay = displayPost.content.startsWith('<!-- screenplay -->')
    const isStagePlay = displayPost.content.startsWith('<!-- stageplay -->')
    const isScript = isScreenplay || isStagePlay
    let body

    if (isScript) {
      const markerEnd = displayPost.content.indexOf('\n') + 1
      body = _sanitizeScriptHtml(displayPost.content.slice(markerEnd))
    } else {
      body = renderMarkdown(displayPost.content)
      // rewrite IPFS URLs (renderMarkdown handles basic rewrite, but rewriteIpfsUrls covers edge cases)
      body = rewriteIpfsUrls(body)
    }

    // edited indicator
    let editedHtml = ''
    if (latestAmendment) {
      editedHtml = ` <a href="/post?id=${postId}&history=1" style="color:var(--dim);font-size:0.55em;font-weight:700;text-decoration:none;vertical-align:middle">${t('post.edited')}</a>`
    }

    // reply-in-context: render parent quote for replies (parent already fetched in parallel above)
    let parentQuoteHtml = ''
    let replySeparatorHtml = ''
    if (isReply && parent) {
      const parentDomain = domainMap[parent.author.toLowerCase()] || `${parent.author.slice(0, 6)}...${parent.author.slice(-4)}`
      // strip markdown for preview
      const parentRaw = (parent.content || '')
        .replace(/!\[([^\]]*)\]\s*\(([^)]+)\)/g, '$1')
        .replace(/\[([^\]]+)\]\s*\(([^)]+)\)/g, '$1')
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/\*(.+?)\*/g, '$1')
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/^>\s+/gm, '')
        .replace(/\n{2,}/g, ' ')
        .replace(/\n/g, ' ')
        .trim()
      const parentPreview = parentRaw.length > 300 ? parentRaw.slice(0, 300) + '...' : parentRaw
      parentQuoteHtml = `<div class="post-parent-quote">
            <div class="parent-meta"><a href="/network?artist=${parent.author.toLowerCase()}">${escapeHtml(parentDomain)}</a></div>
            <div class="parent-title">${escapeHtml(parent.title)}</div>
            <div class="parent-preview">${escapeHtml(parentPreview)}</div>
            <a href="/post?id=${parent.id}" class="parent-link">view full post \u2192</a>
          </div>`
      replySeparatorHtml = `<div class="post-reply-separator">\u21a9 reply by <a href="/network?artist=${post.author.toLowerCase()}" style="color:var(--muted)">${escapeHtml(domain)}</a></div>`
    }

    // reference footer (skip for amendments — refType=5 is internal, skip for replies — shown above)
    let refHtml = ''
    if (isReplyPost && post.refType !== 3) {
      const refLabels = { 1: 'project', 2: 'portfolio', 4: 'cites' }
      const label = refLabels[post.refType] || 'references'

      if (post.refType === 4) {
        // library item reference
        try {
          const libData = await query(`query Lib($id: BigInt!) { libraryItem(id: $id) { ${F.libraryItem} } }`, { id: post.refId })
          if (libData.libraryItem) {
            refHtml = `<div class="post-reference">
              <span class="post-ref-label">${label}:</span>
              <span class="post-ref-title">${escapeHtml(libData.libraryItem.title)}</span>
              ${libData.libraryItem.author ? `<span class="post-ref-author"> -- ${escapeHtml(libData.libraryItem.author)}</span>` : ''}
            </div>`
          }
        } catch {}
      } else if (post.refType === 1) {
        try {
          const projData = await query(`query Proj($id: BigInt!) { project(id: $id) { ${F.projectSummary} } }`, { id: post.refId })
          if (projData.project) {
            refHtml = `<div class="post-reference">
              <span class="post-ref-label">${label}:</span>
              <a href="/projects?id=${post.refId}" class="post-ref-title">${escapeHtml(projData.project.title)}</a>
            </div>`
          }
        } catch {}
      }
    }

    contentEl.innerHTML = `
      ${parentQuoteHtml}
      ${replySeparatorHtml}
      <header class="post-page-header">
        <h1 class="post-page-title">${escapeHtml(displayPost.title)}${editedHtml}</h1>
        <div class="post-page-meta">
          <a href="/network?artist=${post.author.toLowerCase()}">${escapeHtml(domain)}</a>
          <span style="color:var(--dim)"> · </span>
          <time>${dateStr}</time>
          <span id="post-edit-slot" style="margin-left:auto"></span>
        </div>
        <div class="post-page-actions">
          <span id="post-actions" style="display:inline-flex;align-items:center"></span>
          <span id="post-reply-count" style="color:var(--dim);display:inline-flex;align-items:center;gap:0.3ch"><i class="ph ph-chat-circle"></i></span>
        </div>
      </header>
      <div class="post-page-body">${body}</div>
      ${refHtml}
      <div id="post-replies" style="margin-top:2em"></div>
      <div id="post-reply-form" style="margin-top:1.5em"></div>
    `

    document.title = `${displayPost.title} — ${domain}`

    // Add edit button for the post author
    const isOwner = window.getWalletAddress?.()?.toLowerCase() === post.author.toLowerCase()
    if (isOwner) {
      addEditButton(postId, displayPost)
    }

    // Add save/bookmark button for any connected wallet
    if (window.getWalletAddress?.()) {
      addSaveButton(postId, displayPost, domain)
    }

    // Also listen for wallet connect to show edit button + save button
    if (!window._postEditBound) {
      window._postEditBound = true
      window.addEventListener('wallet-connected', () => {
        const addr = window.getWalletAddress?.()
        if (addr?.toLowerCase() === post.author.toLowerCase() && !document.getElementById('post-edit-btn')) {
          addEditButton(postId, displayPost)
        }
        if (addr && !document.getElementById('post-save-btn')) {
          addSaveButton(postId, displayPost, domain)
        }
      })
    }

    // load replies
    await loadReplies(postId, domainMap)

    // show reply form if wallet connected (check after a brief delay for auto-connect)
    const blogAddr = el.dataset.blog || document.body.dataset.blog
    const tryShowReplyForm = () => {
      if (blogAddr && window.getWalletAddress?.()) {
        renderReplyForm(blogAddr, postId)
      }
    }
    tryShowReplyForm()
    // Retry after auto-connect (wallet may not be ready yet on initial load)
    setTimeout(tryShowReplyForm, 1500)
    setTimeout(tryShowReplyForm, 4000)
    window.addEventListener('wallet-connected', tryShowReplyForm)

  } catch (e) {
    loadingEl.textContent = 'could not load post'
    console.error('post error:', e)
  }
}

function addSaveButton(postId, displayPost, domain) {
  const actionsEl = document.getElementById('post-actions')
  if (!actionsEl || document.getElementById('post-save-btn')) return

  const bookmarkId = `post:${postId}`
  const saved = _isBookmarked(bookmarkId)

  const saveBtn = document.createElement('button')
  saveBtn.id = 'post-save-btn'
  saveBtn.className = 'buy-btn'
  saveBtn.style.cssText = 'background:none;border:none;cursor:pointer;color:var(--dim);display:inline-flex;align-items:center;font-family:inherit;padding:0;font-size:inherit;line-height:1'
  const heartOutline = '<i class="ph ph-heart"></i>'
  const heartFilled = '<svg width="1em" height="1em" viewBox="0 0 256 256" fill="currentColor" style="vertical-align:-0.125em"><path d="M240,98a57.63,57.63,0,0,1-17,41L128,233.09,33,139a58,58,0,0,1,82-82.05L128,69.42l13-12.42a58,58,0,0,1,99,41Z"/></svg>'
  saveBtn.innerHTML = saved ? heartFilled : heartOutline
  if (saved) saveBtn.style.color = 'var(--accent)'

  saveBtn.addEventListener('click', () => {
    if (_isBookmarked(bookmarkId)) {
      _removeBookmark(bookmarkId)
      saveBtn.innerHTML = heartOutline
      saveBtn.style.color = 'var(--dim)'
    } else {
      _saveBookmark({
        id: bookmarkId,
        type: 'post',
        title: displayPost.title,
        author: domain,
        url: `/post?id=${postId}`,
      })
      saveBtn.innerHTML = heartFilled
      saveBtn.style.color = 'var(--accent)'
    }
  })

  actionsEl.appendChild(saveBtn)
}

function addEditButton(postId, displayPost) {
  const actionsEl = document.getElementById('post-edit-slot') || document.getElementById('post-actions')
  if (!actionsEl || document.getElementById('post-edit-btn')) return

  const editBtn = document.createElement('button')
  editBtn.id = 'post-edit-btn'
  editBtn.textContent = t('compose.edit')
  editBtn.className = 'buy-btn'
  editBtn.style.cssText = 'font-size:0.75em;padding:0.2em 0.7ch;border-radius:6px;font-weight:normal'
  editBtn.addEventListener('click', () => {
    const params = new URLSearchParams()
    params.set('amend', postId)
    if (displayPost.title) params.set('prefillTitle', displayPost.title)
    if (displayPost.content) params.set('prefillContent', displayPost.content)
    window.location.href = '/write?' + params.toString()
  })
  actionsEl.insertBefore(editBtn, actionsEl.firstChild)
}

async function renderHistoryView(contentEl, originalPost, amendments, postId) {
  const domainMap = await resolveAddresses(query, [originalPost.author]).catch(() => ({}))
  const domain = domainMap[originalPost.author.toLowerCase()] || `${originalPost.author.slice(0, 6)}...${originalPost.author.slice(-4)}`

  // All versions: original first, then amendments in chronological order
  const versions = [originalPost, ...amendments.slice().reverse()]

  let html = `
    <header class="post-page-header">
      <h1 class="post-page-title">${escapeHtml(versions[versions.length - 1].title)}</h1>
      <div class="post-page-meta">
        <a href="/network?artist=${originalPost.author.toLowerCase()}">${escapeHtml(domain)}</a>
        <span style="color:var(--dim)"> · </span>
        <a href="/post?id=${postId}" style="color:var(--dim)">${t('journal.back')}</a>
      </div>
    </header>
    <h3 style="color:var(--muted);font-size:0.8em;text-transform:uppercase;letter-spacing:0.1em;margin:1.5em 0 1em">${versions.length} ${t('post.version')}s</h3>
  `

  for (let i = 0; i < versions.length; i++) {
    const v = versions[i]
    const date = new Date(Number(v.timestamp) * 1000)
    const dateStr = date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    const label = i === 0 ? t('post.original') : `${t('post.amendment')} ${i}`
    const isCurrent = i === versions.length - 1

    let body
    const vIsScript = v.content.startsWith('<!-- screenplay -->') || v.content.startsWith('<!-- stageplay -->')
    if (vIsScript) {
      const markerEnd = v.content.indexOf('\n') + 1
      body = _sanitizeScriptHtml(v.content.slice(markerEnd))
    } else {
      body = renderMarkdown(v.content)
    }
    body = rewriteIpfsUrls(body)

    html += `
      <div style="border:1px solid var(--border);padding:1.25em;margin-bottom:1em;${isCurrent ? 'border-color:var(--accent)' : 'opacity:0.7'}">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.75em">
          <span style="font-size:0.8em;color:${isCurrent ? 'var(--accent)' : 'var(--muted)'};text-transform:uppercase;letter-spacing:0.05em">${label}${isCurrent ? ' (current)' : ''}</span>
          <time style="color:var(--dim);font-size:0.8em">${dateStr}</time>
        </div>
        <h3 style="margin-bottom:0.5em">${escapeHtml(v.title)}</h3>
        <div class="post-page-body" style="font-size:0.95em">${body}</div>
      </div>
    `
  }

  contentEl.innerHTML = html
  document.title = `${t('post.viewHistory')} — ${versions[versions.length - 1].title}`
}

async function loadReplies(postId, domainMap) {
  const repliesEl = document.getElementById('post-replies')
  if (!repliesEl) return

  const resolve = addr => domainMap?.[addr.toLowerCase()] || `${addr.slice(0, 6)}...${addr.slice(-4)}`

  // helper to resolve new reply authors and merge into domainMap
  async function resolveReplyAuthors(replies) {
    const newAddrs = replies.map(r => r.author).filter(a => !domainMap[a.toLowerCase()])
    if (newAddrs.length > 0) {
      try {
        const newDomains = await resolveAddresses(query, newAddrs)
        Object.assign(domainMap, newDomains)
      } catch {}
    }
  }

  function renderReply(r) {
    const d = new Date(Number(r.timestamp) * 1000)
    const timeStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    return `<div class="post-reply" style="padding:1.25em 0">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.4em">
        <a href="/network?artist=${r.author.toLowerCase()}" style="color:var(--muted);font-size:0.85em;text-decoration:none">${escapeHtml(resolve(r.author))}</a>
        <time style="color:var(--dim);font-size:0.8em">${timeStr}</time>
      </div>
      <div style="color:var(--fg);font-size:0.95em;line-height:1.7">${escapeHtml(r.content).replace(/\n/g, '<br>')}</div>
    </div>`
  }

  let repliesCursor = null
  let repliesHasMore = true

  try {
    const data = await query(`
      query Replies($refId: BigInt!) {
        blogPosts(where: { refType: 3, refId: $refId }, orderBy: "timestamp", orderDirection: "asc", limit: 100) {
          items { ${F.post} }
          totalCount
          ${F.pageInfo}
        }
      }
    `, { refId: postId })

    const allReplies = data.blogPosts?.items || []
    const replies = allReplies.filter(r => !isBlocked(r.author))
    const totalCount = replies.length
    repliesCursor = data.blogPosts?.pageInfo?.endCursor
    repliesHasMore = data.blogPosts?.pageInfo?.hasNextPage || false

    if (replies.length === 0) return

    await resolveReplyAuthors(replies)

    // Update reply count in the actions row
    const replyCountEl = document.getElementById('post-reply-count')
    if (replyCountEl) replyCountEl.innerHTML = `<i class="ph ph-chat-circle"></i> ${totalCount}`

    repliesEl.innerHTML = `
      <div style="margin-top:3em;padding-top:1.5em">
        <h3 id="replies-heading" style="color:var(--dim);font-size:0.85em;font-weight:normal;margin-bottom:1em;border:none;padding-bottom:0.5em;border-bottom:1px solid color-mix(in srgb, var(--fg) 8%, transparent)">${totalCount} ${totalCount === 1 ? 'comment' : 'comments'}</h3>
        <div id="replies-list">${replies.map(renderReply).join('')}</div>
      </div>
      ${repliesHasMore ? `<button id="replies-load-more" class="buy-btn" style="margin-top:1em;width:100%">load more replies</button>` : ''}
    `

    document.getElementById('replies-load-more')?.addEventListener('click', async () => {
      const btn = document.getElementById('replies-load-more')
      btn.textContent = 'loading...'
      btn.disabled = true
      try {
        const moreData = await query(`
          query Replies($refId: BigInt!, $after: String) {
            blogPosts(where: { refType: 3, refId: $refId }, orderBy: "timestamp", orderDirection: "asc", limit: 100, after: $after) {
              items { ${F.post} }
              ${F.pageInfo}
            }
          }
        `, { refId: postId, after: repliesCursor })
        const newReplies = (moreData.blogPosts?.items || []).filter(r => !isBlocked(r.author))
        repliesCursor = moreData.blogPosts?.pageInfo?.endCursor
        repliesHasMore = moreData.blogPosts?.pageInfo?.hasNextPage || false

        const listEl = document.getElementById('replies-list')
        listEl.insertAdjacentHTML('beforeend', newReplies.map(renderReply).join(''))

        if (!repliesHasMore) {
          btn.style.display = 'none'
        } else {
          btn.textContent = 'load more replies'
          btn.disabled = false
        }
      } catch (e) {
        btn.textContent = 'error loading'
        console.warn('load more replies error:', e)
      }
    })
  } catch (e) { console.warn('replies error:', e?.message) }
}

import { BLOG_ABI } from './contracts.js'

// --- On-chain posts section for /blog index page ---

registerPage('onchain-posts', initOnchainPosts)
registerPage('blog-collection-filters', initBlogCollectionFilters)

// Build collection filter pills (shown above the posts list)
function initBlogCollectionFilters() {
  const filtersEl = document.getElementById('blog-collection-filters')
  if (!filtersEl) return

  const collections = window.__blogCollections || []
  if (collections.length === 0) return

  const activeCollection = window.__blogActiveCollection || new URL(window.location.href).searchParams.get('collection') || ''

  let html = '<div style="display:flex;gap:0.75ch;flex-wrap:wrap;margin-bottom:1.5em">'
  html += `<a href="/blog" style="font-size:0.85em;padding:0.3em 1ch;border:1px solid ${!activeCollection ? 'var(--accent)' : 'var(--border)'};color:${!activeCollection ? 'var(--accent)' : 'var(--muted)'};text-decoration:none">all</a>`
  for (const col of collections) {
    const slug = col.slug || col.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')
    const isActive = activeCollection === slug
    html += `<a href="/blog/${slug}" style="font-size:0.85em;padding:0.3em 1ch;border:1px solid ${isActive ? 'var(--accent)' : 'var(--border)'};color:${isActive ? 'var(--accent)' : 'var(--muted)'};text-decoration:none">${escapeHtml(col.name)}</a>`
  }
  html += '</div>'
  filtersEl.innerHTML = html
}

async function initOnchainPosts() {
  const container = document.getElementById('onchain-posts')
  if (!container) return

  const ownerAddr = document.body.dataset.owner
  if (!ownerAddr) return

  const PAGE_SIZE = 20
  let cursor = null
  let hasMore = true

  // Collection data from build (injected as window globals)
  const collections = window.__blogCollections || []
  const postCollections = window.__blogPostCollections || {}
  const activeCollection = window.__blogActiveCollection || new URL(window.location.href).searchParams.get('collection') || ''

  container.innerHTML = '<div id="onchain-status"><div class="praxis-loader"></div></div>'

  // Cache of reply counts per post (postId -> count)
  const replyCounts = {}

  async function loadPage() {
    const data = await query(`
      query OwnerPosts($author: String!, $after: String) {
        blogPosts(where: { author: $author, refType: 0 }, orderBy: "timestamp", orderDirection: "desc", limit: ${PAGE_SIZE}, after: $after) {
          items { ${F.postSummary} }
          ${F.pageInfo}
        }
      }
    `, { author: ownerAddr.toLowerCase(), after: cursor })

    const posts = data.blogPosts?.items || []
    cursor = data.blogPosts?.pageInfo?.endCursor || null
    hasMore = data.blogPosts?.pageInfo?.hasNextPage || false

    // Batch-fetch reply counts for these posts
    if (posts.length > 0) {
      try {
        const countPromises = posts.map(p =>
          query(`query ReplyCount($refId: BigInt!) { blogPosts(where: { refType: 3, refId: $refId }, limit: 1) { totalCount } }`, { refId: p.id })
            .then(d => ({ id: p.id, count: d.blogPosts?.totalCount || 0 }))
            .catch(() => ({ id: p.id, count: 0 }))
        )
        const counts = await Promise.all(countPromises)
        for (const c of counts) replyCounts[c.id] = c.count
      } catch {}
    }

    return posts
  }

  function renderPostItem(p) {
    const date = new Date(Number(p.timestamp) * 1000)
    const dateStr = date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    const rc = replyCounts[p.id] || 0
    const replyLabel = rc > 0 ? `<span style="color:var(--dim);font-size:0.8em">${rc} ${rc === 1 ? 'reply' : 'replies'}</span>` : ''
    const rawContent = p.content || ''

    // Extract first image or video URL for thumbnail
    let thumbHtml = ''
    const imgMatch = rawContent.match(/!\[[^\]]*\]\s*\(([^)]+)\)/)
    const vidMatch = rawContent.match(/\[video:\s*[^\]]*\]\s*\(([^)]+)\)/)
    if (imgMatch) {
      const src = imgMatch[1].includes('/api/ipfs-proxy/') ? `/api/img?url=${encodeURIComponent(imgMatch[1])}&w=200` : imgMatch[1]
      thumbHtml = `<div style="flex-shrink:0;width:100px;height:80px;margin-left:1em;border-radius:4px;overflow:hidden;background:var(--border)">
        <img src="${src}" loading="lazy" style="width:100%;height:100%;object-fit:cover" alt="">
      </div>`
    } else if (vidMatch) {
      thumbHtml = `<div style="flex-shrink:0;width:100px;height:80px;margin-left:1em;border-radius:4px;overflow:hidden;background:#000;position:relative;display:flex;align-items:center;justify-content:center">
        <video src="${escapeHtml(vidMatch[1])}" preload="metadata" style="width:100%;height:100%;object-fit:cover;pointer-events:none"></video>
        <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.3)">
          <i class="ph ph-play" style="color:#fff;font-size:1.2em"></i>
        </div>
      </div>`
    }

    // Strip markdown syntax for text preview
    const stripped = rawContent
      .replace(/!\[[^\]]*\]\s*\([^)]+\)/g, '')
      .replace(/\[video:\s*[^\]]*\]\s*\([^)]+\)/g, '')
      .replace(/\[audio:\s*[^\]]*\]\s*\([^)]+\)/g, '')
      .replace(/\[([^\]]+)\]\s*\([^)]+\)/g, '$1')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/\*(.+?)\*/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/^>\s+/gm, '')
      .replace(/^---+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    const preview = stripped.slice(0, 200)
    const previewHtml = preview ? `<div style="color:var(--muted);font-size:0.85em;line-height:1.6;margin-top:0.4em;max-height:4.8em;overflow:hidden">${escapeHtml(preview).replace(/\n/g, '<br>')}${stripped.length > 200 ? '...' : ''}</div>` : ''

    // Flush media at top if available, matching feed card style
    let mediaTopHtml = ''
    if (vidMatch) {
      mediaTopHtml = `<div class="feed-media-wrap"><div class="video-lazy" data-src="${escapeHtml(vidMatch[1])}" style="position:relative;width:100%;aspect-ratio:16/9;overflow:hidden;background:#000;display:flex;align-items:center;justify-content:center"><video src="${escapeHtml(vidMatch[1])}" preload="metadata" style="width:100%;height:100%;object-fit:cover;pointer-events:none"></video></div></div>`
    } else if (imgMatch) {
      const src = imgMatch[1].includes('/api/ipfs-proxy/') ? `/api/img?url=${encodeURIComponent(imgMatch[1])}&w=800` : imgMatch[1]
      mediaTopHtml = `<img src="${src}" loading="lazy" style="width:100%;display:block;max-height:250px;object-fit:cover" alt="">`
    }

    return `<li style="list-style:none;margin-bottom:0.75em">
      <a href="/post/${slugify(p.title)}" style="display:block;text-decoration:none;color:inherit;border:1px solid var(--border);border-radius:6px;overflow:hidden;transition:border-color 0.15s" onmouseover="this.style.borderColor='var(--muted)'" onmouseout="this.style.borderColor='var(--border)'">
        ${mediaTopHtml}
        <div style="padding:0.75em 1em">
          <div style="font-weight:700;font-size:1.4em;line-height:1.25;letter-spacing:-0.01em;color:var(--fg)">${escapeHtml(p.title)}</div>
          ${previewHtml}
          <div style="margin-top:0.5em;display:flex;gap:1.5ch;align-items:center">
            <time style="color:var(--dim);font-size:0.8em">${dateStr}</time>
            ${replyLabel}
          </div>
        </div>
      </a>
    </li>`
  }

  function renderPosts(items) {
    return items.map(renderPostItem).join('')
  }

  // Get the collection slug for a post (by post id)
  function getPostCollection(postId) {
    return postCollections[String(postId)] || ''
  }

  // Filter posts by active collection. Empty activeCollection = show all.
  function filterByCollection(posts) {
    if (!activeCollection) return posts
    return posts.filter(p => getPostCollection(p.id) === activeCollection)
  }

  // Render posts grouped by collection (when no active filter and collections exist)
  function renderGrouped(posts) {
    if (collections.length === 0 || activeCollection) {
      // Flat rendering (no collections or filtered to one)
      return renderPosts(filterByCollection(posts))
    }

    // Group posts by collection
    const groups = {}
    const uncollected = []
    for (const p of posts) {
      const col = getPostCollection(p.id)
      if (col) {
        if (!groups[col]) groups[col] = []
        groups[col].push(p)
      } else {
        uncollected.push(p)
      }
    }

    let html = ''
    // Render each collection in order
    for (const col of collections) {
      const slug = col.slug || col.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')
      const colPosts = groups[slug] || []
      if (colPosts.length === 0) continue
      html += `<div class="blog-collection-group" style="margin-bottom:2em">
        <h3 style="color:var(--muted);font-size:0.85em;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:0.5em">
          <a href="/blog/${slug}" style="color:var(--muted);text-decoration:none">${escapeHtml(col.name)}</a>
        </h3>
        <ul class="post-list" style="padding:0;margin:0">${renderPosts(colPosts)}</ul>
      </div>`
    }

    // Uncollected posts at the end
    if (uncollected.length > 0) {
      if (html) {
        html += `<div class="blog-collection-group" style="margin-bottom:2em">
          <h3 style="color:var(--muted);font-size:0.85em;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:0.5em">uncategorized</h3>
          <ul class="post-list" style="padding:0;margin:0">${renderPosts(uncollected)}</ul>
        </div>`
      } else {
        html += renderPosts(uncollected)
      }
    }

    return html
  }

  try {
    const posts = await loadPage()
    const statusEl = document.getElementById('onchain-status')

    if (posts.length === 0) {
      statusEl.style.display = 'none'
      return
    }

    statusEl.style.display = 'none'

    // When filtering by collection, check if any posts match
    const filtered = activeCollection ? filterByCollection(posts) : posts
    if (filtered.length === 0 && activeCollection) {
      container.innerHTML = `<p style="color:var(--muted);margin-top:1em">no posts in this collection yet.</p>`
      return
    }

    let listEl = container.querySelector('#onchain-list')
    if (!listEl) {
      container.insertAdjacentHTML('beforeend', `
        <div id="onchain-list" style="padding:0;margin:0"></div>
      `)
      listEl = container.querySelector('#onchain-list')
    }

    listEl.innerHTML = renderGrouped(posts)

    if (hasMore) {
      container.insertAdjacentHTML('beforeend', '<button id="onchain-load-more" class="buy-btn" style="margin-top:1em">load more</button>')
      container.querySelector('#onchain-load-more').addEventListener('click', async function handler() {
        const btn = container.querySelector('#onchain-load-more')
        btn.textContent = 'loading...'
        btn.disabled = true
        try {
          const morePosts = await loadPage()
          if (activeCollection) {
            const moreFiltered = filterByCollection(morePosts)
            listEl.insertAdjacentHTML('beforeend', renderPosts(moreFiltered))
          } else {
            // For grouped view, append flat (subsequent pages are appended flat)
            listEl.insertAdjacentHTML('beforeend', `<ul class="post-list" style="padding:0;margin:0">${renderPosts(morePosts)}</ul>`)
          }
          if (!hasMore) {
            btn.remove()
          } else {
            btn.textContent = 'load more'
            btn.disabled = false
          }
        } catch (e) {
          btn.textContent = 'error loading'
          console.warn('onchain posts load more error:', e)
        }
      })
    }
  } catch (e) {
    const statusEl = document.getElementById('onchain-status')
    if (statusEl) statusEl.textContent = ''
    console.warn('onchain posts error:', e)
  }
}

function renderReplyForm(blogAddr, postId) {
  const formEl = document.getElementById('post-reply-form')
  if (!formEl || formEl.dataset.rendered) return
  formEl.dataset.rendered = '1'

  formEl.innerHTML = `
    <div style="padding-top:1em">
      <textarea id="reply-content" placeholder="write a comment..." style="width:100%;background:transparent;border:1px solid color-mix(in srgb, var(--fg) 15%, transparent);color:var(--fg);font-family:inherit;font-size:0.95em;padding:0.75em 1ch;resize:vertical;min-height:4em;line-height:1.7;border-radius:10px;box-sizing:border-box;transition:border-color 0.15s" onfocus="this.style.borderColor='var(--accent)'" onblur="this.style.borderColor=''"></textarea>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:0.75em">
        <span id="reply-status" style="color:var(--muted);font-size:0.85em"></span>
        <button class="buy-btn" id="reply-submit" style="font-size:0.85em;padding:0.4em 2ch;border-radius:8px">comment</button>
      </div>
    </div>
  `

  document.getElementById('reply-submit')?.addEventListener('click', async () => {
    const content = document.getElementById('reply-content').value.trim()
    const statusEl = document.getElementById('reply-status')
    if (!content) { statusEl.textContent = 'write something'; return }

    const addr = window.getWalletAddress?.()
    if (!addr) { statusEl.textContent = 'connect wallet'; return }

    statusEl.textContent = 'confirm in wallet...'
    try {
      const { createWalletClient, custom } = await import('./vendor.js')
      const { optimism } = await import('./vendor.js')
      const publicClient = await getPublicClient()

      if (!await window.ensureOptimism?.()) return
      const replyAccount = await window.ensureAuthorized?.() || addr
      const walletClient = createWalletClient({ chain: optimism, transport: custom(getWalletProvider()) })
      const hash = await walletClient.writeContract({
        address: blogAddr, abi: BLOG_ABI, functionName: 'postWithRef',
        args: ['reply', content, 3, BigInt(postId)],
        account: replyAccount,
      })
      statusEl.textContent = `tx: ${hash.slice(0, 14)}...`
      await publicClient.waitForTransactionReceipt({ hash })
      statusEl.textContent = 'replied'
      setTimeout(() => location.reload(), 2000)
    } catch (e) {
      statusEl.textContent = e.code === 4001 ? 'cancelled' : `error: ${(e.shortMessage || e.message).slice(0, 60)}`
    }
  })
}
