// Library — shared knowledge base for the network
// PDFs, articles, essays uploaded to IPFS or linked externally
import { F } from './fragments.js'
import { createWalletClient, custom } from './vendor.js'
import { optimism } from './vendor.js'
import { query } from './ponder.js'
import { escapeHtml, ensureWallet, resolveAddresses, formatTxError, ipfsUrl, renderMedia, getPublicClient, registerPage, openMediaSheet , getWalletProvider, prettifyFilename, getAuthToken, resolveDomain } from './utils.js'
import { t, whenReady as i18nReady } from './i18n.js'
import { getCached, setCache, invalidate, TTL } from './cache.js'

// Module-level server tag cache shared by inline tag autocomplete and add-form dropdown
let _serverTagCache = null
let _serverTagCacheTs = 0
const SERVER_TAG_TTL = 60000
async function _fetchServerTags() {
  if (_serverTagCache && Date.now() - _serverTagCacheTs < SERVER_TAG_TTL) return _serverTagCache
  try {
    const res = await fetch('/api/library/tags?limit=100')
    if (!res.ok) throw new Error('fetch failed')
    const data = await res.json()
    _serverTagCache = (data.tags || []).map(t => t.tag)
    _serverTagCacheTs = Date.now()
    return _serverTagCache
  } catch {
    return null
  }
}

// Derive a prettified title from a filename (strip extension, replace


import { LIBRARY_ABI } from './contracts.js'

registerPage('library-data', initLibrary)

