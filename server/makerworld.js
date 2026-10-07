// Importing a MakerWorld (makerworld.com) model into the admin's Etsy listing
// form. MakerWorld has no documented public API; this reads the JSON endpoint
// its own model pages load from (/api/v1/design-service/design/<id>), which
// answers plain server requests. Requests identify themselves honestly via
// USER_AGENT. If MakerWorld changes that endpoint, this is the one place that
// needs updating.
//
// Licensing matters here: selling prints of someone else's design is only
// allowed under some licenses. commercialUse() is the single source of truth,
// used both to warn in the form and to refuse the listing server-side.

const sharp = require('sharp');
const etsy = require('./etsy');

const USER_AGENT = 'DemoriStudios-Admin/1.0 (+https://demori-studios.com)';
const IMAGE_HOSTS = ['makerworld.bblmw.com', 'public-cdn.bblmw.com'];
const MAX_IMAGES = 10;
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
const CACHE_TTL_MS = 10 * 60 * 1000;

// Creative Commons variants that permit selling physical prints; ND still
// allows prints of the unmodified design. MakerWorld's own "Standard Digital
// File License" is personal-use only, and anything unrecognised is treated
// the same way rather than guessed at.
const LICENSES = {
  CC0: { label: 'CC0 (public domain)', commercial: true, attribution: false },
  BY: { label: 'CC BY 4.0', commercial: true, attribution: true },
  'BY-SA': { label: 'CC BY-SA 4.0', commercial: true, attribution: true },
  'BY-ND': { label: 'CC BY-ND 4.0', commercial: true, attribution: true },
  'BY-NC': { label: 'CC BY-NC 4.0', commercial: false, attribution: true },
  'BY-NC-SA': { label: 'CC BY-NC-SA 4.0', commercial: false, attribution: true },
  'BY-NC-ND': { label: 'CC BY-NC-ND 4.0', commercial: false, attribution: true },
  'Standard Digital File License': { label: 'MakerWorld Standard Digital File License (personal use only)', commercial: false, attribution: true }
};

const cache = new Map(); // id -> { model, fetchedAt }

class MakerWorldError extends Error {}

function licenseInfo(code) {
  const known = LICENSES[String(code || '').trim()];
  return known
    ? { code, ...known }
    : { code: code || 'unknown', label: code ? `${code} (unrecognised license)` : 'Unknown license', commercial: false, attribution: true };
}

function parseModelId(input) {
  let url;
  try {
    url = new URL(String(input || '').trim());
  } catch {
    throw new MakerWorldError('Paste a MakerWorld model link, e.g. https://makerworld.com/en/models/123456.');
  }
  if (url.protocol !== 'https:' || !/^(www\.)?makerworld\.com$/i.test(url.hostname)) {
    throw new MakerWorldError('That link is not on makerworld.com.');
  }
  const match = url.pathname.match(/\/models\/(\d+)/);
  if (!match) throw new MakerWorldError('That MakerWorld link is not a model page.');
  return match[1];
}

function htmlToText(html) {
  const text = String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/(p|div|h\d|li|ul|ol)>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return etsy.decodeEntities(text)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function fetchModel(id) {
  const cached = cache.get(id);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.model;

  const response = await fetch(`https://makerworld.com/api/v1/design-service/design/${id}`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(15000)
  });
  if (response.status === 404) throw new MakerWorldError('That MakerWorld model was not found.');
  if (!response.ok) throw new MakerWorldError(`MakerWorld returned ${response.status}. Try again in a minute.`);

  const design = await response.json().catch(() => null);
  if (!design?.id) throw new MakerWorldError('Could not read that MakerWorld model; the API may have changed.');

  const creator = design.designCreator || {};
  const license = licenseInfo(design.license);
  // A remix inherits its originals' terms too, so each one must allow sale.
  const originals = (design.originals || []).map(original => ({
    title: original.title || '',
    author: original.author || '',
    url: original.link || '',
    license: licenseInfo(original.license)
  }));
  const pictures = design.designExtension?.design_pictures || [];

  const model = {
    id: String(design.id),
    url: `https://makerworld.com/en/models/${design.id}`,
    title: htmlToText(design.title).slice(0, 140),
    description: htmlToText(design.summary).slice(0, 8000),
    // Used to seed the Etsy category search, e.g. "Hobby & DIY".
    categories: (design.categories || []).map(category => String(category.name || '')).filter(Boolean),
    tags: [...new Set((design.tagsOriginal || design.tags || []).map(tag => String(tag).trim()).filter(Boolean))],
    creator: {
      name: creator.name || 'Unknown creator',
      url: creator.handle ? `https://makerworld.com/en/@${creator.handle}` : ''
    },
    license,
    originals,
    commercialUse: license.commercial && originals.every(original => original.license.commercial),
    images: pictures
      .map(picture => picture.url)
      .filter(url => isAllowedImageUrl(url))
      .slice(0, MAX_IMAGES)
  };
  cache.set(id, { model, fetchedAt: Date.now() });
  return model;
}

// What the admin form prefills from: the model plus the credit line the
// listing description needs, so it's visible (and editable) before submitting.
async function importModel(input) {
  const model = await fetchModel(parseModelId(input));
  return { ...model, attribution: model.license.attribution ? attributionText(model) : '' };
}

function attributionText(model) {
  const lines = [`Design: "${model.title}" by ${model.creator.name} on MakerWorld (${model.url}), licensed ${model.license.label}.`];
  for (const original of model.originals) {
    lines.push(`Based on "${original.title}" by ${original.author} (${original.url}), licensed ${original.license.label}.`);
  }
  return lines.join('\n');
}

function isAllowedImageUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' && IMAGE_HOSTS.includes(url.hostname);
  } catch {
    return false;
  }
}

// Only the MakerWorld image CDN is fetched, so a crafted listing request can't
// make this server download from arbitrary (e.g. internal) addresses. The CDN
// serves everything as application/octet-stream, so each photo is re-encoded
// to a JPEG Etsy accepts, capped at 3000px.
async function downloadImage(value, index) {
  if (!isAllowedImageUrl(value)) throw new MakerWorldError(`Photo ${index + 1} is not a MakerWorld image.`);
  const response = await fetch(value, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new MakerWorldError(`Photo ${index + 1} could not be downloaded from MakerWorld (${response.status}).`);
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_DOWNLOAD_BYTES) throw new MakerWorldError(`Photo ${index + 1} is too large.`);
  const input = Buffer.from(await response.arrayBuffer());
  if (input.length > MAX_DOWNLOAD_BYTES) throw new MakerWorldError(`Photo ${index + 1} is too large.`);
  try {
    const buffer = await sharp(input)
      .rotate()
      .resize({ width: 3000, height: 3000, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 88 })
      .toBuffer();
    return { buffer, mimeType: 'image/jpeg', name: `makerworld-${index + 1}.jpg` };
  } catch {
    throw new MakerWorldError(`Photo ${index + 1} from MakerWorld is not a readable image.`);
  }
}

module.exports = { MakerWorldError, importModel, fetchModel, attributionText, downloadImage, isAllowedImageUrl };
