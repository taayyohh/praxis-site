// markdown-editor.js — reusable markdown editor with toolbar, image upload, preview
// Usage: const editor = createMarkdownEditor(containerEl, { placeholder, rows, value })
//        editor.getValue() / editor.setValue(text)

import { escapeHtml, renderMarkdown } from './utils.js'

export function createMarkdownEditor(container, opts = {}) {
  const { placeholder = 'write something...', rows = 6, value = '', onInput } = opts

  const wrapper = document.createElement('div')
  wrapper.className = 'md-editor'

  // Toolbar
  const toolbar = document.createElement('div')
  toolbar.className = 'md-editor-toolbar'
  toolbar.innerHTML = `
    <div style="display:flex;gap:0.3em;align-items:center;flex-wrap:wrap">
      <button type="button" class="md-fmt" data-wrap="**" title="bold"><b>B</b></button>
      <button type="button" class="md-fmt" data-wrap="*" title="italic"><i>I</i></button>
      <button type="button" class="md-fmt" data-prefix="## " title="heading">H</button>
      <button type="button" class="md-fmt" data-link="true" title="link"><i class="ph ph-link-simple"></i></button>
      <button type="button" class="md-fmt" data-prefix="> " title="quote"><i class="ph ph-quotes"></i></button>
      <button type="button" class="md-fmt" data-prefix="- " title="list"><i class="ph ph-list"></i></button>
      <button type="button" class="md-fmt md-img-btn" title="image"><i class="ph ph-image"></i></button>
      <input type="file" class="md-img-input" accept="image/*" style="display:none">
    </div>
    <button type="button" class="md-preview-toggle" style="font-size:0.75em;color:var(--muted);background:none;border:1px solid var(--border);padding:0.2em 0.8ch;cursor:pointer;border-radius:3px;font-family:inherit">preview</button>
  `

  // Textarea
  const textarea = document.createElement('textarea')
  textarea.className = 'md-editor-textarea project-input'
  textarea.placeholder = placeholder
  textarea.rows = rows
  textarea.value = value
  textarea.style.cssText = 'width:100%;resize:vertical;box-sizing:border-box'
  if (onInput) textarea.addEventListener('input', () => onInput(textarea.value))

  // Preview pane
  const preview = document.createElement('div')
  preview.className = 'md-editor-preview'
  preview.style.cssText = 'display:none;padding:1em;border:1px solid var(--border);border-radius:4px;min-height:100px;line-height:1.6;overflow-y:auto'

  wrapper.appendChild(toolbar)
  wrapper.appendChild(textarea)
  wrapper.appendChild(preview)
  container.appendChild(wrapper)

  // Format buttons
  toolbar.querySelectorAll('.md-fmt:not(.md-img-btn)').forEach(btn => {
    btn.addEventListener('click', () => {
      const start = textarea.selectionStart
      const end = textarea.selectionEnd
      const selected = textarea.value.substring(start, end)
      if (btn.dataset.wrap) {
        const w = btn.dataset.wrap
        textarea.value = textarea.value.substring(0, start) + w + selected + w + textarea.value.substring(end)
        textarea.selectionStart = start + w.length
        textarea.selectionEnd = end + w.length
      } else if (btn.dataset.prefix) {
        const p = btn.dataset.prefix
        textarea.value = textarea.value.substring(0, start) + p + selected + textarea.value.substring(end)
        textarea.selectionStart = start + p.length
        textarea.selectionEnd = end + p.length
      } else if (btn.dataset.link) {
        const linkInput = document.createElement('div')
        linkInput.style.cssText = 'display:flex;gap:0.4ch;align-items:center;margin-top:0.3em'
        linkInput.innerHTML = `<input type="url" placeholder="https://..." style="flex:1;background:var(--surface);border:1px solid var(--border);color:var(--fg);font-family:inherit;font-size:0.85em;padding:0.3em 0.5ch;border-radius:3px"><button class="feed-card-btn" style="font-size:0.75em;padding:0.3em 0.8ch">insert</button><button style="background:none;border:none;color:var(--dim);cursor:pointer;font-size:0.8em">cancel</button>`
        toolbar.after(linkInput)
        const urlInput = linkInput.querySelector('input')
        urlInput.focus()
        linkInput.querySelector('.feed-card-btn').addEventListener('click', () => {
          const url = urlInput.value.trim()
          if (url) {
            const linkText = selected || 'link'
            textarea.value = textarea.value.substring(0, start) + `[${linkText}](${url})` + textarea.value.substring(end)
          }
          linkInput.remove()
          textarea.focus()
        })
        linkInput.querySelector('button:last-child').addEventListener('click', () => { linkInput.remove(); textarea.focus() })
        return
      }
      textarea.focus()
      onInput?.(textarea.value)
    })
  })

  // Image upload
  const imgBtn = toolbar.querySelector('.md-img-btn')
  const imgInput = toolbar.querySelector('.md-img-input')
  imgBtn.addEventListener('click', () => imgInput.click())
  imgInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || !file.type.startsWith('image/')) return
    const statusText = textarea.placeholder
    textarea.placeholder = `uploading ${file.name}...`
    try {
      let authToken = sessionStorage.getItem('praxis-auth-token') || ''
      if (!authToken) {
        await window.ensureAuthorized?.()
        const addr = window.getWalletAddress?.()
        const provider = window.getWalletProvider?.()
        if (provider && addr) {
          const msg = `admin:${location.hostname}:${Date.now()}`
          const sig = await provider.request({ method: 'personal_sign', params: [msg, addr] })
          const authRes = await fetch('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address: addr, signature: sig, message: msg }) })
          const authData = await authRes.json()
          if (authData.token) { authToken = authData.token; sessionStorage.setItem('praxis-auth-token', authToken) }
        }
      }
      const buf = await file.arrayBuffer()
      const uploadRes = await fetch(`/api/ipfs?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Authorization': `Bearer ${authToken}` }, body: buf })
      const uploadData = await uploadRes.json()
      if (uploadData.jobId) {
        for (let i = 0; i < 30; i++) {
          await new Promise(r => setTimeout(r, 1000))
          const s = await fetch(`/api/ipfs/status/${uploadData.jobId}`).then(r => r.json())
          if (s.cid) {
            const imgUrl = `/api/ipfs-proxy/${s.cid}`
            textarea.value += `\n![${file.name}](${imgUrl})\n`
            onInput?.(textarea.value)
            break
          }
          if (s.status === 'error') break
        }
      }
    } catch (err) {
      console.error('image upload failed:', err)
    }
    textarea.placeholder = statusText
  })

  // Drag-and-drop images
  textarea.addEventListener('dragover', (e) => { e.preventDefault(); textarea.style.borderColor = 'var(--accent)' })
  textarea.addEventListener('dragleave', () => { textarea.style.borderColor = '' })
  textarea.addEventListener('drop', (e) => {
    e.preventDefault()
    textarea.style.borderColor = ''
    const file = e.dataTransfer?.files?.[0]
    if (file?.type.startsWith('image/')) {
      imgInput.files = e.dataTransfer.files
      imgInput.dispatchEvent(new Event('change'))
    }
  })

  // Preview toggle
  const previewBtn = toolbar.querySelector('.md-preview-toggle')
  let previewing = false
  previewBtn.addEventListener('click', () => {
    previewing = !previewing
    if (previewing) {
      preview.innerHTML = renderMarkdown(textarea.value) || '<span style="color:var(--dim)">nothing to preview</span>'
      preview.style.display = 'block'
      textarea.style.display = 'none'
      previewBtn.textContent = 'edit'
      previewBtn.style.borderColor = 'var(--accent)'
      previewBtn.style.color = 'var(--accent)'
    } else {
      preview.style.display = 'none'
      textarea.style.display = ''
      previewBtn.textContent = 'preview'
      previewBtn.style.borderColor = ''
      previewBtn.style.color = ''
      textarea.focus()
    }
  })

  return {
    getValue: () => textarea.value,
    setValue: (v) => { textarea.value = v },
    getElement: () => wrapper,
    focus: () => textarea.focus(),
  }
}
