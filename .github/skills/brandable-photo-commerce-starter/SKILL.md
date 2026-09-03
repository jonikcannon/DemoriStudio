---
name: brandable-photo-commerce-starter
description: "Create a new, independently branded photography studio or visual-media commerce project by copying the Demori Photos application scaffold. Use when asked to clone, white-label, bootstrap, rebrand, or start a new company site with the same Angular portfolio, gallery, product shop, bookings, inquiries, private fulfilment, media storage, Stripe, and deployment capabilities."
---

# Brandable Photo Commerce Starter

Create a new project from the current workspace, preserving its working Angular
18 + Express application architecture and its operational tooling. Do not modify
the source project. The destination must be a new, empty directory.

## Required Inputs

Before creating files, collect or confirm:

- Destination directory and npm package name (kebab-case).
- Company name, public site title, short description, and domain.
- Primary contact email and intended admin email.
- Business type and the services, gallery categories, and products to feature.
- Brand direction: logo/wordmark, colours, type direction, and supplied assets.
- Whether the new company will use Cloudflare R2, Google Drive, Stripe, SMTP,
  and the included VPS/Nginx deployment path.
- **Which nav tabs to keep**: Catalog (digital-download shop + cart + Stripe),
  Services (service list + inquiry form), Book (self-serve calendar booking +
  deposits), About. Home and the mailto Contact panel are structural and
  always present. Ask explicitly — many single-service businesses (e.g. a
  wedding-only or portrait-only studio) don't want all four; a studio with no
  self-serve calendar should drop Book rather than ship a fake one.

Use temporary placeholder values for unknowns. Never ask for or copy secrets.

## Source and Destination

Treat the current workspace root as `SOURCE_ROOT`. Let `DESTINATION` be the
new project directory supplied by the user. Refuse to use a destination that
already contains files unless the user explicitly authorizes a merge.

The project is a full-stack application, not a static website. Preserve these
key capabilities:

- Angular single-page portfolio: home, work, catalog, services, about, and
  booking views.
- Gallery manifest generation, R2 CDN delivery, local-media fallback,
  watermarking, video conversion, and safe media-name tooling.
- Product catalog, shopping cart, Stripe checkout, download fulfilment, and
  private Google Drive media delivery.
- Booking availability and persistence, inquiries, admin authentication, rate
  limiting, security headers, and email notifications.
- VPS deployment scripts, Nginx configuration, and GitHub Actions deployment.

## Copy the Scaffold

1. Confirm the source contains `package.json`, `angular.json`, `src/`,
   `server/`, `scripts/`, and `.env.example`.
2. Create `DESTINATION` and copy the source tree without copying any local,
   generated, or customer-specific data. On Windows, run this from the source
   root using PowerShell:

   ```powershell
   New-Item -ItemType Directory -Force -Path $destination | Out-Null
   robocopy . $destination /E /XD .git node_modules dist .angular storage\media storage\uploads storage\quarantine storage\products storage\inquiries storage\orders storage\bookings storage\sale-photos\originals storage\sale-photos\deliveries /XF .env .oauth-token.json client_secret_*.json demoristudios-*.json filezilla_*.xml media-config.json
   if ($LASTEXITCODE -gt 7) { throw "Scaffold copy failed with robocopy exit code $LASTEXITCODE" }
   ```

   Assign `$destination` a fully resolved path before running it. `robocopy`
   exit codes `0` through `7` are successful copy outcomes.
3. Restore the tracked empty directory markers and safe starter directories:

   ```powershell
   New-Item -ItemType Directory -Force -Path storage\media, storage\uploads, storage\inquiries, storage\products, storage\orders, storage\bookings, storage\sale-photos\originals, storage\sale-photos\deliveries | Out-Null
   New-Item -ItemType File -Force -Path storage\uploads\.gitignore, storage\sale-photos\originals\.gitkeep, storage\sale-photos\deliveries\.gitkeep | Out-Null
   ```

   Copy `storage/media/README.md` if it was excluded by the directory copy, and
   do not create fake gallery assets or customer records.
