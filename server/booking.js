// Self-serve session booking: published start times, deposit-confirmed
// reservations.
//
// Flow: the studio publishes a DAY and its open hours -> the server expands that
// into start times -> a client picks one and pays a deposit -> the Stripe
// webhook confirms it. The client commits to a clock time at checkout; the
// studio can still move a booked shoot afterwards via agreedTime, which is what
// absorbs the light, tide and travel that make a photography start time slip.
//
// Booking used to be day-level for exactly that reason, with the time agreed
// afterwards. It is now time-level so a day can carry several sessions and the
// client leaves checkout knowing when to turn up.
//
// Between picking and paying, a start time is HELD rather than booked, so two
// people cannot buy the same time while one is still on the Stripe page. An
// unpaid hold expires and the time returns to the pool.
//
// Concurrency note: hold/release/confirm do their read-modify-write with no
// await in between. Node runs one turn of the event loop at a time, so within a
// single process that sequence cannot interleave. PM2 runs this app in fork mode
// with one instance (scripts/deploy/ecosystem.config.cjs) -- if that ever becomes
// cluster mode or more than one instance, this needs a real lock, because two
// processes could each read "open" for the same start time.
//
// Session fees are set per slot rather than read from the services list, whose
// prices are display strings ("$6 each") with no machine-readable amount.

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const bookingDir = path.join(__dirname, '../storage/bookings');
const slotsFile = path.join(bookingDir, 'slots.jsonl');
const bookingsFile = path.join(bookingDir, 'bookings.jsonl');
const blocksFile = path.join(bookingDir, 'blocks.jsonl');

const SLOT = Object.freeze({ OPEN: 'open', HELD: 'held', BOOKED: 'booked', BLOCKED: 'blocked' });
const BOOKING = Object.freeze({ PENDING: 'pending', CONFIRMED: 'confirmed', CANCELLED: 'cancelled', EXPIRED: 'expired' });

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

// The studio publishes a day and its open hours; the server expands that into
// the individual start times clients can actually book. Expanding at publish
// time -- rather than computing the grid on every read -- keeps one slot row per
// bookable start, so the hold/book/release logic below still operates on a
// single row and needs no second store for per-time state.
const DEFAULT_SESSION_MINUTES = 120;
const DEFAULT_GAP_MINUTES = 30;
// A day cannot be carved into more starts than this. Guards against a typo like
// a 1-minute session turning one publish into thousands of rows.
const MAX_STARTS_PER_DAY = 48;

// Recurring unavailability: "Mon-Fri 09:00-17:00" for a day job, say. A block is
// a weekly rule rather than a row per date, so it keeps applying to months that
// have not been published yet.
//
// Blocks are applied in two places on purpose. publishDay skips blocked starts
// so they are never written, and listOpenSlots filters them so a block added
// later also hides sessions that were already published. Filtering at read
// affects only OPEN slots, so a block can never hide a session someone has
// already paid for -- those are the studio's problem to move by hand.
const WEEKDAY_NAMES = Object.freeze(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);

// Deposit is a share of the session fee, so it scales with the job instead of
// under-securing an expensive shoot.
const DEPOSIT_RATE = 0.25;

function depositFor(sessionFee) {
  const fee = Math.max(0, Math.round(Number(sessionFee) || 0));
  if (!fee) return 0;
  // Never round a deposit down to nothing on a paid session.
  return Math.max(100, Math.round(fee * DEPOSIT_RATE));
}

function holdMinutes() {
  const configured = Number(process.env.BOOKING_HOLD_MINUTES);
  return Number.isFinite(configured) && configured > 0 ? Math.round(configured) : 15;
}

// A cooling-off window measured from when the booking was made -- NOT a cutoff
// before the session. Customer-facing, so it is configuration rather than a
// constant buried in code.
function refundCutoffHours() {
  const configured = Number(process.env.BOOKING_REFUND_CUTOFF_HOURS);
  return Number.isFinite(configured) && configured >= 0 ? Math.round(configured) : 48;
}

function refundPolicyText() {
  const hours = refundCutoffHours();
  if (!hours) return 'Deposits are non-refundable.';
  return `Deposit is refundable if you cancel within ${hours} hours of booking. After that the deposit is retained.`;
}

// Calendar-day comparison, deliberately string-based. Slots are days, not
// instants, so converting to UTC could shift a date across midnight and hide or
// expose a day by one.
function today() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

function isPastDate(date) {
  return String(date || '') < today();
}

function toMinutes(time) {
  const [hours, minutes] = String(time || '').split(':').map(Number);
  return (hours * 60) + minutes;
}

