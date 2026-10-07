// Creating Etsy listings from the admin panel.
//
// Unlike the public listing grid (etsy.js), writing to the shop needs the shop
// owner's permission, granted once through Etsy's OAuth 2.0 + PKCE flow:
//   1. Admin clicks "Connect Etsy" -> startConnect() returns Etsy's consent URL.
//   2. Etsy redirects back to /api/etsy/oauth/callback -> finishConnect()
//      swaps the code for tokens and checks the account really owns the shop.
//   3. Tokens live in storage/etsy/oauth.json (gitignored, per-environment).
//      The access token lasts an hour and is refreshed automatically; the
//      refresh token lasts 90 days, after which admin has to connect again.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const etsy = require('./etsy');
const makerworld = require('./makerworld');

const AUTHORIZE_URL = 'https://www.etsy.com/oauth/connect';
const TOKEN_URL = 'https://openapi.etsy.com/v3/public/oauth/token';
const SCOPES = ['listings_r', 'listings_w', 'shops_r'];
const PENDING_TTL_MS = 10 * 60 * 1000;
const TAXONOMY_TTL_MS = 24 * 60 * 60 * 1000;

const tokenDir = path.join(__dirname, '../storage/etsy');
const tokenFile = path.join(tokenDir, 'oauth.json');

// Every new listing gets the values all of the shop's existing listings use.
const LISTING_DEFAULTS = { who_made: 'i_did', when_made: 'made_to_order', is_supply: 'false', type: 'physical' };
const MAX_IMAGES = 10;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif'];

const pendingConnects = new Map(); // state -> { verifier, createdAt }
let refreshInFlight = null;
let taxonomy = null; // { nodes: Map<id, path>, fetchedAt }

class EtsyNotConnectedError extends Error {}
// Bad form input, caught before anything is sent to Etsy.
class ListingInputError extends Error {}
// A request Etsy answered with an error; status is Etsy's HTTP status, so a
// 4xx (bad listing data) can be told apart from Etsy being unreachable.
class EtsyApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function redirectUri() {
  const explicit = String(process.env.ETSY_REDIRECT_URI || '').trim();
  if (explicit) return explicit;
  const origin = String(process.env.CLIENT_ORIGIN || 'http://localhost:6200').trim().replace(/\/+$/, '');
  return `${origin}/api/etsy/oauth/callback`;
}

function base64Url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function readTokens() {
  try {
    return JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
  } catch {
    return null;
  }
}

