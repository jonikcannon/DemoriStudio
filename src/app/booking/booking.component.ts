import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

export type BookingSlot = {
  id: string;
  service: string;
  /** Calendar day, YYYY-MM-DD. One slot is one bookable start time on that day. */
  date: string;
  /** 24-hour HH:MM. Empty on slots published before booking moved to clock times. */
  startTime: string;
  endTime: string;
  approxDurationMinutes: number;
  location: string;
  /** All money is in cents, matching the API. */
  sessionFee: number;
  deposit: number;
  balanceDue: number;
};

export type BookingRequest = {
  slotId: string;
  name: string;
  email: string;
  phone: string;
  notes: string;
};

/** One published day, with every start time still open on it. */
type DayGroup = { date: string; label: string; slots: BookingSlot[] };

@Component({
  selector: 'app-booking',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './booking.component.html',
  styleUrl: './booking.component.css'
})
export class BookingComponent {
  @Input() slots: BookingSlot[] = [];
  @Input() loading = false;
  @Input() submitting = false;
  @Input() error = '';
  @Input() refundPolicy = '';
  @Input() holdMinutes = 15;
  @Output() book = new EventEmitter<BookingRequest>();
  @Output() enquire = new EventEmitter<void>();

  selectedSlotId = '';
  selectedDateInput = '';
  serviceFilter = 'all';
  calendarMonth = this.firstOfMonth(new Date());
  formError = '';
  form = { name: '', email: '', phone: '', notes: '' };

  get visibleSlots(): BookingSlot[] {
    if (this.serviceFilter === 'all') return this.slots;
    return this.slots.filter(slot => slot.service === this.serviceFilter);
  }

  get selectedSlot(): BookingSlot | null {
    return this.visibleSlots.find(slot => slot.id === this.selectedSlotId) || null;
  }

  get todayDateValue(): string {
    return this.toDateKey(new Date());
  }

  get serviceOptions(): string[] {
    return Array.from(new Set(this.slots.map(slot => slot.service))).sort((left, right) => left.localeCompare(right));
  }

  get calendarMonthLabel(): string {
    return this.parseDay(this.toDateKey(this.calendarMonth)).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  }

  get calendarDays(): Array<{ date: string | null; inMonth: boolean; slots: BookingSlot[]; available: boolean; selected: boolean }> {
    const monthStart = new Date(this.calendarMonth.getFullYear(), this.calendarMonth.getMonth(), 1);
    const firstWeekDay = monthStart.getDay();
    const start = new Date(monthStart);
    start.setDate(monthStart.getDate() - firstWeekDay);
    const days: Array<{ date: string | null; inMonth: boolean; slots: BookingSlot[]; available: boolean; selected: boolean }> = [];

    for (let index = 0; index < 42; index += 1) {
      const current = new Date(start);
      current.setDate(start.getDate() + index);
      const dateKey = this.toDateKey(current);
      const dateSlots = this.visibleSlots.filter(slot => slot.date === dateKey);
      days.push({
        date: dateKey,
        inMonth: current.getMonth() === monthStart.getMonth(),
        slots: dateSlots,
        available: dateSlots.length > 0,
        selected: this.selectedDateInput === dateKey
      });
    }
    return days;
  }

  /** The open start times on the chosen day, in clock order. */
  get timesForSelectedDate(): BookingSlot[] {
    if (!this.selectedDateInput) return [];
    return this.visibleSlots
      .filter(slot => slot.date === this.selectedDateInput)
      .sort((left, right) => String(left.startTime).localeCompare(String(right.startTime)));
  }

  // One entry per published day rather than per start time: with a full day of
  // sessions a flat list would run to dozens of near-identical cards.
  get dayGroups(): DayGroup[] {
    const groups = new Map<string, DayGroup>();
    for (const slot of this.visibleSlots) {
      if (!groups.has(slot.date)) groups.set(slot.date, { date: slot.date, label: this.formatDay(slot.date), slots: [] });
      groups.get(slot.date)!.slots.push(slot);
    }
    return Array.from(groups.values()).sort((left, right) => left.date.localeCompare(right.date));
  }

  // Dates are plain calendar days. Parsing them as local time avoids the
  // off-by-one that `new Date('2026-09-01')` causes by treating it as UTC.
  parseDay(date: string): Date {
    const [year, month, day] = String(date).split('-').map(Number);
    return new Date(year, (month || 1) - 1, day || 1);
  }

