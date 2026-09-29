// Network allowlist entries are URL hostnames, one per line. URL parsing avoids suffix and userinfo tricks;
// URL.hostname also normalizes DNS names to lowercase.
export function isNetworkUrlAllowed(value: string, allowedHosts: string | undefined): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const allowed = new Set(
    (allowedHosts ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim().toLowerCase())
      .filter(Boolean),
  );
  return allowed.has(url.hostname.toLowerCase());
}