function saveTokens(tokens) {
  fs.mkdirSync(tokenDir, { recursive: true });
  const tempFile = `${tokenFile}.${process.pid}.tmp`;
  fs.writeFileSync(tempFile, `${JSON.stringify(tokens, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tempFile, tokenFile);
}

function disconnect() {
  fs.rmSync(tokenFile, { force: true });
}

function status() {
  const tokens = readTokens();
  return {
    configured: etsy.isConfigured(),
    connected: Boolean(tokens?.refreshToken),
    connectedAt: tokens?.connectedAt || null,
    redirectUri: redirectUri(),
    // Where the LAN print share's inbox lives (scripts/deploy/setup-print-share.sh),
    // e.g. \\192.168.4.51\prints\_inbox; shown next to MakerWorld downloads.
    printInboxPath: String(process.env.PRINT_INBOX_PATH || '').trim()
  };
}

function startConnect() {
  const settings = etsy.config();
  if (!settings) throw new Error('Etsy is not configured on the server.');
  const now = Date.now();
  for (const [state, entry] of pendingConnects) {
    if (now - entry.createdAt > PENDING_TTL_MS) pendingConnects.delete(state);
  }

  const state = base64Url(crypto.randomBytes(24));
  const verifier = base64Url(crypto.randomBytes(48));
  const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest());
  pendingConnects.set(state, { verifier, createdAt: now });

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: settings.apiKey.split(':')[0],
    redirect_uri: redirectUri(),
    scope: SCOPES.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256'
  });
  return `${AUTHORIZE_URL}?${params}`;
}

async function requestToken(fields) {
  const settings = etsy.config();
  if (!settings) throw new Error('Etsy is not configured on the server.');
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ client_id: settings.apiKey.split(':')[0], ...fields }),
    signal: AbortSignal.timeout(15000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`Etsy token request failed (${response.status}): ${body.error_description || body.error || 'unknown error'}`);
    error.status = response.status;
    error.code = body.error;
    throw error;
  }
  return body;
}

function tokensFrom(body, previous = {}) {
  return {
    ...previous,
    accessToken: body.access_token,
    refreshToken: body.refresh_token || previous.refreshToken,
    expiresAt: Date.now() + Number(body.expires_in || 3600) * 1000,
    // Etsy access tokens are "<user id>.<token>".
    userId: String(body.access_token).split('.')[0]
  };
}

async function finishConnect({ code, state }) {
  const pending = pendingConnects.get(String(state || ''));
  pendingConnects.delete(String(state || ''));
  if (!pending || Date.now() - pending.createdAt > PENDING_TTL_MS) {
    throw new Error('This Etsy connection link has expired. Start again from the admin panel.');
  }
  if (!code) throw new Error('Etsy did not return an authorization code.');

  const body = await requestToken({
    grant_type: 'authorization_code',
    redirect_uri: redirectUri(),
    code: String(code),
    code_verifier: pending.verifier
  });
  const tokens = tokensFrom(body, { connectedAt: new Date().toISOString() });

  // Anyone could finish the consent screen with their own Etsy login; only
  // the account that owns the configured shop may be stored.
  const shop = await etsy.getShop();
  if (String(shop.ownerUserId) !== tokens.userId) {
    throw new Error('That Etsy account does not own the configured shop. Sign in to Etsy as the shop owner and try again.');
  }
  saveTokens(tokens);
}

async function accessToken() {
  const tokens = readTokens();
  if (!tokens?.refreshToken) throw new EtsyNotConnectedError('Etsy is not connected. Click "Connect Etsy" first.');
  if (tokens.accessToken && tokens.expiresAt - 60000 > Date.now()) return tokens.accessToken;

  if (!refreshInFlight) {
    refreshInFlight = requestToken({ grant_type: 'refresh_token', refresh_token: tokens.refreshToken })
      .then(body => {
        const next = tokensFrom(body, tokens);
        saveTokens(next);
        return next.accessToken;
      })
      .catch(error => {
        // A revoked or 90-day-expired refresh token can't recover by itself.
        if (error.code === 'invalid_grant') {
          disconnect();
          throw new EtsyNotConnectedError('The Etsy connection has expired. Click "Connect Etsy" to reconnect.');
        }
        throw error;
      })
      .finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}

async function sellerRequest(method, apiPath, body) {
  const settings = etsy.config();
  if (!settings) throw new Error('Etsy is not configured on the server.');
  const headers = { 'x-api-key': settings.apiKey, Authorization: `Bearer ${await accessToken()}`, Accept: 'application/json' };
  // FormData sets its own multipart boundary header.
  if (body instanceof URLSearchParams) headers['Content-Type'] = 'application/x-www-form-urlencoded';

  const response = await fetch(`${etsy.API_BASE}${apiPath}`, { method, headers, body, signal: AbortSignal.timeout(60000) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) throw new EtsyNotConnectedError('Etsy rejected the saved connection. Click "Connect Etsy" to reconnect.');
    throw new EtsyApiError(payload.error || `Etsy returned ${response.status}.`, response.status);
  }
  return payload;
}

async function loadTaxonomy() {
  if (taxonomy && Date.now() - taxonomy.fetchedAt < TAXONOMY_TTL_MS) return taxonomy.nodes;
  const settings = etsy.config();
  if (!settings) throw new Error('Etsy is not configured on the server.');
  const response = await fetch(`${etsy.API_BASE}/seller-taxonomy/nodes`, {
    headers: { 'x-api-key': settings.apiKey, Accept: 'application/json' },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`Etsy categories returned ${response.status}.`);
  const nodes = new Map();
  const walk = (node, trail) => {
    const pathNames = [...trail, node.name];
    nodes.set(node.id, pathNames.join(' > '));
    for (const child of node.children || []) walk(child, pathNames);
  };
  for (const root of (await response.json()).results || []) walk(root, []);
  taxonomy = { nodes, fetchedAt: Date.now() };
  return nodes;
}

async function searchCategories(query) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
  if (!words.length) return [];
  const matches = [];
  for (const [id, pathName] of await loadTaxonomy()) {
    const haystack = pathName.toLowerCase();
    if (words.every(word => haystack.includes(word))) matches.push({ id, path: pathName });
    if (matches.length >= 25) break;
  }
  return matches;
}

async function options() {
  const { id } = await etsy.getShop();
  const [shipping, processing, returns, nodes, counts] = await Promise.all([
    sellerRequest('GET', `/shops/${id}/shipping-profiles`),
    sellerRequest('GET', `/shops/${id}/readiness-state-definitions?limit=100`),
    sellerRequest('GET', `/shops/${id}/policies/return`),
    loadTaxonomy(),
    etsy.getCategoryCounts().catch(() => ({}))
  ]);
  const usedCategories = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([taxonomyId]) => ({ id: Number(taxonomyId), path: nodes.get(Number(taxonomyId)) }))
    .filter(category => category.path);

  return {
    shippingProfiles: (shipping.results || [])
      .filter(profile => !profile.is_deleted)
      .map(profile => ({
        id: profile.shipping_profile_id,
        label: etsy.decodeEntities(profile.title) || `Profile ${profile.shipping_profile_id}`,
        // Calculated profiles price shipping from the package, so Etsy refuses
        // a listing on one without the item's weight and dimensions.
        calculated: profile.profile_type === 'calculated'
      })),
    processingProfiles: (processing.results || []).map(profile => ({
      id: profile.readiness_state_id,
      label: profile.processing_days_display_label
        || `${profile.readiness_state === 'ready_to_ship' ? 'Ready to ship' : 'Made to order'}, ${profile.min_processing_days}-${profile.max_processing_days} days`
    })),
    returnPolicies: (returns.results || []).map(policy => ({
      id: policy.return_policy_id,
      label: policy.accepts_returns || policy.accepts_exchanges
        ? `${[policy.accepts_returns && 'Returns', policy.accepts_exchanges && 'exchanges'].filter(Boolean).join(' and ')} within ${policy.return_deadline} days`
        : 'No returns or exchanges'
    })),
    usedCategories
  };
}

// Etsy's own rules for tags (max 13, 20 chars, letters/numbers/spaces/-'™©®)
// and materials (letters/numbers/spaces), checked here so a bad value fails
// before a half-made draft exists on Etsy.
function cleanList(value, { max, maxLength, pattern, field }) {
  const items = (Array.isArray(value) ? value : String(value || '').split(','))
    .map(item => String(item).trim())
    .filter(Boolean);
  if (items.length > max) throw new ListingInputError(`Use at most ${max} ${field}.`);
  for (const item of items) {
    if (item.length > maxLength) throw new ListingInputError(`"${item}" is too long; ${field} can be at most ${maxLength} characters.`);
    if (!pattern.test(item)) throw new ListingInputError(`"${item}" has characters Etsy doesn't allow in ${field}.`);
  }
  return [...new Set(items)];
}

