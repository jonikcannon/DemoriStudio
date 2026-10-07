import { ChangeDetectionStrategy, ChangeDetectorRef, Component, Input, OnChanges, OnDestroy, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeUrl } from '@angular/platform-browser';
import { getApiBaseUrl } from '../media-url';

export const PENDING_DESIGN_KEY = 'demori_makerworld_pending';

// Runs on a MakerWorld model page in the admin's own browser, where MakerWorld
// answers normally (it often blocks this server). Reads the model from the
// page's __NEXT_DATA__ -- or its own API, same-origin, after client-side
// navigation leaves that stale -- keeps only the fields the import uses, and
// opens this site with them in the URL fragment, which never reaches a server.
function buildBookmarklet(origin: string): string {
  const source = `(()=>{
const m=location.pathname.match(/\\/models\\/(\\d+)/);
if(!/(^|\\.)makerworld\\.com$/.test(location.hostname)||!m){alert('Open a MakerWorld model page first, then click Send to Demori.');return}
const pick=d=>({id:d.id,title:d.title,summary:d.summary,license:d.license,
designCreator:{name:(d.designCreator||{}).name,handle:(d.designCreator||{}).handle},
originals:(d.originals||[]).map(o=>({title:o.title,author:o.author,link:o.link,license:o.license})),
categories:(d.categories||[]).map(c=>({name:c.name})),tagsOriginal:d.tagsOriginal,tags:d.tags,
designExtension:{design_pictures:((d.designExtension||{}).design_pictures||[]).map(p=>({url:p.url}))}});
const send=d=>{const b=btoa(unescape(encodeURIComponent(JSON.stringify(pick(d)))));const u=${JSON.stringify(origin)}+'/#mw='+encodeURIComponent(b);if(!window.open(u,'demori_admin'))location.href=u};
try{const d=JSON.parse(document.getElementById('__NEXT_DATA__').textContent).props.pageProps.design;if(d&&String(d.id)===m[1])return send(d)}catch(e){}
fetch('/api/v1/design-service/design/'+m[1],{headers:{Accept:'application/json'}}).then(r=>r.json()).then(send).catch(()=>alert('Could not read this MakerWorld model.'))})()`;
  return `javascript:${encodeURIComponent(source.replace(/\n/g, ''))}`;
}

type EtsyStatus = { configured: boolean; connected: boolean; connectedAt: string | null; redirectUri: string; printInboxPath: string };
type Option = { id: number; label: string };
type ShippingOption = Option & { calculated?: boolean };
type Category = { id: number; path: string };
type EtsyOptions = {
  shippingProfiles: ShippingOption[];
  processingProfiles: Option[];
  returnPolicies: Option[];
  usedCategories: Category[];
};
// A local upload, or a photo imported from MakerWorld, which the server saved
// to the print share on import and publishes from there.
type Photo = { file?: File; remoteUrl?: string; preview: string };
type License = { code: string; label: string; commercial: boolean; attribution: boolean };
type MakerWorldModel = {
  id: string;
  url: string;
  title: string;
  description: string;
  categories: string[];
  tags: string[];
  creator: { name: string; url: string };
  license: License;
  originals: { title: string; author: string; url: string; license: License }[];
  commercialUse: boolean;
  images: string[];
  attribution: string;
  photos: { folder: string; saved: number; failed: number; error?: string };
};
type CreatedListing = { listingId: string; url: string; editUrl: string; state: 'draft' | 'active'; warnings: string[] };

