# Gallery media

This directory is the source of truth for gallery media. **One folder per category —
the folder name is the category.**

```
storage/media/
  nature/
  beach/
  hikes/
  aerial/
  about/          -> displayed as "Others"
  gallery-manifest.json   (generated, do not edit)
```

Every supported image or video in those folders is displayed automatically.
Supported formats are `.jpg`, `.jpeg`, `.png`, `.webp`, `.avif`, and `.mp4`.
Videos play muted and loop. The filename becomes the displayed title; for example,
`sunset-over-water.jpg` displays as "Sunset Over Water".

Run `npm start` (or `npm run build`) after adding files to refresh the manifest, or
regenerate it directly with `node scripts/generate-gallery-manifest.js`.

## Why it lives here and not in `src/assets`

Nothing in this directory is tracked by git or bundled by the Angular build. It is
served straight off disk:

- **Development** — the Express API serves `/assets/gallery/` (see `server/server.js`),
  and `ng serve` proxies that path to it via `proxy.conf.json`. **The API must be
  running (`npm run api`) for gallery media to appear in dev.**
- **Production** — nginx serves `/assets/gallery/` directly from
  `/var/www/demori/data/storage/media`, never touching Node.

The web URL is `assets/gallery/<category>/<file>` in both cases; only the disk
location differs. Override the disk location with the `MEDIA_DIR` env var.

## Changing a photo's category

Move the file between folders, or use the admin UI, which calls
`PATCH /api/admin/gallery/category` — that endpoint renames the file into the
target category folder and rewrites the manifest.

## Backups

These files are not in git. They exist only on disk here and on the VPS. Keep an
off-machine copy (object storage or Drive) before deleting anything locally.
