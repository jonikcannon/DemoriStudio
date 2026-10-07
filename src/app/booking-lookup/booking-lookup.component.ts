import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

/** The sanitized view the server returns for a customer's own booking (see publicBookingView in server/server.js). */
export type BookingLookupResult = {
  id: string;
  confirmationCode: string;
  service: string;
  date: string;
  startTime: string;
  endTime: string;
  agreedTime: string;
  status: string;
  name: string;
  email: string;
  location: string;
  sessionFee: number;
  deposit: number;
  balanceDue: number;
  balancePaid: boolean;
  refundPolicy: string;
  refundable: boolean;
};

@Component({
  selector: 'app-booking-lookup',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './booking-lookup.component.html',
  styleUrl: './booking-lookup.component.css'
})
export class BookingLookupComponent {
  @Input() loading = false;
  @Input() error = '';
  @Input() result: BookingLookupResult | null = null;
  @Input() payBalanceSubmitting = false;
  @Input() icsHref = '';

  @Output() lookup = new EventEmitter<{ email: string; confirmationCode: string }>();
  @Output() payBalance = new EventEmitter<void>();
  @Output() reset = new EventEmitter<void>();

  form = { email: '', confirmationCode: '' };

  submitLookup() {
    const email = this.form.email.trim();
    const confirmationCode = this.form.confirmationCode.trim();
    if (!email || !confirmationCode) return;
    this.lookup.emit({ email, confirmationCode });
  }

  startOver() {
    this.form = { email: '', confirmationCode: '' };
    this.reset.emit();
  }

  displayTime(booking: BookingLookupResult): string {
    return booking.agreedTime || booking.startTime || 'To be agreed';
  }

  money(cents: number): string {
    return `$${((Number(cents) || 0) / 100).toFixed(2)}`;
  }
}
