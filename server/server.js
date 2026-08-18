require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const Stripe = require('stripe');
const { google } = require('googleapis');
const nodemailer = require('nodemailer');
const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

const app = express();
const port = process.env.PORT || 3000;
const origin = process.env.CLIENT_ORIGIN || 'http://localhost:6200';
const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;

const uploadsDir = path.join(__dirname, '../storage/uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const inquiriesDir = path.join(__dirname, '../storage/inquiries');
if (!fs.existsSync(inquiriesDir)) fs.mkdirSync(inquiriesDir, { recursive: true });
const productsDir = path.join(__dirname, '../storage/products');
if (!fs.existsSync(productsDir)) fs.mkdirSync(productsDir, { recursive: true });
const { resolveMediaDir } = require('../scripts/media-dir');
const {
  config: r2Config, isR2Configured, isCdnEnabled, createR2Client,
  toObjectKey: toR2Key, toPublicUrl: toR2Url
} = require('../scripts/r2');
const galleryDir = resolveMediaDir();
if (!fs.existsSync(galleryDir)) fs.mkdirSync(galleryDir, { recursive: true });
const galleryManifestPath = path.join(galleryDir, 'gallery-manifest.json');

const inquiriesLogFile = path.join(inquiriesDir, 'contact-inquiries.jsonl');
const productsFile = path.join(productsDir, 'products.json');
let products = [];
let mailTransporter;
let mediaStorageReady = false;

const googleMediaConfig = {
  folderId: String(process.env.GOOGLE_MEDIA_FOLDER_ID || process.env.GOOGLE_DRIVE_FOLDER_ID || '').trim(),
  serviceAccountJson: String(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '').trim(),
  tokenTtl: String(process.env.GOOGLE_MEDIA_TOKEN_TTL || '12h').trim() || '12h'
};

function getGoogleServiceAccountCredentials() {
  if (!googleMediaConfig.serviceAccountJson) return null;
  try {
    return JSON.parse(googleMediaConfig.serviceAccountJson);
  } catch (error) {
    console.error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON.', error.message || error);
    return null;
  }
}

function createGoogleDriveClient() {
  if (!googleMediaConfig.folderId) return null;
  const credentials = getGoogleServiceAccountCredentials();
  if (!credentials?.client_email || !credentials?.private_key) return null;

  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ['https://www.googleapis.com/auth/drive']
  });

  return google.drive({ version: 'v3', auth });
}

const driveClient = createGoogleDriveClient();

function canUseGoogleDriveMedia() {
  return Boolean(driveClient && googleMediaConfig.folderId);
}

function buildMediaProxyPath(fileId, mimeType) {
  const token = jwt.sign({
    provider: 'gdrive',
    fileId,
    mimeType: String(mimeType || '').trim()
  }, process.env.JWT_SECRET, {
    expiresIn: googleMediaConfig.tokenTtl,
    issuer: 'demori-api',
    audience: 'demori-media'
  });
  return `/api/media/${encodeURIComponent(token)}`;
}

function resolveProductImageForResponse(product) {
  const normalized = ensureSku(product);
  if (normalized?.storageProvider === 'gdrive' && normalized?.driveFileId) {
    return {
      ...normalized,
      image: buildMediaProxyPath(normalized.driveFileId, normalized.driveMimeType || normalized.mediaMimeType || '')
    };
  }
  return normalized;
}