function toTime(minutes) {
  const wrapped = Math.max(0, Math.round(minutes));
  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`;
}

// Sessions do not run past midnight: publishDay cannot generate one, so an
// overrun only comes from hand-edited data. Clamp rather than render "25:00".
function endTimeFor(startTime, sessionMinutes) {
  if (!TIME_PATTERN.test(String(startTime || ''))) return '';
  return toTime(Math.min(toMinutes(startTime) + (Number(sessionMinutes) || 0), (23 * 60) + 59));
}

// Start times run from the opening time until the last one whose session still
// finishes by closing time, spaced by the session plus the gap between shoots.
function generateStartTimes({ openTime, closeTime, sessionMinutes, gapMinutes }) {
  const open = toMinutes(openTime);
  const close = toMinutes(closeTime);
  const session = Math.round(Number(sessionMinutes) || 0);
  const gap = Math.max(0, Math.round(Number(gapMinutes) || 0));
  const times = [];
  for (let start = open; start + session <= close; start += session + gap) {
    times.push(toTime(start));
    if (times.length >= MAX_STARTS_PER_DAY) break;
  }
  return times;
}

// A start time is spent once it has passed, so today's earlier sessions drop off
// the list during the day rather than at midnight. Slots written before booking
// moved to clock times have no startTime; those stay day-level and only expire
// when the whole day has passed.
function isPastSlot(slot) {
  const date = String(slot?.date || '');
  if (date < today()) return true;
  if (date > today()) return false;
  const startTime = String(slot?.startTime || '');
  if (!TIME_PATTERN.test(startTime)) return false;
  const now = new Date();
  return toMinutes(startTime) <= (now.getHours() * 60) + now.getMinutes();
}

function ensureStore() {
  if (!fs.existsSync(bookingDir)) fs.mkdirSync(bookingDir, { recursive: true });
}

function readFile(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

function writeFile(file, rows) {
  ensureStore();
  const next = rows.map(row => JSON.stringify(row)).join('\n');
  fs.writeFileSync(file, next ? `${next}\n` : '', 'utf8');
}

const readSlots = () => readFile(slotsFile);
const readBookings = () => readFile(bookingsFile);
const readBlocks = () => readFile(blocksFile);
const writeSlots = rows => writeFile(slotsFile, rows);
const writeBookings = rows => writeFile(bookingsFile, rows);
const writeBlocks = rows => writeFile(blocksFile, rows);

function appendFileRow(file, row) {
  ensureStore();
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
  return row;
}

const appendSlot = slot => appendFileRow(slotsFile, slot);
const appendBooking = booking => appendFileRow(bookingsFile, booking);

// An abandoned Stripe page must not keep a day off the market forever. Sweeping
// on read means no timer is needed and a restart cannot lose pending releases.
function releaseExpiredHolds(now = Date.now()) {
  const slots = readSlots();
  const expired = slots.filter(slot => slot.status === SLOT.HELD && slot.holdUntil && Date.parse(slot.holdUntil) <= now);
  if (!expired.length) return { slots, released: 0 };

  const expiredIds = new Set(expired.map(slot => slot.id));
  const nextSlots = slots.map(slot => (
    expiredIds.has(slot.id)
      ? { ...slot, status: SLOT.OPEN, holdUntil: '', bookingId: '', updatedAt: new Date(now).toISOString() }
      : slot
  ));
  writeSlots(nextSlots);

  const affected = new Set(expired.map(slot => slot.bookingId).filter(Boolean));
  if (affected.size) {
    writeBookings(readBookings().map(booking => (
      affected.has(booking.id) && booking.status === BOOKING.PENDING
        ? { ...booking, status: BOOKING.EXPIRED, updatedAt: new Date(now).toISOString() }
        : booking
    )));
  }

  return { slots: nextSlots, released: expired.length };
}

function weekdayOf(date) {
  const [year, month, day] = String(date || '').split('-').map(Number);
  return new Date(year, (month || 1) - 1, day || 1).getDay();
}

function blockLabel(block) {
  const days = [...block.weekdays].sort().map(day => WEEKDAY_NAMES[day]).join(', ');
  return `${days} ${block.startTime}-${block.endTime}`;
}

function createBlock({ weekdays, startTime, endTime, reason = '' }) {
  const days = Array.from(new Set(
    (Array.isArray(weekdays) ? weekdays : [weekdays])
      .map(Number)
      .filter(day => Number.isInteger(day) && day >= 0 && day <= 6)
  ));
  if (!days.length) return { error: 'Pick at least one weekday to block.' };

  const from = String(startTime || '').trim();
  const to = String(endTime || '').trim();
  if (!TIME_PATTERN.test(from)) return { error: 'Block start must be a 24-hour time in HH:MM form.' };
  if (!TIME_PATTERN.test(to)) return { error: 'Block end must be a 24-hour time in HH:MM form.' };
  // A window that wraps past midnight would need splitting across two weekdays.
  // Ask for two blocks instead of silently getting the second day wrong.
  if (toMinutes(to) <= toMinutes(from)) {
    return { error: 'Block end must be after the start. For an overnight block, add one block per day.' };
  }

  const now = new Date().toISOString();
  return {
    block: appendFileRow(blocksFile, {
      id: randomUUID(),
      weekdays: days.sort(),
      startTime: from,
      endTime: to,
      reason: String(reason || '').trim().slice(0, 120),
      createdAt: now
    })
  };
}

function deleteBlock(blockId) {
  const blocks = readBlocks();
  if (!blocks.some(block => block.id === blockId)) return { error: 'Block not found.', status: 404 };
  writeBlocks(blocks.filter(block => block.id !== blockId));
  return { ok: true };
}

// True when a session on `date` running [startTime, endTime) touches any blocked
// window. Half-open on both sides, so a session ending exactly at 09:00 does not
// collide with a block starting at 09:00.
function isBlocked(date, startTime, endTime, blocks = readBlocks()) {
  if (!TIME_PATTERN.test(String(startTime || ''))) return false;
  const weekday = weekdayOf(date);
  const from = toMinutes(startTime);
  const to = TIME_PATTERN.test(String(endTime || '')) ? toMinutes(endTime) : from;
  return blocks.some(block => (
    Array.isArray(block.weekdays)
    && block.weekdays.includes(weekday)
    && from < toMinutes(block.endTime)
    && to > toMinutes(block.startTime)
  ));
}

function slotIsBlocked(slot, blocks) {
  return isBlocked(
    slot.date,
    slot.startTime,
    slot.endTime || endTimeFor(slot.startTime, slot.approxDurationMinutes),
    blocks
  );
}

function publicSlot(slot) {
  const deposit = depositFor(slot.sessionFee);
  const startTime = String(slot.startTime || '');
  return {
    id: slot.id,
    service: slot.service,
    date: slot.date,
    startTime,
    endTime: slot.endTime || endTimeFor(startTime, slot.approxDurationMinutes),
    approxDurationMinutes: slot.approxDurationMinutes || 0,
    location: slot.location || '',
    sessionFee: slot.sessionFee,
    deposit,
    balanceDue: Math.max(0, slot.sessionFee - deposit)
  };
}

// Only genuinely open start times still in the future are offered.
function listOpenSlots({ from = '', to = '', service = '' } = {}) {
  const { slots } = releaseExpiredHolds();
  const wantedService = String(service || '').trim().toLowerCase();
  const blocks = readBlocks();
  return slots
    .filter(slot => slot.status === SLOT.OPEN)
    .filter(slot => !isPastSlot(slot))
    .filter(slot => !slotIsBlocked(slot, blocks))
    .filter(slot => (!from || slot.date >= from) && (!to || slot.date <= to))
    .filter(slot => !wantedService || String(slot.service || '').toLowerCase() === wantedService)
    .sort((left, right) => (
      String(left.date).localeCompare(String(right.date))
      || String(left.startTime || '').localeCompare(String(right.startTime || ''))
    ))
    .map(publicSlot);
}

function findSlot(id) {
  return readSlots().find(slot => slot.id === String(id || '')) || null;
}

function findBooking(id) {
  return readBookings().find(booking => booking.id === String(id || '')) || null;
}

// Publishes one day's open hours and expands it into bookable start times.
// Re-publishing the same day is safe and additive: start times that already
// exist are skipped rather than duplicated, so widening a day's hours adds only
// the new sessions and never disturbs one that is already held or booked.
function publishDay({
  service,
  date,
  openTime,
  closeTime,
  sessionFee,
  sessionMinutes = DEFAULT_SESSION_MINUTES,
  gapMinutes = DEFAULT_GAP_MINUTES,
  location = ''
}) {
  if (!String(service || '').trim()) return { error: 'Service is required.' };
  const day = String(date || '').trim();
  if (!DATE_PATTERN.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00`))) {
    return { error: 'Date must be a calendar date in YYYY-MM-DD form.' };
  }
  if (isPastDate(day)) return { error: 'That date is in the past.' };

  const open = String(openTime || '').trim();
  const close = String(closeTime || '').trim();
  if (!TIME_PATTERN.test(open)) return { error: 'Opening time must be a 24-hour time in HH:MM form.' };
  if (!TIME_PATTERN.test(close)) return { error: 'Closing time must be a 24-hour time in HH:MM form.' };
  if (toMinutes(close) <= toMinutes(open)) return { error: 'Closing time must be after the opening time.' };

  const fee = Math.round(Number(sessionFee) || 0);
  if (!Number.isInteger(fee) || fee < 100) return { error: 'Session fee must be at least 100 (in cents).' };

  const session = Math.round(Number(sessionMinutes) || 0);
  if (session < 15 || session > 1440) return { error: 'Session length must be between 15 and 1440 minutes.' };
  const gap = Math.round(Number(gapMinutes) || 0);
  if (gap < 0 || gap > 1440) return { error: 'Gap between sessions must be between 0 and 1440 minutes.' };
  if (toMinutes(open) + session > toMinutes(close)) {
    return { error: 'A session of that length does not fit between the opening and closing times.' };
  }

  const starts = generateStartTimes({ openTime: open, closeTime: close, sessionMinutes: session, gapMinutes: gap });
  if (!starts.length) return { error: 'Those hours produce no bookable sessions.' };

  const serviceName = String(service).trim();
  const existing = new Set(
    readSlots()
      .filter(slot => slot.date === day && String(slot.service || '').toLowerCase() === serviceName.toLowerCase())
      .map(slot => String(slot.startTime || ''))
  );

  const blocks = readBlocks();
  const now = new Date().toISOString();
  const created = [];
  let skipped = 0;
  let blocked = 0;
  for (const startTime of starts) {
    if (existing.has(startTime)) { skipped += 1; continue; }
    // A start time earlier today is already gone; publishing it would create a
    // row that listOpenSlots immediately filters back out.
    if (isPastSlot({ date: day, startTime })) { skipped += 1; continue; }
    if (isBlocked(day, startTime, endTimeFor(startTime, session), blocks)) { blocked += 1; continue; }
    created.push(appendSlot({
      id: randomUUID(),
      service: serviceName,
      date: day,
      startTime,
      endTime: endTimeFor(startTime, session),
      sessionFee: fee,
      approxDurationMinutes: session,
      gapMinutes: gap,
      location: String(location || '').trim(),
      status: SLOT.OPEN,
      holdUntil: '',
      bookingId: '',
      createdAt: now,
      updatedAt: now
    }));
  }

  if (!created.length) {
    return {
      error: blocked
        ? `Every session in those hours is blocked, already published or has passed (${blocked} blocked).`
        : 'Every session in those hours is already published or has passed.'
    };
  }
  return { slots: created, created: created.length, skipped, blocked };
}

