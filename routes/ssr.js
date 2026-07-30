// SSR routes — server-side rendering for blog posts, art pages, project pages
import { join } from 'path'

function slugify(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'untitled'
}

const _VANITY_TYPES = new Set(['music', 'gallery', 'film', 'video', 'audio', 'writing', 'demos'])

/** @param {object} ctx @returns {Promise<boolean>} */
export async function handleSsr(ctx) {
  const { req, res, url, path, method,
    DIR, SITE_JSON, getSiteJson, cachedPonderQuery, cachedExists,
    getSsrTemplate, compressedSend, escapeHtml, injectOgTags } = ctx

  // --- SSR for blog posts (SEO: crawlers see full content + dynamic OG tags) ---
  if (path === '/post' && method === 'GET') {
    const postId = url.searchParams.get('id')
    if (postId) {
      try {
        const data = await cachedPonderQuery(
          `ssr:post:${postId}`,
          `query SSRPost($id: BigInt!) { blogPost(id: $id) { id author title content timestamp refType refId } }`,
          { id: postId },
          60000
        )
        const post = data?.blogPost
        if (post) {
          const [amendData, artistData] = await Promise.all([
            cachedPonderQuery(
              `ssr:amend:${postId}`,
              `query SSRAmend($refId: BigInt!) { blogPosts(where: { refType: 5, refId: $refId }, orderBy: "timestamp", orderDirection: "desc", limit: 1) { items { id author title content timestamp refType refId } } }`,
              { refId: postId },
              60000
            ),
            cachedPonderQuery(
              `resolve:${post.author.toLowerCase()}`,
              `query Resolve($ids: [String!]!) { artists(where: { id_in: $ids }, limit: 1) { items { id domain } } }`,
              { ids: [post.author.toLowerCase()] },
              300000
            )
          ])
          const displayPost = amendData?.blogPosts?.items?.[0] || post
          const authorDomain = artistData?.artists?.items?.[0]?.domain || `${post.author.slice(0, 6)}...${post.author.slice(-4)}`

          const date = new Date(Number(displayPost.timestamp) * 1000)
          const dateStr = date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })

          const esc = escapeHtml

          const isScript = displayPost.content.startsWith('<!-- screenplay -->') || displayPost.content.startsWith('<!-- stageplay -->')
          let body
          if (isScript) {
            const markerEnd = displayPost.content.indexOf('\n') + 1
            body = displayPost.content.slice(markerEnd)
            // Escape all HTML — SSR is just for SEO/OG; the SPA re-renders via fountain.js
            body = `<pre style="white-space:pre-wrap;font-family:inherit">${esc(body)}</pre>`
          } else {
            body = esc(displayPost.content)
            body = body.replace(/!\[([^\]]*)\]\s*\(([^)]+)\)/g, (_, alt, imgUrl) => {
              const src = imgUrl.includes('/api/ipfs-proxy/') ? `/api/img?url=${encodeURIComponent(imgUrl)}&w=1200` : imgUrl
              return `<img src="${esc(src)}" alt="${esc(alt)}" loading="lazy" style="max-width:100%;margin:1em 0">`
            })
            body = body.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, href) => {
              if (/^(https?:|\/[^\/])/.test(href)) return `<a href="${esc(href)}">${text}</a>`
              return text
            })
            body = body.split(/\n\n+/).map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('')
          }

          const plain = displayPost.content.replace(/!\[([^\]]*)\]\s*\(([^)]+)\)/g, '')
            .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
            .replace(/<!--.*?-->/g, '').replace(/<[^>]+>/g, '').replace(/\n+/g, ' ').trim()
          const description = esc(plain.slice(0, 160))

          const site = getSiteJson(SITE_JSON)
          const postHtmlFile = join(DIR, 'post', 'index.html')
          if (cachedExists(postHtmlFile)) {
            let html = await getSsrTemplate(postHtmlFile)
            if (!html) { res.writeHead(500); res.end('template read error'); return true }

            const ssrContent = `<header class="post-page-header"><h1 class="post-page-title">${esc(displayPost.title)}</h1><div class="post-page-meta"><a href="/network?artist=${post.author.toLowerCase()}">${esc(authorDomain)}</a><span style="color:var(--dim)"> · </span><time>${dateStr}</time></div></header><div class="post-page-body">${body}</div><div id="post-replies" style="margin-top:2em"></div><div id="post-reply-form" style="margin-top:1.5em"></div>`
            html = html.replace(
              /<p id="post-loading"><span class="praxis-loader"><\/span><\/p>\s*<div id="post-content"><\/div>/,
              `<p id="post-loading" style="display:none"><span class="praxis-loader"></span></p><div id="post-content">${ssrContent}</div>`
            )

            const ogTitle = `${displayPost.title} — ${site.name || authorDomain}`
            const ogImage = `https://${site.domain}/api/og?type=post&title=${encodeURIComponent(displayPost.title)}&author=${encodeURIComponent(authorDomain)}`
            const canonical = `https://${site.domain}/post?id=${postId}`

            html = injectOgTags(html, { title: ogTitle, description, image: ogImage, url: canonical })

            const jsonLd = `<script type="application/ld+json">{"@context":"https://schema.org","@type":"BlogPosting","headline":"${esc(displayPost.title).replace(/"/g, '\\"')}","author":{"@type":"Person","name":"${esc(authorDomain).replace(/"/g, '\\"')}"},"datePublished":"${date.toISOString()}","description":"${description.replace(/"/g, '\\"')}","url":"${canonical}"}</script>`
            html = html.replace('</head>', `${jsonLd}\n</head>`)

            const buf = Buffer.from(html)
            compressedSend(req, res, buf, 'text/html', { 'Cache-Control': 'public, max-age=10, must-revalidate' })
            return true
          }
        }
      } catch (e) {
        console.warn('SSR post error:', e?.message)
      }
    }
  }

  // --- SSR for blog post vanity URLs: /post/<slug> ---
  if (path.startsWith('/post/') && method === 'GET') {
    const slug = decodeURIComponent(path.split('/')[2] || '')
    if (slug) {
      try {
        const site = getSiteJson(SITE_JSON)
        const wallet = site.wallet?.toLowerCase()
        if (wallet) {
          const data = await cachedPonderQuery(
            `ssr:posts:${wallet}`,
            `query SSRPosts($author: String!) { blogPosts(where: { author: $author, refType: 0 }, orderBy: "timestamp", orderDirection: "desc", limit: 200) { items { id title content timestamp } } }`,
            { author: wallet },
            30000
          )
          const posts = data?.blogPosts?.items || []
          let matched = null, displayPost = null
          // Match slug against original titles first, then check amendments
          for (const p of posts) {
            const amendData = await cachedPonderQuery(
              `ssr:amend:${p.id}`,
              `query SSRAmend($refId: BigInt!) { blogPosts(where: { refType: 5, refId: $refId }, orderBy: "timestamp", orderDirection: "desc", limit: 1) { items { id title content timestamp } } }`,
              { refId: p.id },
              60000
            )
            const amended = amendData?.blogPosts?.items?.[0]
            const current = amended || p
            const currentSlug = slugify(current.title)
            const origSlug = slugify(p.title)
            if (origSlug === slug || currentSlug === slug) {
              // Old slug -> 301 to current slug
              if (currentSlug !== slug) {
                res.writeHead(301, { Location: '/post/' + currentSlug })
                res.end()
                return true
              }
              matched = p
              displayPost = current
              break
            }
          }
          if (matched && displayPost) {
            const esc = escapeHtml
            const plain = displayPost.content.replace(/!\[([^\]]*)\]\s*\(([^)]+)\)/g, '')
              .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
              .replace(/<!--.*?-->/g, '').replace(/<[^>]+>/g, '').replace(/\n+/g, ' ').trim()
            const description = esc(plain.slice(0, 160))
            const currentSlug = slugify(displayPost.title)
            const ogTitle = `${displayPost.title} — ${site.name || site.handle}`
            const ogImage = `https://${site.domain}/api/og?type=post&title=${encodeURIComponent(displayPost.title)}&author=${encodeURIComponent(site.name || site.handle)}`
            const canonical = `https://${site.domain}/post/${currentSlug}`

            const postHtmlFile = join(DIR, 'post', 'index.html')
            if (cachedExists(postHtmlFile)) {
              let html = await getSsrTemplate(postHtmlFile)
              if (!html) { res.writeHead(500); res.end('template read error'); return true }
              html = injectOgTags(html, { title: ogTitle, description, image: ogImage, url: canonical })
              const buf = Buffer.from(html)
              compressedSend(req, res, buf, 'text/html', { 'Cache-Control': 'public, max-age=10, must-revalidate' })
              return true
            }
          }
        }
      } catch (e) { console.warn('SSR post slug error:', e?.message) }
    }
  }

  // --- SSR for art pages (SEO: album artwork as OG image) ---
  if (path === '/art' && method === 'GET') {
    const type = url.searchParams.get('type')
    const aliasIdx = parseInt(url.searchParams.get('alias'))
    const albumIdx = parseInt(url.searchParams.get('album'))
    const mediaId = url.searchParams.get('media')

    try {
      const site = getSiteJson(SITE_JSON)
      const esc = escapeHtml
      let ogTitle, ogImage, ogDescription

      if (type && !isNaN(aliasIdx) && !isNaN(albumIdx)) {
        const module = (site.modules || []).find(m => m.type === type)
        if (module?.data) {
          const aliases = module.data.aliases || []
          const alias = aliases[aliasIdx]
          const album = alias?.albums?.[albumIdx]
          if (album) {
            ogTitle = `${album.title} — ${alias?.name || site.name}`
            ogImage = album.art ? `/api/img?url=${encodeURIComponent(album.art)}&w=1200&fmt=jpg` : null
            ogDescription = `${alias?.name || ''} (${album.year || ''})`
          }
        }
      }

      if (mediaId) {
        const data = await cachedPonderQuery(
          `ssr:media:${mediaId}`,
          `query SSRMedia($id: BigInt!) { mediaListing(id: $id) { id title ipfsCid metadataCid artist } }`,
          { id: mediaId },
          60000
        )
        const media = data?.mediaListing
        if (media) {
          ogTitle = `${media.title} — ${site.name}`
          ogImage = media.metadataCid ? `/api/ipfs-proxy/${media.metadataCid}` : null
          ogDescription = media.title
        }
      }

      if (ogTitle) {
        const artHtmlFile = join(DIR, 'art', 'index.html')
        if (cachedExists(artHtmlFile)) {
          let html = await getSsrTemplate(artHtmlFile)
          if (!html) { res.writeHead(500); res.end('template read error'); return true }
          const canonical = `https://${site.domain}${req.url}`

          const absImage = ogImage ? (ogImage.startsWith('http') ? ogImage : `https://${site.domain}${ogImage}`) : undefined
          html = injectOgTags(html, { title: ogTitle, description: ogDescription, image: absImage, url: canonical })

          const buf = Buffer.from(html)
          compressedSend(req, res, buf, 'text/html', { 'Cache-Control': 'public, max-age=10, must-revalidate' })
          return true
        }
      }
    } catch (e) { console.warn('SSR art error:', e?.message) }
  }

  // --- SSR for vanity media URLs: /music/alias/album, /gallery/slug, etc. ---
  const segs = path.split('/').filter(Boolean)
  if (segs.length >= 2 && _VANITY_TYPES.has(segs[0]) && method === 'GET') {
    try {
      const site = getSiteJson(SITE_JSON)
      const modules = site.modules || []
      const type = segs[0]
      const mod = modules.find(m => m.type === type)
      let ogTitle, ogImage, ogDescription

      if (mod?.data && type === 'music' && segs.length >= 3) {
        const aliasSlug = decodeURIComponent(segs[1])
        const albumSlug = decodeURIComponent(segs[2])
        for (const alias of (mod.data.aliases || [])) {
          if (slugify(alias.name) !== aliasSlug) continue
          for (const album of (alias.albums || [])) {
            if (slugify(album.title) === albumSlug) {
              ogTitle = `${album.title} — ${alias.name || site.name}`
              ogImage = album.art ? `/api/img?url=${encodeURIComponent(album.art)}&w=1200&fmt=jpg` : null
              ogDescription = `${alias.name || ''} (${album.year || ''})`
              break
            }
          }
          if (ogTitle) break
        }
      } else if (mod?.data && type === 'gallery') {
        const slug = decodeURIComponent(segs[1])
        const img = (mod.data.images || []).find(i => slugify(i.title) === slug)
        if (img) {
          ogTitle = `${img.title} — ${site.name}`
          ogImage = img.src ? `/api/img?url=${encodeURIComponent(img.src)}&w=1200&fmt=jpg` : null
          ogDescription = [img.medium, img.year].filter(Boolean).join(', ')
        }
      } else if (mod?.data && (type === 'film' || type === 'video')) {
        const slug = decodeURIComponent(segs[1])
        const items = type === 'film' ? (mod.data.works || []) : (Array.isArray(mod.data) ? mod.data : (mod.data.items || []))
        const item = items.find(i => slugify(i.title) === slug)
        if (item) {
          ogTitle = `${item.title} — ${site.name}`
          ogImage = item.poster ? `/api/img?url=${encodeURIComponent(item.poster)}&w=1200&fmt=jpg` : null
          ogDescription = [item.role, item.director ? `dir. ${item.director}` : '', item.year].filter(Boolean).join(', ')
        }
      } else if (mod?.data && (type === 'audio' || type === 'writing')) {
        const slug = decodeURIComponent(segs[1])
        const items = type === 'writing' ? (mod.data.publications || []) : (Array.isArray(mod.data) ? mod.data : (mod.data.items || []))
        const item = items.find(i => slugify(i.title) === slug)
        if (item) {
          ogTitle = `${item.title} — ${site.name}`
          ogDescription = item.description?.slice(0, 160) || ''
        }
      }

      if (ogTitle) {
        const artHtmlFile = join(DIR, 'art', 'index.html')
        if (cachedExists(artHtmlFile)) {
          let html = await getSsrTemplate(artHtmlFile)
          if (!html) { res.writeHead(500); res.end('template read error'); return true }
          const canonical = `https://${site.domain}${path}`
          const absImage = ogImage ? (ogImage.startsWith('http') ? ogImage : `https://${site.domain}${ogImage}`) : undefined
          html = injectOgTags(html, { title: ogTitle, description: ogDescription, image: absImage, url: canonical })
          const buf = Buffer.from(html)
          compressedSend(req, res, buf, 'text/html', { 'Cache-Control': 'public, max-age=10, must-revalidate' })
          return true
        }
      }

      // Slug redirect: old vanity slug -> 301 to new URL
      const redirectKey = path.slice(1)
      const redirectTarget = site?._slugRedirects?.[redirectKey]
      if (redirectTarget) {
        res.writeHead(301, { Location: '/' + redirectTarget })
        res.end()
        return true
      }
    } catch (e) { console.warn('SSR vanity error:', e?.message) }
  }

  // --- SSR for project vanity URLs: /project/<slug> ---
  if (path.startsWith('/project/') && method === 'GET') {
    const slug = decodeURIComponent(path.split('/')[2] || '')
    if (slug) {
      try {
        const site = getSiteJson(SITE_JSON)
        const wallet = site.wallet?.toLowerCase()
        if (wallet) {
          const data = await cachedPonderQuery(
            `ssr:projects:${wallet}`,
            `query SSRProjects($proposer: String!) { projects(where: { proposer: $proposer }, orderBy: "createdAt", orderDirection: "desc", limit: 200) { items { id title description status } } }`,
            { proposer: wallet },
            30000
          )
          const projects = data?.projects?.items || []
          const matched = projects.find(p => slugify(p.title) === slug)
          if (matched) {
            const esc = escapeHtml
            const statusLabels = { 0: 'proposed', 1: 'funded', 2: 'confirmed', 3: 'completing', 4: 'completed', 5: 'cancelled' }
            const statusLabel = statusLabels[matched.status] || 'proposed'
            const ogTitle = `${matched.title} — ${site.name || 'praxis'}`
            const ogDescription = esc((matched.description || '').slice(0, 160))
            const ogImage = `https://${site.domain}/api/og?type=project&title=${encodeURIComponent(matched.title)}&status=${encodeURIComponent(statusLabel)}`
            const canonical = `https://${site.domain}/project/${slug}`

            const projectHtmlFile = join(DIR, 'project', 'index.html')
            if (cachedExists(projectHtmlFile)) {
              let html = await getSsrTemplate(projectHtmlFile)
              if (!html) { res.writeHead(500); res.end('template read error'); return true }
              html = injectOgTags(html, { title: ogTitle, description: ogDescription, image: ogImage, url: canonical })
              const buf = Buffer.from(html)
              compressedSend(req, res, buf, 'text/html', { 'Cache-Control': 'public, max-age=10, must-revalidate' })
              return true
            }
          }
        }
      } catch (e) { console.warn('SSR project slug error:', e?.message) }
    }
  }

  // --- SSR for project pages (SEO: dynamic OG for project details) ---
  if (path === '/project' && method === 'GET') {
    const projectId = url.searchParams.get('id')
    if (projectId) {
      try {
        const data = await cachedPonderQuery(
          `ssr:project:${projectId}`,
          `query SSRProject($id: BigInt!) { project(id: $id) { id title description status proposer } }`,
          { id: projectId },
          60000
        )
        const project = data?.project
        if (project) {
          const site = getSiteJson(SITE_JSON)
          const esc = escapeHtml

          const statusLabels = { 0: 'proposed', 1: 'funded', 2: 'confirmed', 3: 'completing', 4: 'completed', 5: 'cancelled' }
          const statusLabel = statusLabels[project.status] || 'proposed'
          const ogTitle = `${project.title} — ${site.name || 'praxis'}`
          const ogDescription = esc((project.description || '').slice(0, 160))
          const ogImage = `https://${site.domain}/api/og?type=project&title=${encodeURIComponent(project.title)}&status=${encodeURIComponent(statusLabel)}`
          const canonical = `https://${site.domain}/project?id=${projectId}`

          const projectHtmlFile = join(DIR, 'project', 'index.html')
          if (cachedExists(projectHtmlFile)) {
            let html = await getSsrTemplate(projectHtmlFile)
            if (!html) { res.writeHead(500); res.end('template read error'); return true }

            html = injectOgTags(html, { title: ogTitle, description: ogDescription, image: ogImage, url: canonical })

            const buf = Buffer.from(html)
            compressedSend(req, res, buf, 'text/html', { 'Cache-Control': 'public, max-age=10, must-revalidate' })
            return true
          }
        }
      } catch (e) { console.warn('SSR project error:', e?.message) }
    }
  }

  return false
}