function readProductsFromDisk() {
  if (!fs.existsSync(productsFile)) return [];
  try {
    const raw = fs.readFileSync(productsFile, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error('Failed to read persisted products file:', error.message || error);
    return [];
  }
}

function writeProductsToDisk() {
  try {
    fs.writeFileSync(productsFile, `${JSON.stringify(products, null, 2)}\n`, 'utf8');
    return true;
  } catch (error) {
    console.error('Failed to persist products file:', error.message || error);
    return false;
  }
}

function loadProductsFromDisk() {
  const loaded = readProductsFromDisk();
  products = loaded.map(ensureSku);
  if (!fs.existsSync(productsFile)) {
    writeProductsToDisk();
  }
}

async function initializeMediaStorage() {
  if (canUseGoogleDriveMedia()) {
    try {
      await driveClient.files.get({
        fileId: googleMediaConfig.folderId,
        fields: 'id',
        supportsAllDrives: true
      });
      mediaStorageReady = true;
      console.log(`Media storage: Google Drive mode (${googleMediaConfig.folderId})`);
      return;
    } catch (error) {
      console.error('Google Drive media folder check failed. Falling back to local filesystem mode.', error.message || error);
    }
  }

  mediaStorageReady = true;
  console.log('Media storage: local filesystem mode');
}

async function saveProductMedia({ fileName, mimeType, buffer }) {
  if (canUseGoogleDriveMedia()) {
    try {
      const uploaded = await driveClient.files.create({
        requestBody: {
          name: fileName,
          parents: [googleMediaConfig.folderId]
        },
        media: {
          mimeType: mimeType || 'application/octet-stream',
          body: Readable.from(buffer)
        },
        fields: 'id, name',
        supportsAllDrives: true
      });

      return {
        image: buildMediaProxyPath(uploaded.data.id, mimeType),
        fileName,
        driveFileId: uploaded.data.id,
        driveMimeType: mimeType || 'application/octet-stream',
        storageProvider: 'gdrive'
      };
    } catch (error) {
      console.error('Google Drive media upload failed. Falling back to local upload path.', error.message || error);
    }
  }

  const filePath = path.join(uploadsDir, fileName);
  fs.writeFileSync(filePath, buffer);
  return {
    image: `/uploads/${fileName}`,
    fileName,
    storageProvider: 'local'
  };
}

async function removeProductMedia(product) {
  if (product?.storageProvider === 'gdrive' && product?.driveFileId && driveClient) {
    try {
      await driveClient.files.delete({
        fileId: String(product.driveFileId),
        supportsAllDrives: true
      });
      return;
    } catch (error) {
      console.error('Failed to remove Google Drive media object:', error.message || error);
      return;
    }
  }

  if (product?.fileName) {
    const filePath = path.join(uploadsDir, product.fileName);
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch (error) {
        console.error('Failed to remove uploaded product media:', error);
      }
    }
  }
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32) || 'item';
}

function makeSku(title, category, seed) {
  const categoryPart = slugify(category).slice(0, 8).toUpperCase();
  const titlePart = slugify(title).slice(0, 12).toUpperCase();
  const seedPart = slugify(seed).replace(/-/g, '').slice(-6).toUpperCase() || '000000';
  let sku = `DMR-${categoryPart}-${titlePart}-${seedPart}`;
  let counter = 2;
  while (products.some(product => product.sku === sku)) {
    sku = `DMR-${categoryPart}-${titlePart}-${String(counter).padStart(2, '0')}`;
    counter += 1;
  }
  return sku;
}

function ensureSku(product) {
  if (!product.sku) {
    product.sku = makeSku(product.title, product.category, product.id || product.image || randomUUID());
  }
  return product;
}

function toAbsoluteImage(image) {
  const trimmed = String(image || '').trim();
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
  if (trimmed.startsWith('/')) return `${origin.replace(/\/$/, '')}${trimmed}`;
  return `${origin.replace(/\/$/, '')}/${trimmed.replace(/^\/+/, '')}`;
}

function toGalleryRelativeImage(image) {
  const trimmed = String(image || '').trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('assets/gallery/')) return trimmed;

  const normalizedOrigin = origin.replace(/\/$/, '');
  if (trimmed.startsWith(`${normalizedOrigin}/`)) {
    return trimmed.slice(normalizedOrigin.length + 1);
  }

  const withoutHost = trimmed.replace(/^https?:\/\/[^/]+\/?/i, '');
  if (withoutHost.startsWith('assets/gallery/')) return withoutHost;
  return '';
}

const r2Client = createR2Client();

// Public URL for a gallery path like `assets/gallery/beach/foo.jpg`. Points at
// the CDN when MEDIA_CDN_URL is set, otherwise stays relative and is served
// off local disk.
function toGalleryPublicImage(relativeImage) {
  if (!isCdnEnabled()) return relativeImage;
  return toR2Url(relativeImage);
}

