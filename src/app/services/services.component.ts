import { ChangeDetectionStrategy, ChangeDetectorRef, Component, Input, Output, EventEmitter, OnChanges, OnDestroy, SimpleChanges, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { getApiBaseUrl, mediaUrl } from '../media-url';

export type ShowcaseSite = { title: string; url: string; image?: string };

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
  // A published app shown in the media panel (icon, screenshots, store link).
  featuredApp?: FeaturedApp;
};

export type FeaturedApp = { name: string; tagline: string; url: string; store: string; icon: string; screenshots: string[] };

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

// One stacked <video> in the aerial crossfade. A new clip stays transparent
// until its first frame has loaded, so the previous clip keeps playing behind
// it instead of the panel flashing empty while the next one downloads.
type AerialLayer = { key: number; src: string; ready: boolean };
// Matches the opacity transition in services.component.css.
const AERIAL_FADE_MS = 700;

@Component({
  selector: 'app-services',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './services.component.html',
  styleUrl: './services.component.css'
})
export class ServicesComponent implements OnChanges, OnDestroy {
  @Input() services: Service[] = [];
  @Input() activeService = 'Aerial';
  @Input() aerialVideos: string[] = [];
  @Input() websites: ShowcaseSite[] = [];
  @Output() serviceChange = new EventEmitter<string>();
  // Emits the service being viewed, preselected in the Book/Contact Us form.
  @Output() contactClick = new EventEmitter<string>();
  private readonly api = getApiBaseUrl();
  private aerialVideoIndex = 0;
  aerialLayers: AerialLayer[] = [];
  private aerialLayerKey = 0;
  private aerialFadeTimer?: ReturnType<typeof setTimeout>;

  // One site at a time, paged like the Aerial videos (‹ N/M ›).
  showcaseSites: ShowcaseSite[] = [];
  private websiteIndex = 0;

  constructor(private readonly changeDetector: ChangeDetectorRef) {}

  etsyListings: EtsyListing[] = [];

  ngOnChanges(changes: SimpleChanges) {
    if (changes['services'] && this.services.some(service => service.etsyListings)) this.loadEtsyListings();
    if (changes['websites']) this.buildShowcaseSites();
    if (!changes['aerialVideos']) return;
    clearTimeout(this.aerialFadeTimer);
    if (!this.aerialVideos.length) {
      this.aerialVideoIndex = 0;
      this.aerialLayers = [];
      return;
    }
    this.aerialVideoIndex %= this.aerialVideos.length;
    // The first clip shows straight away (with its poster) rather than fading in.
    this.aerialLayers = [{ key: ++this.aerialLayerKey, src: this.aerialVideos[this.aerialVideoIndex], ready: true }];
  }

  ngOnDestroy() {
    clearTimeout(this.aerialFadeTimer);
  }

  // Shown as screenshot cards linking out, not live iframes: most sites
  // (demori-studios.com included) send X-Frame-Options and framed blank.
  private buildShowcaseSites() {
    this.websiteIndex = 0;
    this.showcaseSites = (this.websites || [])
      .filter(site => /^https:\/\//i.test(site.url))
      .map(site => ({ ...site, image: site.image ? mediaUrl(site.image) : '' }));
  }

  siteHost(site: ShowcaseSite): string {
    try {
      return new URL(site.url).hostname.replace(/^www\./, '');
    } catch {
      return site.url;
    }
  }

  showsWebsites(service: Service) {
    return service.name === 'Websites' && this.showcaseSites.length > 0;
  }

  get activeWebsite(): ShowcaseSite | undefined {
    return this.showcaseSites[this.websiteIndex];
  }

  canCycleWebsites() {
    return this.showcaseSites.length > 1;
  }

  getWebsitePosition() {
    return this.websiteIndex + 1;
  }

  getWebsiteTotal() {
    return this.showcaseSites.length;
  }

  showPreviousWebsite() {
    if (this.showcaseSites.length < 2) return;
    this.websiteIndex = (this.websiteIndex - 1 + this.showcaseSites.length) % this.showcaseSites.length;
  }

  showNextWebsite() {
    if (this.showcaseSites.length < 2) return;
    this.websiteIndex = (this.websiteIndex + 1) % this.showcaseSites.length;
  }

  onServiceChange(serviceName: string) {
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
    this.showAerialVideo((this.aerialVideoIndex - 1 + this.aerialVideos.length) % this.aerialVideos.length);
  }

  showNextAerialVideo() {
    if (this.aerialVideos.length < 2) return;
    this.showAerialVideo((this.aerialVideoIndex + 1) % this.aerialVideos.length);
  }

  // Stacks the new clip on top of whatever is on screen now. Clips skipped
  // past by clicking quickly are dropped before they finish loading, so only
  // the visible clip and the one being faded in are ever downloading.
  private showAerialVideo(index: number) {
    this.aerialVideoIndex = index;
    clearTimeout(this.aerialFadeTimer);
    const onScreen = [...this.aerialLayers].reverse().find(layer => layer.ready);
    this.aerialLayers = [
      ...(onScreen ? [onScreen] : []),
      { key: ++this.aerialLayerKey, src: this.aerialVideos[index], ready: false }
    ];
  }

  // Fired once the new clip has a frame to show (or failed to load, so a bad
  // file can't leave the old clip stuck on screen). Fades it in, then removes
  // the clips underneath once they're fully covered.
  onAerialLayerReady(layer: AerialLayer) {
    if (layer.ready || !this.aerialLayers.includes(layer)) return;
    this.aerialLayers = this.aerialLayers.map(item => item === layer ? { ...item, ready: true } : item);
    clearTimeout(this.aerialFadeTimer);
    this.aerialFadeTimer = setTimeout(() => {
      this.aerialLayers = this.aerialLayers.filter(item => item.key >= layer.key);
      this.changeDetector.markForCheck();
    }, AERIAL_FADE_MS);
  }

  trackAerialLayer(_: number, layer: AerialLayer) {
    return layer.key;
  }

  showsAerialStage(service: Service): boolean {
    return service.name === 'Aerial' && service.mediaType === 'video' && this.aerialLayers.length > 0;
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

  showsFeaturedApp(service: Service): boolean {
    return Boolean(service.featuredApp);
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
