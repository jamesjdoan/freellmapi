/** Fired to open the Extensions dialog from anywhere (the ⋯ menu, and panels
 *  that are gated by an extension that is switched off). */
export const OPEN_EXTENSIONS_EVENT = 'freellmapi:open-extensions'

export function openExtensions(): void {
  window.dispatchEvent(new Event(OPEN_EXTENSIONS_EVENT))
}
