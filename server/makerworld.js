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

const fs = require('fs');
const path = require('path');
const etsy = require('./etsy');

// Imported photos are saved to the LAN print share (scripts/deploy/
// setup-print-share.sh), next to where the model's zip unpacks, and the
// listing is published from those files. No image library is involved:
// sharp's prebuilt binary needs SSE4.2 and SIGILLs the whole API on the
// production CPU (AMD A6-3620), and MakerWorld's photos are already JPG/PNG.
const SHARE_DIR = String(process.env.PRINT_SHARE_DIR || '/srv/prints').trim();
const ETSY_MAX_BYTES = 10 * 1024 * 1024;

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

// A snapshot of each imported model, so publishing later reads the details
// (license included) as they were at import instead of asking MakerWorld
// again -- MakerWorld's bot check often refuses this server's requests.
const SNAPSHOT_DIR = path.join(__dirname, '../storage/makerworld');

function readSnapshot(id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(SNAPSHOT_DIR, `${id}.json`), 'utf8'));
  } catch {
    return null;
  }
}

function writeSnapshot(model) {
  try {
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    fs.writeFileSync(path.join(SNAPSHOT_DIR, `${model.id}.json`), JSON.stringify(model));
  } catch (error) {
    console.warn(`MakerWorld snapshot for ${model.id} not saved: ${error.message}`);
  }
}

function remember(model) {
  cache.set(model.id, { model, fetchedAt: Date.now() });
  writeSnapshot(model);
  return model;
}

async function fetchModel(id) {
  const cached = cache.get(id);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.model;
  const snapshot = readSnapshot(id);
  if (snapshot) return snapshot;

  let response;
  try {
    response = await fetch(`https://makerworld.com/api/v1/design-service/design/${id}`, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000)
    });
  } catch {
    throw new MakerWorldError('Could not reach MakerWorld. Use the "Send to Demori" bookmark on the model page instead.');
  }
  if (response.status === 404) throw new MakerWorldError('That MakerWorld model was not found.');
  if (response.status === 403) throw new MakerWorldError('MakerWorld is blocking this server right now. Use the "Send to Demori" bookmark on the model page instead.');
  if (!response.ok) throw new MakerWorldError(`MakerWorld returned ${response.status}. Try again in a minute.`);

  const design = await response.json().catch(() => null);
  return remember(modelFromDesign(design));
}

// MakerWorld's design JSON -- from its API, or sent by the "Send to Demori"
// bookmark from the admin's own browser -- into the fields the form uses.
// Bookmark data is untrusted input: every field is coerced and trimmed, and
// photos are limited to MakerWorld's image CDN like any other import.
function modelFromDesign(design) {
  if (!design || !/^\d+$/.test(String(design.id || ''))) {
    throw new MakerWorldError('Could not read that MakerWorld model; the page or API may have changed.');
  }
  const list = value => (Array.isArray(value) ? value : []);
  const text = (value, max) => String(value ?? '').slice(0, max);
  const creator = design.designCreator && typeof design.designCreator === 'object' ? design.designCreator : {};
  const license = licenseInfo(text(design.license, 80));
  // A remix inherits its originals' terms too, so each one must allow sale.
  const originals = list(design.originals).slice(0, 20).map(original => ({
    title: text(original?.title, 200),
    author: text(original?.author, 100),
    url: isMakerWorldUrl(original?.link) ? String(original.link) : '',
    license: licenseInfo(text(original?.license, 80))
  }));
  const handle = text(creator.handle, 80).replace(/[^\w.-]/g, '');

  return {
    id: String(design.id),
    url: `https://makerworld.com/en/models/${design.id}`,
    title: htmlToText(text(design.title, 2000)).slice(0, 140),
    description: htmlToText(text(design.summary, 100000)).slice(0, 8000),
    // Used to seed the Etsy category search, e.g. "Hobby & DIY".
    categories: list(design.categories).map(category => text(category?.name, 80)).filter(Boolean).slice(0, 10),
    tags: [...new Set(list(design.tagsOriginal?.length ? design.tagsOriginal : design.tags).map(tag => text(tag, 60).trim()).filter(Boolean))].slice(0, 40),
    creator: {
      name: text(creator.name, 100) || 'Unknown creator',
      url: handle ? `https://makerworld.com/en/@${handle}` : ''
    },
    license,
    originals,
    commercialUse: license.commercial && originals.every(original => original.license.commercial),
    images: list(design.designExtension?.design_pictures)
      .map(picture => picture?.url)
      .filter(url => isAllowedImageUrl(url))
      .slice(0, MAX_IMAGES)
  };
}

function isMakerWorldUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' && /^(www\.)?makerworld\.com$/i.test(url.hostname);
  } catch {
    return false;
  }
}

// What the admin form prefills from: the model plus the credit line the
// listing description needs, so it's visible (and editable) before submitting.
async function importModel(input) {
  return prefill(await fetchModel(parseModelId(input)));
}