// Mirror a category change into R2. Objects are keyed by category, so a move
// on disk has to be a copy+delete in the bucket or the CDN URL 404s.
async function moveGalleryObjectInR2(fromRelative, toRelative) {
  if (!r2Client || !isR2Configured()) return;
  const { CopyObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
  const fromKey = decodeURIComponent(fromRelative);
  const toKey = decodeURIComponent(toRelative);
  await r2Client.send(new CopyObjectCommand({
    Bucket: r2Config.bucket,
    Key: toKey,
    CopySource: `${r2Config.bucket}/${fromKey}`.split('/').map(encodeURIComponent).join('/')
  }));
  await r2Client.send(new DeleteObjectCommand({ Bucket: r2Config.bucket, Key: fromKey }));
}

function listGalleryCategories() {
  if (!fs.existsSync(galleryDir)) return [];
  return fs.readdirSync(galleryDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name.toLowerCase());
}

function toCategoryFolder(value) {
  return slugify(value || '').replace(/-/g, '');
}

function isPrintOrder(product) {
  const sku = String(product?.sku || '').toUpperCase();
  const title = String(product?.title || '').toLowerCase();
  return /-(4X6|5X7|6X8|8X10|8X11)$/.test(sku) || title.includes(' print)');
}

function buildCheckoutDescription(product) {
  const base = String(product?.description || '').trim();
  const disclaimer = 'Printing is an add-on service. Digital file purchase is separate.';
  if (!isPrintOrder(product)) return base;
  if (!base) return disclaimer;
  if (base.toLowerCase().includes('digital file purchase is separate')) return base;
  return `${base} ${disclaimer}`;
}

function buildCheckoutLineItem(product, quantity) {
  const normalizedImage = String(product?.image || '').trim();
  const canUseStripeImage = normalizedImage && !normalizedImage.startsWith('/api/media/') && !normalizedImage.startsWith('api/media/');
  return {
    quantity,
    price_data: {
      currency: 'usd',
      unit_amount: product.price,
      product_data: {
        name: product.title,
        description: buildCheckoutDescription(product),
        images: product.mediaType === 'image' && canUseStripeImage ? [toAbsoluteImage(product.image)] : []
      }
    }
  };
}

function resolvePreviewProduct(preview) {
  const sku = String(preview?.sku || '').trim();
  const title = String(preview?.title || '').trim();
  const description = String(preview?.description || '').trim();
  const image = String(preview?.image || '').trim();
  const mediaType = String(preview?.mediaType || '').trim().toLowerCase();
  const price = Number(preview?.price);

  if (!title || !Number.isInteger(price) || price < 100 || !image) return null;
  const normalizedOrigin = origin.replace(/\/$/, '');
  const isGalleryImage = image.startsWith('assets/gallery/');
  const isUploadImage = image.startsWith('/uploads/') || image.startsWith('uploads/');
  const isProxyImage = image.startsWith('/api/media/') || image.startsWith('api/media/');
  const isOriginImage = image.startsWith(`${normalizedOrigin}/`);
  const isAbsoluteRemote = /^https?:\/\//i.test(image);
  if (!isGalleryImage && !isUploadImage && !isProxyImage && !isOriginImage && !isAbsoluteRemote) return null;

  return {
    sku,
    title,
    description,
    price,
    image: toAbsoluteImage(image),
    mediaType: mediaType === 'video' || /\.mp4(\?|$)/i.test(image) ? 'video' : 'image'
  };
}

function parseInquiryLines(content) {
  return content
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function readInquiries() {
  if (!fs.existsSync(inquiriesLogFile)) return [];
  const raw = fs.readFileSync(inquiriesLogFile, 'utf8');
  return parseInquiryLines(raw);
}

function writeInquiries(inquiries) {
  const next = inquiries.map(inquiry => JSON.stringify(inquiry)).join('\n');
  fs.writeFileSync(inquiriesLogFile, next ? `${next}\n` : '', 'utf8');
}

function appendInquiry(inquiry) {
  fs.appendFileSync(inquiriesLogFile, `${JSON.stringify(inquiry)}\n`, 'utf8');
}

function updateInquiryById(id, updater) {
  const inquiries = readInquiries();
  const index = inquiries.findIndex(inquiry => inquiry.id === id);
  if (index < 0) return null;
  const updated = updater({ ...inquiries[index] });
  inquiries[index] = updated;
  writeInquiries(inquiries);
  return updated;
}

function getMailerConfig() {
  const host = String(process.env.SMTP_HOST || '').trim();
  const user = String(process.env.SMTP_USER || '').trim();
  const pass = String(process.env.SMTP_PASS || '').trim();
  if (!host || !user || !pass) return null;

  const parsedPort = Number(process.env.SMTP_PORT || 587);
  const port = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : 587;
  const secure = String(process.env.SMTP_SECURE || '').trim() === 'true' || port === 465;

  return { host, port, secure, user, pass };
}

function getMailer() {
  if (mailTransporter) return mailTransporter;
  const config = getMailerConfig();
  if (!config) return null;

  mailTransporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: {
      user: config.user,
      pass: config.pass
    }
  });

  return mailTransporter;
}

