import { ChangeDetectionStrategy, Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';

// Mirrors the manifest shape in app.component.ts: `description` is optional
// because only described media carries one, and the title is the fallback.
type GalleryItem = { category: string; title: string; image: string; mediaType: 'image' | 'video'; description?: string };

@Component({
  selector: 'app-gallery',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './gallery.component.html',
  styleUrl: './gallery.component.css'
})
export class GalleryComponent {
  @Input() visibleGallery: GalleryItem[] = [];
  @Input() activeGallery = 'All';
  @Input() galleryLoading = true;
  @Input() galleryPrefetching = false;
  @Input() galleryPrefetchCount = 0;
  @Output() categoryChange = new EventEmitter<string>();
  @Output() mediaClick = new EventEmitter<GalleryItem>();
  @Output() mediaLoaded = new EventEmitter<void>();

  categories = ['All', 'Nature', 'Others', 'Beach', 'Hikes', 'Aerial'];

  onCategoryChange(category: string) {
    this.categoryChange.emit(category);
  }

  onMediaClick(image: GalleryItem) {
    this.mediaClick.emit(image);
  }

  onMediaLoaded() {
    this.mediaLoaded.emit();
  }

  trackByCategory(_: number, category: string) {
    return category;
  }

  trackByGalleryItem(_: number, item: GalleryItem) {
    return `${item.category}:${item.image}`;
  }
}

