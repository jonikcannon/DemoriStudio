// Minimal RFC 5545 .ics builder for confirmed bookings -- one VEVENT shape, no
// recurrence/attendees/alarms, so a small hand-rolled builder is simpler than
// pulling in a calendar library for it.
//
// DTSTART/DTEND are emitted as "floating" local date-times (no Z suffix, no
// TZID/VTIMEZONE): booking.date/startTime/endTime are already the studio's own
// wall-clock values ("9:00" on a calendar day), so this reproduces them as-is
// rather than converting through a server timezone that may not even match
// the shoot location's (a VPS commonly runs on UTC system time). A calendar
// app renders a floating time in the *viewer's own* local timezone, which is
// correct for the common case of a local client and is a deliberate
// simplification otherwise -- getting this exactly right for a remote client
// would need full IANA timezone/DST handling, which isn't worth it for a
// one-VEVENT-at-a-time feature.

function pad(n) {
  return String(n).padStart(2, '0');
}

// booking.date is YYYY-MM-DD, booking.startTime/endTime are 24-hour HH:MM --
// already the exact shape this needs, unlike a 12-hour "9:00 AM" string.
function toIcsDateTime(dateKey, time) {
  const [year, month, day] = String(dateKey || '').split('-').map(Number);
  const [hour, minute] = String(time || '00:00').split(':').map(Number);
  return `${year}${pad(month)}${pad(day)}T${pad(hour || 0)}${pad(minute || 0)}00`;
}

function toUtcStamp(date) {
  return `${date.toISOString().replace(/[-:]/g, '').split('.')[0]}Z`;
}

function escapeText(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

// RFC 5545 content lines over 75 octets should be folded with a leading space
// on each continuation line -- not critical for most readers, but keeps
// stricter parsers happy for a long SUMMARY/DESCRIPTION.
function foldLine(line) {
  if (line.length <= 75) return line;
  const parts = [];
  let rest = line;
  while (rest.length > 75) {
    parts.push(rest.slice(0, 75));
    rest = ` ${rest.slice(75)}`;
  }
  parts.push(rest);
  return parts.join('\r\n');
}

function buildEvent(booking) {
  // agreedTime wins over startTime, matching every other place this booking
  // is displayed: if the studio has already moved the shoot by hand, that is
  // the time the client needs on their calendar.
  const startTime = booking.agreedTime || booking.startTime || '09:00';
  const endTime = booking.endTime && !booking.agreedTime ? booking.endTime : '';

  const description = [
    `Session for ${booking.name || 'client'}`,
    booking.location ? `Location: ${booking.location}` : '',
    `Confirmation code: ${booking.confirmationCode || ''}`
  ].filter(Boolean).join('\n');

  return [
    'BEGIN:VEVENT',
    `UID:booking-${booking.id}@demori-studio`,
    `DTSTAMP:${toUtcStamp(new Date())}`,
    `DTSTART:${toIcsDateTime(booking.date, startTime)}`,
    endTime ? `DTEND:${toIcsDateTime(booking.date, endTime)}` : '',
    foldLine(`SUMMARY:${escapeText(`Demori Studio -- ${booking.service || 'Session'}`)}`),
    foldLine(`DESCRIPTION:${escapeText(description)}`),
    booking.location ? foldLine(`LOCATION:${escapeText(booking.location)}`) : '',
    'STATUS:CONFIRMED',
    'END:VEVENT'
  ].filter(Boolean).join('\r\n');
}

function buildCalendar(bookings, { calendarName = 'Demori Studio Bookings' } = {}) {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Demori Studio//Bookings//EN',
    'CALSCALE:GREGORIAN',
    `X-WR-CALNAME:${escapeText(calendarName)}`,
    bookings.map(buildEvent).join('\r\n'),
    'END:VCALENDAR'
  ].filter(Boolean).join('\r\n') + '\r\n';
}

module.exports = { buildEvent, buildCalendar };
