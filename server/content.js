const fs = require('fs');
const path = require('path');

const contentDir = path.join(__dirname, '../storage/content');
const contentFile = path.join(contentDir, 'site-content.json');
const backupFile = path.join(contentDir, 'site-content.json.bak');

const defaults = {
  revision: 0,
  updatedAt: '',
  site: {
    brand: 'Demori Studios',
    title: 'Demori Studios',
    description: 'A thoughtful visual studio for people, places, and stories.',
    contactEmail: 'hello@example.com',
    footerText: 'All rights reserved.',
    logo: '',
    socialLinks: []
  },
  navigation: {
    catalog: { label: 'Catalog', visible: true },
    services: { label: 'Services', visible: true },
    booking: { label: 'Book', visible: true },
    about: { label: 'About', visible: true }
  },
  hero: {
    eyebrow: 'Photography studio',
    headline: 'Made to make you look twice.',
    intro: 'Thoughtful imagery for the places, people, and stories worth remembering.',
    ctaLabel: 'Explore the catalog',
    ctaTarget: 'products',
    video: '',
    poster: ''
  },
  statement: {
    eyebrow: 'A different perspective',
    heading: 'Images with a sense of place and feeling.',
    copy: 'From the ground to the sky, we make photographs that feel both immediate and lasting.'
  },
  // These defaults are the copy the About page shipped with before it became
  // editable, so an untouched site reads exactly as it always did. An empty
  // portrait means "use the bundled portrait" (see AboutComponent).
  about: {
    eyebrow: 'BEHIND THE LENS',
    heading: "Hi, I'm",
    headingEmphasis: 'Jonik.',
    paragraphs: [
      "I'm a photographer and licensed drone pilot with a deep passion for capturing honest moments, striking light, and perspectives people do not usually get to see.",
      'While I am newer in my professional photography journey, I bring an exceptional eye for composition, timing, and storytelling that helps each shoot feel intentional and emotionally true.',
      'I also bring 15+ years of technology leadership across the full software development lifecycle, currently serving as an Application Delivery Manager, Senior QA Automation Engineer, and Team Lead.',
      'That technical experience shapes how I approach creative work: strong preparation, repeatable quality, precision in post-processing, and a client experience built on clear communication and dependable delivery.',
      'Whether I am shooting portraits, creating aerial content, or building brand-focused visuals, my goal is simple: create images that feel personal, polished, and memorable.'
    ],
    portrait: '',
    ctaLabel: 'More about the studio',
    features: []
  },
  services: [],
  work: [],
  // Sites shown, live, in the Websites service's scrollable iframe list.
  websites: [],
  // CSS custom properties applied at runtime (see AppComponent.applyTheme).
  // The defaults match the palette the stylesheets shipped with.
  theme: { primary: '#26362e', background: '#f4f2ec', text: '#1f211d' },
  contact: {
    eyebrow: "Let's make something",
    heading: "Have a story in mind? Let's talk.",
    email: 'hello@example.com'
  }
};

const maxLengths = {
  brand: 80, title: 120, description: 320, contactEmail: 254, footerText: 180,
  eyebrow: 100, headline: 180, intro: 500, ctaLabel: 80, heading: 180, copy: 600,
  paragraph: 1200, label: 60, media: 2000, serviceName: 100, serviceText: 600,
  workTitle: 120, category: 80
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function assertString(value, max, field, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) {
    throw new Error(`${field} must be a string of ${required ? '1' : '0'}-${max} characters.`);
  }
}

// Accepts every path shape this server's upload flow can hand back: a
// manifest-relative gallery path, a local /uploads/ file, or a stable
// /api/site-media/ Drive reference (see saveSiteMedia in server.js). The signed
// /api/media/<token> links are deliberately not accepted: they expire after
// hours, so a value saved into content would silently break.
function assertMediaReference(value, field) {
  if (value === '') return;
  assertString(value, maxLengths.media, field);
  if (!/^(assets\/gallery\/|\/uploads\/|\/api\/site-media\/)/.test(value)) {
    throw new Error(`${field} must reference uploaded media.`);
  }
}

function assertHttpsUrl(value, field) {
  assertString(value, 500, field, true);
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error(`${field} must be a valid URL.`); }
  if (parsed.protocol !== 'https:') throw new Error(`${field} must use https://.`);
}

