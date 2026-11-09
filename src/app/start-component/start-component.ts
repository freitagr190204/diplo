import {Component, HostListener, OnDestroy, OnInit} from '@angular/core';
import {Router} from '@angular/router';
import {version, versionDateString} from '../shared/version';

@Component({
  selector: 'app-start-component',
  imports: [],
  templateUrl: './start-component.html',
  styleUrl: './start-component.scss',
})
export class StartComponent implements OnInit, OnDestroy {
  readonly version = version;
  readonly versionDate = versionDateString;
  private animationFrameId: number | null = null;
  private lastButtonStates: Record<string, boolean> = {};
  private connectRetryInterval: ReturnType<typeof setInterval> | null = null;

  constructor(private router: Router) {}

  ngOnInit() {
    this.pollGamepad();
    window.addEventListener('blur', this.onWindowBlur);
    this.tryAutoConnect();
    this.connectRetryInterval = setInterval(() => this.tryAutoConnect(), 4000);
  }

  ngOnDestroy() {
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    if (this.connectRetryInterval) {
      clearInterval(this.connectRetryInterval);
      this.connectRetryInterval = null;
    }
    window.removeEventListener('blur', this.onWindowBlur);
  }

  private tryAutoConnect() {
    void window.api?.autoConnect?.('192.168.10.1:4203', '4203');
  }

  private readonly onWindowBlur = () => {
    window.api?.refocusLauncher?.();
  };

  protected goMesse() {
    void this.router.navigate(['/messe']);
  }

  protected goFull() {
    void this.router.navigate(['/home']);
  }

  @HostListener('window:keydown', ['$event'])
  protected handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this.goMesse();
    }
  }

  private pollGamepad() {
    const loop = () => {
      this.readGamepad();
      this.animationFrameId = requestAnimationFrame(loop);
    };
    this.animationFrameId = requestAnimationFrame(loop);
  }

  private readGamepad() {
    const nav: any = navigator;
    if (!nav.getGamepads) {
      return;
    }
    const pads = (nav.getGamepads() as (Gamepad | null)[])
      .filter((p): p is Gamepad => !!p && p.connected);
    if (!pads.length) {
      return;
    }
    const isPressedAny = (buttonIndex: number) =>
      pads.some((pad) => !!pad.buttons[buttonIndex] && pad.buttons[buttonIndex].pressed);
    const handleEdge = (buttonIndex: number, onPressed: () => void) => {
      const key = `btn:${buttonIndex}`;
      const prev = this.lastButtonStates[key] ?? false;
      const curr = isPressedAny(buttonIndex);
      if (!prev && curr) {
        onPressed();
      }
      this.lastButtonStates[key] = curr;
    };
    const startMesse = () => this.goMesse();
    handleEdge(0, startMesse);
    handleEdge(1, startMesse);
    handleEdge(2, startMesse);
    handleEdge(3, startMesse);
    handleEdge(9, startMesse);
  }
}
