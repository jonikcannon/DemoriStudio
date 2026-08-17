import { Component, ElementRef, HostListener, OnInit, ViewChild, ChangeDetectorRef, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { WorkComponent } from './work/work.component';
import { GalleryComponent } from './gallery/gallery.component';
import { Service, ServicesComponent } from './services/services.component';
import { AboutComponent } from './about/about.component';
import { Product, ProductEditPayload, ProductOrderPayload, ProductsComponent } from './products/products.component';
import { CartComponent, CartItem } from './cart/cart.component';

type Work = { id?: string; image: string; title: string; type: string; size?: string; price?: number; mediaType?: 'image' | 'video' };
type GalleryItem = { category: string; title: string; image: string; mediaType: 'image' | 'video' };
type Inquiry = {
  id: string;
  name: string;
  email: string;
  service: string;
  message: string;
  status: 'new' | 'in-progress' | 'closed';
  createdAt: string;
  emailDelivered?: boolean;
};

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule, WorkComponent, GalleryComponent, ServicesComponent, AboutComponent, ProductsComponent, CartComponent],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css'
})
export class AppComponent implements OnInit {
  private readonly categoryOrder = ['Nature', 'Others', 'Beach', 'Hikes', 'Aerial'];
  menuOpen = false;
  showAll = false;
  activeService = 'Aerial';
  activeGallery = 'All';
  activeSection: 'home' | 'products' | 'gallery' | 'services' | 'about' | 'contact' = 'home';
  adminOpen = false;
  adminView: 'products' | 'inquiries' = 'products';
  private changeDetector: ChangeDetectorRef;
  private ngZone: NgZone;
  constructor(changeDetector: ChangeDetectorRef, ngZone: NgZone) {
    this.changeDetector = changeDetector;
    this.ngZone = ngZone;
  }
  uploadPreview = '';
  uploadFile?: File;
  product = { title: '', category: 'Print', price: 95, description: '' };
  adminEmail = '';
  adminPassword = '';
  adminToken = sessionStorage.getItem('demori_admin_token') || '';
  adminAuthProvider = sessionStorage.getItem('demori_admin_provider') || '';
  adminError = '';
  inquiries: Inquiry[] = [];
  inquiriesLoading = false;
  inquiriesError = '';
  inquirySearch = '';
  inquiryServiceFilter = 'all';
  inquiryStatusFilter: 'all' | 'new' | 'in-progress' | 'closed' = 'all';
  uploading = false;
  productsLoading = false;
  cartCheckingOut = false;
  cartFormError = '';
  digitalDeliveryEmail = '';
  deliveryUpdatesOptIn = false;
  isCartOpen = false;
  galleryLoading = true;
  galleryMediaLoaded = 0;
  galleryMediaTotal = 0;
  selectedMedia?: GalleryItem;
  isMediaViewerOpen = false;
  currentMediaIndex = -1;
  viewerVideoPlaying = false;
  aerialServiceVideos: string[] = [];
  promptDialogOpen = false;
  promptDialogTitle = '';
  promptDialogMessage = '';
  promptDialogMode: 'alert' | 'confirm' = 'alert';
  private promptDialogResolver?: (value: boolean) => void;
  galleryPrefetchCount = 0;
  private galleryPrefetchPending = false;
  galleryPrefetching = false;
  private readonly galleryPrefetchSize = 4;
  private readonly prefetchedMediaKeys = new Set<string>();
  @ViewChild('viewerVideo') viewerVideo?: ElementRef<HTMLVideoElement>;
  private readonly api = 'http://localhost:3000/api';
  private readonly productEditsStorageKey = 'demori_product_edits';
  private readonly hiddenProductImagesStorageKey = 'demori_hidden_product_images';
  private readonly digitalDeliveryEmailStorageKey = 'demori_digital_delivery_email';
  private readonly deliveryUpdatesOptInStorageKey = 'demori_delivery_updates_opt_in';
  private readonly defaultHiddenProductImageKeys = [
    'assets/gallery/about/20220706_152306.jpg'
  ];
  private readonly hiddenProductImageKeys = new Set<string>(this.defaultHiddenProductImageKeys);
  private galleryProductsReady = false;
  private apiProductsReady = false;
  private apiProducts: Product[] = [];
  private productEdits: Record<string, Omit<ProductEditPayload, 'id'>> = {};
  services: Service[] = [
    {
      name: 'Digital prints',
      icon: '▦',
      title: 'Digital printing from product gallery items',
      text: 'Select any published image from the Products page and order professional digital prints with consistent color, archival paper options, and batch-ready pricing.',
      image: 'assets/gallery/nature/20250814_164125.jpg',
      mediaType: 'image',
      pricingTitle: 'Comprehensive print pricing (up to 8 x 11)',
      tiers: [
        {
          label: '4 x 6 print',
          price: '$6 each',
          details: '10+ copies: $5 each, 25+ copies: $4.50 each, 50+ copies: $4 each.'
        },
        {
          label: '5 x 7 print',
          price: '$9 each',
          details: '10+ copies: $8 each, 25+ copies: $7 each, 50+ copies: $6.50 each.'
        },
        {
          label: '6 x 8 print',
          price: '$12 each',
          details: '10+ copies: $11 each, 25+ copies: $10 each, 50+ copies: $9 each.'
        },
        {
          label: '8 x 10 print',
          price: '$16 each',
          details: '10+ copies: $15 each, 25+ copies: $13.50 each, 50+ copies: $12 each.'
        },
        {
          label: '8 x 11 print',
          price: '$18 each',
          details: '10+ copies: $16.50 each, 25+ copies: $15 each, 50+ copies: $13.50 each.'
        }
      ],
      addons: [
        {
          label: 'Paper finish',
          price: 'Included',
          details: 'Choose matte, luster, or glossy at no additional cost.'
        },
        {
          label: 'Fine-art cotton paper upgrade',
          price: '+$4 per print',
          details: 'Available for 5 x 7 through 8 x 11 for gallery-grade output.'
        },
        {
          label: 'Color correction and retouch pass',
          price: '+$12 per image',
          details: 'One-time prep fee applied before bulk printing from the same image.'
        },
        {
          label: 'Rush turnaround (48 hours)',
          price: '+20% order total',
          details: 'Subject to production slot availability.'
        }
      ]
    },
    {
      name: 'Spaces',
      icon: '⌂',
      title: 'Residential real estate photography',
      text: 'MLS-ready interior and exterior coverage with consistent color, clean verticals, and agent-focused composition.',
      image: 'assets/gallery/beach/20260708_140401.jpg',
      mediaType: 'image',
      pricingTitle: 'Photo package strategy',
      tiers: [
        { label: 'Starter/Basic (Under 1,500 sq. ft.)', price: '$150 - $225', details: '15-20 edited photos.' },
        { label: 'Standard (1,500-3,000 sq. ft.)', price: '$230 - $300', details: '25-35 edited photos.' },
        { label: 'Premium (3,000-5,000+ sq. ft.)', price: '$325 - $500+', details: '40+ images, advanced editing, and property grounds coverage.' }
      ],
      addons: [
        { label: 'AI twilight conversion', price: '$15 / image', details: 'Day-to-twilight enhancement for premium listing images.' },
        { label: '3D virtual tour add-on', price: '$100 - $200', details: 'Interactive walkthrough depending on property layout.' }
      ]
    },
    {
      name: 'Aerial',
      icon: '✦',
      title: 'Drone photography and aerial coverage',
      text: 'FAA-compliant aerial captures that highlight lot lines, neighborhood context, rooflines, and estate scale.',
      image: 'assets/gallery/aerial/dji_fly_20260709_091946_0027_1783650449096_slowmotion.mp4',
      mediaType: 'video',
      poster: 'assets/gallery/aerial/dji_fly_20260709_092240_0032_1783650435377_photo_beautify.jpg',
      pricingTitle: 'Drone pricing strategy',
      tiers: [
        { label: 'Drone add-on to photo shoot', price: '$75 - $150', details: 'Adds 5-15 aerial images to a ground package.' },
        { label: 'Standalone aerial package', price: '$250 - $400', details: 'Dedicated flight for boundaries, roofs, or land context.' },
        { label: 'Commercial aerial hourly', price: '$150 - $300 / hour', details: 'Professional pilot time including flight planning and post.' }
      ],
      addons: [
        { label: 'Boundary mapping stills', price: 'Quoted per site', details: 'Overlay-ready orientation shots for larger parcels.' },
        { label: 'Construction progress revisit', price: 'Quoted per cadence', details: 'Scheduled repeat flights for project tracking.' }
      ]
    },
    {
      name: 'Portraits',
      icon: '◌',
      title: 'Outdoor portraits and personal branding',
      text: 'Natural-light portrait sessions for professionals, creatives, and personal brands with clean direction, relaxed pacing, and polished final edits.',
      image: 'assets/outdoor portrait.png',
      mediaType: 'image',
      pricingTitle: 'Portrait session pricing',
      tiers: [
        { label: 'Mini session', price: '$175 - $250', details: '20-30 minute outdoor session with 8 edited images.' },
        { label: 'Signature session', price: '$300 - $450', details: '60-minute session with multiple looks and 20 edited images.' },
        { label: 'Branding session', price: '$500+', details: 'Extended portrait coverage for teams, entrepreneurs, and campaign use.' }
      ],
      addons: [
        { label: 'Additional retouched images', price: '$15 / image', details: 'Expanded final gallery beyond the included delivery count.' },
        { label: 'Rush turnaround', price: '$75', details: '48-hour edit delivery for time-sensitive announcements or campaigns.' }
      ]
    }
  ];
  work: Work[] = [
    { title: 'Headland House', type: 'Aerial', size: 'tall', image: 'https://images.unsplash.com/photo-1494526585095-c41746248156?auto=format&fit=crop&w=1100&q=85' },
    { title: 'Quiet Morning', type: 'Portraits', image: 'https://images.unsplash.com/photo-1524504388940-b1c1722653e1?auto=format&fit=crop&w=1100&q=85' },
    { title: 'Salt & Stone', type: 'Spaces', image: 'https://images.unsplash.com/photo-1600585154340-be6161a56a0c?auto=format&fit=crop&w=1100&q=85' },
    { title: 'The Long Road', type: 'Aerial', image: 'https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?auto=format&fit=crop&w=1100&q=85' },
    { title: 'Summer Ceremony', type: 'Portraits', image: 'https://images.unsplash.com/photo-1519741497674-611481863552?auto=format&fit=crop&w=1100&q=85' },
    { title: 'A Place To Gather', type: 'Spaces', image: 'https://images.unsplash.com/photo-1600566753086-00f18fb6b3ea?auto=format&fit=crop&w=1100&q=85' }
  ];
  products: Product[] = [];
  cart: CartItem[] = [];
  gallery: GalleryItem[] = [];
  get visibleWork() { return this.showAll ? this.work : this.work.slice(0, 4); }
  get visibleGallery() { return this.getVisibleGalleryItems(); }
  get visibleCatalogCategories() {
    return this.catalogCategories;
  }
  get catalogCategories() {
    const categories = Array.from(new Set(this.gallery
      .filter(item => item.mediaType === 'image')
      .map(item => item.category)));
    const orderedCategories = this.categoryOrder.filter(category => categories.includes(category));
    const remainingCategories = categories
      .filter(category => !this.categoryOrder.includes(category))
      .sort((left, right) => left.localeCompare(right));
    return ['All', ...orderedCategories, ...remainingCategories];
  }
  get editableCategoryOptions() {
    return this.catalogCategories.filter(category => category !== 'All');
  }
  get visibleProducts() {
    return this.products.filter(product => {
      if (this.activeGallery === 'All') return true;
      const category = this.getGalleryCategoryByProductImage(product.image);
      return category === this.activeGallery;
    });
  }
  get canManageProducts() { return !!this.adminToken && this.adminAuthProvider === 'google'; }
  get cartCount() { return this.cart.reduce((total, item) => total + item.quantity, 0); }
  get activeCartItems() { return this.cart.filter(item => item.quantity > 0); }
  get activeCartCount() { return this.activeCartItems.reduce((total, item) => total + item.quantity, 0); }
  get cartTotal() { return this.cart.reduce((total, item) => total + item.price * item.quantity, 0); }
  get hasDigitalItemsInCart() { return this.activeCartItems.some(item => item.orderType === 'digital'); }
  get inquiryServiceOptions() { return Array.from(new Set(this.inquiries.map(inquiry => inquiry.service))).sort((a, b) => a.localeCompare(b)); }
  get filteredInquiries() {
    const search = this.inquirySearch.trim().toLowerCase();
    return this.inquiries.filter(inquiry => {
      if (this.inquiryServiceFilter !== 'all' && inquiry.service !== this.inquiryServiceFilter) return false;
      if (this.inquiryStatusFilter !== 'all' && inquiry.status !== this.inquiryStatusFilter) return false;
      if (!search) return true;
      return [inquiry.name, inquiry.email, inquiry.message].some(field => field.toLowerCase().includes(search));
    });
  }
  ngOnInit(): void {
    this.loadStoredProductEdits();
    this.loadStoredHiddenProductImages();
    this.loadStoredDeliveryPreferences();
    void this.loadGallery();
    void this.loadProducts();
    this.initGoogleSignIn();
  }
  private loadStoredDeliveryPreferences() {
    try {
      const storedEmail = localStorage.getItem(this.digitalDeliveryEmailStorageKey);
      if (storedEmail) this.digitalDeliveryEmail = storedEmail;
      const storedOptIn = localStorage.getItem(this.deliveryUpdatesOptInStorageKey);
      this.deliveryUpdatesOptIn = storedOptIn === 'true';
    } catch {
      this.digitalDeliveryEmail = '';
      this.deliveryUpdatesOptIn = false;
    }
  }
  private initGoogleSignIn() {
    const w = window as any;
    if (!w.google?.accounts?.id) {
      setTimeout(() => this.initGoogleSignIn(), 100);
      return;
    }
    w.google.accounts.id.initialize({
      client_id: '352038115250-io37tumi7dseohtgklrlg435vpj2qddb.apps.googleusercontent.com',
      callback: (response: any) => this.handleGoogleResponse(response)
    });
  }
  private openPromptDialog(message: string, title: string, mode: 'alert' | 'confirm'): Promise<boolean> {
    this.promptDialogTitle = title;
    this.promptDialogMessage = message;
    this.promptDialogMode = mode;
    this.promptDialogOpen = true;
    return new Promise(resolve => {
      this.promptDialogResolver = resolve;
    });
  }
  private showNotice(message: string, title = 'Notice') {
    return this.openPromptDialog(message, title, 'alert').then(() => undefined);
  }
  private requestConfirmation(message: string, title = 'Confirm action') {
    return this.openPromptDialog(message, title, 'confirm');
  }
  onPromptDialogCancel() {
    if (!this.promptDialogOpen) return;
    this.promptDialogOpen = false;
    const resolver = this.promptDialogResolver;
    this.promptDialogResolver = undefined;
    resolver?.(false);
  }
  onPromptDialogConfirm() {
    if (!this.promptDialogOpen) return;
    this.promptDialogOpen = false;
    const resolver = this.promptDialogResolver;
    this.promptDialogResolver = undefined;
    resolver?.(true);
  }
  private handleGoogleResponse(response: any) {
    if (response.credential) {
      this.ngZone.run(() => {
        void this.googleLogin(response.credential);
      });
    }
  }
  renderGoogleSignInButton(containerId: string) {
    const w = window as any;
    if (w.google?.accounts?.id) {
      w.google.accounts.id.renderButton(
        document.getElementById(containerId),
        { theme: 'outline', size: 'large', width: '100%' }
      );
    }
  }
  private async loadGallery() {
    this.galleryLoading = true;
    this.galleryMediaLoaded = 0;
    this.galleryMediaTotal = 0;
    this.resetGalleryPrefetch();
    try {
      const response = await fetch('assets/gallery/gallery-manifest.json', { cache: 'no-store' });
      if (!response.ok) throw new Error('Gallery manifest unavailable');
      this.gallery = await response.json() as GalleryItem[];
      this.syncAerialServiceMedia();
    } catch { this.gallery = []; }
    this.galleryProductsReady = true;
    this.rebuildProducts();
    this.resetGalleryLoading();
    this.queueGalleryPrefetch();
  }
  private syncAerialServiceMedia() {
    this.aerialServiceVideos = this.gallery
      .filter(item => item.category === 'Aerial' && item.mediaType === 'video')
      .map(item => item.image);
    if (!this.aerialServiceVideos.length) return;
    const aerialService = this.services.find(service => service.name === 'Aerial');
    if (!aerialService) return;
    aerialService.mediaType = 'video';
    aerialService.image = this.aerialServiceVideos[0];
  }
  private getVisibleGalleryItems() { return this.activeGallery === 'All' ? this.gallery : this.gallery.filter(item => item.category === this.activeGallery); }
  private slugify(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'item';
  }
  private buildSku(prefix: string, title: string, category: string, seed: string): string {
    const categoryPart = this.slugify(category).slice(0, 8).toUpperCase();
    const titlePart = this.slugify(title).slice(0, 12).toUpperCase();
    const seedPart = this.slugify(seed).replace(/-/g, '').slice(-6).toUpperCase() || '000000';
    return `${prefix}-${categoryPart}-${titlePart}-${seedPart}`;
  }
  private normalizeProduct(raw: any): Product {
    const resolvedImage = String(raw.image || '');
    const resolvedMediaType = String(raw.mediaType || '').toLowerCase() === 'video' || /\.mp4(\?|$)/i.test(resolvedImage)
      ? 'video'
      : 'image';
    return {
      id: String(raw.id || ''),
      sku: String(raw.sku || this.buildSku('DMR', String(raw.title || 'Untitled'), String(raw.category || 'Digital'), String(raw.id || raw.image || ''))),
      title: String(raw.title || 'Untitled'),
      category: String(raw.category || 'Digital download'),
      description: typeof raw.description === 'string' ? raw.description : '',
      details: '',
      image: resolvedImage,
      mediaType: resolvedMediaType,
      price: typeof raw.price === 'number' ? Math.round(raw.price / 100) : 20,
      checkoutEnabled: true
    };
  }
  private makeGalleryProductId(item: GalleryItem): string {
    return `gallery-${item.category}-${item.title}-${item.image}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }
  private buildGalleryProducts(): Product[] {
    return this.gallery
      .filter(item => !this.isHiddenProductImage(item.image))
      .map(item => ({
        id: this.makeGalleryProductId(item),
        sku: this.buildSku('DMR', item.title, item.category, item.image),
        title: item.title,
        category: item.mediaType === 'video' ? `${item.category} video lease` : `${item.category} digital image`,
        description: item.mediaType === 'video' ? 'Video lease license.' : '',
        details: '',
        image: item.image,
        mediaType: item.mediaType,
        price: item.mediaType === 'video' ? 100 : 20,
        checkoutEnabled: false
      }));
  }
  private applyProductEdit(product: Product): Product {
    const edits = this.productEdits[product.id];
    if (!edits) return product;
    return {
      ...product,
      title: edits.title || product.title,
      category: edits.category || product.category,
      description: edits.description || '',
      details: edits.details || '',
      price: edits.price > 0 ? Math.round(edits.price) : product.price
    };
  }
  private getProductImageKey(image: string): string {
    const strippedProtocol = image.replace(/^https?:\/\/[^/]+\/?/i, '');
    return strippedProtocol.replace(/^\/+/, '').toLowerCase();
  }
  private getGalleryCategoryByProductImage(image: string): string {
    const imageKey = this.getProductImageKey(image);
    const match = this.gallery.find(item => this.getProductImageKey(item.image) === imageKey);
    return match?.category || '';
  }
  private isGalleryImagePath(image: string): boolean {
    return this.getProductImageKey(image).startsWith('assets/gallery/');
  }
  private isHiddenProductImage(image: string): boolean {
    return this.hiddenProductImageKeys.has(this.getProductImageKey(image));
  }
  private rebuildProducts() {
    const galleryProducts = this.buildGalleryProducts();
    const apiImageProducts = this.apiProducts.filter(product => product.image && !this.isHiddenProductImage(product.image));
    const merged = new Map<string, Product>();
    galleryProducts.forEach(product => merged.set(this.getProductImageKey(product.image), product));
    apiImageProducts.forEach(product => merged.set(this.getProductImageKey(product.image), product));
    this.products = Array.from(merged.values()).map(product => this.applyProductEdit(product));
    this.productsLoading = !(this.galleryProductsReady && this.apiProductsReady);
  }
  private loadStoredProductEdits() {
    try {
      const stored = localStorage.getItem(this.productEditsStorageKey);
      if (!stored) return;
      const parsed = JSON.parse(stored) as Record<string, Omit<ProductEditPayload, 'id'>>;
      this.productEdits = parsed || {};
    } catch {
      this.productEdits = {};
    }
  }
  private saveStoredProductEdits() {
    localStorage.setItem(this.productEditsStorageKey, JSON.stringify(this.productEdits));
  }
  private loadStoredHiddenProductImages() {
    this.hiddenProductImageKeys.clear();
    this.defaultHiddenProductImageKeys.forEach(image => this.hiddenProductImageKeys.add(this.getProductImageKey(image)));
    try {
      const stored = localStorage.getItem(this.hiddenProductImagesStorageKey);
      if (!stored) return;
      const parsed = JSON.parse(stored) as string[];
      if (!Array.isArray(parsed)) return;
      parsed
        .filter(value => typeof value === 'string' && value.trim().length > 0)
        .forEach(value => this.hiddenProductImageKeys.add(this.getProductImageKey(value)));
    } catch {
      // Keep defaults only when storage is unavailable or malformed.
    }
  }
  private saveStoredHiddenProductImages() {
    const values = Array.from(this.hiddenProductImageKeys);
    localStorage.setItem(this.hiddenProductImagesStorageKey, JSON.stringify(values));
  }
  trackByCategory(_: number, category: string) { return category; }
  trackByProduct(_: number, product: Product) { return product.id; }
  trackByInquiry(_: number, inquiry: Inquiry) { return inquiry.id; }
  trackByCartItem(_: number, item: CartItem) { return item.cartItemId; }
  trackByGalleryItem(_: number, item: GalleryItem) { return item.image; }
  trackByWorkItem(_: number, item: Work) { return item.id || item.image; }
  private async loadProducts() {
    this.apiProductsReady = false;
    this.productsLoading = true;
    try {
      const response = await fetch(`${this.api}/products`);
      if (!response.ok) throw new Error('Products unavailable');
      const rawProducts = await response.json() as unknown[];
      this.apiProducts = rawProducts
        .map(item => this.normalizeProduct(item))
        .filter(product => product.id && product.image);
    } catch {
      this.apiProducts = [];
    }
    this.apiProductsReady = true;
    this.rebuildProducts();
  }
  private resetGalleryLoading() {
    const visibleItems = this.getVisibleGalleryItems();
    this.galleryMediaTotal = Math.max(visibleItems.length, 1);
    this.galleryMediaLoaded = 0;
    this.galleryLoading = this.galleryMediaTotal > 0;
  }
  changeGalleryCategory(category: string) {
    this.activeGallery = category;
  }
  onMediaLoaded() {
    if (!this.galleryLoading) return;
    this.galleryMediaLoaded += 1;
    if (this.galleryMediaLoaded >= Math.min(this.galleryMediaTotal, 4)) {
      this.galleryLoading = false;
    }
  }
  private resetGalleryPrefetch() {
    this.galleryPrefetchCount = 0;
    this.galleryPrefetchPending = false;
    this.galleryPrefetching = false;
    this.prefetchedMediaKeys.clear();
  }
  private queueGalleryPrefetch() {
    if (!this.gallery.length || this.galleryPrefetchPending) return;
    this.galleryPrefetchPending = true;
    this.galleryPrefetching = true;
    window.setTimeout(() => {
      this.prefetchGalleryMedia();
      this.galleryPrefetchPending = false;
      this.galleryPrefetching = false;
    }, 150);
  }
  private prefetchGalleryMedia() {
    if (!this.gallery.length) return;
    const gallerySection = document.getElementById('gallery');
    const nearGalleryBottom = !gallerySection || window.innerHeight + window.scrollY >= gallerySection.offsetTop + gallerySection.offsetHeight - 900;
    if (!nearGalleryBottom) return;
    const items = this.getVisibleGalleryItems();
    const nextItems = items.slice(this.galleryPrefetchCount, this.galleryPrefetchCount + this.galleryPrefetchSize);
    if (!nextItems.length) {
      this.galleryPrefetching = false;
      return;
    }
    nextItems.forEach(item => {
      const cacheKey = `${item.category}-${item.title}-${item.image}`;
      if (this.prefetchedMediaKeys.has(cacheKey)) return;
      this.prefetchedMediaKeys.add(cacheKey);
      if (item.mediaType === 'image') {
        const img = new Image();
        img.decoding = 'async';
        img.src = item.image;
      } else {
        const video = document.createElement('video');
        video.preload = 'metadata';
        video.src = item.image;
      }
    });
    this.galleryPrefetchCount += nextItems.length;
  }
  openMedia(item: GalleryItem) {
    const items = this.getVisibleGalleryItems();
    const index = items.findIndex(media => media.title === item.title && media.image === item.image);
    this.selectedMedia = item;
    this.currentMediaIndex = index;
    this.viewerVideoPlaying = false;
    this.isMediaViewerOpen = true;
  }
  openProductMedia(item: Product) {
    this.selectedMedia = {
      category: item.category,
      title: item.title,
      image: item.image,
      mediaType: item.mediaType
    };
    this.currentMediaIndex = -1;
    this.viewerVideoPlaying = false;
    this.isMediaViewerOpen = true;
  }
  closeMediaViewer() {
    this.selectedMedia = undefined;
    this.currentMediaIndex = -1;
    this.viewerVideoPlaying = false;
    this.isMediaViewerOpen = false;
  }
  showPreviousMedia() {
    if (!this.isMediaViewerOpen) return;
    const items = this.getVisibleGalleryItems();
    if (!items.length) return;
    const nextIndex = this.currentMediaIndex <= 0 ? items.length - 1 : this.currentMediaIndex - 1;
    this.selectedMedia = items[nextIndex];
    this.currentMediaIndex = nextIndex;
    this.viewerVideoPlaying = false;
  }
  showNextMedia() {
    if (!this.isMediaViewerOpen) return;
    const items = this.getVisibleGalleryItems();
    if (!items.length) return;
    const nextIndex = (this.currentMediaIndex + 1) % items.length;
    this.selectedMedia = items[nextIndex];
    this.currentMediaIndex = nextIndex;
    this.viewerVideoPlaying = false;
  }
  toggleViewerPlayback() {
    if (!this.viewerVideo || this.selectedMedia?.mediaType !== 'video') return;
    const video = this.viewerVideo.nativeElement;
    if (video.paused) {
      void video.play();
      this.viewerVideoPlaying = true;
    } else {
      video.pause();
      this.viewerVideoPlaying = false;
    }
  }
  onViewerVideoPlay() { this.viewerVideoPlaying = true; }
  onViewerVideoPause() { this.viewerVideoPlaying = false; }
  @HostListener('window:scroll')
  onWindowScroll() {
    this.queueGalleryPrefetch();
  }
  @HostListener('document:keydown', ['$event'])
  handleKeyboardEvent(event: KeyboardEvent) {
    if (this.promptDialogOpen) {
      if (event.key === 'Escape') {
        event.preventDefault();
        this.onPromptDialogCancel();
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        this.onPromptDialogConfirm();
        return;
      }
    }

    if (!this.isMediaViewerOpen) return;
    if (event.key === 'Escape') {
      this.closeMediaViewer();
      return;
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      this.showPreviousMedia();
      return;
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      this.showNextMedia();
      return;
    }
    if (event.key === ' ' && this.selectedMedia?.mediaType === 'video') {
      event.preventDefault();
      this.toggleViewerPlayback();
    }
  }
  scrollTo(id: string) { document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' }); this.menuOpen = false; }
  openCartView() {
    this.isCartOpen = true;
    this.cartFormError = '';
    this.menuOpen = false;
  }
  closeCartView() {
    this.isCartOpen = false;
  }
  closeAdmin() {
    this.adminOpen = false;
  }
  openAdmin() {
    this.adminOpen = true;
    setTimeout(() => { this.renderGoogleSignInButton('google-signin-button'); }, 100);
    if (this.adminToken) {
      void this.loadInquiries();
    }
  }
  setAdminView(view: 'products' | 'inquiries') {
    this.adminView = view;
    if (view === 'inquiries' && this.adminToken && !this.inquiries.length) {
      void this.loadInquiries();
    }
  }
  pickMedia(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    this.uploadFile = file;
    this.uploadPreview = URL.createObjectURL(file);
  }
  async login() {
    this.adminError = '';
    const response = await fetch(`${this.api}/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: this.adminEmail, password: this.adminPassword }) });
    const body = await response.json();
    if (!response.ok) { this.adminError = body.error || 'Could not sign in.'; return; }
    this.adminToken = body.token; sessionStorage.setItem('demori_admin_token', body.token); this.adminAuthProvider = body.provider || 'password'; sessionStorage.setItem('demori_admin_provider', this.adminAuthProvider); this.adminPassword = '';
    void this.loadInquiries();
  }
  async googleLogin(token: string) {
    this.adminError = '';
    try {
      const response = await fetch(`${this.api}/admin/google-login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
      const body = await response.json();
      if (!response.ok) { this.adminError = body.error || 'Google sign in failed.'; this.changeDetector.markForCheck(); return; }
      this.adminToken = body.token;
      this.adminAuthProvider = body.provider || 'google';
      sessionStorage.setItem('demori_admin_token', body.token);
      sessionStorage.setItem('demori_admin_provider', this.adminAuthProvider);
      void this.loadInquiries();
      this.changeDetector.markForCheck();
    } catch (err) {
      this.adminError = 'Network error. Please try again.';
      this.changeDetector.markForCheck();
    }
  }
  logout() {
    this.adminToken = '';
    this.adminAuthProvider = '';
    this.inquiries = [];
    this.inquiriesError = '';
    sessionStorage.removeItem('demori_admin_token');
    sessionStorage.removeItem('demori_admin_provider');
  }
  async loadInquiries() {
    if (!this.adminToken) return;
    this.inquiriesLoading = true;
    this.inquiriesError = '';
    try {
      const response = await fetch(`${this.api}/admin/inquiries`, {
        headers: { Authorization: `Bearer ${this.adminToken}` }
      });
      const body = await response.json();
      if (!response.ok) {
        this.inquiriesError = body.error || 'Could not load inquiries.';
        this.inquiriesLoading = false;
        return;
      }
      this.inquiries = (body.inquiries || []) as Inquiry[];
    } catch {
      this.inquiriesError = 'Network error while loading inquiries.';
    }
    this.inquiriesLoading = false;
  }
  async updateInquiryStatus(inquiryId: string, status: 'new' | 'in-progress' | 'closed') {
    if (!this.adminToken) return;
    const previous = this.inquiries.find(inquiry => inquiry.id === inquiryId);
    if (!previous || previous.status === status) return;
    this.inquiries = this.inquiries.map(inquiry => inquiry.id === inquiryId ? { ...inquiry, status } : inquiry);
    try {
      const response = await fetch(`${this.api}/admin/inquiries/${encodeURIComponent(inquiryId)}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.adminToken}`
        },
        body: JSON.stringify({ status })
      });
      const body = await response.json();
      if (!response.ok) {
        this.inquiries = this.inquiries.map(inquiry => inquiry.id === inquiryId ? { ...inquiry, status: previous.status } : inquiry);
        this.inquiriesError = body.error || 'Could not update inquiry status.';
        return;
      }
      this.inquiries = this.inquiries.map(inquiry => inquiry.id === inquiryId ? body.inquiry as Inquiry : inquiry);
      this.inquiriesError = '';
    } catch {
      this.inquiries = this.inquiries.map(inquiry => inquiry.id === inquiryId ? { ...inquiry, status: previous.status } : inquiry);
      this.inquiriesError = 'Network error while updating inquiry status.';
    }
  }
  formatInquiryDate(value: string) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString();
  }
  async publishProduct() {
    if (!this.uploadFile || !this.product.title.trim() || !this.product.price) return;
    if (this.uploadFile.size > 45 * 1024 * 1024) { this.adminError = 'Please choose a file smaller than 45 MB.'; return; }
    this.uploading = true; this.adminError = '';
    const data = await this.uploadFile.arrayBuffer();
    const media = { name: this.uploadFile.name, mimeType: this.uploadFile.type, data: this.toBase64(data) };
    const response = await fetch(`${this.api}/admin/products`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.adminToken}` }, body: JSON.stringify({ ...this.product, price: Math.round(this.product.price * 100), media }) });
    const body = await response.json(); this.uploading = false;
    if (!response.ok) { this.adminError = body.error || 'Upload failed.'; return; }
    const publishedProduct = this.normalizeProduct(body);
    if (publishedProduct.image) {
      this.apiProducts.unshift(publishedProduct);
      this.rebuildProducts();
    }
    this.work.unshift({ ...body, type: body.category, price: body.price / 100 }); this.showAll = true; this.product = { title: '', category: 'Print', price: 95, description: '' }; this.uploadFile = undefined; this.uploadPreview = ''; this.adminOpen = false; setTimeout(() => this.scrollTo('work'));
  }
  private toBase64(buffer: ArrayBuffer) { let binary = ''; const bytes = new Uint8Array(buffer); const chunk = 8192; for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk)); return btoa(binary); }
  async buy(item: Work) {
    if (!item.id) return;
    const response = await fetch(`${this.api}/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: item.id })
    });
    const body = await response.json();
    if (response.ok) {
      window.location.assign(body.url);
      return;
    }
    await this.showNotice(body.error || 'Checkout is unavailable.', 'Checkout unavailable');
  }
  private getPrintCartItemId(item: ProductOrderPayload) {
    return `${item.product.id}::print::${item.printSize}`;
  }
  private getDigitalCartItemId(product: Product) {
    return `${product.id}::digital`;
  }
  private buildDigitalCartItem(product: Product): CartItem {
    return {
      cartItemId: this.getDigitalCartItemId(product),
      productId: product.id,
      sku: product.sku,
      title: product.mediaType === 'video' ? `${product.title} (video lease)` : `${product.title} (digital file)`,
      price: product.price,
      quantity: 1,
      image: product.image,
      mediaType: product.mediaType,
      orderType: 'digital',
      checkoutEnabled: !!product.checkoutEnabled,
      description: product.description || ''
    };
  }
  private addDigitalToCart(product: Product, quantity = 1) {
    const cartItemId = this.getDigitalCartItemId(product);
    const existing = this.cart.find(cartItem => cartItem.cartItemId === cartItemId);
    if (existing) {
      existing.quantity += Math.max(1, Math.round(quantity || 1));
      return;
    }
    const digitalItem = this.buildDigitalCartItem(product);
    digitalItem.quantity = Math.max(1, Math.round(quantity || 1));
    this.cart.unshift(digitalItem);
  }
  private buildPrintCartItem(item: ProductOrderPayload): CartItem {
    return {
      cartItemId: this.getPrintCartItemId(item),
      productId: item.product.id,
      sku: `${item.product.sku}-${item.printSize.toUpperCase()}`,
      title: `${item.product.title} (${item.printSize} print)`,
      price: item.printUnitPrice,
      quantity: Math.max(1, Math.round(item.quantity || 1)),
      image: item.product.image,
      mediaType: 'image',
      orderType: 'print',
      printSize: item.printSize,
      checkoutEnabled: false,
      description: item.product.description || ''
    };
  }
  addToCart(item: ProductOrderPayload) {
    this.cartFormError = '';
    if (item.includeDigitalCopy) {
      const digitalCartItemId = this.getDigitalCartItemId(item.product);
      if (!this.cart.some(cartItem => cartItem.cartItemId === digitalCartItemId)) {
        this.cart.unshift(this.buildDigitalCartItem(item.product));
      }
    }
    const cartItemId = this.getPrintCartItemId(item);
    const existing = this.cart.find(cartItem => cartItem.cartItemId === cartItemId);
    if (existing) {
      existing.quantity += Math.max(1, Math.round(item.quantity || 1));
      this.openCartView();
      return;
    }
    this.cart.unshift(this.buildPrintCartItem(item));
    this.openCartView();
  }
  removeFromCart(cartItemId: string) {
    this.cartFormError = '';
    this.cart = this.cart.filter(item => item.cartItemId !== cartItemId);
  }
  updateCartQuantity(cartItemId: string, quantity: number) {
    this.cartFormError = '';
    const nextQuantity = Math.max(1, Math.round(quantity || 1));
    this.cart = this.cart.map(item => item.cartItemId === cartItemId ? { ...item, quantity: nextQuantity } : item);
  }
  onDigitalDeliveryEmailChange(value: string) {
    this.digitalDeliveryEmail = value.trim();
    localStorage.setItem(this.digitalDeliveryEmailStorageKey, this.digitalDeliveryEmail);
    this.cartFormError = '';
  }
  onDeliveryUpdatesOptInChange(value: boolean) {
    this.deliveryUpdatesOptIn = !!value;
    localStorage.setItem(this.deliveryUpdatesOptInStorageKey, String(this.deliveryUpdatesOptIn));
  }
  async checkoutCart() {
    if (!this.activeCartItems.length) return;
    this.cartFormError = '';
    if (this.hasDigitalItemsInCart && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(this.digitalDeliveryEmail)) {
      this.cartFormError = 'Enter a valid email for digital media delivery.';
      return;
    }
    this.cartCheckingOut = true;
    try {
      const response = await fetch(`${this.api}/checkout/cart`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          digitalDeliveryEmail: this.hasDigitalItemsInCart ? this.digitalDeliveryEmail : undefined,
          digitalEmailOptIn: this.hasDigitalItemsInCart ? this.deliveryUpdatesOptIn : undefined,
          items: this.activeCartItems.map(item => {
            if (item.orderType === 'digital' && item.checkoutEnabled) {
              return { productId: item.productId, quantity: item.quantity, orderType: item.orderType };
            }
            return {
              quantity: item.quantity,
              orderType: item.orderType,
              preview: {
                sku: item.sku,
                title: item.title,
                description: item.description || '',
                price: Math.round(item.price * 100),
                image: item.image
              }
            };
          })
        })
      });
      const body = await response.json();
      if (!response.ok) {
        this.cartFormError = body.error || 'Cart checkout is unavailable.';
        return;
      }
      const checkoutUrl = typeof body.url === 'string' ? body.url : '';
      if (!checkoutUrl.startsWith('http')) {
        this.cartFormError = 'Checkout URL was not returned. Please try again.';
        return;
      }
      this.isCartOpen = false;
      this.cartFormError = '';
      window.location.assign(checkoutUrl);
    } catch {
      this.cartFormError = 'Could not reach checkout service. Ensure the API is running and try again.';
    } finally {
      this.cartCheckingOut = false;
    }
  }
  buyProduct(item: Product) {
    if (!item.id) return;
    this.addDigitalToCart(item, 1);
    this.openCartView();
  }
  buyPrintProduct(item: ProductOrderPayload) {
    this.addToCart(item);
  }
  async onPublishProduct(item: Product) {
    if (!this.canManageProducts) {
      await this.showNotice('Open Admin and sign in first, then publish this image for checkout.', 'Admin required');
      return;
    }
    const response = await fetch(`${this.api}/admin/products/from-gallery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.adminToken}` },
      body: JSON.stringify({
        title: item.title,
        category: item.category,
        description: item.description || '',
        details: item.details || '',
        price: Math.round((item.price || 20) * 100),
        mediaType: item.mediaType,
        image: item.image
      })
    });
    const body = await response.json();
    if (!response.ok) {
      await this.showNotice(body.error || 'Could not publish this product.', 'Publish failed');
      return;
    }
    const published = this.normalizeProduct(body);
    if (typeof body.details === 'string') published.details = body.details;
    published.checkoutEnabled = true;
    this.apiProducts.unshift(published);
    this.rebuildProducts();
  }
  async onDeleteProduct(item: Product) {
    if (!this.canManageProducts) {
      await this.showNotice('Only the Google admin account can delete products.', 'Admin required');
      return;
    }
    const confirmed = await this.requestConfirmation(`Delete "${item.title}" from products?`, 'Delete product');
    if (!confirmed) return;

    if (!item.checkoutEnabled) {
      this.hiddenProductImageKeys.add(this.getProductImageKey(item.image));
      this.saveStoredHiddenProductImages();
      delete this.productEdits[item.id];
      this.saveStoredProductEdits();
      this.rebuildProducts();
      return;
    }

    try {
      const response = await fetch(`${this.api}/admin/products/${encodeURIComponent(item.id)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${this.adminToken}` }
      });
      const body = await response.json();
      if (!response.ok) {
        await this.showNotice(body.error || 'Could not delete this product.', 'Delete failed');
        return;
      }
      this.apiProducts = this.apiProducts.filter(product => product.id !== item.id);
      delete this.productEdits[item.id];
      this.saveStoredProductEdits();
      this.rebuildProducts();
    } catch {
      await this.showNotice('Network error while deleting product.', 'Delete failed');
    }
  }
  async onSaveProductEdits(edit: ProductEditPayload) {
    if (!this.canManageProducts) {
      await this.showNotice('Only the Google admin account can edit product details.', 'Admin required');
      return;
    }
    const existing = this.products.find(product => product.id === edit.id);
    const previousCategory = existing ? this.getGalleryCategoryByProductImage(existing.image) : '';
    const nextCategory = edit.category.trim();

    if (existing && previousCategory && nextCategory && previousCategory !== nextCategory && this.isGalleryImagePath(existing.image)) {
      try {
        const response = await fetch(`${this.api}/admin/gallery/category`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.adminToken}`
          },
          body: JSON.stringify({ image: existing.image, category: nextCategory })
        });
        const body = await response.json();
        if (!response.ok) {
          await this.showNotice(body.error || 'Could not move media to the new category.', 'Category move failed');
          return;
        }

        const oldImageKey = this.getProductImageKey(existing.image);
        const nextRelativeImage = String(body.image || '').trim();
        const nextAbsoluteImage = String(body.absoluteImage || '').trim();

        this.gallery = this.gallery.map(item => {
          if (this.getProductImageKey(item.image) !== oldImageKey) return item;
          return {
            ...item,
            category: body.category || nextCategory,
            image: nextRelativeImage || item.image
          };
        });

        this.apiProducts = this.apiProducts.map(product => {
          if (this.getProductImageKey(product.image) !== oldImageKey) return product;
          return {
            ...product,
            image: nextAbsoluteImage || product.image,
            category: body.category || nextCategory
          };
        });
      } catch {
        await this.showNotice('Network error while moving media to the new category.', 'Category move failed');
        return;
      }
    }

    this.productEdits[edit.id] = {
      title: edit.title,
      category: edit.category,
      description: edit.description,
      details: edit.details,
      price: Math.max(1, Math.round(edit.price || 20))
    };
    this.saveStoredProductEdits();
    this.rebuildProducts();
  }
}
