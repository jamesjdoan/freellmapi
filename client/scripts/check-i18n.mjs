import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const localeDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../src/i18n/locales',
)
const expectedLocales = [
  'en', 'zh-CN', 'es', 'fr', 'pt-BR', 'it', 'hi', 'ar', 'bn', 'ru',
  'ur', 'id', 'de', 'ja', 'sw', 'mr', 'te', 'tr', 'ta', 'vi',
  'ko', 'fa', 'th', 'gu', 'pl', 'uk', 'kn', 'ml', 'or', 'my',
  'pa', 'ro', 'nl', 'ms', 'tl', 'ha', 'yo', 'ig', 'am', 'uz',
  'az', 'si', 'ne', 'km', 'el', 'cs', 'hu', 'sv', 'he', 'da',
  'fi', 'no', 'sk', 'bg', 'hr', 'sr', 'lt', 'zh-TW', 'pt-PT', 'ka',
]

function flatten(value, prefix = '', output = new Map()) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      flatten(child, prefix ? `${prefix}.${key}` : key, output)
    }
  } else {
    output.set(prefix, value)
  }
  return output
}

function placeholders(value) {
  if (typeof value !== 'string') return []
  return [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort()
}

// Script coherence. A missing key is caught above and an English value is a
// legitimate state (many keys are still awaiting a translator), but a value
// that mixes unrelated writing systems is neither: it is fabricated text.
//
// This exists because a translation pass produced Malayalam strings containing
// Japanese, Cyrillic and Thai words, and a Khmer string carrying a
// Canadian-syllabics character and Unicode replacement marks. All of it parsed
// as JSON, type-checked, and passed every other check in this project - a
// string is a string. Only a reader of that language would have noticed.
//
// Latin is exempt everywhere: product names, model ids and units are Latin in
// every locale. Japanese legitimately mixes Han with both kana, and Korean
// mixes Hangul with Han, so those combinations are declared native.
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
const NATIVE_SCRIPTS = {
  ja: ['Han', 'Kana'], ko: ['Hangul', 'Han'], 'zh-CN': ['Han'], 'zh-TW': ['Han'],
}

function foreignScripts(value, locale) {
  if (typeof value !== 'string') return []
  const native = new Set(NATIVE_SCRIPTS[locale] ?? [])
  const stripped = value.replace(/\{\w+\}/g, '')
  return SCRIPT_PATTERNS
    .filter(([name, pattern]) => pattern.test(stripped) && !native.has(name))
    .map(([name]) => name)
}

const fileNames = (await readdir(localeDirectory))
  .filter(fileName => fileName.endsWith('.json'))
  .sort()
const actualLocales = fileNames.map(fileName => fileName.slice(0, -5))
const missingFiles = expectedLocales.filter(locale => !actualLocales.includes(locale))
const unexpectedFiles = actualLocales.filter(locale => !expectedLocales.includes(locale))
const errors = []

if (missingFiles.length) errors.push(`Missing locale files: ${missingFiles.join(', ')}`)
if (unexpectedFiles.length) errors.push(`Unexpected locale files: ${unexpectedFiles.join(', ')}`)

const english = JSON.parse(await readFile(path.join(localeDirectory, 'en.json'), 'utf8'))
const englishEntries = flatten(english)
const englishKeys = new Set(englishEntries.keys())

for (const locale of actualLocales) {
  const dictionary = JSON.parse(
    await readFile(path.join(localeDirectory, `${locale}.json`), 'utf8'),
  )
  const entries = flatten(dictionary)
  const keys = new Set(entries.keys())
  const missingKeys = [...englishKeys].filter(key => !keys.has(key))
  const extraKeys = [...keys].filter(key => !englishKeys.has(key))

  if (missingKeys.length) {
    errors.push(`${locale}: missing keys: ${missingKeys.join(', ')}`)
  }
  if (extraKeys.length) {
    errors.push(`${locale}: extra keys: ${extraKeys.join(', ')}`)
  }

  for (const [key, englishValue] of englishEntries) {
    if (!entries.has(key)) continue
    const localizedValue = entries.get(key)
    if (typeof localizedValue !== typeof englishValue) {
      errors.push(`${locale}:${key}: expected ${typeof englishValue}, got ${typeof localizedValue}`)
      continue
    }
    const expectedPlaceholders = placeholders(englishValue)
    const actualPlaceholders = placeholders(localizedValue)
    if (expectedPlaceholders.join(',') !== actualPlaceholders.join(',')) {
      errors.push(
        `${locale}:${key}: placeholders {${actualPlaceholders.join(', ')}} do not match {${expectedPlaceholders.join(', ')}}`,
      )
    }
    const mixed = foreignScripts(localizedValue, locale)
    if (mixed.length > 1) {
      errors.push(`${locale}:${key}: mixes ${mixed.join(' + ')} in one string - ${JSON.stringify(localizedValue)}`)
    }
    if (localizedValue.includes('\uFFFD')) {
      errors.push(`${locale}:${key}: contains a Unicode replacement character - ${JSON.stringify(localizedValue)}`)
    }
  }
}

if (errors.length) {
  console.error(`i18n validation failed with ${errors.length} error(s):`)
  for (const error of errors) console.error(`- ${error}`)
  process.exitCode = 1
} else {
  console.log(`i18n validation passed for ${actualLocales.length} locales and ${englishKeys.size} keys`)
}