async function sendInquiryEmail(inquiry) {
  const transporter = getMailer();
  const to = String(process.env.CONTACT_TO_EMAIL || process.env.ADMIN_EMAIL || '').trim();
  if (!transporter || !to) return false;

  const from = String(process.env.CONTACT_FROM_EMAIL || process.env.SMTP_USER || '').trim();
  if (!from) return false;

  const subject = `[Demori Studio] ${inquiry.service} inquiry from ${inquiry.name}`;
  const text = [
    'A new contact inquiry was submitted.',
    '',
    `Inquiry ID: ${inquiry.id}`,
    `Name: ${inquiry.name}`,
    `Email: ${inquiry.email}`,
    `Service: ${inquiry.service}`,
    `Submitted: ${inquiry.createdAt}`,
    '',
    'Message:',
    inquiry.message
  ].join('\n');

  await transporter.sendMail({
    from,
    to,
    replyTo: inquiry.email,
    subject,
    text
  });

  return true;
}

app.use(helmet());
app.use(cors({ origin, methods: ['GET', 'POST', 'PATCH', 'DELETE'], allowedHeaders: ['Content-Type', 'Authorization'] }));
// Only these two subtrees of storage/ are public. Mount them explicitly rather
// than serving all of storage/, which would also expose inquiries (PII),
// products.json, and sale-photos originals.
// In production nginx serves both paths directly; these mounts are the dev-mode
// and direct-hit equivalent.
app.use('/uploads', express.static(uploadsDir, { maxAge: '7d' }));

// The manifest is regenerated on every build and rewritten by category moves,
// so it is never pushed to the bucket -- always serve it from disk.
app.get('/assets/gallery/gallery-manifest.json', (req, res) => {
  if (!fs.existsSync(galleryManifestPath)) return res.status(404).json({ error: 'Manifest not found.' });
  return res.sendFile(galleryManifestPath);
});

// In CDN mode, send media requests to the bucket instead of serving bytes.
// The manifest already carries absolute CDN URLs, but templates also hard-code
// a few gallery paths (the hero video among them, at 206 MB). Redirecting here
// means those go to R2 too, and any path added later is covered by default
// rather than quietly billing the origin.
if (isCdnEnabled()) {
  app.get(/^\/assets\/gallery\/.+/, (req, res) => {
    const key = req.path.replace(/^\/+/, '');
    return res.redirect(302, toR2Url(key));
  });
} else {
  app.use('/assets/gallery', express.static(galleryDir, { maxAge: '7d' }));
}

app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), stripeWebhook);
app.use(express.json({ limit: '65mb' }));
app.use(rateLimit({ windowMs: 900000, max: 150, standardHeaders: true, legacyHeaders: false }));

function auth(req, res, next) {
  try {
    req.admin = jwt.verify(req.headers.authorization?.replace('Bearer ', ''), process.env.JWT_SECRET, {
      issuer: 'demori-api',
      audience: 'demori-admin'
    });
    next();
  } catch {
    res.status(401).json({ error: 'Sign in required.' });
  }
}

app.get('/api/products', (req, res) => {
  res.json(products.filter(product => product.published).map(resolveProductImageForResponse));
});

app.post('/api/admin/login', rateLimit({ windowMs: 900000, max: 8, message: { error: 'Too many attempts. Try again later.' } }), async (req, res) => {
  const { email, password } = req.body || {};
  if (
    !email ||
    !password ||
    email !== process.env.ADMIN_EMAIL ||
    !(await bcrypt.compare(password, process.env.ADMIN_PASSWORD_HASH || ''))
  ) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  return res.json({
    token: jwt.sign({ role: 'admin', email }, process.env.JWT_SECRET, {
      expiresIn: '2h',
      issuer: 'demori-api',
      audience: 'demori-admin'
    }),
    provider: 'password'
  });
});

