const installedIdsByDoc = new WeakMap<object, Set<string>>();
const sheetCacheByCtor = new WeakMap<object, Map<string, CSSStyleSheet>>();

/**
 * Installs a stylesheet once per owner Document, preferring Constructable Stylesheets
 * (`adoptedStyleSheets`) for zero-DOM-node shared CSS bytecode and falling back to a
 * deduplicated `<style id>` element in headless test DOMs.
 */
export function adoptDocumentStyleSheet(owner: Document | undefined, id: string, cssText: string): void {
  if (!owner) return;
  let installed = installedIdsByDoc.get(owner);
  if (installed?.has(id)) return;

  const SheetCtor = (owner.defaultView as (Window & { CSSStyleSheet?: typeof CSSStyleSheet }) | null | undefined)?.CSSStyleSheet
    ?? (typeof CSSStyleSheet === 'function' ? CSSStyleSheet : undefined);

  if (SheetCtor && Array.isArray(owner.adoptedStyleSheets)) {
    try {
      let byCss = sheetCacheByCtor.get(SheetCtor);
      if (!byCss) {
        byCss = new Map();
        sheetCacheByCtor.set(SheetCtor, byCss);
      }
      let sheet = byCss.get(cssText);
      if (!sheet) {
        sheet = new SheetCtor();
        sheet.replaceSync(cssText);
        byCss.set(cssText, sheet);
      }
      if (!owner.adoptedStyleSheets.includes(sheet)) {
        owner.adoptedStyleSheets = [...owner.adoptedStyleSheets, sheet];
      }
      if (!installed) {
        installed = new Set();
        installedIdsByDoc.set(owner, installed);
      }
      installed.add(id);
      return;
    } catch {
      // Fall through to <style> injection when the environment stubs CSSStyleSheet without replaceSync.
    }
  }

  if (!owner.head || owner.getElementById?.(id)) return;
  const style = owner.createElement('style');
  style.id = id;
  style.textContent = cssText;
  owner.head.append(style);
  if (!installed) {
    installed = new Set();
    installedIdsByDoc.set(owner, installed);
  }
  installed.add(id);
}
