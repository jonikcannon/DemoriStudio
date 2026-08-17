const fs = require('fs');
const path = require('path');
const { resolveMediaDir, CATEGORIES } = require('./media-dir');

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

const gallery = categories.flatMap((folder) => {
  const categoryPath = path.join(galleryRoot, folder);
  if (!fs.existsSync(categoryPath)) return [];
  return fs.readdirSync(categoryPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && supported.has(path.extname(entry.name).toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    .map((entry) => ({
      category: categoryLabels[folder] || folder[0].toUpperCase() + folder.slice(1),
      title: titleFromFilename(entry.name),
      image: `assets/gallery/${folder}/${encodeURIComponent(entry.name)}`,
      mediaType: videoExtensions.has(path.extname(entry.name).toLowerCase()) ? 'video' : 'image'
    }));
});

fs.writeFileSync(output, `${JSON.stringify(gallery, null, 2)}\n`);
console.log(`Gallery manifest created with ${gallery.length} item(s).`);