app.post('/api/admin/google-login', rateLimit({ windowMs: 900000, max: 15, message: { error: 'Too many attempts. Try again later.' } }), async (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: 'Google token required.' });

  try {
    const ticket = await new google.auth.OAuth2({
      clientId: '352038115250-io37tumi7dseohtgklrlg435vpj2qddb.apps.googleusercontent.com'
    }).verifyIdToken({
      idToken: token,
      audience: '352038115250-io37tumi7dseohtgklrlg435vpj2qddb.apps.googleusercontent.com'
    });

    const payload = ticket.getPayload();
    if (!payload || payload.email !== process.env.ADMIN_EMAIL) {
      return res.status(403).json({ error: 'Access denied. Not authorized.' });
    }

    return res.json({
      token: jwt.sign({ role: 'admin', email: payload.email }, process.env.JWT_SECRET, {
        expiresIn: '2h',
        issuer: 'demori-api',
        audience: 'demori-admin'
      }),
      provider: 'google',
      email: payload.email
    });
  } catch (error) {
    console.error('Google auth error:', error);
    return res.status(401).json({ error: 'Invalid Google token.' });
  }
});

app.get('/api/admin/inquiries', auth, (req, res) => {
  const query = String(req.query.q || '').trim().toLowerCase();
  const serviceFilter = String(req.query.service || '').trim();
  const statusFilter = String(req.query.status || '').trim();
  const allowedStatus = new Set(['new', 'in-progress', 'closed']);

  const inquiries = readInquiries()
    .map(inquiry => ({ ...inquiry, status: allowedStatus.has(inquiry.status) ? inquiry.status : 'new' }))
    .filter(inquiry => {
      if (serviceFilter && serviceFilter !== 'all' && inquiry.service !== serviceFilter) return false;
      if (statusFilter && statusFilter !== 'all' && inquiry.status !== statusFilter) return false;
      if (!query) return true;
      return [inquiry.name, inquiry.email, inquiry.message, inquiry.service]
        .map(value => String(value || '').toLowerCase())
        .some(value => value.includes(query));
    })
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  res.json({ inquiries });
});

app.patch('/api/admin/inquiries/:id', auth, (req, res) => {
  const id = String(req.params.id || '').trim();
  const status = String(req.body?.status || '').trim();
  if (!id) return res.status(400).json({ error: 'Inquiry id is required.' });
  if (!['new', 'in-progress', 'closed'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status value.' });
  }

  const updated = updateInquiryById(id, current => ({
    ...current,
    status,
    updatedAt: new Date().toISOString()
  }));

  if (!updated) return res.status(404).json({ error: 'Inquiry not found.' });
  return res.json({ inquiry: updated });
});

app.post('/api/admin/products', auth, async (req, res) => {
  const { title, category, price, description, media } = req.body || {};
  if (!title || !category || !Number.isInteger(price) || price < 100 || !media?.data || !media?.name || !media?.mimeType) {
    return res.status(400).json({ error: 'Product details or media are invalid.' });
  }

  try {
    const fileExt = path.extname(media.name);
    const fileName = `${randomUUID()}${fileExt}`;
    const upload = await saveProductMedia({
      fileName,
      mimeType: media.mimeType,
      buffer: Buffer.from(media.data, 'base64')
    });

    const product = ensureSku({
      id: randomUUID(),
      title,
      category,
      price,
      description: description || '',
      mediaType: media.mimeType.startsWith('video/') ? 'video' : 'image',
      mediaMimeType: media.mimeType,
      fileName: upload.fileName,
      driveFileId: upload.driveFileId,
      driveMimeType: upload.driveMimeType,
      storageProvider: upload.storageProvider,
      image: upload.image,
      published: true,
      createdAt: new Date().toISOString()
    });

    products.unshift(product);
    if (!writeProductsToDisk()) {
      return res.status(500).json({ error: 'Media uploaded but product could not be saved.' });
    }
    return res.status(201).json(resolveProductImageForResponse(product));
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Media upload failed.' });
  }
});

app.post('/api/admin/products/from-gallery', auth, (req, res) => {
  const { title, category, price, description, details, image, mediaType } = req.body || {};
  if (!title || !category || !Number.isInteger(price) || price < 100 || typeof image !== 'string' || !image.trim()) {
    return res.status(400).json({ error: 'Product details are invalid.' });
  }

  const trimmedImage = image.trim();
  if (!trimmedImage.startsWith('assets/gallery/')) {
    return res.status(400).json({ error: 'Only gallery images can be published from this endpoint.' });
  }

  const resolvedMediaType = mediaType === 'video' || /\.mp4(\?|$)/i.test(trimmedImage) ? 'video' : 'image';

  const absoluteImageUrl = `${origin.replace(/\/$/, '')}/${trimmedImage.replace(/^\/+/, '')}`;
  const product = ensureSku({
    id: randomUUID(),
    title,
    category,
    price,
    description: description || '',
    details: details || '',
    mediaType: resolvedMediaType,
    image: absoluteImageUrl,
    published: true,
    createdAt: new Date().toISOString()
  });

  products.unshift(product);
  if (!writeProductsToDisk()) {
    return res.status(500).json({ error: 'Product was created but could not be saved.' });
  }
  return res.status(201).json(resolveProductImageForResponse(product));
});

app.delete('/api/admin/products/:id', auth, async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ error: 'Product id is required.' });

  const product = products.find(item => item.id === id);
  if (!product) return res.status(404).json({ error: 'Product not found.' });

  products = products.filter(item => item.id !== id);

  await removeProductMedia(product);
  if (!writeProductsToDisk()) {
    return res.status(500).json({ error: 'Product removed from memory but could not be saved.' });
  }

  return res.json({ ok: true, id });
});

