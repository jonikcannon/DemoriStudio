#!/usr/bin/env node
// Sync storage/media/<category>/ to a Cloudflare R2 bucket.
//
//   npm run media:sync -- --dry-run     preview, upload nothing
//   npm run media:sync                  upload new and changed files
//   npm run media:sync -- --prune       also delete objects with no local file
//
// Local disk stays the authoring master: drop files into a category folder,
// run this, and R2 mirrors it. Safe to re-run -- files whose size already
// matches the stored object are skipped, so an interrupted run resumes.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { resolveMediaDir } = require('./media-dir');
const {
  config, MEDIA_PREFIX, isR2Configured, createR2Client,
  toObjectKey, toPublicUrl, contentTypeFor
} = require('./r2');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const prune = args.includes('--prune');

// Files above this go up in parts rather than one request. The library handles
// the multipart lifecycle; several gallery videos are hundreds of MB.
const MULTIPART_THRESHOLD = 8 * 1024 * 1024;
const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;

function walk(dir, base = dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full, base));
    } else if (entry.isFile()) {
      out.push({ full, relative: path.relative(base, full), size: fs.statSync(full).size });
    }
  }
  return out;
}

async function listRemote(client) {
  const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
  const remote = new Map();
  let token;
  do {
    const page = await client.send(new ListObjectsV2Command({
      Bucket: config.bucket,
      Prefix: `${MEDIA_PREFIX}/`,
      ContinuationToken: token
    }));
    for (const obj of page.Contents || []) remote.set(obj.Key, obj.Size);
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return remote;
}

async function upload(client, file, key) {
  const { Upload } = require('@aws-sdk/lib-storage');
  const uploader = new Upload({
    client,
    params: {
      Bucket: config.bucket,
      Key: key,
      Body: fs.createReadStream(file.full),
      ContentType: contentTypeFor(file.full),
      // Media is immutable in practice: a changed photo gets a new filename.
      CacheControl: 'public, max-age=31536000, immutable'
    },
    partSize: MULTIPART_THRESHOLD,
    queueSize: 4
  });
  await uploader.done();
}

async function main() {
  if (!isR2Configured()) {
    console.error('R2 is not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,');
    console.error('R2_SECRET_ACCESS_KEY and R2_BUCKET in .env (see .env.example).');
    process.exit(1);
  }

  const mediaDir = resolveMediaDir();
  const files = walk(mediaDir).filter(f => !f.relative.endsWith('.gitkeep'));
  if (!files.length) {
    console.log(`No media found in ${mediaDir}. Nothing to sync.`);
    return;
  }

  const client = createR2Client();
  console.log(`Local : ${files.length} file(s), ${mb(files.reduce((n, f) => n + f.size, 0))}`);
  console.log(`Bucket: ${config.bucket} (prefix ${MEDIA_PREFIX}/)`);
  if (dryRun) console.log('DRY RUN - nothing will be uploaded.\n');

  const remote = await listRemote(client);
  console.log(`Remote: ${remote.size} existing object(s)\n`);

  let uploaded = 0, skipped = 0, failed = 0, bytes = 0;
  const localKeys = new Set();

  for (const file of files) {
    const key = toObjectKey(file.relative);
    localKeys.add(key);

    // Size match is the cheap proxy for "already uploaded". Sufficient here
    // because these files are write-once; a re-edit lands under a new name.
    if (remote.get(key) === file.size) {
      skipped++;
      continue;
    }

    const verb = remote.has(key) ? 'replace' : 'upload';
    if (dryRun) {
      console.log(`  [dry-run] ${verb} ${key} (${mb(file.size)})`);
      uploaded++;
      bytes += file.size;
      continue;
    }

    process.stdout.write(`  ${verb} ${key} (${mb(file.size)}) ... `);
    try {
      await upload(client, file, key);
      console.log('ok');
      uploaded++;
      bytes += file.size;
    } catch (error) {
      console.log(`FAILED: ${error.message || error}`);
      failed++;
    }
  }

  if (prune) {
    const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
    const orphans = [...remote.keys()].filter(key => !localKeys.has(key));
    for (const key of orphans) {
      if (dryRun) {
        console.log(`  [dry-run] delete ${key}`);
        continue;
      }
      process.stdout.write(`  delete ${key} ... `);
      try {
        await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
        console.log('ok');
      } catch (error) {
        console.log(`FAILED: ${error.message || error}`);
        failed++;
      }
    }
    if (orphans.length) console.log(`\n${orphans.length} orphaned object(s) handled.`);
  }

  console.log(`\nuploaded ${uploaded}  skipped ${skipped}  failed ${failed}  (${mb(bytes)} transferred)`);
  if (config.cdnUrl) {
    console.log(`\nPublic URL example:\n  ${toPublicUrl(toObjectKey(files[0].relative))}`);
    console.log('\nRegenerate the manifest so it points at the CDN:\n  npm run manifest');
  } else {
    console.log('\nMEDIA_CDN_URL is not set, so the app still serves media from local disk.');
    console.log('Set it to your R2 public domain, then run: npm run manifest');
  }
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error('Sync failed:', error.message || error);
  process.exit(1);
});