  private toDateKey(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  // Anchored to day 1 so `setMonth` can never overflow into the wrong month --
  // e.g. a Jan 31 anchor plus one month rolls over to Mar 3 in plain JS Date math.
  private firstOfMonth(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth(), 1);
  }

  formatDay(date: string): string {
    return this.parseDay(date).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  }

  formatMonth(date: string): string {
    return this.parseDay(date).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  }

  // Renders 24-hour "14:30" in the viewer's own convention, so a US visitor sees
  // 2:30 PM without the studio having to publish times twice.
  formatTime(time: string): string {
    if (!/^\d{2}:\d{2}$/.test(String(time || ''))) return '';
    const [hours, minutes] = time.split(':').map(Number);
    const at = new Date();
    at.setHours(hours, minutes, 0, 0);
    return at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  timeRange(slot: BookingSlot): string {
    const start = this.formatTime(slot.startTime);
    if (!start) return 'Time to be agreed';
    const end = this.formatTime(slot.endTime);
    return end ? `${start} – ${end}` : start;
  }

  money(cents: number): string {
    return `$${((Number(cents) || 0) / 100).toFixed(2)}`;
  }

  duration(minutes: number): string {
    if (!minutes) return '';
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `${hours}h ${rest}m` : `${hours}h`;
  }

  shiftCalendarMonth(offset: number) {
    this.calendarMonth = new Date(this.calendarMonth.getFullYear(), this.calendarMonth.getMonth() + offset, 1);
  }

  // Picking a day only opens that day's times -- the booking is not made until a
  // start time is chosen, so a stray click on the calendar cannot skip ahead to
  // the deposit form.
  selectCalendarDate(day: { date: string | null; slots: BookingSlot[] }) {
    if (!day.date || !day.slots.length) {
      this.formError = 'That date is not available for bookings yet.';
      return;
    }
    this.formError = '';
    this.selectedSlotId = '';
    this.selectedDateInput = day.date;
  }

  selectDateInput(date: string) {
    this.selectedDateInput = date;
    this.selectedSlotId = '';
    // Cleared up front so emptying the date input also clears a message left by
    // the previous pick, rather than leaving it stranded over a blank calendar.
    this.formError = '';
    if (!date) return;
    this.calendarMonth = this.firstOfMonth(this.parseDay(date));
    if (!this.visibleSlots.some(slot => slot.date === date)) {
      this.formError = 'No sessions are open on that date for the selected service.';
      this.selectedDateInput = '';
    }
  }

  onServiceFilterChange(value: string) {
    this.serviceFilter = value;
    this.selectedSlotId = '';
    this.selectedDateInput = '';
    this.formError = '';
    const firstAvailable = this.visibleSlots[0];
    if (firstAvailable) {
      this.calendarMonth = this.firstOfMonth(this.parseDay(firstAvailable.date));
    }
  }

  select(slot: BookingSlot) {
    this.selectedSlotId = slot.id;
    this.selectedDateInput = slot.date;
    this.formError = '';
  }

  // Drops back to the chosen day's times rather than all the way to an empty
  // calendar: someone changing their mind usually wants a different hour, not a
  // different month.
  cancel() {
    this.selectedSlotId = '';
    this.formError = '';
  }

  clearDate() {
    this.selectedSlotId = '';
    this.selectedDateInput = '';
    this.formError = '';
  }

  submit() {
    const slot = this.selectedSlot;
    if (!slot || this.submitting) return;
    const name = this.form.name.trim();
    const email = this.form.email.trim();
    if (name.length < 2) {
      this.formError = 'Please enter your name.';
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      this.formError = 'Please enter a valid email address.';
      return;
    }
    this.formError = '';
    this.book.emit({
      slotId: slot.id,
      name,
      email,
      phone: this.form.phone.trim(),
      notes: this.form.notes.trim()
    });
  }

  trackBySlot(_: number, slot: BookingSlot) {
    return slot.id;
  }

  trackByCalendarDay(_: number, day: { date: string | null }) {
    return day.date || `empty-${_}`;
  }

  trackByGroup(_: number, group: DayGroup) {
    return group.date;
  }
}
