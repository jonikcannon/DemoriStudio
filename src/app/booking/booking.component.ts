import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

export type BookingSlot = {
  id: string;
  service: string;
  /** Calendar day, YYYY-MM-DD. Sessions are booked by day; the start time is agreed afterwards. */
  date: string;
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
  preferredTime: string;
  notes: string;
};

type SlotGroup = { label: string; slots: BookingSlot[] };

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
  calendarMonth = new Date();
  formError = '';
  form = { name: '', email: '', phone: '', preferredTime: '', notes: '' };

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

  // Grouped by month so a long list of open days stays scannable.
  get slotGroups(): SlotGroup[] {
    const groups = new Map<string, SlotGroup>();
    for (const slot of this.visibleSlots) {
      const key = String(slot.date).slice(0, 7);
      if (!groups.has(key)) groups.set(key, { label: this.formatMonth(slot.date), slots: [] });
      groups.get(key)!.slots.push(slot);
    }
    return Array.from(groups.values());
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

  formatDay(date: string): string {
    return this.parseDay(date).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  }

  formatMonth(date: string): string {
    return this.parseDay(date).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
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
    const next = new Date(this.calendarMonth);
    next.setMonth(next.getMonth() + offset);
    this.calendarMonth = next;
  }

  selectCalendarDate(day: { date: string | null; slots: BookingSlot[] }) {
    if (!day.date || !day.slots.length) {
      this.formError = 'That date is not available for bookings yet.';
      return;
    }
    this.formError = '';
    this.select(day.slots[0]);
  }

  selectDateInput(date: string) {
    this.selectedDateInput = date;
    if (!date) {
      this.selectedSlotId = '';
      return;
    }
    this.calendarMonth = this.parseDay(date);
    const slot = this.visibleSlots.find(next => next.date === date) || null;
    if (!slot) {
      this.formError = 'No open booking is available on that date for the selected service.';
      this.selectedSlotId = '';
      return;
    }
    this.formError = '';
    this.select(slot);
  }

  onServiceFilterChange(value: string) {
    this.serviceFilter = value;
    this.selectedSlotId = '';
    this.selectedDateInput = '';
    this.formError = '';
    const firstAvailable = this.visibleSlots[0];
    if (firstAvailable) {
      this.calendarMonth = this.parseDay(firstAvailable.date);
    }
  }

  select(slot: BookingSlot) {
    this.selectedSlotId = slot.id;
    this.selectedDateInput = slot.date;
    this.formError = '';
  }

  cancel() {
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
      preferredTime: this.form.preferredTime.trim(),
      notes: this.form.notes.trim()
    });
  }

  trackBySlot(_: number, slot: BookingSlot) {
    return slot.id;
  }

  trackByCalendarDay(_: number, day: { date: string | null }) {
    return day.date || `empty-${_}`;
  }

  trackByGroup(_: number, group: SlotGroup) {
    return group.label;
  }
}
