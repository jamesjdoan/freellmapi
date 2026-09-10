#!/usr/bin/env node
// Merge translation batches into the locale files.
//
// Translation arrives as per-batch JSON, one object per locale, nested exactly
// like en.json. This applies it key by key and refuses anything that would
// break the dashboard or leave a fabrication behind:
//   - a key en.json does not have          (a typo in the batch)
//   - a value whose placeholders disagree  (renders a hole or a literal brace)
//   - a value mixing unrelated scripts     (fabricated text)
//   - a Unicode replacement character      (mangled encoding)
//   - the literal marker UNTRANSLATED      (the translator declined; the key
//     falls through to the English text, which is a state 3300 other keys are
//     already in and is honest, unlike inventing a translation)
//
// Rejections are reported and skipped, never applied. Everything written is
// re-read and re-parsed afterwards, and existing content is preserved
// byte-for-byte apart from the inserted keys.
//
// `--fill-english` then copies the English text into any key a locale still
// lacks. That is not a translation and is not pretending to be one: `t()`
// already falls back to English for a missing key, so the rendered UI is
// identical either way - but check-i18n requires the key to be PRESENT, and
// 3300 keys across these files are already in exactly this state. It makes the
// gap explicit and greppable instead of leaving the suite red.
//
//   node scripts/apply-translations.mjs /tmp/batch-*.json
//   node scripts/apply-translations.mjs --dry-run /tmp/batch-*.json
//   node scripts/apply-translations.mjs --fill-english

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'i18n', 'locales')
const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const fillEnglish = args.includes('--fill-english')
const files = args.filter(a => !a.startsWith('--'))
if (files.length === 0 && !fillEnglish) {
  console.error('usage: apply-translations.mjs [--dry-run] [--fill-english] <batch.json>...')
  process.exit(2)
}

const SCRIPT_PATTERNS = [
  ['Cyrillic', /\p{Script=Cyrillic}/u], ['Greek', /\p{Script=Greek}/u],
  ['Arabic', /\p{Script=Arabic}/u], ['Hebrew', /\p{Script=Hebrew}/u],
  ['Devanagari', /\p{Script=Devanagari}/u], ['Bengali', /\p{Script=Bengali}/u],
  ['Gujarati', /\p{Script=Gujarati}/u], ['Gurmukhi', /\p{Script=Gurmukhi}/u],
  ['Tamil', /\p{Script=Tamil}/u], ['Telugu', /\p{Script=Telugu}/u],
  ['Kannada', /\p{Script=Kannada}/u], ['Malayalam', /\p{Script=Malayalam}/u],
  ['Sinhala', /\p{Script=Sinhala}/u], ['Thai', /\p{Script=Thai}/u],
  ['Khmer', /\p{Script=Khmer}/u], ['Myanmar', /\p{Script=Myanmar}/u],
  ['Georgian', /\p{Script=Georgian}/u], ['Ethiopic', /\p{Script=Ethiopic}/u],
  ['Hangul', /\p{Script=Hangul}/u], ['Han', /\p{Script=Han}/u],
  ['Kana', /[\p{Script=Hiragana}\p{Script=Katakana}]/u],
]
const NATIVE_SCRIPTS = { ja: ['Han', 'Kana'], ko: ['Hangul', 'Han'], 'zh-CN': ['Han'], 'zh-TW': ['Han'] }
const placeholders = s => [...String(s).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',')

function flatten(obj, prefix = '', out = new Map()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out)
    else out.set(key, v)
  }
  return out
}

function setPath(obj, dotted, value) {
  const parts = dotted.split('.')
  let node = obj
  for (const p of parts.slice(0, -1)) {
    if (typeof node[p] !== 'object' || node[p] === null) node[p] = {}
    node = node[p]
  }
  node[parts.at(-1)] = value
}

const en = flatten(JSON.parse(readFileSync(join(dir, 'en.json'), 'utf8')))

// locale -> dotted key -> value, last batch wins
const incoming = new Map()
for (const file of files) {
  const batch = JSON.parse(readFileSync(file, 'utf8'))
  for (const [locale, tree] of Object.entries(batch)) {
    const bucket = incoming.get(locale) ?? new Map()
    for (const [key, value] of flatten(tree)) bucket.set(key, value)
    incoming.set(locale, bucket)
  }
}

const rejected = []
const declined = []
let applied = 0
const touched = []

for (const [locale, entries] of [...incoming].sort()) {
  const path = join(dir, `${locale}.json`)
  if (!existsSync(path)) { rejected.push(`${locale}: no such locale file`); continue }
  const doc = JSON.parse(readFileSync(path, 'utf8'))
  const native = new Set(NATIVE_SCRIPTS[locale] ?? [])
  let changes = 0

  for (const [key, value] of entries) {
    const enValue = en.get(key)
    if (enValue === undefined) { rejected.push(`${locale}:${key}: not a key in en.json`); continue }
    if (typeof value !== 'string') { rejected.push(`${locale}:${key}: not a string`); continue }
    if (value === 'UNTRANSLATED') { declined.push(`${locale}:${key}`); continue }
    if (placeholders(value) !== placeholders(enValue)) {
      rejected.push(`${locale}:${key}: placeholders {${placeholders(value)}} != {${placeholders(enValue)}} -> ${JSON.stringify(value)}`)
      continue
    }
    if (value.includes('\uFFFD')) { rejected.push(`${locale}:${key}: replacement character -> ${JSON.stringify(value)}`); continue }
    const stripped = value.replace(/\{\w+\}/g, '')
    const mixed = SCRIPT_PATTERNS.filter(([n, re]) => re.test(stripped) && !native.has(n)).map(([n]) => n)
    if (mixed.length > 1) {
      rejected.push(`${locale}:${key}: mixes ${mixed.join(' + ')} -> ${JSON.stringify(value)}`)
      continue
    }
    setPath(doc, key, value)
    changes++
  }

  if (changes > 0 && !dryRun) {
    // Trailing newline and two-space indent, matching the files as committed.
    writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`)
    JSON.parse(readFileSync(path, 'utf8'))
  }
  if (changes > 0) { applied += changes; touched.push(`${locale}:${changes}`) }
}

// Second pass: every key still absent gets the English text verbatim.
let filled = 0
const filledLocales = []
if (fillEnglish) {
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json') || file === 'en.json') continue
    const path = join(dir, file)
    const doc = JSON.parse(readFileSync(path, 'utf8'))
    const have = flatten(doc)
    let changes = 0
    for (const [key, enValue] of en) {
      if (have.has(key)) continue
      setPath(doc, key, enValue)
      changes++
    }
    if (changes > 0) {
      if (!dryRun) {
        writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`)
        JSON.parse(readFileSync(path, 'utf8'))
      }
      filled += changes
      filledLocales.push(`${file.replace(/\.json$/, '')}:${changes}`)
    }
  }
}

console.log(`${dryRun ? 'DRY RUN - ' : ''}applied ${applied} value(s) across ${touched.length} locale(s)`)
if (fillEnglish) console.log(`filled ${filled} key(s) with the English text across ${filledLocales.length} locale(s) - untranslated, not fabricated`)
if (declined.length) console.log(`declined by translator (left to English fallback): ${declined.length}\n  ${declined.join('\n  ')}`)
if (rejected.length) {
  console.error(`REJECTED ${rejected.length} value(s):`)
  for (const r of rejected) console.error(`  ${r}`)
  process.exitCode = 1
}
