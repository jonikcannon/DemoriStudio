import { ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, Input, OnChanges, SimpleChanges, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule, NgForm } from '@angular/forms';
import { getApiBaseUrl } from '../media-url';

const MAX_PRINT_FILES = 3;
const MAX_PRINT_BYTES = 20 * 1024 * 1024;

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

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
  // Extra details for a 3D-print request; sent only for that service.
  print = this.emptyPrint();
  files: File[] = [];
  readonly today = new Date().toISOString().slice(0, 10);
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

  get isPrintRequest(): boolean {
    return /3d\s*print/i.test(this.contact.service);
  }

  // Same limits the server enforces (server/print-requests.js), checked here
  // first so the visitor finds out before uploading.
  pickFiles(event: Event) {
    const input = event.target as HTMLInputElement;
    const picked = Array.from(input.files || []);
    input.value = '';
    const next = [...this.files, ...picked];
    this.formError = '';
    if (next.length > MAX_PRINT_FILES) {
      this.formError = `Attach at most ${MAX_PRINT_FILES} files.`;
      return;
    }
    if (next.reduce((sum, file) => sum + file.size, 0) > MAX_PRINT_BYTES) {
      this.formError = 'Attachments add up to more than 20 MB. Share a link to larger files instead.';
      return;
    }
    this.files = next;
  }

  removeFile(index: number) {
    this.files = this.files.filter((_, i) => i !== index);
  }

  formatSize(bytes: number): string {
    return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  async onSubmit() {
    this.formError = '';
    this.formSuccess = '';
    this.submitting = true;
    let sent = false;
    try {
      const printRequest = this.isPrintRequest
        ? {
            ...this.print,
            files: await Promise.all(this.files.map(async file => ({ name: file.name, data: toBase64(await file.arrayBuffer()) })))
          }
        : undefined;
      const response = await fetch(`${this.api}/contact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...this.contact, printRequest })
      });
      const body = await response.json();
      if (response.ok) {
        sent = true;
        this.formSuccess = this.isPrintRequest
          ? 'Thanks. Your print request has been sent. We will reply with a quote shortly.'
          : 'Thanks. Your inquiry has been sent. We will respond shortly.';
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
  private emptyPrint() {
    return { modelLink: '', quantity: 1, size: '', colors: '', neededBy: '' };
  }

  private resetForm() {
    this.print = this.emptyPrint();
    this.files = [];
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