app.patch('/api/admin/gallery/category', auth, async (req, res) => {
  const image = toGalleryRelativeImage(req.body?.image);
  const requestedCategory = String(req.body?.category || '').trim();
  if (!image || !requestedCategory) {
    return res.status(400).json({ error: 'Image and category are required.' });
  }

  if (!image.startsWith('assets/gallery/')) {
    return res.status(400).json({ error: 'Only gallery images can be moved.' });
  }

  const parts = image.split('/');
  if (parts.length < 4) {
    return res.status(400).json({ error: 'Image path is invalid.' });
  }

  const currentFolder = String(parts[2] || '').toLowerCase();
  const fileName = decodeURIComponent(parts.slice(3).join('/'));
  const targetFolder = toCategoryFolder(requestedCategory);
  const availableFolders = new Set(listGalleryCategories());
  if (!availableFolders.has(targetFolder)) {
    return res.status(400).json({ error: 'Target category is invalid.' });
  }

  const sourcePath = path.join(galleryDir, currentFolder, fileName);
  const destinationPath = path.join(galleryDir, targetFolder, fileName);
  const nextImage = `assets/gallery/${targetFolder}/${encodeURIComponent(fileName)}`;

  if (!fs.existsSync(sourcePath)) {
    return res.status(404).json({ error: 'Source media file was not found.' });
  }

  if (currentFolder !== targetFolder) {
    if (fs.existsSync(destinationPath)) {
      return res.status(409).json({ error: 'A file with the same name already exists in that category.' });
    }
    fs.renameSync(sourcePath, destinationPath);

    // Keep the bucket in step. If this fails the local move has already
    // happened, so roll it back rather than leave disk and CDN disagreeing.
    if (isR2Configured()) {
      try {
        await moveGalleryObjectInR2(image, nextImage);
      } catch (error) {
        console.error('R2 category move failed; rolling back local move.', error.message || error);
        try {
          fs.renameSync(destinationPath, sourcePath);
        } catch (rollbackError) {
          console.error('Rollback of local move also failed.', rollbackError.message || rollbackError);
        }
        return res.status(502).json({ error: 'Could not move the media in remote storage. Nothing was changed.' });
      }
    }
  }

  const nextPublicImage = toGalleryPublicImage(nextImage);

  products = products.map(product => {
    const relative = toGalleryRelativeImage(product.image);
    if (relative !== image) return product;
    return {
      ...product,
      image: isCdnEnabled() ? nextPublicImage : toAbsoluteImage(nextImage)
    };
  });
  if (!writeProductsToDisk()) {
    return res.status(500).json({ error: 'Gallery update saved in memory but failed to persist.' });
  }

  if (fs.existsSync(galleryManifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(galleryManifestPath, 'utf8'));
      if (Array.isArray(manifest)) {
        const categoryLabel = targetFolder.charAt(0).toUpperCase() + targetFolder.slice(1);
        const updated = manifest.map(item => {
          // Manifest entries are absolute CDN URLs in R2 mode and relative
          // paths otherwise; normalise both sides before comparing.
          if (toGalleryRelativeImage(item?.image) !== image) return item;
          return {
            ...item,
            category: categoryLabel,
            image: nextPublicImage
          };
        });
        fs.writeFileSync(galleryManifestPath, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
      }
    } catch (error) {
      console.error('Failed to update gallery manifest after category move:', error);
    }
  }

  return res.json({
    ok: true,
    image: nextPublicImage,
    absoluteImage: isCdnEnabled() ? nextPublicImage : toAbsoluteImage(nextImage),
    category: targetFolder.charAt(0).toUpperCase() + targetFolder.slice(1)
  });
});

