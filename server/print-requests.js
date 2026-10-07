// Custom 3D-print requests sent through the public contact form: the extra
// details (model link, quantity, size, colors, date) and any model files or
// reference photos the customer attaches. Attachments go straight onto the
// LAN print share (scripts/deploy/setup-print-share.sh) under _requests/,
// next to the models being printed -- never into anything served on the web.
//
// This is public input, so everything is bounded: three attachments, 20 MB
// in total, an allow-list of extensions, and photos checked by magic bytes.

const fs = require('fs');
const path = require('path');

const SHARE_DIR = String(process.env.PRINT_SHARE_DIR || '/srv/prints').trim();
const REQUESTS_DIR = path.join(SHARE_DIR, '_requests');
const MAX_FILES = 3;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const MODEL_EXTENSIONS = ['.stl', '.3mf', '.obj', '.step', '.stp'];
const PHOTO_TYPES = {
  '.jpg': [0xff, 0xd8, 0xff],
  '.jpeg': [0xff, 0xd8, 0xff],
  '.png': [0x89, 0x50, 0x4e, 0x47],
  '.webp': [0x52, 0x49, 0x46, 0x46],
  '.heic': null
};

class PrintRequestError extends Error {}

function isPrintService(service) {
  return /3d\s*print/i.test(String(service || ''));
}

function text(value, max, label) {
  const result = String(value ?? '').trim();
  if (result.length > max) throw new PrintRequestError(`${label} is too long (max ${max} characters).`);
  return result;
}

// Same rules as the inbox extractor's safe_name(): a name every device on
// the share can open.
function safeName(name) {
  return String(name || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().replace(/^[ .]+|[ .]+$/g, '').slice(0, 80) || 'file';
}

// Returns the validated request, or null when the form sent none. Throws
// PrintRequestError with a message fit to show the customer.
function parsePrintRequest(input) {
  if (!input || typeof input !== 'object') return null;

  const modelLink = text(input.modelLink, 500, 'Model link');
  if (modelLink) {
    let url;
    try {
      url = new URL(modelLink);
    } catch {
      throw new PrintRequestError('The model link must be a full web address, like https://makerworld.com/...');
    }
    if (!['https:', 'http:'].includes(url.protocol)) throw new PrintRequestError('The model link must be a web address.');
  }

  const quantity = input.quantity === undefined || input.quantity === null || input.quantity === '' ? 1 : Number(input.quantity);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 500) throw new PrintRequestError('Quantity must be a whole number from 1 to 500.');

  const neededBy = text(input.neededBy, 10, 'Needed-by date');
  if (neededBy && !/^\d{4}-\d{2}-\d{2}$/.test(neededBy)) throw new PrintRequestError('Needed-by must be a date.');

  const attachments = Array.isArray(input.files) ? input.files : [];
  if (attachments.length > MAX_FILES) throw new PrintRequestError(`Attach at most ${MAX_FILES} files.`);
  let total = 0;
  const files = attachments.map((file, index) => {
    const name = safeName(path.basename(String(file?.name || `file-${index + 1}`)));
    const ext = path.extname(name).toLowerCase();
    if (!MODEL_EXTENSIONS.includes(ext) && !(ext in PHOTO_TYPES)) {
      throw new PrintRequestError(`"${name}" isn't a model file (STL, 3MF, OBJ, STEP) or a photo (JPG, PNG, WEBP, HEIC).`);
    }
    if (typeof file?.data !== 'string') throw new PrintRequestError(`"${name}" could not be read.`);
    const buffer = Buffer.from(file.data, 'base64');
    if (!buffer.length) throw new PrintRequestError(`"${name}" is empty.`);
    const magic = PHOTO_TYPES[ext];
    if (magic && !magic.every((byte, i) => buffer[i] === byte)) throw new PrintRequestError(`"${name}" doesn't look like a real ${ext.slice(1).toUpperCase()} image.`);
    total += buffer.length;
    if (total > MAX_TOTAL_BYTES) throw new PrintRequestError('Attachments add up to more than 20 MB. Share a link to larger files instead.');
    return { name, buffer, kind: MODEL_EXTENSIONS.includes(ext) ? 'model' : 'photo' };
  });

  return {
    modelLink,
    quantity,
    size: text(input.size, 120, 'Size'),
    colors: text(input.colors, 120, 'Colors / material'),
    neededBy,
    files
  };
}

function summaryLines(inquiry, request) {
  return [
    `3D print request from ${inquiry.name} <${inquiry.email}>`,
    `Received: ${inquiry.createdAt}`,
    `Inquiry ID: ${inquiry.id}`,
    '',
    `Model link: ${request.modelLink || '-'}`,
    `Quantity: ${request.quantity}`,
    `Approximate size: ${request.size || '-'}`,
    `Colors / material: ${request.colors || '-'}`,
    `Needed by: ${request.neededBy || '-'}`,
    `Attachments: ${request.files.map(file => file.name).join(', ') || 'none'}`,
    '',
    'Message:',
    inquiry.message
  ];
}

// Writes the attachments and a request.txt summary into their own folder on
// the share. Returns the folder relative to the share, or '' if the share
// isn't writable (the inquiry itself is still saved and emailed).
function saveToShare(inquiry, request) {
  const day = inquiry.createdAt.slice(0, 10);
  const folder = `${day} ${safeName(inquiry.name)} ${inquiry.id.slice(0, 8)}`;
  const dir = path.join(REQUESTS_DIR, folder);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o2775 });
    for (const file of request.files) {
      // Two attachments with one name ("part.stl" twice) both survive.
      let target = path.join(dir, file.name);
      for (let n = 2; fs.existsSync(target); n++) {
        const { name, ext } = path.parse(file.name);
        target = path.join(dir, `${name} (${n})${ext}`);
      }
      fs.writeFileSync(target, file.buffer);
      fs.chmodSync(target, 0o664);
    }
    const summary = path.join(dir, 'request.txt');
    fs.writeFileSync(summary, `${summaryLines(inquiry, request).join('\r\n')}\r\n`);
    fs.chmodSync(summary, 0o664);
    return `_requests\\${folder}`;
  } catch (error) {
    console.error(`Print request ${inquiry.id}: could not save to the print share: ${error.message}`);
    return '';
  }
}

// What's stored with the inquiry and shown to the admin: the details, file
// names and sizes, and where the files landed -- not the file contents.
function describe(request, folder) {
  return {
    modelLink: request.modelLink,
    quantity: request.quantity,
    size: request.size,
    colors: request.colors,
    neededBy: request.neededBy,
    files: request.files.map(file => ({ name: file.name, kind: file.kind, bytes: file.buffer.length })),
    folder
  };
}

module.exports = { PrintRequestError, isPrintService, parsePrintRequest, saveToShare, describe };