async function initLibrary() {
  await i18nReady()
  const libraryData = document.getElementById('library-data')
  if (!libraryData) return
  const libraryAddress = libraryData.dataset.address
  const statusEl = document.getElementById('library-status')
  const listEl = document.getElementById('library-list')

  if (!libraryAddress) { statusEl.textContent = t('library.notDeployed'); return }

  let domainMap = {}
  const resolve = addr => resolveDomain(domainMap, addr)

  // load items with pagination
  let libraryCursor = null
  let libraryHasMore = true
  const items = []

  function renderItem(item) {
    const domain = resolve(item.contributor)
    const date = new Date(Number(item.timestamp) * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    const link = item.ipfsCid
      ? ipfsUrl(item.ipfsCid)
      : item.url
    const tags = item.tags.split(',').map(tg => tg.toLowerCase().trim()).filter(Boolean)
      .map(tg => `<span class="library-tag">${escapeHtml(tg)}</span>`).join(' ')
    const myAddr = window.getWalletAddress?.()?.toLowerCase()
    const isMine = myAddr && item.contributor.toLowerCase() === myAddr
    const filename = item.title || ''

    return `<div class="library-item" data-link="${escapeHtml(link)}" data-filename="${escapeHtml(filename)}" data-title="${escapeHtml(item.title)}" data-author="${escapeHtml(item.author || '')}" data-item-id="${item.id}" style="cursor:pointer">
      <div class="library-item-header">
        <span class="library-item-title">${escapeHtml(item.title)}</span>
        <span class="library-item-date">${date}</span>
      </div>
      <div class="library-item-meta">
        ${item.author ? `<span class="library-item-author">${escapeHtml(item.author)}</span>` : ''}
        <span class="library-item-contributor">${t('library.addedBy')} <a href="/network?artist=${item.contributor}">${escapeHtml(domain)}</a></span>
      </div>
      <div class="library-item-tags">${tags}${isMine ? ` <button class="library-add-tag-btn" data-item-id="${item.id}" style="background:none;border:1px solid var(--border);color:var(--dim);font-family:inherit;font-size:0.8em;padding:0.1em 0.5ch;cursor:pointer;margin-left:0.5ch">${t('library.addTag')}</button>` : ''}</div>
      ${item.ipfsCid ? `<span class="library-item-ipfs">${t('library.ipfs')}</span>` : ''}
    </div>`
  }

  try {
    const libraryCacheKey = 'library:' + libraryAddress
    const cachedLibrary = getCached(libraryCacheKey)

    if (cachedLibrary) {
      items.push(...cachedLibrary.items)
      libraryCursor = cachedLibrary.cursor
      libraryHasMore = cachedLibrary.hasMore
    } else {
      const safeCursor = libraryCursor ? libraryCursor.replace(/[^a-zA-Z0-9+/=_-]/g, '') : null
      const afterArg = safeCursor ? `, after: "${safeCursor}"` : ''
      const data = await query(`{
        libraryItems(orderBy: "timestamp", orderDirection: "desc", limit: 100${afterArg}) {
          items { ${F.libraryItem} }
          totalCount
          ${F.pageInfo}
        }
      }`)

      items.push(...data.libraryItems.items)
      libraryCursor = data.libraryItems.pageInfo?.endCursor
      libraryHasMore = data.libraryItems.pageInfo?.hasNextPage || false

      // cache library items with medium TTL
      setCache(libraryCacheKey, { items: [...items], cursor: libraryCursor, hasMore: libraryHasMore, totalCount: data.libraryItems.totalCount }, TTL.medium)
    }

    const totalCount = cachedLibrary ? cachedLibrary.totalCount : items.length
    statusEl.textContent = items.length > 0
      ? t('library.itemCount', { count: totalCount })
      : t('library.empty')

    // resolve contributor domains on demand
    const contributorAddresses = items.map(item => item.contributor).filter(Boolean)
    domainMap = await resolveAddresses(query, contributorAddresses).catch(() => ({}))

    // collect tags
    const tagCounts = {}
    for (const item of items) {
      for (const tag of item.tags.split(',').map(tg => tg.toLowerCase().trim()).filter(Boolean)) {
        tagCounts[tag] = (tagCounts[tag] || 0) + 1
      }
    }

    // render tag cloud
    const tagsHtml = Object.entries(tagCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([tag, count]) => `<span class="library-tag" data-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</span>`)
      .join(' ')

    // render items
    let html = `<div class="library-tags">${tagsHtml}</div>`
    html += `<div id="library-search" style="margin:1em 0">
      <input type="text" id="library-search-input" placeholder="${t('library.searchPlaceholder')}" class="project-input" style="max-width:400px">
    </div>`

    html += items.map(renderItem).join('')

    if (libraryHasMore) {
      html += `<div id="library-load-more-sentinel" style="height:1px;margin-top:1em"></div>`
    }

    listEl.innerHTML = html

    // search filter (debounced)
    let _libSearchTimer = null
    document.getElementById('library-search-input')?.addEventListener('input', (e) => {
      clearTimeout(_libSearchTimer)
      _libSearchTimer = setTimeout(() => {
        const q = e.target.value.toLowerCase()
        listEl.querySelectorAll('.library-item').forEach((el, i) => {
          const item = items[i]
          const match = !q ||
            item.title.toLowerCase().includes(q) ||
            item.author.toLowerCase().includes(q) ||
            item.tags.toLowerCase().includes(q)
          el.style.display = match ? 'block' : 'none'
        })
      }, 200)
    })

    // tag click filter
    listEl.querySelectorAll('.library-tag').forEach(tag => {
      tag.addEventListener('click', () => {
        const input = document.getElementById('library-search-input')
        if (input) { input.value = tag.dataset.tag || tag.textContent; input.dispatchEvent(new Event('input')) }
        // update URL without reload
        const url = new URL(window.location)
        url.searchParams.set('tag', tag.dataset.tag || tag.textContent)
        history.replaceState(null, '', url)
      })
    })

    // apply ?tag= URL param on page load
    const params = new URLSearchParams(window.location.search)
    const tagParam = params.get('tag')
    if (tagParam) {
      const input = document.getElementById('library-search-input')
      if (input) { input.value = tagParam; input.dispatchEvent(new Event('input')) }
    }

    // auto-open media sheet if ?item=ID is in URL
    const itemParam = params.get('item')
    if (itemParam) {
      const match = items.find(i => String(i.id) === itemParam)
      if (match) {
        const link = match.ipfsCid ? ipfsUrl(match.ipfsCid) : match.url
        if (link && !link.startsWith('/') && !match.ipfsCid && /^https?:\/\//i.test(link)) {
          window.open(link, '_blank')
        } else {
          openMediaSheet({ url: link, title: match.title || '', author: match.author || '', itemId: match.id || '' })
        }
      }
    }

    // "load more" button handler
    function attachItemHandlers(container) {
      container.querySelectorAll('.library-item:not([data-bound])').forEach(el => {
        el.dataset.bound = '1'
        el.addEventListener('click', (e) => {
          // Only open the media sheet when clicking the title. Skip tags, buttons,
          // inputs, links, and any other interactive elements inside the item.
          if (e.target.closest('.library-item-tags') || e.target.closest('.library-inline-tag-input') || e.target.closest('a') || e.target.closest('button') || e.target.closest('input')) return
          // update URL with ?item= for deep-linking
          const itemId = el.dataset.itemId
          if (itemId) {
            const u = new URL(window.location)
            u.searchParams.set('item', itemId)
            history.replaceState(null, '', u)
          }
          const link = el.dataset.link
          // URL-only items (no IPFS file) open in a new tab
          if (link && !link.startsWith('/') && !link.startsWith(location.origin) && /^https?:\/\//i.test(link)) {
            window.open(link, '_blank')
          } else {
            openMediaSheet({ url: link, title: el.dataset.title || '', author: el.dataset.author || '', itemId: itemId || '' })
          }
        })
      })
      container.querySelectorAll('.library-add-tag-btn:not([data-bound])').forEach(btn => {
        btn.dataset.bound = '1'
        btn.addEventListener('click', async (e) => {
          e.stopPropagation()
          const itemId = btn.dataset.itemId
          const tagsHost = btn.closest('.library-item-tags')
          if (!tagsHost) return

          // Prevent double-opening — toggle off if already open for this item.
          const existing = tagsHost.querySelector('.library-inline-tag-input')
          if (existing) { existing.remove(); btn.style.display = ''; return }

          // Inline pill-input matching the /library upload form UX.
          // Tags are committed on Enter/Tab/comma, deleted via × or Backspace,
          // and the whole batch gets submitted to tagItem() on "add" or blur.
          btn.style.display = 'none'
          const wrap = document.createElement('span')
          wrap.className = 'library-inline-tag-input'
          wrap.style.cssText = 'display:inline-flex;align-items:center;flex-wrap:wrap;gap:0.3ch;margin-left:0.5ch;position:relative'
          wrap.innerHTML = `
            <input type="text" class="li-tag-in" placeholder="tag..." style="background:none;border:1px solid var(--border);color:var(--fg);font-family:inherit;font-size:0.8em;padding:0.15em 0.6ch;outline:none;min-width:8ch">
            <button class="li-tag-submit" style="background:none;border:1px solid var(--accent);color:var(--accent);font-family:inherit;font-size:0.8em;padding:0.15em 0.6ch;cursor:pointer">add</button>
            <button class="li-tag-cancel" style="background:none;border:none;color:var(--dim);font-family:inherit;font-size:0.85em;cursor:pointer">×</button>
            <div class="li-tag-dd" style="position:absolute;top:100%;left:0;background:var(--bg);border:1px solid var(--border);display:none;z-index:10;max-height:200px;overflow-y:auto;min-width:12ch"></div>
          `
          tagsHost.appendChild(wrap)
          const input = wrap.querySelector('.li-tag-in')
          const dd = wrap.querySelector('.li-tag-dd')
          const pending = [] // tags typed but not yet committed on-chain

          const addPillLocally = (tag) => {
            const pill = document.createElement('span')
            pill.className = 'library-tag li-tag-pill-pending'
            pill.dataset.tag = tag
            pill.style.cssText = 'display:inline-flex;align-items:center;gap:0.3ch;border:1px solid var(--accent);color:var(--accent);font-size:0.8em;padding:0.15em 0.6ch;margin-right:0.3ch'
            pill.innerHTML = `${escapeHtml(tag)} <span style="cursor:pointer;color:var(--dim)" class="li-pill-x">&times;</span>`
            pill.querySelector('.li-pill-x').addEventListener('click', () => {
              const idx = pending.indexOf(tag); if (idx >= 0) pending.splice(idx, 1)
              pill.remove()
            })
            tagsHost.insertBefore(pill, wrap)
          }
          const commitLocal = (val) => {
            const tag = val.trim().toLowerCase().replace(/,/g, '')
            if (!tag || pending.includes(tag)) return
            // Skip if already on the item
            const existing = [...tagsHost.querySelectorAll('.library-tag')].map(el => el.textContent.trim().toLowerCase())
            if (existing.includes(tag)) return
            pending.push(tag)
            addPillLocally(tag)
            input.value = ''
          }

          // Server tag autocomplete — reuse module-level cache (_fetchServerTags)
          let serverTags = []
          try {
            serverTags = (await _fetchServerTags()) || []
          } catch {}
          const showDD = (filter) => {
            const existing = [...tagsHost.querySelectorAll('.library-tag')].map(el => el.textContent.trim().toLowerCase())
            const filtered = serverTags.filter(t => !pending.includes(t) && !existing.includes(t) && (!filter || t.includes(filter.toLowerCase())))
            if (!filtered.length) { dd.style.display = 'none'; return }
            dd.innerHTML = filtered.slice(0, 8).map(t =>
              `<div class="li-tag-opt" data-tag="${escapeHtml(t)}" style="padding:0.3em 0.6ch;cursor:pointer;font-size:0.85em;color:var(--muted)">${escapeHtml(t)}</div>`
            ).join('')
            dd.style.display = 'block'
            dd.querySelectorAll('.li-tag-opt').forEach(opt => {
              opt.addEventListener('mousedown', (e) => { e.preventDefault(); commitLocal(opt.dataset.tag); dd.style.display = 'none' })
            })
          }

          input.addEventListener('keydown', (e) => {
            if ((e.key === 'Enter' || e.key === 'Tab' || e.key === ',') && input.value.trim()) {
              e.preventDefault(); commitLocal(input.value); dd.style.display = 'none'
            }
            if (e.key === 'Backspace' && !input.value && pending.length) {
              const last = pending.pop()
              wrap.parentElement.querySelectorAll('.li-tag-pill-pending').forEach(p => {
                if (p.dataset.tag === last) p.remove()
              })
            }
            if (e.key === 'Escape') { wrap.remove(); btn.style.display = '' }
          })
          input.addEventListener('input', () => showDD(input.value))
          input.addEventListener('focus', () => showDD(input.value))
          input.addEventListener('blur', () => setTimeout(() => { dd.style.display = 'none' }, 150))
          input.focus()

          wrap.querySelector('.li-tag-cancel').addEventListener('click', () => {
            wrap.parentElement.querySelectorAll('.li-tag-pill-pending').forEach(p => p.remove())
            wrap.remove(); btn.style.display = ''
          })

          const submit = async () => {
            if (input.value.trim()) commitLocal(input.value)
            if (!pending.length) return
            const addr = await ensureWallet()
            if (!addr) return
            const tagAccount = await window.authorizedSigner?.(addr)
          if (!await window.ensureOptimism?.()) return
            const submitBtn = wrap.querySelector('.li-tag-submit')
            submitBtn.textContent = t('library.tagging')
            submitBtn.disabled = true
            try {
              const pc = await getPublicClient()
              const walletClient = createWalletClient({ chain: optimism, transport: custom(getWalletProvider()) })
              const hash = await walletClient.writeContract({
                address: libraryAddress, abi: LIBRARY_ABI, functionName: 'tagItem',
                args: [BigInt(itemId), pending.join(',')], account: tagAccount,
              })
              submitBtn.textContent = t('library.confirming')
              await pc.waitForTransactionReceipt({ hash })
              // Success — promote pending pills to real tag pills (no reload).
              tagsHost.querySelectorAll('.li-tag-pill-pending').forEach(p => {
                p.classList.remove('li-tag-pill-pending')
                p.style.cssText = '' // inherit default .library-tag styling
                p.innerHTML = escapeHtml(p.dataset.tag)
              })
              wrap.remove()
              btn.style.display = ''
            } catch (e) {
              submitBtn.textContent = 'error — retry'
              submitBtn.disabled = false
              console.error('tag error:', e)
            }
          }
          wrap.querySelector('.li-tag-submit').addEventListener('click', submit)
        })
      })
    }

    // infinite scroll via IntersectionObserver
    let _libraryLoadingMore = false
    const sentinel = document.getElementById('library-load-more-sentinel')
    if (sentinel) {
      const observer = new IntersectionObserver(async ([entry]) => {
        if (!entry.isIntersecting || _libraryLoadingMore || !libraryHasMore) return
        _libraryLoadingMore = true
        try {
          const safeCursor = libraryCursor ? libraryCursor.replace(/[^a-zA-Z0-9+/=_-]/g, '') : null
          const afterArg = safeCursor ? `, after: "${safeCursor}"` : ''
          const moreData = await query(`{
            libraryItems(orderBy: "timestamp", orderDirection: "desc", limit: 100${afterArg}) {
              items { ${F.libraryItem} }
              ${F.pageInfo}
            }
          }`)
          const newItems = moreData.libraryItems?.items || []
          items.push(...newItems)
          libraryCursor = moreData.libraryItems.pageInfo?.endCursor
          libraryHasMore = moreData.libraryItems.pageInfo?.hasNextPage || false

          // insert before the sentinel
          const newHtml = newItems.map(renderItem).join('')
          sentinel.insertAdjacentHTML('beforebegin', newHtml)
          attachItemHandlers(listEl)

          // update tag counts for new items
          for (const item of newItems) {
            for (const tag of item.tags.split(',').map(tg => tg.toLowerCase().trim()).filter(Boolean)) {
              tagCounts[tag] = (tagCounts[tag] || 0) + 1
            }
          }

          // re-render tag cloud with updated counts
          const tagCloudEl = listEl.querySelector('.library-tags')
          if (tagCloudEl) {
            const updatedTagsHtml = Object.entries(tagCounts)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 20)
              .map(([tag, count]) => `<span class="library-tag" data-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</span>`)
              .join(' ')
            tagCloudEl.innerHTML = updatedTagsHtml
            // re-bind tag click handlers
            tagCloudEl.querySelectorAll('.library-tag').forEach(tagEl => {
              tagEl.addEventListener('click', () => {
                const input = document.getElementById('library-search-input')
                if (input) { input.value = tagEl.dataset.tag || tagEl.textContent; input.dispatchEvent(new Event('input')) }
                const u = new URL(window.location)
                u.searchParams.set('tag', tagEl.dataset.tag || tagEl.textContent)
                history.replaceState(null, '', u)
              })
            })
          }

          if (!libraryHasMore) {
            sentinel.remove()
            observer.disconnect()
          }
        } catch (e) {
          console.warn('library load more error:', e)
        } finally {
          _libraryLoadingMore = false
        }
      }, { rootMargin: '200px' })
      observer.observe(sentinel)
    }

    // initial item handlers (tag buttons + expand) — uses attachItemHandlers above
    attachItemHandlers(listEl)
  } catch (e) {
    statusEl.textContent = 'could not load library'
    console.warn('library error:', e)
  }

  // render add form
  renderAddForm(libraryAddress, domainMap)
}

