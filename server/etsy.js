// Live listings from the Etsy 3D printing shop (Etsy Open API v3).
//
// Only public shop data is read, so no OAuth is needed: every request just
// carries x-api-key: <keystring>:<shared secret>. Both halves stay on this
// server; the browser only ever sees the trimmed listing JSON below.
//
// The app is limited to 10 requests/second and 10K/day, so results are cached
// in memory. A refresh costs 3 calls (shop lookup once, then one active-listings
// page plus one image batch per 100 listings), and concurrent visitors share a
// single in-flight refresh. If Etsy is unreachable the last good result keeps
// being served rather than emptying the section.

const API_BASE = 'https://openapi.etsy.com/v3/application';
const CACHE_TTL_MS = 30 * 60 * 1000;
// After a failed refresh, wait this long before trying Etsy again.
const RETRY_AFTER_MS = 2 * 60 * 1000;
const PAGE_SIZE = 100; // Etsy's max for both endpoints below.

let shop = null; // { id, ownerUserId }
let cache = null; // { listings, categoryCounts, fetchedAt }
let nextAttemptAt = 0;
let inFlight = null;

function config() {
  const keystring = String(process.env.ETSY_API_KEYSTRING || '').trim();
  const secret = String(process.env.ETSY_SHARED_SECRET || '').trim();
  const shopName = String(process.env.ETSY_SHOP_NAME || '').trim();
  return keystring && secret && shopName ? { apiKey: `${keystring}:${secret}`, shopName } : null;
}

function isConfigured() {
  return Boolean(config());
}

async function etsyGet(path, apiKey) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { 'x-api-key': apiKey, Accept: 'application/json' },
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Etsy ${path.split('?')[0]} returned ${response.status}: ${body.slice(0, 200)}`);
  }
  return response.json();
}

// Etsy returns titles HTML-escaped ("Mom&#39;s Planter"); Angular escapes on
// render too, so they'd otherwise show up double-encoded.
function decodeEntities(value) {
  return String(value || '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

async function resolveShop({ apiKey, shopName }) {
  if (shop) return shop;
  const body = await etsyGet(`/shops?shop_name=${encodeURIComponent(shopName)}`, apiKey);
  const match = (body.results || []).find(item => String(item.shop_name).toLowerCase() === shopName.toLowerCase());
  if (!match) throw new Error(`Etsy shop "${shopName}" was not found.`);
  shop = { id: match.shop_id, ownerUserId: match.user_id };
  return shop;
}

async function getShop() {
  const settings = config();
  if (!settings) throw new Error('Etsy is not configured.');
  return resolveShop(settings);
}

async function fetchListings() {
  const settings = config();
  if (!settings) throw new Error('Etsy is not configured.');
  const { id } = await resolveShop(settings);

  const active = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await etsyGet(`/shops/${id}/listings/active?limit=${PAGE_SIZE}&offset=${offset}`, settings.apiKey);
    active.push(...(page.results || []));
    if (active.length >= page.count || !(page.results || []).length) break;
  }

  // The active-listings endpoint ignores includes=Images, so photos come from
  // the batch endpoint instead.
  const images = new Map();
  for (let i = 0; i < active.length; i += PAGE_SIZE) {
    const ids = active.slice(i, i + PAGE_SIZE).map(listing => listing.listing_id).join(',');
    const batch = await etsyGet(`/listings/batch?listing_ids=${ids}&includes=Images`, settings.apiKey);
    for (const listing of batch.results || []) {
      const primary = [...(listing.images || [])].sort((a, b) => (a.rank || 0) - (b.rank || 0))[0];
      if (primary) images.set(listing.listing_id, primary);
    }
  }

  // Lets the admin form offer the categories this shop already lists under.
  const categoryCounts = {};
  for (const listing of active) {
    if (listing.taxonomy_id) categoryCounts[listing.taxonomy_id] = (categoryCounts[listing.taxonomy_id] || 0) + 1;
  }

  const listings = active.map(listing => {
    const image = images.get(listing.listing_id);
    const title = decodeEntities(listing.title);
    return {
      id: String(listing.listing_id),
      title,
      price: listing.price ? listing.price.amount / listing.price.divisor : null,
      currency: listing.price?.currency_code || 'USD',
      url: listing.url,
      image: image?.url_570xN || '',
      imageAlt: decodeEntities(image?.alt_text) || title
    };
  });
  return { listings, categoryCounts };
}

async function getShopSnapshot() {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) return cache;
  if (now < nextAttemptAt) {
    if (cache) return cache;
    throw new Error('Etsy listings are temporarily unavailable.');
  }
  if (!inFlight) {
    inFlight = fetchListings()
      .then(result => {
        cache = { ...result, fetchedAt: Date.now() };
        return cache;
      })
      .catch(error => {
        nextAttemptAt = Date.now() + RETRY_AFTER_MS;
        throw error;
      })
      .finally(() => { inFlight = null; });
  }
  try {
    return await inFlight;
  } catch (error) {
    if (cache) {
      console.error('Etsy refresh failed; serving cached listings.', error.message || error);
      return cache;
    }
    throw error;
  }
}

async function getListings() {
  return (await getShopSnapshot()).listings;
}

async function getCategoryCounts() {
  return (await getShopSnapshot()).categoryCounts;
}

// Called after publishing from admin so the new item shows up on the site now
// rather than whenever the 30-minute cache next expires.
function clearCache() {
  cache = null;
  nextAttemptAt = 0;
}

module.exports = { API_BASE, config, isConfigured, decodeEntities, getShop, getListings, getCategoryCounts, clearCache };
