// i18n — shared internationalization for artist sites
const SUPPORTED = ['en','es','fr','pt','ar','zh','ja','ko','sw','hi','de','ru','bn','id','tr','vi','fa','ur','sv','da']
const DEFAULT = 'en'
let strings = {}
let currentLang = DEFAULT
let ready = false
const waiters = []

function detectLanguage() {
  const stored = localStorage.getItem('praxis-lang')
  if (stored && SUPPORTED.includes(stored)) return stored
  const nav = (navigator.language || '').split('-')[0].toLowerCase()
  if (SUPPORTED.includes(nav)) return nav
  return DEFAULT
}

async function init() {
  const lang = detectLanguage()
  await setLanguage(lang)
}

async function setLanguage(lang) {
  if (!SUPPORTED.includes(lang)) lang = DEFAULT
  try {
    const res = await fetch(`/i18n/${lang}.json`)
    if (!res.ok) throw new Error()
    strings = await res.json()
  } catch {
    if (lang !== DEFAULT) {
      try {
        const res = await fetch(`/i18n/${DEFAULT}.json`)
        strings = await res.json()
      } catch {}
      lang = DEFAULT
    }
  }
  currentLang = lang
  localStorage.setItem('praxis-lang', lang)
  document.documentElement.lang = lang
  document.documentElement.dir = ['ar','fa','ur'].includes(lang) ? 'rtl' : 'ltr'
  applyTranslations()

  const switcher = document.getElementById('lang-switcher')
  if (switcher) switcher.value = lang

  if (!ready) {
    ready = true
    waiters.forEach(fn => fn())
    waiters.length = 0
  } else {
    // reload to re-render JS-generated content (feed, projects, etc.) with new language
    window.location.reload()
  }
}

function applyTranslations() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.dataset.i18n
    if (strings[key]) el.textContent = strings[key]
  })
  document.querySelectorAll('[data-i18n-html]').forEach(el => {
    const key = el.dataset.i18nHtml
    if (strings[key]) el.innerHTML = strings[key]
  })
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.dataset.i18nPlaceholder
    if (strings[key]) el.placeholder = strings[key]
  })
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const key = el.dataset.i18nTitle
    if (strings[key]) el.title = strings[key]
  })
}

function t(key, vars = {}) {
  let s = strings[key] || key
  for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, v)
  return s
}

function whenReady() {
  if (ready) return Promise.resolve()
  return new Promise(resolve => waiters.push(resolve))
}

function getLang() { return currentLang }

// auto-init
init()

export { t, init, setLanguage, whenReady, getLang, applyTranslations, SUPPORTED }
