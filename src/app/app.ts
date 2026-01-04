import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
// import { toSignal } from '@angular/core/rxjs-interop';
// import { JsonPipe } from '@angular/common';
// import { FormsModule } from '@angular/forms';

@Component({
  selector: 'app-root',
  imports: [
    RouterOutlet,
    // RouterLink,
    // FormsModule,
    // JsonPipe,
  ],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App {
}