4. Initialize a new Git repository in `DESTINATION`. Do not copy the source
   `.git` history, credentials, `.env`, R2/Google service-account files,
   media, runtime records, generated manifests, or installed dependencies.

## Branding Pass

Perform the branding pass inside `DESTINATION` after the scaffold is copied.
Use structured edits where possible, and search the whole new project for the
old brand/domain before declaring it complete.

1. Update identity and build identifiers:
   - `package.json`: `name`, `description`, and any company-labelled scripts.
   - `angular.json`: application project key and `dist/` output path.
   - `src/index.html`: title, favicon reference, metadata, and social tags.
   - `README.md`, deployment documentation, Nginx config filenames/content,
     and workflow/deployment labels.
2. Rebrand the UI in `src/app/` and `src/styles.css`:
   - Replace company name, contact details, service descriptions, navigation
     copy, product copy, policies, logo treatment, and brand colours.
   - Update actual hard-coded media references in `app.component.ts` and the
     about/service components. Use neutral local placeholders only when new
     brand media is unavailable; do not retain Demori-owned image or video URLs.
   - Preserve accessible labels, responsive layout behaviour, cart, catalog,
     booking, and admin flows.
3. Configure operational defaults:
   - Copy `.env.example` to `.env.example` only if it was not copied, then
     replace example domains, sender/recipient placeholders, bucket names,
     watermark text, and deployment host placeholders with new-company values.
   - Keep `.env` absent. Explain that real credentials must be created in the
     destination environment, never transferred from the source project.
   - Keep the `API_BASE_URL` example empty for same-origin deployments; only
     set it for a deliberately separate API origin. Whatever value ends up in
     `.env`, it only reaches the running app through
     `src/assets/media-config.json`, written by `generate-gallery-manifest.js`
     at `prestart`/`prebuild` time — editing `.env` after that file already
     exists has no effect until the manifest step re-runs.
4. Search for residual source branding, including case-insensitive instances of
   `Demori`, `demori`, `demoristudios`, `demori.studio`, and any source contact
   email or CDN hostname found during the copy. Resolve every intended match or
   state why a historical reference remains.

## Drop Sections the New Business Doesn't Need

Asked-for tabs only. If the required inputs ruled out a nav tab, remove it
cleanly in `DESTINATION` rather than leaving a dead or half-configured feature:

- **Nav link and route.** In `src/app/app.component.html`, delete the `<a>` in
  `<nav>` for that tab and the `*ngIf="activeSection === '...'"` block that
  renders it (the `<app-services>`, `<app-booking>`, `<app-about>` element, or
  the `catalog-controls`/products section pair).
- **Dead inbound links.** Grep the rest of `app.component.html` and the
  component templates for the same `activeSection` value — the hero CTA jumps
  to `products`, and Services/About/Booking each set `activeSection = 'contact'`
  on their own inquiry links; repoint or remove any that now target a dropped
  tab.
- **Backing code.** Remove the now-unused component import from
  `AppComponent`'s `imports:` array, its state fields, loader methods (e.g.
  `loadBookingSlots`, `onBookSlot` for Book; `loadProducts`/cart logic for
  Catalog), and the component's own files under `src/app/<section>/` once
  nothing references them.
- **Server routes.** Dropping Catalog or Book also makes the matching
  `server/*.js` routes (`booking.js`, product/cart/Stripe routes in
  `server.js`) and their `storage/` subfolders dead weight — remove the route
  mounts and admin-panel tab for a fully excised feature, or leave them
  mounted-but-unlinked only if the user wants the admin capability without a
  public entry point.
- Do not remove Home or the Contact panel — every remaining tab's inquiry
  links depend on `activeSection = 'contact'` staying reachable.

## Media and Integrations

- Gallery media is public and served from Cloudflare R2 when `R2_*` and
  `MEDIA_CDN_URL` are configured. With no R2 configuration, it is served from
  `storage/media/` locally. Run `npm run manifest -- --local` for an empty or
  local starter library.
