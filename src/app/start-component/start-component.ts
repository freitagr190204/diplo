import {Component} from '@angular/core';
import {Router} from '@angular/router';
import {version, versionDateString} from '../shared/version';

@Component({
  selector: 'app-start-component',
  imports: [],
  templateUrl: './start-component.html',
  styleUrl: './start-component.scss',
})
export class StartComponent {
  readonly version = version;
  readonly versionDate = versionDateString;

  constructor(private router: Router) {}

  protected goMesse() {
    void this.router.navigate(['/messe']);
  }

  protected goFull() {
    void this.router.navigate(['/home']);
  }
}