app.post('/api/contact', rateLimit({ windowMs: 900000, max: 30, message: { error: 'Too many inquiries. Please try again shortly.' } }), async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const email = String(req.body?.email || '').trim();
  const service = String(req.body?.service || '').trim();
  const message = String(req.body?.message || '').trim();

  if (name.length < 2 || name.length > 120) return res.status(400).json({ error: 'Please enter your name.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Please enter a valid email.' });
  if (service.length < 2 || service.length > 80) return res.status(400).json({ error: 'Please choose a service.' });
  if (message.length < 8 || message.length > 4000) return res.status(400).json({ error: 'Please include project details.' });

  const inquiry = {
    id: randomUUID(),
    name,
    email,
    service,
    message,
    status: 'new',
    emailDelivered: false,
    createdAt: new Date().toISOString()
  };

  try {
    appendInquiry(inquiry);

    let emailDelivered = false;
    try {
      emailDelivered = await sendInquiryEmail(inquiry);
    } catch (error) {
      console.error('Contact inquiry email failed:', error);
    }

    if (emailDelivered) {
      const emailedAt = new Date().toISOString();
      updateInquiryById(inquiry.id, current => ({
        ...current,
        emailDelivered: true,
        emailedAt
      }));
      inquiry.emailDelivered = true;
      inquiry.emailedAt = emailedAt;
    }

    console.log('Contact inquiry received:', inquiry.id, inquiry.service, inquiry.email);
    return res.status(201).json({ ok: true, id: inquiry.id, emailDelivered });
  } catch (error) {
    console.error('Contact inquiry save failed:', error);
    return res.status(500).json({ error: 'Could not submit your inquiry right now.' });
  }
});

app.post('/api/checkout', async (req, res) => {
  const product = products.find(item => item.id === req.body?.productId && item.published);
  if (!product) return res.status(404).json({ error: 'Product unavailable.' });
  if (!stripe) return res.status(503).json({ error: 'Stripe is not configured yet.' });

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    line_items: [buildCheckoutLineItem(product, 1)],
    metadata: { productId: product.id },
    success_url: `${origin}/?checkout=success`,
    cancel_url: `${origin}/?checkout=cancel`
  });

  res.json({ url: session.url });
});

app.post('/api/checkout/preview', async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe is not configured yet.' });
  const preview = resolvePreviewProduct(req.body?.preview);
  if (!preview) return res.status(400).json({ error: 'Preview product is invalid.' });

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    line_items: [buildCheckoutLineItem(preview, 1)],
    metadata: { previewSku: preview.sku || '', preview: 'true' },
    success_url: `${origin}/?checkout=success`,
    cancel_url: `${origin}/?checkout=cancel`
  });

  res.json({ url: session.url });
});