const MAX_PHOTOS = 10;
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
// Kept under the API's 65 MB JSON limit once base64 adds its third.
const MAX_TOTAL_BYTES = 45 * 1024 * 1024;
// Etsy's tag rules; MakerWorld tags that break them are dropped on import.
const ETSY_TAG = /^[\p{L}\p{Nd}\p{Zs}\-'™©®]{1,20}$/u;
const MAX_TAGS = 13;

// Admin "Etsy" tab: connects the Etsy shop once (OAuth, handled server-side in
// etsy-seller.js), then creates listings in it -- drafts by default.
@Component({
  selector: 'app-admin-etsy',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './admin-etsy.component.html',
  styleUrl: './admin-etsy.component.css'
})
export class AdminEtsyComponent implements OnChanges, OnDestroy {
  @Input() adminToken = '';
  // Result of the OAuth round trip, read from the return URL by AppComponent.
  @Input() connectResult: { ok: boolean; message: string } | null = null;
  // Bumped by AppComponent each time the bookmark hands over a model.
  @Input() pendingImportTick = 0;

  private readonly api = getApiBaseUrl();
  status: EtsyStatus | null = null;
  options: EtsyOptions | null = null;
  loading = false;
  connecting = false;
  error = '';

  listing = this.emptyListing();
  photos: Photo[] = [];
  categoryQuery = '';
  categoryResults: Category[] = [];
  selectedCategory: Category | null = null;
  private categoryTimer?: ReturnType<typeof setTimeout>;
  submitting = false;
  created: CreatedListing | null = null;

  makerworldUrl = '';
  importing = false;
  imported: MakerWorldModel | null = null;

  // The "Send to Demori" bookmarklet, built for whichever origin this admin
  // runs on. Angular blocks javascript: links unless explicitly trusted.
  readonly bookmarklet: SafeUrl;

  constructor(
    private readonly changeDetector: ChangeDetectorRef,
    sanitizer: DomSanitizer
  ) {
    this.bookmarklet = sanitizer.bypassSecurityTrustUrl(buildBookmarklet(window.location.origin));
  }

  ngOnChanges(changes: SimpleChanges) {
    if (changes['adminToken'] && this.adminToken) void this.loadStatus();
    else if (changes['pendingImportTick'] && this.adminToken && this.options) void this.importPendingDesign();
  }

  ngOnDestroy() {
    clearTimeout(this.categoryTimer);
    this.releasePhotos(this.photos);
  }

  private releasePhotos(photos: Photo[]) {
    for (const photo of photos) if (photo.file) URL.revokeObjectURL(photo.preview);
  }

  async importFromMakerWorld() {
    const url = this.makerworldUrl.trim();
    if (!url) return;
    await this.runImport(() => this.request<MakerWorldModel>(`/admin/makerworld/import?url=${encodeURIComponent(url)}`));
  }

  // A model sent by the "Send to Demori" bookmark (see AppComponent's
  // handleMakerWorldHandoff), kept in sessionStorage across an admin login.
  private async importPendingDesign() {
    let design: unknown;
    try {
      design = JSON.parse(sessionStorage.getItem(PENDING_DESIGN_KEY) || 'null');
      sessionStorage.removeItem(PENDING_DESIGN_KEY);
    } catch {
      return;
    }
    if (!design) return;
    await this.runImport(() => this.request<MakerWorldModel>('/admin/makerworld/import-design', {
      method: 'POST',
      body: JSON.stringify({ design })
    }));
    if (this.imported) this.makerworldUrl = this.imported.url;
  }

  // Fills in everything the MakerWorld model provides; the rest (price,
  // category choice, profiles) stays with the admin. Replaces any earlier
  // import's photos but keeps photos uploaded by hand.
  private async runImport(load: () => Promise<MakerWorldModel>) {
    if (this.importing) return;
    this.importing = true;
    this.error = '';
    this.created = null;
    this.refresh();
    try {
      const model = await load();
      this.imported = model;
      this.listing.title = model.title;
      this.listing.description = [model.description, model.attribution].filter(Boolean).join('\n\n');
      this.listing.tags = model.tags.filter(tag => ETSY_TAG.test(tag)).slice(0, MAX_TAGS).join(', ');

      const ownPhotos = this.photos.filter(photo => photo.file);
      const room = Math.max(0, MAX_PHOTOS - ownPhotos.length);
      this.photos = [...model.images.slice(0, room).map(image => ({ remoteUrl: image, preview: image })), ...ownPhotos];

      // Seed the category search; Etsy's taxonomy differs from MakerWorld's,
      // so the admin still picks the exact category from the results.
      if (!this.selectedCategory) {
        const seed = model.categories.find(name => name.trim().length >= 2);
        if (seed) this.onCategoryInput(seed.split('&')[0].trim());
      }
    } catch (error) {
      this.error = error instanceof Error ? error.message : 'Could not import from MakerWorld.';
    }
    this.importing = false;
    this.refresh();
  }

  clearImport() {
    if (!this.imported) return;
    this.photos = this.photos.filter(photo => photo.file);
    this.imported = null;
    this.makerworldUrl = '';
  }

  // \\server\prints\<title>\photos, from the share's inbox path when it's set.
  photoFolder(): string {
    const folder = this.imported?.photos.folder || '';
    const share = (this.status?.printInboxPath || '').replace(/[\\/]_inbox[\\/]?$/i, '');
    return share ? `${share}\\${folder}` : folder;
  }

  private emptyListing() {
    return {
      title: '',
      description: '',
      price: null as number | null,
      quantity: 999,
      tags: '',
      materials: '',
      weight: null as number | null,
      weightUnit: 'oz',
      length: null as number | null,
      width: null as number | null,
      height: null as number | null,
      dimensionsUnit: 'in',
      shippingProfileId: null as number | null,
      processingProfileId: null as number | null,
      returnPolicyId: null as number | null,
      publish: false
    };
  }

  private headers(json = false): Record<string, string> {
    return json
      ? { Authorization: `Bearer ${this.adminToken}`, 'Content-Type': 'application/json' }
      : { Authorization: `Bearer ${this.adminToken}` };
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.api}${path}`, { ...init, headers: { ...this.headers(Boolean(init.body)), ...(init.headers || {}) } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (body?.notConnected && this.status) this.status = { ...this.status, connected: false };
      throw new Error(body?.error || `Request failed (${response.status}).`);
    }
    return body as T;
  }

  private refresh() {
    this.changeDetector.markForCheck();
  }

  async loadStatus() {
    this.loading = true;
    this.error = '';
    this.refresh();
    try {
      this.status = await this.request<EtsyStatus>('/admin/etsy/status');
      if (this.status.connected) {
        await this.loadOptions();
        await this.importPendingDesign();
      }
    } catch (error) {
      this.error = error instanceof Error ? error.message : 'Could not load Etsy status.';
    }
    this.loading = false;
    this.refresh();
  }

  private async loadOptions() {
    const options = await this.request<EtsyOptions>('/admin/etsy/options');
    this.options = options;
    // Preselect when there's only one choice, which is the shop's usual case.
    this.listing.shippingProfileId ??= options.shippingProfiles[0]?.id ?? null;
    this.listing.processingProfileId ??= options.processingProfiles[0]?.id ?? null;
    this.listing.returnPolicyId ??= options.returnPolicies[0]?.id ?? null;
  }

  async connect() {
    this.connecting = true;
    this.error = '';
    this.refresh();
    try {
      const { url } = await this.request<{ url: string }>('/admin/etsy/connect', { method: 'POST' });
      // Full-page hop: Etsy's consent screen, then back via the API callback.
      window.location.href = url;
    } catch (error) {
      this.error = error instanceof Error ? error.message : 'Could not start the Etsy connection.';
      this.connecting = false;
      this.refresh();
    }
  }

  async disconnect() {
    if (!confirm('Disconnect Etsy? You will need to connect again before creating listings.')) return;
    try {
      this.status = await this.request<EtsyStatus>('/admin/etsy/disconnect', { method: 'POST' });
      this.options = null;
    } catch (error) {
      this.error = error instanceof Error ? error.message : 'Could not disconnect Etsy.';
    }
    this.refresh();
  }

  onCategoryInput(query: string) {
    this.categoryQuery = query;
    this.selectedCategory = null;
    clearTimeout(this.categoryTimer);
    if (query.trim().length < 2) {
      this.categoryResults = [];
      return;
    }
    // Debounced: the admin API shares the site-wide rate limit.
    this.categoryTimer = setTimeout(async () => {
      try {
        const { categories } = await this.request<{ categories: Category[] }>(`/admin/etsy/categories?q=${encodeURIComponent(query.trim())}`);
        if (this.categoryQuery === query) this.categoryResults = categories;
      } catch (error) {
        this.error = error instanceof Error ? error.message : 'Category search failed.';
      }
      this.refresh();
    }, 300);
  }

  chooseCategory(category: Category) {
    this.selectedCategory = category;
    this.categoryQuery = category.path;
    this.categoryResults = [];
  }

  pickPhotos(event: Event) {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files || []);
    input.value = '';
    this.error = '';
    for (const file of files) {
      if (this.photos.length >= MAX_PHOTOS) {
        this.error = `Etsy allows at most ${MAX_PHOTOS} photos per listing.`;
        break;
      }
      if (!['image/jpeg', 'image/png', 'image/gif'].includes(file.type)) {
        this.error = `${file.name} isn't a JPG, PNG, or GIF.`;
        continue;
      }
      if (file.size > MAX_PHOTO_BYTES) {
        this.error = `${file.name} is over 10 MB.`;
        continue;
      }
      this.photos.push({ file, preview: URL.createObjectURL(file) });
    }
  }

  removePhoto(index: number) {
    const [photo] = this.photos.splice(index, 1);
    if (photo) this.releasePhotos([photo]);
  }

  // The first photo is the listing's main image on Etsy and in the site grid.
  makePrimary(index: number) {
    const [photo] = this.photos.splice(index, 1);
    this.photos.unshift(photo);
  }

  // Etsy refuses a listing on a calculated shipping profile without them.
  get needsPackageSize(): boolean {
    const profile = this.options?.shippingProfiles.find(option => option.id === this.listing.shippingProfileId);
    return Boolean(profile?.calculated);
  }

  get canSubmit(): boolean {
    const l = this.listing;
    return Boolean(
      !this.submitting && l.title.trim() && l.description.trim() && l.price && l.quantity &&
      this.selectedCategory && l.shippingProfileId && l.processingProfileId && l.returnPolicyId && this.photos.length &&
      (!this.needsPackageSize || (l.weight && l.length && l.width && l.height))
    );
  }

  async submit() {
    if (!this.canSubmit || !this.selectedCategory) return;
    const totalBytes = this.photos.reduce((sum, photo) => sum + (photo.file?.size || 0), 0);
    if (totalBytes > MAX_TOTAL_BYTES) {
      this.error = 'Photos add up to more than 45 MB. Remove a few or use smaller files.';
      return;
    }
    if (this.listing.publish && !confirm('Publish this listing on Etsy now? Etsy charges its $0.20 listing fee when it goes live.')) return;

    this.submitting = true;
    this.error = '';
    this.created = null;
    this.refresh();
    try {
      const images = await Promise.all(this.photos.map(async photo => photo.file
        ? { name: photo.file.name, mimeType: photo.file.type, data: toBase64(await photo.file.arrayBuffer()) }
        : { remoteUrl: photo.remoteUrl }));
      this.created = await this.request<CreatedListing>('/admin/etsy/listings', {
        method: 'POST',
        body: JSON.stringify({
          ...this.listing,
          taxonomyId: this.selectedCategory.id,
          images,
          makerworldId: this.imported?.id
        })
      });
      this.resetForm();
    } catch (error) {
      this.error = error instanceof Error ? error.message : 'Could not create the listing.';
    }
    this.submitting = false;
    this.refresh();
  }

  // Keeps the shop-level choices (profiles, category) for the next item.
  private resetForm() {
    const { shippingProfileId, processingProfileId, returnPolicyId, weightUnit, dimensionsUnit } = this.listing;
    this.listing = { ...this.emptyListing(), shippingProfileId, processingProfileId, returnPolicyId, weightUnit, dimensionsUnit };
    this.releasePhotos(this.photos);
    this.photos = [];
    this.imported = null;
    this.makerworldUrl = '';
  }
}

function toBase64(buffer: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}