const WEIGHT_UNITS = ['oz', 'lb', 'g', 'kg'];
const DIMENSION_UNITS = ['in', 'ft', 'mm', 'cm', 'm'];

// Weight and L x W x H: optional, but all-or-nothing, and required by Etsy on
// calculated shipping profiles.
function packageSize(input) {
  const fields = { weight: 'Weight', length: 'Length', width: 'Width', height: 'Height' };
  const given = Object.keys(fields).filter(key => input?.[key] !== null && input?.[key] !== undefined && input?.[key] !== '');
  if (!given.length) return null;
  const size = {};
  for (const [key, label] of Object.entries(fields)) {
    const value = Number(input?.[key]);
    if (!Number.isFinite(value) || value <= 0 || value > 100000) {
      throw new ListingInputError(`${label} must be a number above 0 (fill in weight and all three dimensions, or none).`);
    }
    size[key] = value;
  }
  size.weightUnit = WEIGHT_UNITS.includes(input?.weightUnit) ? input.weightUnit : 'oz';
  size.dimensionsUnit = DIMENSION_UNITS.includes(input?.dimensionsUnit) ? input.dimensionsUnit : 'in';
  return size;
}

function positiveInt(value, field) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new ListingInputError(`${field} is required.`);
  return number;
}

async function validateListing(input) {
  const title = String(input?.title || '').trim();
  const description = String(input?.description || '').trim();
  const price = Number(input?.price);
  const quantity = Number(input?.quantity);
  if (!title || title.length > 140) throw new ListingInputError('Title must be 1-140 characters.');
  if (!description || description.length > 10000) throw new ListingInputError('Description is required.');
  if (!Number.isFinite(price) || price < 0.2 || price > 50000) throw new ListingInputError('Price must be between $0.20 and $50,000.');
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) throw new ListingInputError('Quantity must be a whole number from 1 to 999.');

  const taxonomyId = positiveInt(input?.taxonomyId, 'Category');
  if (!(await loadTaxonomy()).has(taxonomyId)) throw new ListingInputError('Choose a category from the list.');

  const images = Array.isArray(input?.images) ? input.images : [];
  if (!images.length) throw new ListingInputError('Add at least one photo.');
  if (images.length > MAX_IMAGES) throw new ListingInputError(`Etsy allows at most ${MAX_IMAGES} photos per listing.`);

  // No license gate: the admin only imports models they have permission to
  // sell. The creator credit is still added where the license asks for one.
  const makerworldId = input?.makerworldId ? String(input.makerworldId) : '';
  if (makerworldId && !/^\d+$/.test(makerworldId)) throw new ListingInputError('MakerWorld model ID is invalid.');
  if (!makerworldId && images.some(image => image?.remoteUrl)) throw new ListingInputError('Imported photos must come with their MakerWorld model.');
  let finalDescription = description;
  let model = null;
  if (makerworldId) {
    model = await makerworld.fetchModel(makerworldId);
    if (model.license.attribution && !description.includes(model.url)) {
      finalDescription = `${description}\n\n${makerworld.attributionText(model)}`;
    }
  }
  if (finalDescription.length > 10000) throw new ListingInputError('Description is too long once the MakerWorld credit is added.');

  const files = [];
  for (const [index, image] of images.entries()) {
    if (image?.remoteUrl) {
      try {
        files.push(await makerworld.downloadImage(image.remoteUrl, index, model));
      } catch (error) {
        throw new ListingInputError(error.message);
      }
      continue;
    }
    if (!IMAGE_TYPES.includes(image?.mimeType) || typeof image?.data !== 'string') {
      throw new ListingInputError(`Photo ${index + 1} must be a JPG, PNG, or GIF.`);
    }
    const buffer = Buffer.from(image.data, 'base64');
    if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) throw new ListingInputError(`Photo ${index + 1} must be under 10 MB.`);
    files.push({ buffer, mimeType: image.mimeType, name: path.basename(String(image.name || `photo-${index + 1}`)) });
  }

  return {
    title,
    description: finalDescription,
    price: Math.round(price * 100) / 100,
    quantity,
    taxonomyId,
    shippingProfileId: positiveInt(input?.shippingProfileId, 'Shipping profile'),
    returnPolicyId: positiveInt(input?.returnPolicyId, 'Return policy'),
    processingProfileId: positiveInt(input?.processingProfileId, 'Processing profile'),
    tags: cleanList(input?.tags, { max: 13, maxLength: 20, pattern: /^[\p{L}\p{Nd}\p{Zs}\-'™©®]+$/u, field: 'tags' }),
    size: packageSize(input),
    materials: cleanList(input?.materials, { max: 13, maxLength: 45, pattern: /^[\p{L}\p{Nd}\p{Zs}]+$/u, field: 'materials' }),
    files,
    publish: input?.publish === true
  };
}

async function createListing(input) {
  const listing = await validateListing(input);
  const { id: shopId } = await etsy.getShop();

  const form = new URLSearchParams({
    ...LISTING_DEFAULTS,
    title: listing.title,
    description: listing.description,
    price: listing.price.toFixed(2),
    quantity: String(listing.quantity),
    taxonomy_id: String(listing.taxonomyId),
    shipping_profile_id: String(listing.shippingProfileId),
    return_policy_id: String(listing.returnPolicyId),
    readiness_state_id: String(listing.processingProfileId)
  });
  if (listing.tags.length) form.set('tags', listing.tags.join(','));
  if (listing.materials.length) form.set('materials', listing.materials.join(','));
  if (listing.size) {
    form.set('item_weight', String(listing.size.weight));
    form.set('item_weight_unit', listing.size.weightUnit);
    form.set('item_length', String(listing.size.length));
    form.set('item_width', String(listing.size.width));
    form.set('item_height', String(listing.size.height));
    form.set('item_dimensions_unit', listing.size.dimensionsUnit);
  }

  const created = await sellerRequest('POST', `/shops/${shopId}/listings`, form);
  const listingId = created.listing_id;
  const result = {
    listingId: String(listingId),
    editUrl: `https://www.etsy.com/your/shops/me/listing-editor/edit/${listingId}`,
    url: `https://www.etsy.com/listing/${listingId}`,
    state: 'draft',
    warnings: []
  };

  // The draft already exists on Etsy at this point, so later failures are
  // reported as warnings (with a link to finish it there) rather than errors.
  let uploaded = 0;
  for (const [index, file] of listing.files.entries()) {
    const upload = new FormData();
    upload.set('image', new Blob([file.buffer], { type: file.mimeType }), file.name);
    upload.set('rank', String(index + 1));
    try {
      await sellerRequest('POST', `/shops/${shopId}/listings/${listingId}/images`, upload);
      uploaded++;
    } catch (error) {
      result.warnings.push(`Photo ${index + 1} failed to upload: ${error.message}`);
    }
  }

  if (listing.publish) {
    if (!uploaded) {
      result.warnings.push('Not published: Etsy needs at least one photo before a listing can go live.');
    } else {
      try {
        await sellerRequest('PATCH', `/shops/${shopId}/listings/${listingId}`, new URLSearchParams({ state: 'active' }));
        result.state = 'active';
        etsy.clearCache();
      } catch (error) {
        result.warnings.push(`Saved as a draft, but publishing failed: ${error.message}`);
      }
    }
  }
  return result;
}

module.exports = {
  EtsyNotConnectedError, ListingInputError, EtsyApiError, status, startConnect, finishConnect, disconnect, options, searchCategories, createListing
};
