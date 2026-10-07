import { ChangeDetectionStrategy, ChangeDetectorRef, Component, Input, Output, EventEmitter, OnChanges, SimpleChanges, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { getApiBaseUrl } from '../media-url';

export type ShowcaseSite = { title: string; url: string };
type SafeShowcaseSite = ShowcaseSite & { safeUrl: SafeResourceUrl };

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
  // Set for services fulfilled somewhere other than this site's own contact
  // form -- e.g. an existing Etsy shop -- so "Learn more" can point straight
  // there instead of scrolling to the on-site inquiry form.
  link?: string;
  linkLabel?: string;
  // Shows the live Etsy shop listings (GET /api/etsy/listings) in place of the
  // image, falling back to it -- or to a shop link panel -- when there are none.
  etsyListings?: boolean;
};

export type EtsyListing = {
  id: string;
  title: string;
  price: number | null;
  currency: string;
  url: string;
  image: string;
  imageAlt: string;
};

// Shared across component instances: the Services page is re-created each
// time it's opened, and the listings only change when the shop does.
let etsyListingsRequest: Promise<EtsyListing[]> | null = null;

@Component({
  selector: 'app-services',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './services.component.html',
  styleUrl: './services.component.css'
})
export class ServicesComponent implements OnChanges {
  @Input() services: Service[] = [];
  @Input() activeService = 'Aerial';
  @Input() aerialVideos: string[] = [];
  @Input() websites: ShowcaseSite[] = [];
  @Output() serviceChange = new EventEmitter<string>();
  // Emits the service being viewed, preselected in the Book/Contact Us form.
  @Output() contactClick = new EventEmitter<string>();
  private readonly api = getApiBaseUrl();
  private aerialVideoIndex = 0;

  safeWebsites: SafeShowcaseSite[] = [];
  private websiteIndex = 0;
  // Whether the visitor has clicked into the current frame. It sits under a
  // shield until then, matching the Aerial video's page-one-at-a-time cycling
  // (‹ N/M ›) rather than a scrolling list, so the mouse wheel and arrow keys
  // move between sites instead of being swallowed by whichever page is loaded.
  interactingWithWebsite = false;

  constructor(
    private readonly changeDetector: ChangeDetectorRef,
    private readonly sanitizer: DomSanitizer
  ) {}

  etsyListings: EtsyListing[] = [];

  ngOnChanges(changes: SimpleChanges) {
    if (changes['services'] && this.services.some(service => service.etsyListings)) this.loadEtsyListings();
    if (changes['websites']) this.buildSafeWebsites();
    if (!changes['aerialVideos']) return;
    if (!this.aerialVideos.length) {
      this.aerialVideoIndex = 0;
      return;
    }
    this.aerialVideoIndex %= this.aerialVideos.length;
  }

  // Only https:// addresses are ever framed (the server enforces it too), and
  // each is trusted individually rather than bypassing sanitisation wholesale.
  private buildSafeWebsites() {
    this.websiteIndex = 0;
    this.interactingWithWebsite = false;
    this.safeWebsites = (this.websites || [])
      .filter(site => /^https:\/\//i.test(site.url))
      .map(site => ({ ...site, safeUrl: this.sanitizer.bypassSecurityTrustResourceUrl(site.url) }));
  }

  showsWebsites(service: Service) {
    return service.name === 'Websites' && this.safeWebsites.length > 0;
  }

  get activeWebsite(): SafeShowcaseSite | undefined {
    return this.safeWebsites[this.websiteIndex];
  }

  canCycleWebsites() {
    return this.safeWebsites.length > 1;
  }

  getWebsitePosition() {
    return this.websiteIndex + 1;
  }

  getWebsiteTotal() {
    return this.safeWebsites.length;
  }

  showPreviousWebsite() {
    if (this.safeWebsites.length < 2) return;
    this.websiteIndex = (this.websiteIndex - 1 + this.safeWebsites.length) % this.safeWebsites.length;
    this.interactingWithWebsite = false;
  }

  showNextWebsite() {
    if (this.safeWebsites.length < 2) return;
    this.websiteIndex = (this.websiteIndex + 1) % this.safeWebsites.length;
    this.interactingWithWebsite = false;
  }

  onServiceChange(serviceName: string) {
    this.interactingWithWebsite = false;
    this.serviceChange.emit(serviceName);
  }

  onLearnMoreClick() {
    this.contactClick.emit(this.activeService);
  }

  canCycleAerialVideos(service: Service) {
    return service.name === 'Aerial' && this.aerialVideos.length > 1;
  }

  getAerialVideoPosition() {
    return this.aerialVideoIndex + 1;
  }

  getAerialVideoTotal() {
    return this.aerialVideos.length;
  }

  getServiceMediaSource(service: Service) {
    if (service.name !== 'Aerial' || !this.aerialVideos.length) return service.image;
    return this.aerialVideos[this.aerialVideoIndex];
  }

  showPreviousAerialVideo() {
    if (this.aerialVideos.length < 2) return;
    this.aerialVideoIndex = (this.aerialVideoIndex - 1 + this.aerialVideos.length) % this.aerialVideos.length;
  }

  showNextAerialVideo() {
    if (this.aerialVideos.length < 2) return;
    this.aerialVideoIndex = (this.aerialVideoIndex + 1) % this.aerialVideos.length;
  }

  @HostListener('document:keydown', ['$event'])
  onDocumentKeydown(event: KeyboardEvent) {
    const cyclingAerial = this.canCycleActiveAerialVideos();
    const cyclingWebsites = this.activeService === 'Websites' && this.canCycleWebsites();
    if (!cyclingAerial && !cyclingWebsites) return;
    if (this.isTypingTarget(event.target)) return;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      cyclingAerial ? this.showPreviousAerialVideo() : this.showPreviousWebsite();
      return;
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      cyclingAerial ? this.showNextAerialVideo() : this.showNextWebsite();
    }
  }

  private canCycleActiveAerialVideos() {
    return this.activeService === 'Aerial' && this.aerialVideos.length > 1;
  }

  private isTypingTarget(target: EventTarget | null) {
    if (!(target instanceof HTMLElement)) return false;
    return !!target.closest('input, textarea, select, [contenteditable="true"]');
  }

  showsEtsyListings(service: Service): boolean {
    return Boolean(service.etsyListings) && this.etsyListings.length > 0;
  }

  formatEtsyPrice(listing: EtsyListing): string {
    if (listing.price === null) return '';
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: listing.currency || 'USD' }).format(listing.price);
  }

  private loadEtsyListings() {
    if (!etsyListingsRequest) {
      etsyListingsRequest = fetch(`${this.api}/etsy/listings`)
        .then(response => response.ok ? response.json() : { listings: [] })
        .then(body => Array.isArray(body?.listings) ? body.listings as EtsyListing[] : [])
        .catch(() => []);
      // A failed or empty load shouldn't stick for the whole visit.
      etsyListingsRequest.then(listings => { if (!listings.length) etsyListingsRequest = null; });
    }
    etsyListingsRequest.then(listings => {
      this.etsyListings = listings;
      this.changeDetector.markForCheck();
    });
  }
}