function assertKeys(value, allowed, field) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${field}.${key} is not editable.`);
  }
}

function validateContent(input) {
  if (!isPlainObject(input)) throw new Error('Content must be an object.');
  assertKeys(input, ['site', 'navigation', 'hero', 'statement', 'about', 'services', 'work', 'websites', 'theme', 'contact'], 'content');

  const site = input.site;
  if (!isPlainObject(site)) throw new Error('site must be an object.');
  assertKeys(site, ['brand', 'title', 'description', 'contactEmail', 'footerText', 'logo', 'socialLinks'], 'site');
  for (const field of ['brand', 'title', 'description', 'contactEmail', 'footerText']) assertString(site[field], maxLengths[field], `site.${field}`, field !== 'footerText');
  assertMediaReference(site.logo, 'site.logo');
  if (!Array.isArray(site.socialLinks) || site.socialLinks.length > 8) throw new Error('site.socialLinks is invalid.');
  for (const link of site.socialLinks) {
    if (!isPlainObject(link)) throw new Error('Each social link must be an object.');
    assertKeys(link, ['label', 'url'], 'site.socialLinks[]');
    assertString(link.label, maxLengths.label, 'social link label', true);
    assertString(link.url, 500, 'social link url', true);
    if (!/^https:\/\//i.test(link.url)) throw new Error('Social links must use HTTPS URLs.');
  }

  const navigation = input.navigation;
  if (!isPlainObject(navigation)) throw new Error('navigation must be an object.');
  assertKeys(navigation, ['catalog', 'services', 'booking', 'about'], 'navigation');
  for (const key of Object.keys(navigation)) {
    const item = navigation[key];
    if (!isPlainObject(item)) throw new Error(`navigation.${key} is invalid.`);
    assertKeys(item, ['label', 'visible'], `navigation.${key}`);
    assertString(item.label, maxLengths.label, `navigation.${key}.label`, true);
    if (typeof item.visible !== 'boolean') throw new Error(`navigation.${key}.visible must be boolean.`);
  }

  const hero = input.hero;
  if (!isPlainObject(hero)) throw new Error('hero must be an object.');
  assertKeys(hero, ['eyebrow', 'headline', 'intro', 'ctaLabel', 'ctaTarget', 'video', 'poster'], 'hero');
  for (const field of ['eyebrow', 'headline', 'intro', 'ctaLabel', 'ctaTarget']) assertString(hero[field], maxLengths[field], `hero.${field}`, true);
  assertMediaReference(hero.video, 'hero.video');
  assertMediaReference(hero.poster, 'hero.poster');

  const statement = input.statement;
  if (!isPlainObject(statement)) throw new Error('statement must be an object.');
  assertKeys(statement, ['eyebrow', 'heading', 'copy'], 'statement');
  assertString(statement.eyebrow, maxLengths.eyebrow, 'statement.eyebrow', true);
  assertString(statement.heading, maxLengths.heading, 'statement.heading', true);
  assertString(statement.copy, maxLengths.copy, 'statement.copy', true);

  const about = input.about;
  if (!isPlainObject(about) || !Array.isArray(about.paragraphs) || about.paragraphs.length > 12) throw new Error('about is invalid.');
  assertKeys(about, ['eyebrow', 'heading', 'headingEmphasis', 'paragraphs', 'portrait', 'ctaLabel', 'features'], 'about');
  assertString(about.eyebrow, maxLengths.eyebrow, 'about.eyebrow', true);
  assertString(about.heading, maxLengths.heading, 'about.heading', true);
  assertString(about.headingEmphasis, maxLengths.heading, 'about.headingEmphasis');
  assertString(about.ctaLabel, maxLengths.ctaLabel, 'about.ctaLabel', true);
  assertMediaReference(about.portrait, 'about.portrait');
  about.paragraphs.forEach((paragraph, index) => assertString(paragraph, maxLengths.paragraph, `about.paragraphs[${index}]`, true));
  if (!Array.isArray(about.features) || about.features.length > 12) throw new Error('about.features is invalid.');
  about.features.forEach((feature, index) => {
    if (!isPlainObject(feature)) throw new Error(`about.features[${index}] is invalid.`);
    assertKeys(feature, ['title', 'description', 'image'], `about.features[${index}]`);
    assertString(feature.title, maxLengths.workTitle, `about.features[${index}].title`, true);
    assertString(feature.description, maxLengths.serviceText, `about.features[${index}].description`, true);
    assertMediaReference(feature.image, `about.features[${index}].image`);
  });

  if (!Array.isArray(input.services) || input.services.length > 30) throw new Error('services is invalid.');
  for (const service of input.services) {
    if (!isPlainObject(service)) throw new Error('Each service must be an object.');
    assertKeys(service, ['name', 'icon', 'title', 'text', 'image', 'mediaType', 'poster', 'pricingTitle', 'tiers', 'addons'], 'services[]');
    for (const field of ['name', 'icon', 'title', 'text', 'pricingTitle']) assertString(service[field], field === 'text' ? maxLengths.serviceText : maxLengths.serviceName, `service.${field}`, true);
    assertMediaReference(service.image, 'service.image');
    assertMediaReference(service.poster || '', 'service.poster');
    if (!['image', 'video'].includes(service.mediaType)) throw new Error('service.mediaType is invalid.');
    for (const collection of ['tiers', 'addons']) {
      if (!Array.isArray(service[collection]) || service[collection].length > 20) throw new Error(`service.${collection} is invalid.`);
      service[collection].forEach(item => {
        if (!isPlainObject(item)) throw new Error(`service.${collection} item is invalid.`);
        assertKeys(item, ['label', 'price', 'details'], `service.${collection}[]`);
        assertString(item.label, maxLengths.label, 'service item label', true);
        assertString(item.price, 80, 'service item price', true);
        assertString(item.details, maxLengths.paragraph, 'service item details', true);
      });
    }
  }

  if (!Array.isArray(input.work) || input.work.length > 60) throw new Error('work is invalid.');
  for (const item of input.work) {
    if (!isPlainObject(item)) throw new Error('Each work item must be an object.');
    assertKeys(item, ['title', 'type', 'size', 'image', 'description', 'mediaType'], 'work[]');
    assertString(item.title, maxLengths.workTitle, 'work.title', true);
    assertString(item.type, maxLengths.category, 'work.type', true);
    assertString(item.size, 30, 'work.size');
    assertString(item.description, maxLengths.paragraph, 'work.description');
    assertMediaReference(item.image, 'work.image');
    if (!['image', 'video'].includes(item.mediaType)) throw new Error('work.mediaType is invalid.');
  }

  if (!Array.isArray(input.websites) || input.websites.length > 12) throw new Error('websites is invalid.');
  input.websites.forEach((site, index) => {
    if (!isPlainObject(site)) throw new Error(`websites[${index}] is invalid.`);
    assertKeys(site, ['title', 'url'], `websites[${index}]`);
    assertString(site.title, maxLengths.workTitle, `websites[${index}].title`, true);
    assertHttpsUrl(site.url, `websites[${index}].url`);
  });

  const theme = input.theme;
  if (!isPlainObject(theme)) throw new Error('theme must be an object.');
  assertKeys(theme, ['primary', 'background', 'text'], 'theme');
  for (const key of ['primary', 'background', 'text']) {
    if (typeof theme[key] !== 'string' || !/^#[0-9a-f]{6}$/i.test(theme[key])) throw new Error(`theme.${key} must be a #rrggbb color.`);
  }

  const contact = input.contact;
  if (!isPlainObject(contact)) throw new Error('contact must be an object.');
  assertKeys(contact, ['eyebrow', 'heading', 'email'], 'contact');
  assertString(contact.eyebrow, maxLengths.eyebrow, 'contact.eyebrow', true);
  assertString(contact.heading, maxLengths.heading, 'contact.heading', true);
  assertString(contact.email, maxLengths.contactEmail, 'contact.email', true);
  return input;
}

