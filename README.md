# Demori Studio

1. Copy `.env.example` to `.env` and fill in every value.
2. Run `npm install`.
3. Run `npm run api` and `npm start` in separate terminals.

## Production notes

- **Admin:** Authentication happens only on the server. Set `ADMIN_EMAIL`, a bcrypt `ADMIN_PASSWORD_HASH`, and a long random `JWT_SECRET`.
- **Contact email delivery:** Configure `CONTACT_TO_EMAIL`, `CONTACT_FROM_EMAIL`, and SMTP settings (`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`) so contact inquiries are emailed in real time.
- **Google Drive:** Create a Google Cloud service account, enable the Drive API, then share one Drive folder with the service account `client_email`. Put the folder ID and one-line service-account JSON in `.env`. Never commit these values.
- **Stripe:** Start with Stripe test keys. Configure a webhook for `checkout.session.completed` at `https://your-domain/api/webhooks/stripe`.

## Admin inquiries

- Open the admin modal from the header and switch to the `Inquiries` tab.
- Filter by search text, service, and status.
- Update inquiry status (`New`, `In progress`, `Closed`) directly in the dashboard.

This starter keeps products in memory. Replace the `products` array with a database before deploying so products and orders persist after a restart.
