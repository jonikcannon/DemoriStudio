import { ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, Input, OnChanges, SimpleChanges, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule, NgForm } from '@angular/forms';
import { getApiBaseUrl } from '../media-url';

// The project inquiry form (POST /api/contact). Lives on the Book/Contact Us
// page; the Services page links to it with the service being viewed
// preselected.
@Component({
  selector: 'app-contact-form',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './contact-form.component.html',
  styleUrl: './contact-form.component.css'
})
export class ContactFormComponent implements OnChanges {
  @Input() services: string[] = [];
  @Input() service = '';
  @ViewChild('contactForm') private contactForm?: NgForm;
  @ViewChild('successBanner') private successBanner?: ElementRef<HTMLElement>;
  contact = { name: '', email: '', service: '', message: '' };
  submitting = false;
  formSuccess = '';
  formError = '';
  private readonly api = getApiBaseUrl();

  constructor(private readonly changeDetector: ChangeDetectorRef) {}

  ngOnChanges(changes: SimpleChanges) {
    if (changes['service'] || changes['services']) {
      this.contact.service = this.services.includes(this.service) ? this.service : this.contact.service || this.services[0] || '';
    }
  }

  async onSubmit() {
    this.formError = '';
    this.formSuccess = '';
    this.submitting = true;
    let sent = false;
    try {
      const response = await fetch(`${this.api}/contact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.contact)
      });
      const body = await response.json();
      if (response.ok) {
        sent = true;
        this.formSuccess = 'Thanks. Your inquiry has been sent. We will respond shortly.';
        this.resetForm();
      } else {
        this.formError = body.error || 'Could not send your inquiry right now.';
      }
    } catch {
      this.formError = 'Network error. Please try again in a moment.';
    }
    this.submitting = false;
    this.changeDetector.markForCheck();
    if (sent) this.showSuccess();
  }

  // Resetting through NgForm, not just reassigning the model, also clears the
  // touched/dirty/submitted state so the emptied fields don't look half-filled.
  private resetForm() {
    this.contact = { name: '', email: '', service: this.contact.service, message: '' };
    this.contactForm?.resetForm(this.contact);
  }

  // Moves focus onto the confirmation so keyboard and screen-reader users land
  // on the result instead of the emptied form.
  private showSuccess() {
    this.changeDetector.detectChanges();
    const banner = this.successBanner?.nativeElement;
    if (!banner) return;
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    banner.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
    banner.focus({ preventScroll: true });
  }
}
