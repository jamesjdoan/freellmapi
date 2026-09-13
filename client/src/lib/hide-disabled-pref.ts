// Which providers' model tables hide the rows that cannot route.
//
// Per provider, because HuggingFace with 121 rows wants hiding and Groq with 4
// does not, and re-hiding on every expand made the control feel broken.
//
// localStorage rather than server settings: this is view state. Hiding a row
// here changes nothing about what routes, unlike the Quota panel's hidden
// pools, which are a property of the install. Absence means "no opinion" — a
// stored `false` would outlive any change to the default.
//
// Lives in lib/ rather than beside the panel so the component file exports only
// components (react-refresh/only-export-components).

const PREFIX = 'freellmapi.keys.hideDisabled.'

export function readHideDisabled(platform: string): boolean {
  try {
    return localStorage.getItem(PREFIX + platform) === '1'
  } catch {
    // Private mode, disabled storage, a sandboxed frame: a view preference must
    // never be the reason a panel fails to render.
    return false
  }
}

export function writeHideDisabled(platform: string, hide: boolean): void {
  try {
    if (hide) localStorage.setItem(PREFIX + platform, '1')
    else localStorage.removeItem(PREFIX + platform)
  } catch { /* see readHideDisabled */ }
}