- Product/sale media is separate from gallery media and uses Google Drive through
  authenticated API routes. Configure a new Drive folder and service account;
  never reuse source credentials or buyer media.
- Update `WATERMARK_TEXT` before publishing any public gallery assets.

## Stripe Checkout

Only relevant if Catalog and/or Book were kept. Checkout sessions are built
entirely from local data at request time — nothing needs to be pre-created as
a Product or Price in the Stripe dashboard, only the account and API keys.

- **Keys.** Set `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` in the new
  `.env` from a Stripe account owned by the new company. Start with test-mode
  (`sk_test_...`) keys; never reuse the source project's keys.
- **Webhook.** Register a webhook for `checkout.session.completed` at
  `https://<new-domain>/api/webhooks/stripe` and put its signing secret in
  `STRIPE_WEBHOOK_SECRET`. `server/server.js`'s `stripeWebhook` handler
  verifies that signature and is a no-op (`400`) without it — checkout will
  start but paid orders will never fulfil. For local testing, use the Stripe
  CLI (`stripe listen --forward-to localhost:3000/api/webhooks/stripe`) and
  its printed `whsec_...` instead of a dashboard webhook.
- **`CLIENT_ORIGIN`.** Drives the `success_url`/`cancel_url` built for every
  checkout session (`/api/checkout`, `/api/checkout/cart`,
  `/api/booking/hold`). Set it to the new production domain; it defaults to
  `http://localhost:6200`, which does not match this app's dev port (4200) or
  API port (3000) and should not be relied on for local testing — pass it
  through `.env` instead.
- **Currency is hardcoded to `usd`** in two places: `buildCheckoutLineItem` in
  `server/server.js` (catalog/cart checkout) and the inline `price_data` in the
  `/api/booking/hold` handler (booking deposits). If the new business needs a
  different currency, update both.
- **Refunds are manual.** There is no auto-refund flow; `bookingStore`'s
  refund-policy text and the admin cancel-booking action only track whether a
  deposit is inside the refund window (`booking.js`) — the operator issues the
  actual refund by hand in the Stripe dashboard. Mention this to the new owner
  rather than implying automated refunds exist.
- Set a new random `JWT_SECRET`, a bcrypt `ADMIN_PASSWORD_HASH`, SMTP details,
  and production contact addresses alongside the Stripe keys.

## Validate the New Project

From `DESTINATION`:

```powershell
npm install
npm run manifest -- --local
npx ng build
```

If `npm run <script>` fails with `PSSecurityException: UnauthorizedAccess`,
PowerShell's execution policy is blocking `npm.ps1`; run the underlying script
directly instead, e.g. `node scripts/generate-gallery-manifest.js`.

The build is the primary check: it must compile after the project key, branding,
and source changes. Then start the full stack with `npm start` and verify the
home page and every *kept* tab (catalog/cart, services/inquiry, booking, about)
load, plus the admin sign-in surface. Confirm a dropped tab has no residual nav
link, console error, or dead route. Do not treat payment, mail, Drive, or R2
calls as successful until their new credentials are configured and tested.

A freshly copied project has no `storage/bookings/*.jsonl` rows, so the
Booking tab correctly renders its "No sessions are open" empty state rather
than a calendar — that is expected, not a regression. Use the admin panel's
Bookings tab (or `POST /api/admin/booking/slots`) to publish a test day before
judging whether the calendar itself renders correctly. If the calendar instead
shows a load error (`Availability could not be loaded`) or a network failure
pointing at the old company's domain, `.env`'s `API_BASE_URL` still needs
correcting and the manifest step re-run — see the note in Branding Pass step 3.

## Completion Report

Report the destination path, new package/application identifiers, completed
branding substitutions, which nav tabs were kept vs. dropped (and what was
removed for each dropped tab), intentionally retained features, excluded
data/secrets, and validation results. List integrations still requiring
customer-provided credentials or media. Do not commit unless asked.