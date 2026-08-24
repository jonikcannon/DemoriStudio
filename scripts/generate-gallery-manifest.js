#!/usr/bin/env node
// Build storage/media/gallery-manifest.json -- the list the gallery renders from.
//
//   npm run manifest              build from the bucket when R2 serves media
//   npm run manifest -- --local   force the local-disk listing instead
//
// The bucket is the source of truth whenever it is the thing actually serving
// media, because it is the only place guaranteed to be complete: a fresh clone
// or a rebuilt VPS has no photos on disk, and listing an empty directory would
// publish an empty gallery over a bucket holding the whole library.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { resolveMediaDir, CATEGORIES } = require('./media-dir');
const {
  config: r2Config, isCdnEnabled, isR2Configured, createR2Client, listMediaObjects,
  toObjectKey, fromObjectKey, toPublicUrl
} = require('./r2');

const forceLocal = process.argv.slice(2).includes('--local');

const galleryRoot = resolveMediaDir();
const output = path.join(galleryRoot, 'gallery-manifest.json');
const categories = CATEGORIES;
const categoryLabels = {
  about: 'Others'
};
const supported = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.mp4']);
const videoExtensions = new Set(['.mp4']);

const isSupported = (name) => supported.has(path.extname(name).toLowerCase());
const isVideo = (name) => videoExtensions.has(path.extname(name).toLowerCase());
const byName = (a, b) => a.localeCompare(b, undefined, { numeric: true });

const titleFromFilename = (file) => path.basename(file, path.extname(file))
  .replace(/[-_]+/g, ' ')
  .replace(/\b\w/g, (letter) => letter.toUpperCase());

fs.mkdirSync(galleryRoot, { recursive: true });

// With MEDIA_CDN_URL set, items point at R2 through the CDN; otherwise they
// stay relative and are served off local disk. The `assets/gallery/` prefix is
// preserved either way, which is what lets the app's gallery checks keep
// working against absolute URLs.
const imageUrlFor = (folder, name) => (
  isCdnEnabled()
    ? toPublicUrl(toObjectKey(`${folder}/${name}`))
    : `assets/gallery/${folder}/${encodeURIComponent(name)}`
);

const toItem = (folder, name) => ({
  category: categoryLabels[folder] || folder[0].toUpperCase() + folder.slice(1),
  title: titleFromFilename(name),
  image: imageUrlFor(folder, name),
  mediaType: isVideo(name) ? 'video' : 'image'
});

// folder -> [file name], ordered by CATEGORIES then by name, so the two
// sources below produce byte-identical manifests from the same library.
const buildManifest = (filesByFolder) => categories.flatMap((folder) => {
  const names = filesByFolder.get(folder) || [];
  return [...names].sort(byName).map((name) => toItem(folder, name));
});

function listLocal() {
  const filesByFolder = new Map();
  for (const folder of categories) {
    const categoryPath = path.join(galleryRoot, folder);
    if (!fs.existsSync(categoryPath)) continue;
    filesByFolder.set(folder, fs.readdirSync(categoryPath, { withFileTypes: true })
      .filter((entry) => entry.isFile() && isSupported(entry.name))
      .map((entry) => entry.name));
  }
  return filesByFolder;
}

async function listBucket() {
  const client = createR2Client();
  const filesByFolder = new Map();
  for (const object of await listMediaObjects(client)) {
    const parsed = fromObjectKey(object.key);
    if (!parsed || !isSupported(parsed.name)) continue;
    if (!filesByFolder.has(parsed.folder)) filesByFolder.set(parsed.folder, []);
    filesByFolder.get(parsed.folder).push(parsed.name);
  }
  return filesByFolder;
}

const countFiles = (filesByFolder) => [...filesByFolder.values()].reduce((n, names) => n + names.length, 0);

// Files sitting on disk that the bucket has never seen are invisible to a
// bucket-sourced manifest. That is correct -- the gallery can only show what
// is servable -- but it is also exactly the mistake of forgetting media:sync,
// so name it rather than let the count quietly come up short.
function warnAboutUnsyncedFiles(bucketFiles) {
  const local = listLocal();
  const missing = [];
  for (const [folder, names] of local) {
    const uploaded = new Set(bucketFiles.get(folder) || []);
    for (const name of names) {
      if (!uploaded.has(name)) missing.push(`${folder}/${name}`);
    }
  }
  if (!missing.length) return;
  console.warn(`\n${missing.length} local file(s) are not in the bucket and were left out:`);
  for (const file of missing.slice(0, 10)) console.warn(`  ${file}`);
  if (missing.length > 10) console.warn(`  ... and ${missing.length - 10} more`);
  console.warn('Run `npm run media:sync` to upload them, then rerun this.\n');
}

async function resolveSource() {
  // Local disk is the source when it is also what serves the media, or when
  // asked for explicitly.
  if (forceLocal) return { files: listLocal(), source: 'local disk (--local)' };
  if (!isCdnEnabled() || !isR2Configured()) return { files: listLocal(), source: 'local disk' };

  try {
    const files = await listBucket();
    // An empty bucket almost always means "not uploaded yet" rather than "the
    // gallery is empty", so keep whatever disk can offer instead of wiping it.
    if (!countFiles(files)) {
      console.warn('The bucket holds no media yet; falling back to local disk.');
      console.warn('Run `npm run media:sync` to upload it.');
      return { files: listLocal(), source: 'local disk (bucket empty)' };
    }
    warnAboutUnsyncedFiles(files);
    return { files, source: 'Cloudflare R2 bucket' };
  } catch (error) {
    console.warn(`Could not list the R2 bucket (${error.message || error}); falling back to local disk.`);
    return { files: listLocal(), source: 'local disk (bucket unreachable)' };
  }
}

// The manifest covers media the gallery discovers at runtime, but templates
// also hard-code a few gallery paths. This hands the browser the same base URL
// so those resolve to the bucket directly instead of bouncing off the origin.
// It lands in src/assets because that is what the Angular build copies into
// dist -- which keeps it working for a static deploy with no API in front.
const appConfigPath = path.resolve(__dirname, '../src/assets/media-config.json');

function writeAppMediaConfig() {
  const mediaBaseUrl = isCdnEnabled() ? r2Config.cdnUrl : '';
  const apiBaseUrl = String(process.env.API_BASE_URL || '').trim().replace(/\/+$/, '');
  fs.mkdirSync(path.dirname(appConfigPath), { recursive: true });
  fs.writeFileSync(appConfigPath, `${JSON.stringify({ mediaBaseUrl, apiBaseUrl }, null, 2)}\n`);
  return { mediaBaseUrl, apiBaseUrl };
}

async function main() {
  const { files, source } = await resolveSource();
  const gallery = buildManifest(files);

  fs.writeFileSync(output, `${JSON.stringify(gallery, null, 2)}\n`);
  const { mediaBaseUrl, apiBaseUrl } = writeAppMediaConfig();

  console.log(`Gallery manifest created with ${gallery.length} item(s).`);
  console.log(`Listed from: ${source}`);
  console.log(mediaBaseUrl ? `Media URLs: ${mediaBaseUrl}` : 'Media URLs: local disk');
  console.log(apiBaseUrl ? `API URL: ${apiBaseUrl}` : 'API URL: same-origin /api (Nginx proxies to the Express server)');
}

main().catch((error) => {
  console.error('Manifest generation failed:', error.message || error);
  process.exit(1);
});