// revision/updatedAt are storage metadata stamped on by writeContent, not
// part of the editable content schema, so they're stripped before validation
// rather than added to every section's allow-list.
function stripMetadata(value) {
  const { revision, updatedAt, ...rest } = value;
  return rest;
}

// Content saved before a field existed (a logo, a theme, the websites list...)
// simply lacks it, so gaps are filled from the defaults before validating --
// otherwise every schema addition would make an existing site fall back to the
// defaults wholesale.
function withDefaults(stored) {
  return mergeContent(stripMetadata(clone(defaults)), stored);
}

function readContent() {
  if (!fs.existsSync(contentFile)) return clone(defaults);
  try {
    const parsed = JSON.parse(fs.readFileSync(contentFile, 'utf8'));
    return { ...validateContent(withDefaults(stripMetadata(parsed))), revision: parsed.revision, updatedAt: parsed.updatedAt };
  } catch (error) {
    console.error('Failed to read site content; using defaults.', error.message || error);
    return clone(defaults);
  }
}

function writeContent(next) {
  const content = validateContent(stripMetadata(next));
  fs.mkdirSync(contentDir, { recursive: true });
  const payload = { ...clone(content), revision: Number(next.revision || 0) + 1, updatedAt: new Date().toISOString() };
  const tempFile = `${contentFile}.${process.pid}.tmp`;
  if (fs.existsSync(contentFile)) fs.copyFileSync(contentFile, backupFile);
  fs.writeFileSync(tempFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tempFile, contentFile);
  return payload;
}

function mergeContent(current, patch) {
  if (!isPlainObject(patch)) throw new Error('Content update must be an object.');
  const merge = (left, right) => {
    if (!isPlainObject(right)) return right;
    const result = { ...left };
    for (const [key, value] of Object.entries(right)) {
      result[key] = isPlainObject(value) && isPlainObject(result[key])
        ? merge(result[key], value)
        : value;
    }
    return result;
  };
  return merge(current, patch);
}

module.exports = { defaults, readContent, writeContent, validateContent, mergeContent };