app.post('/api/checkout/cart', async (req, res) => {
  const incomingItems = Array.isArray(req.body?.items) ? req.body.items : [];
  const digitalDeliveryEmail = String(req.body?.digitalDeliveryEmail || '').trim();
  const digitalEmailOptIn = req.body?.digitalEmailOptIn === true;
  if (!incomingItems.length) return res.status(400).json({ error: 'Cart is empty.' });
  if (!stripe) return res.status(503).json({ error: 'Stripe is not configured yet.' });
  const requiresDigitalDelivery = incomingItems.some(entry => String(entry?.orderType || '').trim() === 'digital');
  if (requiresDigitalDelivery && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(digitalDeliveryEmail)) {
    return res.status(400).json({ error: 'A valid digital delivery email is required for digital items.' });
  }

  const lineItems = [];
  for (const entry of incomingItems) {
    const quantity = Math.max(1, Math.min(10, parseInt(entry?.quantity, 10) || 1));

    if (entry?.productId) {
      const product = products.find(item => item.id === entry.productId && item.published);
      if (!product) return res.status(404).json({ error: 'One or more cart items are unavailable.' });
      lineItems.push(buildCheckoutLineItem(product, quantity));
      continue;
    }

    if (entry?.preview) {
      const preview = resolvePreviewProduct(entry.preview);
      if (!preview) return res.status(400).json({ error: 'One or more preview items are invalid.' });
      lineItems.push(buildCheckoutLineItem(preview, quantity));
      continue;
    }

    return res.status(400).json({ error: 'Cart item format is invalid.' });
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    line_items: lineItems,
    metadata: {
      cartSize: String(lineItems.length),
      hasDigitalItems: requiresDigitalDelivery ? 'true' : 'false',
      digitalDeliveryEmail: requiresDigitalDelivery ? digitalDeliveryEmail.slice(0, 200) : '',
      digitalEmailOptIn: requiresDigitalDelivery ? String(digitalEmailOptIn) : 'false'
    },
    customer_email: requiresDigitalDelivery ? digitalDeliveryEmail : undefined,
    success_url: `${origin}/?checkout=success`,
    cancel_url: `${origin}/?checkout=cancel`
  });

  res.json({ url: session.url });
});

app.get('/api/media/:token', async (req, res) => {
  if (!driveClient) return res.status(404).json({ error: 'Media proxy unavailable.' });

  try {
    const decoded = jwt.verify(String(req.params.token || ''), process.env.JWT_SECRET, {
      issuer: 'demori-api',
      audience: 'demori-media'
    });

    if (decoded?.provider !== 'gdrive' || !decoded?.fileId) {
      return res.status(400).json({ error: 'Invalid media token.' });
    }

    const mimeType = String(decoded?.mimeType || '').trim();
    if (mimeType) {
      res.setHeader('Content-Type', mimeType);
    }
    res.setHeader('Cache-Control', 'private, max-age=300');

    const response = await driveClient.files.get({
      fileId: String(decoded.fileId),
      alt: 'media',
      supportsAllDrives: true
    }, {
      responseType: 'stream'
    });

    response.data.on('error', (error) => {
      console.error('Drive media stream failed:', error.message || error);
      if (!res.headersSent) res.status(502).end();
    });

    response.data.pipe(res);
  } catch (error) {
    if (error?.name === 'TokenExpiredError' || error?.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Media token expired or invalid.' });
    }
    console.error('Media proxy error:', error.message || error);
    return res.status(404).json({ error: 'Media unavailable.' });
  }
});

async function stripeWebhook(req, res) {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return res.sendStatus(400);

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (error) {
    return res.status(400).send(`Webhook Error: ${error.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    console.log('Paid order:', event.data.object.id, event.data.object.metadata.productId);
  }

  return res.json({ received: true });
}

loadProductsFromDisk();
console.log(`Products loaded: ${products.length}`);

// Bind the port before probing Google Drive, not after. The probe is a network
// round-trip with no timeout, and nothing served here needs it to have finished:
// gallery media is read straight off disk, and uploads re-check
// canUseGoogleDriveMedia() at call time. Blocking listen on it meant the dev
// server proxied gallery requests to a socket that was not open yet and logged
// ECONNREFUSED for the first seconds of every boot -- or forever, if Drive was
// unreachable.
app.listen(port, () => console.log(`Demori API running on http://localhost:${port}`));
console.log(isCdnEnabled()
  ? `Gallery media: CDN (${r2Config.cdnUrl})`
  : 'Gallery media: local disk');

initializeMediaStorage().catch((error) => {
  console.error('Media storage init failed; continuing in local filesystem mode.', error.message || error);
});