// Read-modify-write with no await inside, so the open -> held transition cannot
// interleave with another request in this process.
function holdSlot(slotId, { name, email, phone = '', notes = '' }) {
  releaseExpiredHolds();
  const slots = readSlots();
  const index = slots.findIndex(slot => slot.id === String(slotId || ''));
  if (index < 0) return { error: 'That session is no longer available.', status: 404 };

  const slot = slots[index];
  if (slot.status !== SLOT.OPEN) return { error: 'That time has just been taken. Please pick another.', status: 409 };
  if (isPastSlot(slot)) return { error: 'That time has already passed.', status: 409 };
  // A page loaded before the studio added a block would still offer this time.
  if (slotIsBlocked(slot)) return { error: 'That time is no longer available. Please pick another.', status: 409 };

  const now = new Date();
  const deposit = depositFor(slot.sessionFee);
  const booking = appendBooking({
    id: randomUUID(),
    slotId: slot.id,
    service: slot.service,
    date: slot.date,
    // The start time the client actually booked. agreedTime stays as the
    // studio's override for when a shoot is later moved by hand.
    startTime: String(slot.startTime || ''),
    endTime: String(slot.endTime || endTimeFor(slot.startTime, slot.approxDurationMinutes)),
    agreedTime: '',
    approxDurationMinutes: slot.approxDurationMinutes || 0,
    location: slot.location || '',
    name: String(name || '').trim(),
    email: String(email || '').trim(),
    phone: String(phone || '').trim(),
    notes: String(notes || '').trim().slice(0, 2000),
    status: BOOKING.PENDING,
    sessionFee: slot.sessionFee,
    deposit,
    balanceDue: Math.max(0, slot.sessionFee - deposit),
    // Frozen at booking time: changing the policy later must not rewrite the
    // terms this customer accepted.
    refundPolicy: refundPolicyText(),
    refundCutoffHours: refundCutoffHours(),
    orderId: '',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    confirmedAt: '',
    cancelledAt: ''
  });

  slots[index] = {
    ...slot,
    status: SLOT.HELD,
    holdUntil: new Date(now.getTime() + holdMinutes() * 60000).toISOString(),
    bookingId: booking.id,
    updatedAt: now.toISOString()
  };
  writeSlots(slots);
  return { booking, slot: slots[index] };
}