// The same, from design JSON the bookmark read in the admin's browser.
async function importDesign(design) {
  return prefill(remember(modelFromDesign(design)));
}

async function prefill(model) {
  const photos = await savePhotos(model);
  return { ...model, attribution: model.license.attribution ? attributionText(model) : '', photos };
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

// The CDN labels everything octet-stream (and some ".jpg" files are PNGs), so
// the type comes from the file's magic bytes.
function sniffImage(buffer) {
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { mimeType: 'image/jpeg', ext: 'jpg' };
  if (buffer.length > 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mimeType: 'image/png', ext: 'png' };
  if (buffer.length > 6 && /^GIF8[79]a$/.test(buffer.subarray(0, 6).toString('latin1'))) return { mimeType: 'image/gif', ext: 'gif' };
  return null;
}

// Same rules as the print-inbox extractor's safe_name(), so the photos land in
// the folder the model's zip unpacks into when the names match.
function safeName(name) {
  return String(name || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().replace(/^[ .]+|[ .]+$/g, '').slice(0, 100) || 'model';
}

function photoDir(model) {
  return path.join(SHARE_DIR, safeName(model.title), 'photos');
}

function photoStem(model, url) {
  return `makerworld-${model.images.indexOf(url) + 1}`;
}

function findSavedPhoto(model, url) {
  const dir = photoDir(model);
  const stem = photoStem(model, url);
  try {
    const file = fs.readdirSync(dir).find(name => path.parse(name).name === stem);
    return file ? path.join(dir, file) : null;
  } catch {
    return null;
  }
}

// Only the MakerWorld image CDN is fetched, so a crafted listing request can't
// make this server download from arbitrary (e.g. internal) addresses.
async function fetchPhoto(url, label) {
  if (!isAllowedImageUrl(url)) throw new MakerWorldError(`${label} is not a MakerWorld image.`);
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new MakerWorldError(`${label} could not be downloaded from MakerWorld (${response.status}).`);
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_DOWNLOAD_BYTES) throw new MakerWorldError(`${label} is too large.`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_DOWNLOAD_BYTES) throw new MakerWorldError(`${label} is too large.`);
  return buffer;
}

// Downloads every photo of the model into <share>/<title>/photos/ (skipping
// ones already there), group-writable so they can be edited or replaced over
// the share before publishing. A photo that fails is reported, not fatal.
async function savePhotos(model) {
  const dir = photoDir(model);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o2775 });
  } catch (error) {
    console.warn(`MakerWorld photos: cannot create ${dir}: ${error.message}`);
    return { folder: '', saved: 0, failed: model.images.length, error: 'The print share is not writable from the API.' };
  }
  const results = await Promise.all(model.images.map(async (url, index) => {
    if (findSavedPhoto(model, url)) return true;
    try {
      const buffer = await fetchPhoto(url, `Photo ${index + 1}`);
      const type = sniffImage(buffer);
      if (!type) throw new MakerWorldError(`Photo ${index + 1} is not a JPG, PNG, or GIF.`);
      const file = path.join(dir, `${photoStem(model, url)}.${type.ext}`);
      fs.writeFileSync(file, buffer);
      fs.chmodSync(file, 0o664);
      return true;
    } catch (error) {
      console.warn(`MakerWorld photos: ${model.id} photo ${index + 1}: ${error.message}`);
      return false;
    }
  }));
  const saved = results.filter(Boolean).length;
  return { folder: path.relative(SHARE_DIR, dir).split(path.sep).join('\\'), saved, failed: results.length - saved };
}

// Publishing reads the photo saved on the share at import, so any edit made
// there is what goes to Etsy. If it's missing (share unavailable, or deleted)
// it's downloaded and saved again.
async function downloadImage(url, index, model) {
  const label = `Photo ${index + 1}`;
  if (!isAllowedImageUrl(url) || !model.images.includes(url)) throw new MakerWorldError(`${label} is not one of this model's MakerWorld photos.`);
  let file = findSavedPhoto(model, url);
  if (!file) {
    await savePhotos({ ...model, images: [url] }).catch(() => null);
    file = findSavedPhoto({ ...model, images: [url] }, url);
  }
  let buffer;
  try {
    buffer = file ? fs.readFileSync(file) : await fetchPhoto(url, label);
  } catch (error) {
    if (error instanceof MakerWorldError) throw error;
    throw new MakerWorldError(`${label} could not be read from the print share.`);
  }
  const type = sniffImage(buffer);
  if (!type) throw new MakerWorldError(`${label} is not a JPG, PNG, or GIF.`);
  if (buffer.length > ETSY_MAX_BYTES) throw new MakerWorldError(`${label} is over Etsy's 10 MB limit; shrink it on the print share and try again.`);
  return { buffer, mimeType: type.mimeType, name: `${photoStem(model, url)}.${type.ext}` };
}

module.exports = { MakerWorldError, importModel, importDesign, fetchModel, attributionText, downloadImage, isAllowedImageUrl };
