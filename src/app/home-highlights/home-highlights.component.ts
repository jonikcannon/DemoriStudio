import { ChangeDetectionStrategy, ChangeDetectorRef, Component, EventEmitter, Input, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { getApiBaseUrl, mediaUrl } from '../media-url';
import { EtsyListing, FeaturedApp, Service, ShowcaseSite } from '../services/services.component';

// Home page sections below the statement: every service at a glance, recent
// projects (the featured app, the website showcase, live 3D-print listings),
// and a closing call to action. Everything shown comes from data the rest of
// the site already uses, so it stays in step with the admin edits.
@Component({
  selector: 'app-home-highlights',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './home-highlights.component.html',
  styleUrl: './home-highlights.component.css'
})
export class HomeHighlightsComponent implements OnInit {
  @Input() services: Service[] = [];
  @Input() websites: ShowcaseSite[] = [];
  @Input() etsyShopUrl = '';
  @Output() openService = new EventEmitter<string>();
  @Output() book = new EventEmitter<void>();
  @Output() contact = new EventEmitter<void>();

  etsyListings: EtsyListing[] = [];
  private readonly api = getApiBaseUrl();

  constructor(private readonly changeDetector: ChangeDetectorRef) {}

  ngOnInit() {
    fetch(`${this.api}/etsy/listings`)
      .then(response => (response.ok ? response.json() : { listings: [] }))
      .then(body => {
        this.etsyListings = Array.isArray(body?.listings) ? body.listings.slice(0, 4) : [];
        this.changeDetector.markForCheck();
      })
      .catch(() => undefined);
  }

  // "From $75" from the first tier's "$75 - $150" (or "$500+", "$7 each");
  // a price with no dollar amount, like "Priced per item", is shown as is.
  startingPrice(service: Service): string {
    const price = (service.tiers[0]?.price || '').trim();
    const amount = price.match(/^\$[\d,]+(\.\d+)?/);
    return amount ? `From ${amount[0]}` : price;
  }

  get featuredApp(): { service: Service; app: FeaturedApp } | null {
    const service = this.services.find(item => item.featuredApp);
    return service?.featuredApp ? { service, app: service.featuredApp } : null;
  }

  get featuredSite(): ShowcaseSite | null {
    const site = (this.websites || []).find(item => /^https:\/\//i.test(item.url));
    return site ? { ...site, image: site.image ? mediaUrl(site.image) : '' } : null;
  }

  get websitesService(): Service | undefined {
    return this.services.find(service => service.name === 'Websites');
  }

  get printService(): Service | undefined {
    return this.services.find(service => service.etsyListings);
  }

  host(url: string): string {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return url;
    }
  }

  formatPrice(listing: EtsyListing): string {
    if (listing.price === null) return '';
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: listing.currency || 'USD' }).format(listing.price);
  }

  trackByName(_: number, service: Service) {
    return service.name;
  }
}