function updateBooking(id, updater) {
  const bookings = readBookings();
  const index = bookings.findIndex(booking => booking.id === id);
  if (index < 0) return null;
  bookings[index] = { ...updater({ ...bookings[index] }), updatedAt: new Date().toISOString() };
  writeBookings(bookings);
  return bookings[index];
}

function updateSlot(id, updater) {
  const slots = readSlots();
  const index = slots.findIndex(slot => slot.id === id);
  if (index < 0) return null;
  slots[index] = { ...updater({ ...slots[index] }), updatedAt: new Date().toISOString() };
  writeSlots(slots);
  return slots[index];
}

function attachOrder(bookingId, orderId) {
  return updateBooking(bookingId, booking => ({ ...booking, orderId: String(orderId || '') }));
}

// Idempotent: a webhook retry must not double-confirm. Returns null if already
// confirmed.
function confirmBooking(bookingId) {
  const booking = findBooking(bookingId);
  if (!booking || booking.status === BOOKING.CONFIRMED) return null;
  const confirmed = updateBooking(bookingId, current => ({
    ...current,
    status: BOOKING.CONFIRMED,
    confirmedAt: new Date().toISOString()
  }));
  // A paid deposit outranks an expired hold: take the day even if the sweep
  // already released it, rather than leaving a paid booking without a date.
  updateSlot(booking.slotId, slot => ({ ...slot, status: SLOT.BOOKED, holdUntil: '', bookingId }));
  return confirmed;
}

