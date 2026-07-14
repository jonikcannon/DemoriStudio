import { ChangeDetectionStrategy, Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';

type Work = { id?: string; image: string; title: string; type: string; size?: string; price?: number; mediaType?: 'image' | 'video' };

@Component({
  selector: 'app-work',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './work.component.html',
  styleUrl: './work.component.css'
})
export class WorkComponent {
  @Input() visibleWork: Work[] = [];
  @Input() showAll = false;
  @Output() showAllChange = new EventEmitter<boolean>();
  @Output() buy = new EventEmitter<Work>();

  onShowAllToggle() {
    this.showAllChange.emit(!this.showAll);
  }

  onBuy(item: Work) {
    this.buy.emit(item);
  }

  trackByWorkItem(_: number, item: Work) {
    return item.id || item.image;
  }
}

