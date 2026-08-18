require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { resolveMediaDir, CATEGORIES } = require('./media-dir');
const { isCdnEnabled, toObjectKey, toPublicUrl } = require('./r2');

const galleryRoot = resolveMediaDir();
const output = path.join(galleryRoot, 'gallery-manifest.json');
const categories = CATEGORIES;
const categoryLabels = {
  about: 'Others'
};
const supported = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.mp4']);
const videoExtensions = new Set(['.mp4']);

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

const gallery = categories.flatMap((folder) => {
  const categoryPath = path.join(galleryRoot, folder);
  if (!fs.existsSync(categoryPath)) return [];
  return fs.readdirSync(categoryPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && supported.has(path.extname(entry.name).toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    .map((entry) => ({
      category: categoryLabels[folder] || folder[0].toUpperCase() + folder.slice(1),
      title: titleFromFilename(entry.name),
      image: imageUrlFor(folder, entry.name),
      mediaType: videoExtensions.has(path.extname(entry.name).toLowerCase()) ? 'video' : 'image'
    }));
});

fs.writeFileSync(output, `${JSON.stringify(gallery, null, 2)}\n`);
console.log(`Gallery manifest created with ${gallery.length} item(s).`);
console.log(isCdnEnabled() ? 'Media URLs: CDN (R2)' : 'Media URLs: local disk');