function setAgreedTime(bookingId, agreedTime) {
  return updateBooking(bookingId, booking => ({ ...booking, agreedTime: String(agreedTime || '').trim().slice(0, 120) }));
}

function cancelBooking(bookingId, { releaseSlot = true } = {}) {
  const booking = findBooking(bookingId);
  if (!booking) return null;
  const cancelled = updateBooking(bookingId, current => ({
    ...current,
    status: BOOKING.CANCELLED,
    cancelledAt: new Date().toISOString()
  }));
  if (releaseSlot) {
    updateSlot(booking.slotId, slot => ({ ...slot, status: SLOT.OPEN, holdUntil: '', bookingId: '' }));
  }
  return cancelled;
}

function deleteSlot(slotId) {
  const slots = readSlots();
  const slot = slots.find(entry => entry.id === slotId);
  if (!slot) return { error: 'Slot not found.', status: 404 };
  if (slot.status === SLOT.BOOKED) return { error: 'That date is booked. Cancel the booking first.', status: 409 };
  writeSlots(slots.filter(entry => entry.id !== slotId));
  return { ok: true };
}

// Whether the deposit is still refundable under the terms this booking was made
// under: a cooling-off window from when it was booked. Advisory only -- refunds
// are issued by hand in Stripe, never automatically.
function isRefundable(booking, now = Date.now()) {
  const hours = Number(booking?.refundCutoffHours);
  if (!Number.isFinite(hours) || hours === 0) return false;
  const bookedAt = Date.parse(booking?.confirmedAt || booking?.createdAt);
  if (!Number.isFinite(bookedAt)) return false;
  return now - bookedAt <= hours * 3600000;
}

module.exports = {
  SLOT,
  BOOKING,
  DEPOSIT_RATE,
  slotsFile,
  bookingsFile,
  blocksFile,
  WEEKDAY_NAMES,
  ensureStore,
  depositFor,
  holdMinutes,
  refundCutoffHours,
  refundPolicyText,
  today,
  isPastDate,
  isPastSlot,
  generateStartTimes,
  endTimeFor,
  releaseExpiredHolds,
  listOpenSlots,
  publicSlot,
  readSlots,
  readBookings,
  readBlocks,
  createBlock,
  deleteBlock,
  isBlocked,
  slotIsBlocked,
  blockLabel,
  weekdayOf,
  findSlot,
  findBooking,
  publishDay,
  holdSlot,
  attachOrder,
  updateBooking,
  updateSlot,
  confirmBooking,
  setAgreedTime,
  cancelBooking,
  deleteSlot,
  isRefundable
};
