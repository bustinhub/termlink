const dns = require('node:dns').promises;
const net = require('node:net');

function cleanUsername(value = '') {
  return String(value).trim().toLowerCase();
}

function publicUser(user) {
  if (!user) return null;
  const { password_hash, ...safe } = user;
  return safe;
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168);
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    return v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80:');
  }
  return true;
}

async function isSafePublicUrl(raw) {
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    if (['localhost', '0.0.0.0'].includes(url.hostname)) return false;
    const addrs = await dns.lookup(url.hostname, { all: true });
    return addrs.length > 0 && addrs.every(({ address }) => !isPrivateIp(address));
  } catch {
    return false;
  }
}

function extractMeta(html, name, property) {
  const escaped = (property || name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = property ? [
    new RegExp(`<meta[^>]+property=["']${escaped}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${escaped}["']`, 'i')
  ] : [
    new RegExp(`<meta[^>]+name=["']${escaped}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${escaped}["']`, 'i')
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) return decodeHtml(m[1]);
  }
  return '';
}

function decodeHtml(s = '') {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
}

async function getLinkPreview(raw) {
  if (!(await isSafePublicUrl(raw))) throw new Error('Unsafe URL');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4500);
  try {
    const r = await fetch(raw, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'TerminalMessenger/1.0 link-preview' }
    });
    const type = r.headers.get('content-type') || '';
    if (!type.includes('text/html')) return { url: r.url || raw, title: new URL(raw).hostname, description: '', image: '' };
    const html = (await r.text()).slice(0, 500000);
    const titleTag = html.match(/<title[^>]*>([^<]{1,300})<\/title>/i)?.[1] || '';
    return {
      url: r.url || raw,
      title: extractMeta(html, null, 'og:title') || decodeHtml(titleTag) || new URL(raw).hostname,
      description: (extractMeta(html, null, 'og:description') || extractMeta(html, 'description')).slice(0, 260),
      image: extractMeta(html, null, 'og:image') || ''
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { cleanUsername, publicUser, getLinkPreview };
