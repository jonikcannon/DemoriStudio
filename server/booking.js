// Self-serve session booking: published days, deposit-confirmed reservations.
//
// Flow: the studio publishes available DAYS -> a client picks one, gives a
// preferred time and pays a deposit -> the Stripe webhook confirms it -> the
// exact start time is agreed afterwards. Slots are day-level on purpose: a
// shoot's real start depends on light, tide, travel and the client, so
// committing to a clock time at checkout would only create reschedules.
//
// Between picking and paying, a day is HELD rather than booked, so two people
// cannot buy the same day while one is still on the Stripe page. An unpaid hold
// expires and the day returns to the pool.
//
// Concurrency note: hold/release/confirm do their read-modify-write with no
// await in between. Node runs one turn of the event loop at a time, so within a
// single process that sequence cannot interleave. PM2 runs this app in fork mode
// with one instance (scripts/deploy/ecosystem.config.cjs) -- if that ever becomes
// cluster mode or more than one instance, this needs a real lock, because two
// processes could each read "open" for the same day.
//
// Session fees are set per slot rather than read from the services list, whose
// prices are display strings ("$6 each") with no machine-readable amount.

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const bookingDir = path.join(__dirname, '../storage/bookings');
const slotsFile = path.join(bookingDir, 'slots.jsonl');
const bookingsFile = path.join(bookingDir, 'bookings.jsonl');

const SLOT = Object.freeze({ OPEN: 'open', HELD: 'held', BOOKED: 'booked', BLOCKED: 'blocked' });
const BOOKING = Object.freeze({ PENDING: 'pending', CONFIRMED: 'confirmed', CANCELLED: 'cancelled', EXPIRED: 'expired' });

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

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
const writeSlots = rows => writeFile(slotsFile, rows);
const writeBookings = rows => writeFile(bookingsFile, rows);

function appendSlot(slot) {
  ensureStore();
  fs.appendFileSync(slotsFile, `${JSON.stringify(slot)}\n`, 'utf8');
  return slot;
}

function appendBooking(booking) {
  ensureStore();
  fs.appendFileSync(bookingsFile, `${JSON.stringify(booking)}\n`, 'utf8');
  return booking;
}

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

function publicSlot(slot) {
  const deposit = depositFor(slot.sessionFee);
  return {
    id: slot.id,
    service: slot.service,
    date: slot.date,
    approxDurationMinutes: slot.approxDurationMinutes || 0,
    location: slot.location || '',
    sessionFee: slot.sessionFee,
    deposit,
    balanceDue: Math.max(0, slot.sessionFee - deposit)
  };
}

// Only future, genuinely open days are offered.
function listOpenSlots({ from = '', to = '', service = '' } = {}) {
  const { slots } = releaseExpiredHolds();
  const wantedService = String(service || '').trim().toLowerCase();
  return slots
    .filter(slot => slot.status === SLOT.OPEN)
    .filter(slot => !isPastDate(slot.date))
    .filter(slot => (!from || slot.date >= from) && (!to || slot.date <= to))
    .filter(slot => !wantedService || String(slot.service || '').toLowerCase() === wantedService)
    .sort((left, right) => String(left.date).localeCompare(String(right.date)))
    .map(publicSlot);
}

function findSlot(id) {
  return readSlots().find(slot => slot.id === String(id || '')) || null;
}

function findBooking(id) {
  return readBookings().find(booking => booking.id === String(id || '')) || null;
}

function createSlot({ service, date, sessionFee, approxDurationMinutes = 0, location = '' }) {
  if (!String(service || '').trim()) return { error: 'Service is required.' };
  const day = String(date || '').trim();
  if (!DATE_PATTERN.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00`))) {
    return { error: 'Date must be a calendar date in YYYY-MM-DD form.' };
  }
  if (isPastDate(day)) return { error: 'That date is in the past.' };
  const fee = Math.round(Number(sessionFee) || 0);
  if (!Number.isInteger(fee) || fee < 100) return { error: 'Session fee must be at least 100 (in cents).' };
  const duration = Math.round(Number(approxDurationMinutes) || 0);
  if (duration && (duration < 15 || duration > 1440)) return { error: 'Approximate duration must be between 15 and 1440 minutes.' };

  const now = new Date().toISOString();
  return {
    slot: appendSlot({
      id: randomUUID(),
      service: String(service).trim(),
      date: day,
      sessionFee: fee,
      approxDurationMinutes: duration,
      location: String(location || '').trim(),
      status: SLOT.OPEN,
      holdUntil: '',
      bookingId: '',
      createdAt: now,
      updatedAt: now
    })
  };
}

// Read-modify-write with no await inside, so the open -> held transition cannot
// interleave with another request in this process.
function holdSlot(slotId, { name, email, phone = '', preferredTime = '', notes = '' }) {
  releaseExpiredHolds();
  const slots = readSlots();
  const index = slots.findIndex(slot => slot.id === String(slotId || ''));
  if (index < 0) return { error: 'That date is no longer available.', status: 404 };

  const slot = slots[index];
  if (slot.status !== SLOT.OPEN) return { error: 'That date has just been taken. Please pick another.', status: 409 };
  if (isPastDate(slot.date)) return { error: 'That date has already passed.', status: 409 };

  const now = new Date();
  const deposit = depositFor(slot.sessionFee);
  const booking = appendBooking({
    id: randomUUID(),
    slotId: slot.id,
    service: slot.service,
    date: slot.date,
    // The clock time is agreed after booking; this is the client's preference.
    preferredTime: String(preferredTime || '').trim().slice(0, 120),
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
  ensureStore,
  depositFor,
  holdMinutes,
  refundCutoffHours,
  refundPolicyText,
  today,
  isPastDate,
  releaseExpiredHolds,
  listOpenSlots,
  publicSlot,
  readSlots,
  readBookings,
  findSlot,
  findBooking,
  createSlot,
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
