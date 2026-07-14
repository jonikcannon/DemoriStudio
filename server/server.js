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

const app = express();
const port = process.env.PORT || 3000;
const origin = process.env.CLIENT_ORIGIN || 'http://localhost:6200';
const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;

const uploadsDir = path.join(__dirname, '../storage/uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const inquiriesDir = path.join(__dirname, '../storage/inquiries');
if (!fs.existsSync(inquiriesDir)) fs.mkdirSync(inquiriesDir, { recursive: true });
const galleryDir = path.join(__dirname, '../src/assets/gallery');
const galleryManifestPath = path.join(galleryDir, 'gallery-manifest.json');

const inquiriesLogFile = path.join(inquiriesDir, 'contact-inquiries.jsonl');
let products = [];
let mailTransporter;

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
  return {
    quantity,
    price_data: {
      currency: 'usd',
      unit_amount: product.price,
      product_data: {
        name: product.title,
        description: buildCheckoutDescription(product),
        images: product.mediaType === 'image' ? [toAbsoluteImage(product.image)] : []
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
  const isOriginImage = image.startsWith(`${normalizedOrigin}/`);
  if (!isGalleryImage && !isUploadImage && !isOriginImage) return null;

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
app.use(express.static(path.join(__dirname, '../storage')));

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
  res.json(products.filter(product => product.published).map(ensureSku));
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
    const filePath = path.join(uploadsDir, fileName);
    fs.writeFileSync(filePath, Buffer.from(media.data, 'base64'));

    const product = ensureSku({
      id: randomUUID(),
      title,
      category,
      price,
      description: description || '',
      mediaType: media.mimeType.startsWith('video/') ? 'video' : 'image',
      fileName,
      image: `/uploads/${fileName}`,
      published: true,
      createdAt: new Date().toISOString()
    });

    products.unshift(product);
    return res.status(201).json(product);
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
  return res.status(201).json(product);
});

app.delete('/api/admin/products/:id', auth, (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ error: 'Product id is required.' });

  const product = products.find(item => item.id === id);
  if (!product) return res.status(404).json({ error: 'Product not found.' });

  products = products.filter(item => item.id !== id);

  if (product.fileName) {
    const filePath = path.join(uploadsDir, product.fileName);
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch (error) {
        console.error('Failed to remove uploaded product media:', error);
      }
    }
  }

  return res.json({ ok: true, id });
});

app.patch('/api/admin/gallery/category', auth, (req, res) => {
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
  }

  products = products.map(product => {
    const relative = toGalleryRelativeImage(product.image);
    if (relative !== image) return product;
    return {
      ...product,
      image: toAbsoluteImage(nextImage)
    };
  });

  if (fs.existsSync(galleryManifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(galleryManifestPath, 'utf8'));
      if (Array.isArray(manifest)) {
        const categoryLabel = targetFolder.charAt(0).toUpperCase() + targetFolder.slice(1);
        const updated = manifest.map(item => {
          if (String(item?.image || '') !== image) return item;
          return {
            ...item,
            category: categoryLabel,
            image: nextImage
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
    image: nextImage,
    absoluteImage: toAbsoluteImage(nextImage),
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

app.listen(port, () => console.log(`Demori API running on http://localhost:${port}`));