function renderAddForm(libraryAddress) {
  const formEl = document.getElementById('library-add-form')
  if (!formEl) return

  formEl.innerHTML = `
    <button id="library-add-toggle" class="buy-btn" style="width:100%;margin-bottom:1em">+ add to library</button>
    <div id="library-add-fields" style="display:none">
      <div style="display:grid;gap:0.75em;max-width:500px">
        <input type="text" id="lib-title" placeholder="title" class="project-input">
        <input type="text" id="lib-author" placeholder="author" class="project-input">
        <div id="lib-tags-container" style="display:flex;flex-wrap:wrap;gap:0.3em;align-items:center;border:1px solid var(--border,#1a1a1a);padding:0.4em 0.5ch;min-height:2em;position:relative;cursor:text">
          <input type="text" id="lib-tags-input" placeholder="add tags..." style="background:none;border:none;color:var(--fg);font-family:inherit;font-size:0.85em;outline:none;flex:1;min-width:80px;padding:0.1em 0">
          <div id="lib-tags-dropdown" style="display:none;position:absolute;top:100%;left:0;right:0;background:var(--bg,#0a0a0a);border:1px solid var(--border,#1a1a1a);border-top:none;z-index:10;max-height:120px;overflow-y:auto"></div>
        </div>
        <div style="border:1px solid var(--border);padding:1em">
          <p style="color:var(--fg);margin-bottom:0.5em">upload PDF or link</p>
          <input type="file" id="lib-file" accept=".pdf,.doc,.docx,.txt,.epub" style="color:var(--muted);font-size:0.85em;margin-bottom:0.5em">
          <p style="color:var(--dim);font-size:0.8em;margin-bottom:0.5em">or</p>
          <input type="text" id="lib-url" placeholder="https://..." class="project-input">
        </div>
        <button class="buy-btn" id="lib-submit-btn">add to library</button>
      </div>
      <p id="lib-status" style="color:var(--muted);font-size:0.85em;margin-top:0.5em"></p>
    </div>
  `

  document.getElementById('library-add-toggle').addEventListener('click', () => {
    const fields = document.getElementById('library-add-fields')
    fields.style.display = fields.style.display === 'none' ? 'block' : 'none'
  })

  // Auto-fill the title input from the selected filename when the title is
  // empty. Lets users drop in a PDF without re-typing its name.
  const libFileInput = document.getElementById('lib-file')
  if (libFileInput) {
    libFileInput.addEventListener('change', () => {
      const file = libFileInput.files && libFileInput.files[0]
      if (!file) return
      const titleEl = document.getElementById('lib-title')
      if (titleEl && !titleEl.value.trim()) {
        titleEl.value = prettifyFilename(file.name)
      }
    })
  }

  // --- Tag pill input for library tags ---
  const LIB_TAG_CACHE_KEY = 'praxis:library-tags'
  function _getCachedLibTags() {
    try { return JSON.parse(localStorage.getItem(LIB_TAG_CACHE_KEY) || '[]') } catch { return [] }
  }
  function _saveCachedLibTags(tags) {
    const existing = _getCachedLibTags()
    const merged = [...new Set([...tags, ...existing])]
    const capped = merged.length > 200 ? merged.slice(-200) : merged
    try { localStorage.setItem(LIB_TAG_CACHE_KEY, JSON.stringify(capped)) } catch {}
  }
  // seed cache from existing items on page
  const existingTags = [...document.querySelectorAll('.library-tag')].map(el => el.textContent.trim()).filter(Boolean)
  if (existingTags.length) _saveCachedLibTags(existingTags)

  function _addLibTag(text) {
    const tag = text.trim().toLowerCase().replace(/[,]/g, '')
    if (!tag) return
    const container = document.getElementById('lib-tags-container')
    if (!container) return
    // dedup
    if ([...container.querySelectorAll('.lib-tag-pill')].some(el => el.dataset.tag === tag)) return
    const pill = document.createElement('span')
    pill.className = 'lib-tag-pill'
    pill.dataset.tag = tag
    pill.style.cssText = 'display:inline-flex;align-items:center;gap:0.3ch;border:1px solid var(--border,#1a1a1a);color:var(--fg);font-size:0.8em;padding:0.2em 0.6ch;white-space:nowrap'
    pill.innerHTML = `${escapeHtml(tag)} <span style="cursor:pointer;color:var(--dim,#666);margin-left:0.2ch" class="lib-tag-x">&times;</span>`
    pill.querySelector('.lib-tag-x').addEventListener('click', () => pill.remove())
    const input = document.getElementById('lib-tags-input')
    container.insertBefore(pill, input)
    input.value = ''
    _saveCachedLibTags([tag])
  }

  function _showLibTagDropdown(filter) {
    const dd = document.getElementById('lib-tags-dropdown')
    if (!dd) return
    const localTags = _getCachedLibTags()
    const existing = [...document.querySelectorAll('#lib-tags-container .lib-tag-pill')].map(el => el.dataset.tag)
    const renderDropdown = (allTags) => {
      const filtered = allTags.filter(t => !existing.includes(t) && (!filter || t.includes(filter.toLowerCase())))
      if (filtered.length === 0) { dd.style.display = 'none'; return }
      dd.innerHTML = filtered.slice(0, 8).map(t =>
        `<div class="lib-tag-option" style="padding:0.4em 0.8ch;cursor:pointer;font-size:0.85em;color:var(--muted)" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</div>`
      ).join('')
      dd.style.display = 'block'
      dd.querySelectorAll('.lib-tag-option').forEach(opt => {
        opt.addEventListener('mousedown', (e) => { e.preventDefault(); _addLibTag(opt.dataset.tag); dd.style.display = 'none' })
      })
    }
    // render immediately with local cache
    renderDropdown(localTags)
    // merge server tags asynchronously
    _fetchServerTags().then(serverTags => {
      if (!serverTags) return
      const merged = [...new Set([...serverTags, ...localTags])]
      renderDropdown(merged)
    })
  }

  const libTagInput = document.getElementById('lib-tags-input')
  if (libTagInput) {
    libTagInput.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === 'Tab' || e.key === ',') && libTagInput.value.trim()) {
        e.preventDefault()
        _addLibTag(libTagInput.value)
        document.getElementById('lib-tags-dropdown').style.display = 'none'
      }
      if (e.key === 'Backspace' && !libTagInput.value) {
        const pills = document.querySelectorAll('#lib-tags-container .lib-tag-pill')
        if (pills.length) pills[pills.length - 1].remove()
      }
    })
    libTagInput.addEventListener('input', () => _showLibTagDropdown(libTagInput.value))
    libTagInput.addEventListener('focus', () => _showLibTagDropdown(libTagInput.value))
    libTagInput.addEventListener('blur', () => setTimeout(() => { document.getElementById('lib-tags-dropdown').style.display = 'none' }, 150))
    document.getElementById('lib-tags-container')?.addEventListener('click', () => libTagInput.focus())
  }

  document.getElementById('lib-submit-btn').addEventListener('click', async () => {
    const title = document.getElementById('lib-title').value.trim()
    const author = document.getElementById('lib-author').value.trim()
    // collect tags from pill elements
    const tagEls = document.querySelectorAll('#lib-tags-container .lib-tag-pill')
    const pendingInput = document.getElementById('lib-tags-input')?.value.trim()
    if (pendingInput) _addLibTag(pendingInput)
    const tagPills = document.querySelectorAll('#lib-tags-container .lib-tag-pill')
    const tags = [...tagPills].map(el => el.dataset.tag).filter(Boolean).join(',')
    const file = document.getElementById('lib-file').files[0]
    const url = document.getElementById('lib-url').value.trim()
    const statusEl = document.getElementById('lib-status')

    if (!title) { statusEl.textContent = 'enter a title'; return }
    if (!file && !url) { statusEl.textContent = 'upload a file or enter a URL'; return }

    const addr = await ensureWallet()
    if (!addr) { statusEl.textContent = t('projects.connectWallet'); return }
    // Activate embedded provider FIRST (sets window.praxisEthereum) so that
    // getWalletProvider() and ensureScroll() don't accidentally hijack
    // MetaMask/Brave when window.ethereum is locked by another wallet.
    const addAccount = await window.authorizedSigner?.(addr)
          if (!await window.ensureOptimism?.()) { statusEl.textContent = t('projects.connectWallet'); return }

    let ipfsCid = ''

    // upload to IPFS if file provided
    if (file) {
      statusEl.textContent = 'uploading to IPFS...'
      try {
        const buffer = await file.arrayBuffer()
        const res = await fetch(`/api/ipfs?name=${encodeURIComponent(file.name)}`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${await getAuthToken()}`,
            'Content-Length': String(buffer.byteLength),
          },
          body: buffer,
        })
        const data = await res.json()
        // The /api/ipfs endpoint is now async and returns a jobId; we must poll
        // /api/ipfs/status/:jobId until done. Synchronous { cid } is preserved
        // as a backwards-compatible fast path in case the server changes again.
        if (data.cid) {
          // M10: validate CID format before trusting for downstream addItem()
          if (!/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[A-Za-z2-7]{58,})$/.test(data.cid)) {
            throw new Error('invalid cid')
          }
          ipfsCid = data.cid
          statusEl.textContent = `uploaded: ${ipfsCid.slice(0, 12)}...`
        } else if (data.jobId) {
          statusEl.textContent = 'queued for IPFS...'
          const POLL_INTERVAL = 2000
          const MAX_POLLS = 300 // 10 min max
          let polled = null
          for (let i = 0; i < MAX_POLLS; i++) {
            await new Promise(r => setTimeout(r, POLL_INTERVAL))
            try {
              const sres = await fetch(`/api/ipfs/status/${data.jobId}`)
              const sdata = await sres.json()
              if (sdata.status === 'done' && sdata.cid) { polled = sdata; break }
              if (sdata.status === 'error') {
                statusEl.textContent = `upload failed: ${sdata.error || 'unknown error'}`
                return
              }
              if (sdata.status === 'queued') statusEl.textContent = 'queued for IPFS...'
              else if (sdata.status === 'processing') statusEl.textContent = 'uploading to IPFS...'
            } catch {}
          }
          if (!polled) { statusEl.textContent = 'upload timed out'; return }
          // M10: validate polled CID format before addItem()
          if (!/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[A-Za-z2-7]{58,})$/.test(polled.cid)) {
            throw new Error('invalid cid')
          }
          ipfsCid = polled.cid
          statusEl.textContent = `uploaded: ${ipfsCid.slice(0, 12)}...`
        } else {
          // Show whatever the server actually returned (handles 401/413/503 etc.)
          statusEl.textContent = `upload failed: ${data.error || res.statusText || `HTTP ${res.status}`}`
          return
        }
      } catch (e) {
        statusEl.textContent = `upload error: ${e.message || 'unknown'}`
        return
      }
    }

    // add to on-chain registry
    statusEl.textContent = 'adding to library...'
    try {
      const walletClient = createWalletClient({ chain: optimism, transport: custom(getWalletProvider()) })
      const hash = await walletClient.writeContract({
        address: libraryAddress,
        abi: LIBRARY_ABI,
        functionName: 'addItem',
        args: [title, author, ipfsCid, url, tags],
        account: addAccount,
      })
      statusEl.textContent = `tx: ${hash.slice(0, 14)}...`
      const pc = await getPublicClient()
      await pc.waitForTransactionReceipt({ hash })
      statusEl.textContent = 'added -- reloading...'
      invalidate('library:')
      setTimeout(() => location.reload(), 2500)
    } catch (e) {
      statusEl.textContent = formatTxError(e)
    }
  })
}
