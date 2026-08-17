# Demori Studio

1. Copy `.env.example` to `.env` and fill in every value. Use the same template for both local and production setup.
2. Run `npm install`.
3. Run `npm run strict` — starts the API and the dev server together.

Both processes are required: the API serves gallery media at `/assets/gallery/`, and
the dev server proxies that path to it. Without the API running, the gallery is empty.

`npm run strict` runs them concurrently with tagged `[api]` / `[web]` output, and if
either one exits it shuts down the other, so you never end up with a half-running
stack. To run them in separate terminals instead, use `npm run api` and `npm start`.

## Gallery media

Gallery media lives in `storage/media/<category>/` — one folder per category, the
folder name being the category. It is not tracked by git and not bundled by the
Angular build; it is served off disk by the API in dev and by nginx in production.
Add or recategorise photos by moving files between those folders, then rerun
`npm start` to refresh the manifest. See [storage/media/README.md](storage/media/README.md).

## Production notes

- **Admin:** Authentication happens only on the server. Set `ADMIN_EMAIL`, a bcrypt `ADMIN_PASSWORD_HASH`, and a long random `JWT_SECRET`.
- **Contact email delivery:** Configure `CONTACT_TO_EMAIL`, `CONTACT_FROM_EMAIL`, and SMTP settings (`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`) so contact inquiries are emailed in real time.
- **Google Drive:** Create a Google Cloud service account, enable the Drive API, then share one Drive folder with the service account `client_email`. Put the folder ID and one-line service-account JSON in `.env`. Set `GOOGLE_MEDIA_FOLDER_ID` if private sale-photo delivery should use a separate Drive folder. Never commit these values.
- **Stripe:** Start with Stripe test keys. Configure a webhook for `checkout.session.completed` at `https://your-domain/api/webhooks/stripe`.

## Admin inquiries

- Open the admin modal from the header and switch to the `Inquiries` tab.
- Filter by search text, service, and status.
- Update inquiry status (`New`, `In progress`, `Closed`) directly in the dashboard.

This starter keeps products in memory. Replace the `products` array with a database before deploying so products and orders persist after a restart.
