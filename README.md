# Demori Studio

## Setup

1. Copy `.env.example` to `.env` and fill in every value. Use the same template for both local and production setup.
2. Run `npm install`.
3. **Provision gallery media into `storage/media/`.** A fresh clone has none — the
   photos are not in git, so the gallery renders empty until you copy them in. See
   [Gallery media](#gallery-media) below.
4. Run `npm run strict` — starts the API and the dev server together.

Both processes are required: the API serves gallery media at `/assets/gallery/`, and
the dev server proxies that path to it. Without the API running, the gallery is empty.

`npm run strict` runs them concurrently with tagged `[api]` / `[web]` output, and if
either one exits it shuts down the other, so you never end up with a half-running
stack. To run them in separate terminals instead, use `npm run api` and `npm start`.

## Where media lives

There are two independent media systems. They are easy to confuse, because the API
logs `Media storage: Google Drive mode …` at startup — that line refers only to the
second one.

| | Gallery (public portfolio) | Shop / product media |
|---|---|---|
| Stored in | `storage/media/<category>/` on local disk | Google Drive |
| Added by | dropping files into a category folder | admin panel upload |
| Served by | Cloudflare R2 + CDN when `MEDIA_CDN_URL` is set, otherwise nginx (prod) / the API (dev) | `/api/media/<token>` proxy, signed JWT |
| In git? | no | no |

The gallery deliberately does **not** use Drive: every view would proxy through Node
with a signed token, with no CDN caching and Drive API quota acting as the gallery's
rate limit.

## Gallery media

Gallery media lives in `storage/media/<category>/` — one folder per category, the
folder name being the category. It is not tracked by git and not bundled by the
Angular build; it is served off disk by the API in dev and by nginx in production.
Add or recategorise photos by moving files between those folders, then rerun
`npm start` to refresh the manifest. See [storage/media/README.md](storage/media/README.md).

### Provisioning on a new machine

`git clone` gives you the app but no photos. Copy them in from wherever your master
copy lives, preserving the category folder names:

```bash
# from the production VPS
rsync -av user@your-vps:/var/www/demori/data/storage/media/ storage/media/

# or from a local/external backup
robocopy D:\backups\demori-media storage\media /E    # Windows
rsync -av /path/to/backup/media/ storage/media/      # macOS/Linux
```

Then regenerate the manifest and check the count matches your library:

```bash
npm run media
```

Because this content exists only on disk and on the VPS, **keep an off-machine backup**.
Nothing in this repo can restore it.

### Serving media from Cloudflare R2

Local disk stays the authoring master; R2 is the serving origin. Egress from R2 is
free, so the gallery's bandwidth stops landing on the VPS.

1. Create an R2 bucket and an API token scoped to it. Put the account ID, key,
   secret and bucket name in `.env` (see `.env.example`).
2. Bind a custom domain to the bucket in the Cloudflare dashboard, e.g.
   `media.demori.studio`. Use a custom domain rather than the `r2.dev` URL, which
   is rate limited and not meant for production.
3. Push the media:

   ```bash
   npm run media:sync -- --dry-run   # preview
   npm run media:sync                # upload
   ```

4. Set `MEDIA_CDN_URL=https://media.demori.studio` in `.env` and regenerate:

   ```bash
   npm run manifest
   ```

`MEDIA_CDN_URL` is the switch. Unset, everything is served from local disk exactly
as before; set, the manifest emits absolute CDN URLs. Objects keep the
`assets/gallery/<category>/<file>` key prefix, which is what lets the app's gallery
matching work unchanged against absolute URLs.

Re-run `npm run media:sync` after adding files — it skips anything already uploaded
at the same size, so it is cheap and resumable. Add `--prune` to delete objects that
no longer exist locally. Changing a photo's category in the admin panel moves the
object in R2 as well, and rolls the local move back if the bucket update fails.

For the initial bulk upload, [rclone](https://rclone.org/s3/#cloudflare-r2) is worth
considering over `media:sync` — it parallelises and resumes better across several GB.

## Production notes

- **Admin:** Authentication happens only on the server. Set `ADMIN_EMAIL`, a bcrypt `ADMIN_PASSWORD_HASH`, and a long random `JWT_SECRET`.
- **Contact email delivery:** Configure `CONTACT_TO_EMAIL`, `CONTACT_FROM_EMAIL`, and SMTP settings (`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`) so contact inquiries are emailed in real time.
- **Google Drive:** Create a Google Cloud service account, enable the Drive API, then share one Drive folder with the service account `client_email`. Put the folder ID and one-line service-account JSON in `.env`. Set `GOOGLE_MEDIA_FOLDER_ID` if private sale-photo delivery should use a separate Drive folder. Never commit these values.
- **Stripe:** Start with Stripe test keys. Configure a webhook for `checkout.session.completed` at `https://your-domain/api/webhooks/stripe`.

## Admin inquiries

- Open the admin modal from the header and switch to the `Inquiries` tab.
- Filter by search text, service, and status.
- Update inquiry status (`New`, `In progress`, `Closed`) directly in the dashboard.

## Runtime data

The API persists products to `storage/products/products.json` and inquiries to
`storage/inquiries/`, both untracked and per-environment. On the VPS these live under
`/var/www/demori/data/storage/`, so deploys never overwrite them. Products survive a
restart, but a JSON file is not a substitute for a real database once orders matter —
move to one before the catalog or order volume grows.
