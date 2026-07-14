import { ChangeDetectionStrategy, Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

export type ServiceTier = { label: string; price: string; details: string };
export type ServiceAddon = { label: string; price: string; details: string };
export type Service = {
  name: string;
  icon: string;
  title: string;
  text: string;
  image: string;
  mediaType?: 'image' | 'video';
  poster?: string;
  pricingTitle: string;
  tiers: ServiceTier[];
  addons: ServiceAddon[];
};

@Component({
  selector: 'app-services',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './services.component.html',
  styleUrl: './services.component.css'
})
export class ServicesComponent {
  @Input() services: Service[] = [];
  @Input() activeService = 'Aerial';
  @Output() serviceChange = new EventEmitter<string>();
  @Output() contactClick = new EventEmitter<void>();
  contact = { name: '', email: '', service: 'Aerial', message: '' };
  submitting = false;
  formSuccess = '';
  formError = '';
  private readonly api = 'http://localhost:3000/api';

  onServiceChange(serviceName: string) {
    this.serviceChange.emit(serviceName);
  }

  onLearnMoreClick() {
    this.contactClick.emit();
  }

  async onSubmitContact() {
    this.formError = '';
    this.formSuccess = '';
    this.submitting = true;
    try {
      const response = await fetch(`${this.api}/contact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.contact)
      });
      const body = await response.json();
      if (!response.ok) {
        this.formError = body.error || 'Could not send your inquiry right now.';
        this.submitting = false;
        return;
      }
      this.formSuccess = 'Thanks. Your inquiry has been sent. We will respond shortly.';
      this.contact = { name: '', email: '', service: this.services[0]?.name || 'Aerial', message: '' };
    } catch {
      this.formError = 'Network error. Please try again in a moment.';
    }
    this.submitting = false;
  }
}
