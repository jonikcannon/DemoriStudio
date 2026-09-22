import { ChangeDetectionStrategy, Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { mediaUrl } from '../media-url';
import { SiteContent } from '../site-content';

@Component({
  selector: 'app-about',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './about.component.html',
  styleUrl: './about.component.css'
})
export class AboutComponent {
  @Input({ required: true }) content!: SiteContent['about'];
  @Output() contactClick = new EventEmitter<void>();

  // The bundled default until an admin uploads a portrait in the Site content form.
  private readonly defaultPortrait = mediaUrl('assets/gallery/about/portrait-in-the-green-hills.jpg');

  get portraitImage(): string {
    return this.content.portrait ? mediaUrl(this.content.portrait) : this.defaultPortrait;
  }

  get portraitAlt(): string {
    return this.content.portrait
      ? `Portrait: ${this.content.headingEmphasis || this.content.heading}`
      : 'Jonik, photographer and drone pilot';
  }

  // Unlike the portrait, a feature has no bundled default image -- an admin may
  // leave it off entirely, so this returns '' rather than a fallback.
  featureImage(image: string): string {
    return image ? mediaUrl(image) : '';
  }

  // Falls back to [] for content saved before this field existed.
  get features(): SiteContent['about']['features'] {
    return this.content.features || [];
  }

  onLearnMoreClick() {
    this.contactClick.emit();
  }
}
