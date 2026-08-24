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
  formError = '';
  form = { name: '', email: '', phone: '', preferredTime: '', notes: '' };

  get selectedSlot(): BookingSlot | null {
    return this.slots.find(slot => slot.id === this.selectedSlotId) || null;
  }

  // Grouped by month so a long list of open days stays scannable.
  get slotGroups(): SlotGroup[] {
    const groups = new Map<string, SlotGroup>();
    for (const slot of this.slots) {
      const key = String(slot.date).slice(0, 7);
      if (!groups.has(key)) groups.set(key, { label: this.formatMonth(slot.date), slots: [] });
      groups.get(key)!.slots.push(slot);
    }
    return Array.from(groups.values());
  }

  // Dates are plain calendar days. Parsing them as local time avoids the
  // off-by-one that `new Date('2026-09-01')` causes by treating it as UTC.
  private parseDay(date: string): Date {
    const [year, month, day] = String(date).split('-').map(Number);
    return new Date(year, (month || 1) - 1, day || 1);
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

  select(slot: BookingSlot) {
    this.selectedSlotId = slot.id;
    this.formError = '';
  }

  cancel() {
    this.selectedSlotId = '';
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

  trackByGroup(_: number, group: SlotGroup) {
    return group.label;
  }
}
