import { INSPECTOR_ASSETS } from './inspector-bundle.js';

const placeholder = '__MAYURA_STYLE_NONCE__';
/** 16 random bytes, base64: a fresh nonce per console page response. */
function nonce(): string { return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))); }

/**
 * Operator console served same-origin by the agent server when `inspector: true`. The static assets are prebuilt from
 * packages/inspector-ui and contain no data; every read and command goes through the authenticated API with a token the
 * operator types, which stays in page memory. React renders all values as text.
 */
const headers = (styleNonce?: string) => ({
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Resource-Policy': 'same-origin',
  // Scripts are same-origin files only. The page nonce admits the one <style> element dialogs inject for scroll locking.
  'Content-Security-Policy': `default-src 'none'; script-src 'self'; style-src 'self'${styleNonce ? ` 'nonce-${styleNonce}'` : ''}; connect-src 'self'; img-src 'self' data:; font-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`,
});

/** Static console assets for a GET of exactly these paths; `undefined` for everything else. */
export function inspectorAsset(method: string, pathname: string): Response | undefined {
  const path = pathname === '/inspector/' ? '/inspector' : pathname;
  const asset = method === 'GET' && Object.hasOwn(INSPECTOR_ASSETS, path) ? INSPECTOR_ASSETS[path] : undefined;
  if (!asset) return undefined;
  if (path !== '/inspector') return new Response(asset.body, { status: 200, headers: { ...headers(), 'Content-Type': asset.type } });
  const value = nonce();
  return new Response(asset.body.replace(placeholder, value), { status: 200, headers: { ...headers(value), 'Content-Type': asset.type } });
}
