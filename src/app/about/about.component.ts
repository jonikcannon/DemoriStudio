import { ChangeDetectionStrategy, Component, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-about',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule],
  templateUrl: './about.component.html',
  styleUrl: './about.component.css'
})
export class AboutComponent {
  @Output() contactClick = new EventEmitter<void>();

  onLearnMoreClick() {
    this.contactClick.emit();
  }
}
