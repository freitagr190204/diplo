import {Component, signal, effect, OnInit, OnDestroy, HostListener, inject} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {CommonModule} from '@angular/common';
import {ActivatedRoute} from '@angular/router';
import type {SlotSpinPayload} from '../../electron-api';

type GameEntry = {
  name: string;
  batchPath: string;
  imagePath?: string;
};

type ReelRuntime = {
  offset: number;
  startOffset: number;
  targetOffset: number;
  stopAtMs: number;
  settleDurationMs: number;
  done: boolean;
};

@Component({
  selector: 'app-home-component',
  imports: [
    FormsModule,
    CommonModule
  ],
  templateUrl: './home-component.arcade.html',
  styleUrl: './home-component.arcade.scss',
})
export class HomeComponent implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  /** Messe-/Show-UI: nur Slot, ohne manuelle Auswahl, Status und Trefferliste. */
  fairMode = signal(false);
  schoolLogoSrc = 'htl-grieskirchen-logo.png';
  isConnected = signal(false);
  hasServer = signal(false);
  isClient = signal(false);
  // Fixed setup: PC 1 will host on 192.168.10.1:4203
  serverUrl = signal('192.168.10.1:4203');
  serverPort = signal('4203');
  connectionRole = signal<'server' | 'client' | 'disconnected'>('disconnected');
  linkedClientCount = signal(0);
  statusMessage = signal('Nicht verbunden');
  localIp = signal<string | null>(null);
  localRole = signal<'server' | 'client' | 'unknown'>('unknown');
  games = signal<GameEntry[]>([]);
  selectedGameIndex = signal<number | null>(null);
  mode = signal<'random' | 'manual'>('random');
  currentGameName = signal<string | null>(null);
  gameError = signal<string | null>(null);
  usingMockData = signal(false);
  isSpinning = signal(false);
  /** The single game all three reels target for this spin (center row when stopped). */
  slotResultGame = signal<GameEntry | null>(null);
  /** Newest first: up to 10 results from the Zufallsmodus slot. */
  randomPickHistory = signal<GameEntry[]>([]);
  launchCountdown = signal<number | null>(null);
  reelOffsets = signal<number[]>([0, 0, 0]);
  reelTrackA = signal<GameEntry[]>([]);
  reelTrackB = signal<GameEntry[]>([]);
  reelTrackC = signal<GameEntry[]>([]);
  isScreenShaking = signal(false);
  /** Laufende Hervorhebung in der rechten Spielliste waehrend des Spins. */
  carouselHighlightIndex = signal<number | null>(null);
  /** Grosses „Spiel ausgewählt“-Overlay (volle UI rechts / Messe auf dem Automaten). */
  showPickReveal = signal(false);
  /** Messemodus: laufende Attract-/Demo-Ziehung ohne echten Start. */
  isAttractDemo = signal(false);
  /** Kurz nach Spielende: beide Automaten wieder im Launcher. */
  showReturnOverlay = signal(false);
  /** True while the physical lever is animating (pull, hold, or spring return). */
  isPulling = signal(false);
  /**
   * Which cabinet photo to show (real lever positions in the assets — swap files in /public if order is wrong).
   */
  machineFrame = signal<'idle' | 'middle' | 'down'>('idle');
  /** Short glow flash at lever bottom / spin trigger. */
  leverGlow = signal(false);
  /** Cabinet renders (must live under public/). */
  protected readonly cabinetAssets = {
    idle: 'arcade-cabinet-idle.png',
    middle: 'arcade-cabinet-middle.png',
    down: 'arcade-cabinet-down.png',
  } as const;
  private randomSpinTimeout: ReturnType<typeof setTimeout> | null = null;
  private slotAnimationFrameId: number | null = null;
  private reelRuntime: ReelRuntime[] = [];
  private reelRows = [0, 0, 0];
  private reelBaseStartRow = [0, 0, 0];
  /** Kept in sync with `.reel-item` height in `home-component.arcade.scss` (compact left panel). */
  private readonly reelItemHeight = 56;
  private readonly reelVisibleRows = 3;
  /** How many full strips are concatenated per reel (must match `buildReelStrip` / `normalize`). */
  private readonly slotReelRepeats = 30;
  private launchCountdownInterval: ReturnType<typeof setInterval> | null = null;
  private shakeTimeout: ReturnType<typeof setTimeout> | null = null;
  private tickTimeouts: ReturnType<typeof setTimeout>[] = [];
  private audioCtx: AudioContext | null = null;
  private brokenImageMap = signal<Record<string, boolean>>({});
  private statusCheckInterval: any;
  private animationFrameId: number | null = null;
  private lastButtonStates: Record<string, boolean> = {};
  private lastBothPressed = false;
  private lastBackLbPressed = false;
  private lastAxisNavigateAt = 0;
  private clientRetryInterval: any;
  /** Lever = image sequence: middle (ms) → down + hold → mech delay → spin + idle photo. */
  private readonly leverMiddleMs = 140;
  private readonly leverBottomHoldMs = 110;
  private readonly leverMechDelayMs = 75;
  private leverTimeouts: ReturnType<typeof setTimeout>[] = [];
  private lastCarouselScrollIdx = -1;
  /** Mindestabstand zwischen gelbem Rahmen-Wechsel rechts (ms). */
  private readonly carouselStepMinMs = 220;
  private carouselSpinStartAt = 0;
  private carouselSpinTargetIndex = 0;
  private lastCarouselStepAt = 0;
  /** Idle-Zeit bis zur Attract-Demo im Messemodus. */
  private readonly attractIdleMs = 18000;
  private readonly attractRevealMs = 4000;
  private readonly returnOverlayMs = 4500;
  private attractIdleTimeout: ReturnType<typeof setTimeout> | null = null;
  private attractRevealTimeout: ReturnType<typeof setTimeout> | null = null;
  private returnOverlayTimeout: ReturnType<typeof setTimeout> | null = null;
  constructor() {
    effect(() => {
      const role = this.connectionRole();
      if (role === 'server') {
        this.statusMessage.set('Warte auf zweiten Automaten...');
      } else if (role === 'client') {
        this.statusMessage.set('Mit Server verbunden');
      } else {
        this.statusMessage.set('Nicht verbunden');
      }
    });
  }

  ngOnInit() {
    const isFair = this.route.snapshot.data['fairMode'] === true;
    this.fairMode.set(isFair);
    if (isFair) {
      this.mode.set('random');
      this.scheduleAttractIdle();
    }
    this.checkConnectionStatus();
    this.statusCheckInterval = setInterval(() => {
      this.checkConnectionStatus();
    }, 1000);
    this.loadGames();
    this.loadLocalNetworkInfo().then(() => {
      this.startClientAutoConnect();
    });
    this.startGamepadLoop();

    // Listen for game selection events from Electron (random or manual, server or client)
    // @ts-ignore
    if (window.api?.onGameSelected) {
      // @ts-ignore
      window.api.onGameSelected((payload: any) => {
        const index = typeof payload === 'number' ? payload : payload?.index;
        const games = this.games();
        if (typeof index === 'number' && index >= 0 && index < games.length) {
          this.cancelAttract();
          this.showReturnOverlay.set(false);
          this.selectedGameIndex.set(index);
          this.currentGameName.set(games[index].name);
          this.gameError.set(null);
        }
      });
    }

    // Listen for game start errors
    // @ts-ignore
    if (window.api?.onGameError) {
      // @ts-ignore
      window.api.onGameError((payload: any) => {
        const message = typeof payload === 'string' ? payload : payload?.message;
        if (message) {
          this.gameError.set(message);
        }
      });
    }

    // @ts-ignore
    if (window.api?.onGameClosed) {
      // @ts-ignore
      window.api.onGameClosed(() => {
        this.onGameSessionClosed();
      });
    }

    // @ts-ignore
    if (window.api?.onSlotSpinBegin) {
      // @ts-ignore
      window.api.onSlotSpinBegin((payload: SlotSpinPayload) => {
        if (this.usingMockData()) {
          return;
        }
        if (!payload || payload.error) {
          if (payload?.error) {
            this.gameError.set(this.formatConnectionError(payload.error));
          }
          return;
        }
        if (this.isSpinning() || this.isPulling() || this.launchCountdown() !== null) {
          return;
        }
        if (typeof payload.targetIndex === 'number' && typeof payload.seed === 'number') {
          this.cancelAttract();
          this.startRemoteLeverAndSpin({targetIndex: payload.targetIndex, seed: payload.seed});
        }
      });
    }
  }

  ngOnDestroy() {
    if (this.statusCheckInterval) {
      clearInterval(this.statusCheckInterval);
    }
    if (this.clientRetryInterval) {
      clearInterval(this.clientRetryInterval);
    }
    if (this.randomSpinTimeout) {
      clearTimeout(this.randomSpinTimeout);
      this.randomSpinTimeout = null;
    }
    if (this.slotAnimationFrameId !== null) {
      cancelAnimationFrame(this.slotAnimationFrameId);
      this.slotAnimationFrameId = null;
    }
    if (this.launchCountdownInterval) {
      clearInterval(this.launchCountdownInterval);
      this.launchCountdownInterval = null;
    }
    if (this.shakeTimeout) {
      clearTimeout(this.shakeTimeout);
      this.shakeTimeout = null;
    }
    this.stopTickSound();
    this.clearLeverTimeouts();
    this.clearAttractTimers();
    if (this.returnOverlayTimeout) {
      clearTimeout(this.returnOverlayTimeout);
      this.returnOverlayTimeout = null;
    }
    this.stopGamepadLoop();
  }

  private async checkConnectionStatus() {
    try {
      // @ts-ignore
      const status = await window.api.getConnectionStatus();
      if (status) {
        this.connectionRole.set(status.status);
        this.isConnected.set(status.status !== 'disconnected');
        this.hasServer.set(status.isServer);
        this.isClient.set(status.isClient);
        this.linkedClientCount.set(status.linkedClientCount ?? 0);
      }
    } catch (e) {
      console.error('Error checking status:', e);
    }
  }

  private async loadGames() {
    try {
      // @ts-ignore
      const games = await window.api.getGames();
      if (Array.isArray(games)) {
        if (games.length > 0) {
          this.games.set([...games]);
          this.usingMockData.set(false);
          this.selectedGameIndex.set(0);
          this.setupReels();
        } else {
          this.loadMockGames();
        }
      }
    } catch (e) {
      console.error('Error loading games:', e);
      this.loadMockGames();
    }
  }

  private loadMockGames() {
    const mockGames: GameEntry[] = [
      {name: 'Neon Racer', batchPath: 'MOCK://neon-racer'},
      {name: 'Sky Arena', batchPath: 'MOCK://sky-arena'},
      {name: 'Dungeon Clash', batchPath: 'MOCK://dungeon-clash'},
      {name: 'Pixel Strikers', batchPath: 'MOCK://pixel-strikers'},
      {name: 'Turbo Tennis', batchPath: 'MOCK://turbo-tennis'}
    ];
    this.games.set([...mockGames]);
    this.selectedGameIndex.set(0);
    this.usingMockData.set(true);
    this.statusMessage.set('Demo-Modus aktiv');
    this.setupReels();
  }

  private async loadLocalNetworkInfo() {
    try {
      // @ts-ignore
      const info = await window.api.getLocalNetworkInfo();
      if (info?.ip) {
        this.localIp.set(info.ip);
      }
      if (info?.role) {
        this.localRole.set(info.role);
      }
    } catch (e) {
      console.error('Error loading network info:', e);
    }
  }

  private startClientAutoConnect() {
    if (this.localRole() !== 'client' || this.isConnected()) return;
    this.autoConnect().then(() => {
      if (!this.isConnected()) {
        this.clientRetryInterval = setInterval(() => {
          if (this.isConnected()) {
            clearInterval(this.clientRetryInterval);
            this.clientRetryInterval = null;
            return;
          }
          this.statusMessage.set('Verbinden... (erneut)');
          this.autoConnect();
        }, 5000);
      }
    });
  }

  protected connectionStatusLabel() {
    const role = this.connectionRole();
    const ip = this.localIp();
    const ipStr = ip ? ` (${ip})` : '';
    if (role === 'server') {
      return 'Server' + ipStr;
    }
    if (role === 'client') {
      return 'Client' + ipStr;
    }
    return ip ? `Nicht verbunden (${ip})` : 'Nicht verbunden';
  }

  /** Both cabinets linked and ready for a synced spin (demo mode always ok). */
  protected isPairReady(): boolean {
    if (this.usingMockData()) {
      return true;
    }
    const role = this.connectionRole();
    if (role === 'client') {
      return this.isConnected();
    }
    if (role === 'server') {
      return this.linkedClientCount() > 0;
    }
    return false;
  }

  /** Compact fair-mode pill label (no IP clutter). */
  protected fairConnectionLabel(): string {
    const role = this.connectionRole();
    if (role === 'client') {
      return 'Verbunden';
    }
    if (role === 'server') {
      return this.linkedClientCount() > 0 ? 'Beide bereit' : 'Warte auf Client';
    }
    return 'Offline';
  }

  protected fairConnectionTone(): 'ok' | 'server' | 'down' {
    const role = this.connectionRole();
    if (role === 'client' || (role === 'server' && this.linkedClientCount() > 0)) {
      return 'ok';
    }
    if (role === 'server') {
      return 'server';
    }
    return 'down';
  }

  protected isFairIdle(): boolean {
    return (
      this.fairMode() &&
      !this.isSpinning() &&
      !this.isPulling() &&
      !this.showPickReveal() &&
      !this.showReturnOverlay() &&
      this.launchCountdown() === null &&
      !this.isAttractDemo()
    );
  }

  protected onFairCabinetPressed() {
    if (!this.fairMode()) {
      return;
    }
    void this.onPlayPressed();
  }

  protected setMode(mode: 'random' | 'manual') {
    if (this.fairMode() || this.isSpinning() || this.isPulling()) {
      return;
    }
    this.mode.set(mode);
  }

  protected selectGame(index: number) {
    if (this.fairMode() || this.isSpinning() || this.isPulling()) {
      return;
    }
    if (index >= 0 && index < this.games().length) {
      this.selectedGameIndex.set(index);
    }
  }

  protected canLaunchRandom() {
    return (
      this.games().length > 0 &&
      this.isPairReady() &&
      !this.isSpinning() &&
      !this.isPulling() &&
      this.launchCountdown() === null
    );
  }

  protected canLaunchSelected() {
    return (
      this.games().length > 0 &&
      this.isPairReady() &&
      this.selectedGameIndex() !== null &&
      !this.isSpinning() &&
      !this.isPulling() &&
      this.launchCountdown() === null
    );
  }

  protected async onPlayPressed() {
    this.noteUserActivity();

    if (this.showReturnOverlay()) {
      return;
    }

    if (this.isAttractDemo()) {
      if (this.isSpinning() || this.isPulling()) {
        return;
      }
      if (this.showPickReveal()) {
        this.clearAttractReveal();
      }
    }

    if (this.isSpinning() || this.isPulling() || this.launchCountdown() !== null) {
      return;
    }

    if (!this.usingMockData() && !this.isConnected()) {
      await this.autoConnect();
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    const currentMode = this.mode();
    if (currentMode === 'manual') {
      const index = this.selectedGameIndex();
      if (index === null) {
        return;
      }
      const games = this.games();
      if (index >= 0 && index < games.length) {
        this.currentGameName.set(games[index].name);
        this.selectedGameIndex.set(index);
        this.slotResultGame.set(games[index]);
      }
      if (this.usingMockData()) {
        this.gameError.set(null);
        this.startLaunchCountdown(index);
        return;
      }
      // @ts-ignore
      window.api.launchGameByIndex(index);
    } else {
      this.startLeverPullSequence();
    }
  }

  private clearLeverTimeouts() {
    this.leverTimeouts.forEach((id) => clearTimeout(id));
    this.leverTimeouts = [];
  }

  private scheduleLever(fn: () => void, delayMs: number) {
    const id = setTimeout(() => {
      fn();
    }, delayMs);
    this.leverTimeouts.push(id);
  }

  /**
   * Controller-driven: image frames idle → middle → down → (mech) → spin, then idle photo again.
   */
  private startLeverPullSequence(options?: {attract?: boolean}) {
    if (this.isPulling() || this.isSpinning() || this.launchCountdown() !== null) {
      return;
    }
    if (this.mode() !== 'random' || this.games().length === 0) {
      return;
    }

    const attract = options?.attract === true;
    if (attract) {
      this.isAttractDemo.set(true);
    } else if (!this.isPairReady()) {
      this.gameError.set(this.formatConnectionError(
        'Kein zweiter Automat verbunden: Bitte zuerst den Launcher auf PC 2 (192.168.10.2) starten und warten, bis „Beide bereit“ bzw. „Verbunden“ angezeigt wird.'
      ));
      return;
    }

    this.clearLeverTimeouts();
    this.isPulling.set(true);
    this.machineFrame.set('middle');

    const atBottomMs = this.leverMiddleMs;
    const spinAtMs = atBottomMs + this.leverBottomHoldMs + this.leverMechDelayMs;

    this.scheduleLever(() => {
      this.machineFrame.set('down');
      this.triggerLeverHitShake();
    }, atBottomMs);

    this.scheduleLever(() => {
      this.leverGlow.set(true);
      this.scheduleLever(() => this.leverGlow.set(false), 100);
    }, atBottomMs + 10);

    this.scheduleLever(() => {
      if (attract || this.isAttractDemo()) {
        if (!this.runSyncedSpinLocalFallback()) {
          this.isAttractDemo.set(false);
          this.scheduleAttractIdle();
        }
      } else {
        void this.requestSyncedRandomSpin();
      }
      this.machineFrame.set('idle');
      this.isPulling.set(false);
    }, spinAtMs);
  }

  private startRemoteLeverAndSpin(payload: {targetIndex: number; seed: number}) {
    if (this.mode() !== 'random' || this.games().length === 0) {
      return;
    }
    this.clearLeverTimeouts();
    this.isPulling.set(true);
    this.machineFrame.set('middle');
    const atBottomMs = this.leverMiddleMs;
    const spinAtMs = atBottomMs + this.leverBottomHoldMs + this.leverMechDelayMs;
    this.scheduleLever(() => {
      this.machineFrame.set('down');
      this.triggerLeverHitShake();
    }, atBottomMs);
    this.scheduleLever(() => {
      this.leverGlow.set(true);
      this.scheduleLever(() => this.leverGlow.set(false), 100);
    }, atBottomMs + 10);
    this.scheduleLever(() => {
      void this.runSyncedSpin(payload);
      this.machineFrame.set('idle');
      this.isPulling.set(false);
    }, spinAtMs);
  }

  private async requestSyncedRandomSpin() {
    if (this.usingMockData()) {
      this.gameError.set(null);
      this.runSyncedSpinLocalFallback();
      return;
    }

    const payload: SlotSpinPayload | null = window.api?.beginRandomSpin
      ? await window.api.beginRandomSpin()
      : null;
    if (!payload) {
      this.runSyncedSpinLocalFallback();
      return;
    }
    if (payload.error) {
      this.gameError.set(this.formatConnectionError(payload.error));
      this.scheduleAttractIdle();
      return;
    }
    if (typeof payload.targetIndex === 'number' && typeof payload.seed === 'number') {
      this.runSyncedSpin({targetIndex: payload.targetIndex, seed: payload.seed});
    }
  }

  private runSyncedSpinLocalFallback(): boolean {
    const gameList = this.games();
    if (!gameList.length) {
      return false;
    }
    const targetIndex = Math.floor(Math.random() * gameList.length);
    return this.runSyncedSpin({targetIndex, seed: Date.now() % 2147483646});
  }

  protected cabinetPhotoSrc(): string {
    const frame = this.machineFrame();
    return this.cabinetAssets[frame];
  }

  private triggerLeverHitShake() {
    this.isScreenShaking.set(true);
    if (this.shakeTimeout) {
      clearTimeout(this.shakeTimeout);
    }
    this.shakeTimeout = setTimeout(() => {
      this.isScreenShaking.set(false);
      this.shakeTimeout = null;
    }, 180);
  }

  protected selectedGame(): GameEntry | null {
    const index = this.selectedGameIndex();
    const allGames = this.games();
    if (index === null || index < 0 || index >= allGames.length) {
      return null;
    }
    return allGames[index];
  }

  protected trackRandomPickBy(_i: number, g: GameEntry) {
    return g.batchPath + '::' + g.name;
  }

  protected formatConnectionError(raw: string): string {
    const t = raw.trim();
    if (/spin-timeout|Spin-Timeout/i.test(t)) {
      return (
        'Spin-Timeout (10 s): Der Server-PC (192.168.10.1) hat die gemeinsame Zufallsziehung nicht beantwortet. ' +
        'Beide Launcher muessen laufen und verbunden sein — zuerst den Server-PC (192.168.10.1), dann den Client-PC (192.168.10.2) starten.'
      );
    }
    if (/Verbindungs-Timeout|Connection timeout/i.test(t)) {
      return (
        'Verbindungs-Timeout (6 s): Dieser PC konnte den Server-PC (192.168.10.1) auf Port 4203 nicht erreichen. ' +
        'Ursache oft: Server-Launcher noch nicht gestartet, falsches Netzwerk (192.168.10.x), Kabel/WLAN getrennt oder Windows-Firewall blockiert Port 4203.'
      );
    }
    if (/Verbindung fehlgeschlagen|Could not reach server/i.test(t)) {
      return (
        'Verbindung fehlgeschlagen: Kein Kontakt zum Server-PC (192.168.10.1:4203). ' +
        'Bitte zuerst den Launcher auf PC 1 starten, dann PC 2. Pruefen Sie IP-Adressen (10.1 / 10.2) und die Firewall.'
      );
    }
    if (/Kein Client verbunden/i.test(t)) {
      return (
        'Kein zweiter Automat verbunden: Auf PC 1 (Server) laeuft der Launcher, aber PC 2 (Client) ist noch nicht verbunden. ' +
        'Bitte auch auf 192.168.10.2 den Launcher starten und warten, bis die Verbindung steht.'
      );
    }
    return t;
  }

  protected gameErrorText(): string {
    const raw = this.gameError();
    return raw ? this.formatConnectionError(raw) : '';
  }

  protected gameImageUrl(game: GameEntry | null): string | null {
    if (!game?.imagePath) {
      return null;
    }
    const raw = game.imagePath.trim();
    if (!raw) {
      return null;
    }
    if (/^(https?:|file:|data:)/i.test(raw)) {
      return raw;
    }
    const normalized = raw.replace(/\\/g, '/');
    const withPrefix = /^[a-zA-Z]:\//.test(normalized)
      ? `file:///${normalized}`
      : `file://${normalized}`;
    return encodeURI(withPrefix);
  }

  protected imageBroken(game: GameEntry | null): boolean {
    if (!game?.imagePath) {
      return false;
    }
    return !!this.brokenImageMap()[game.imagePath];
  }

  protected onGameImageError(game: GameEntry | null) {
    if (!game?.imagePath) {
      return;
    }
    const next = {...this.brokenImageMap()};
    next[game.imagePath] = true;
    this.brokenImageMap.set(next);
  }

  private static gameEquals(a: GameEntry, b: GameEntry): boolean {
    return a.batchPath === b.batchPath && a.name === b.name;
  }

  /** Center column index inside one shuffled block (0..n-1). */
  private reelCenterIndex(gameCount: number): number {
    if (gameCount <= 0) {
      return 0;
    }
    return Math.floor(gameCount / 2);
  }

  /** `topRow` = first of 3 visible; center = `topRow + centerRow` shows strip[centerIndex] (the result). */
  private idleTopRowForCenteredResult(gameCount: number, centerIndex: number): number {
    const cr = Math.floor(this.reelVisibleRows / 2);
    if (gameCount === 1) {
      return 0;
    }
    const block = Math.floor(this.slotReelRepeats / 2);
    return block * gameCount + centerIndex - cr;
  }

  private pickOtherGame(result: GameEntry, alsoAvoid: GameEntry | null, list: GameEntry[]): GameEntry {
    for (const g of list) {
      if (HomeComponent.gameEquals(g, result)) {
        continue;
      }
      if (alsoAvoid && HomeComponent.gameEquals(g, alsoAvoid)) {
        continue;
      }
      return g;
    }
    return list[0];
  }

  /**
   * Each call builds a new shuffled order; only the middle of each repeated block is `result`.
   * Top/bottom differ per reel; center aligns on `result` when stopped.
   */
  private seededRandom(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  private buildReelStrip(result: GameEntry, list: GameEntry[], rng?: () => number): GameEntry[] {
    const n = list.length;
    if (!n) {
      return [];
    }
    if (n === 1) {
      return Array.from({length: this.slotReelRepeats}, () => list[0]);
    }

    const rand = rng ?? Math.random;
    const copy = [...list];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }

    const centerIndex = this.reelCenterIndex(n);
    const resolved = list.find((g) => HomeComponent.gameEquals(g, result)) ?? result;
    copy[centerIndex] = resolved;

    if (n >= 2) {
      if (centerIndex > 0 && HomeComponent.gameEquals(copy[centerIndex - 1], resolved)) {
        copy[centerIndex - 1] = this.pickOtherGame(
          resolved,
          centerIndex < n - 1 ? copy[centerIndex + 1] : null,
          list
        );
      }
      if (centerIndex < n - 1 && HomeComponent.gameEquals(copy[centerIndex + 1], resolved)) {
        copy[centerIndex + 1] = this.pickOtherGame(
          resolved,
          centerIndex > 0 ? copy[centerIndex - 1] : null,
          list
        );
      }
    }

    const out: GameEntry[] = [];
    for (let r = 0; r < this.slotReelRepeats; r++) {
      for (let k = 0; k < n; k++) {
        out.push(copy[k]);
      }
    }
    return out;
  }

  private runSyncedSpin(payload: {targetIndex: number; seed: number}): boolean {
    if (this.isSpinning()) {
      return false;
    }

    const gameList = this.games();
    if (!gameList.length) {
      return false;
    }

    const targetIndex = payload.targetIndex;
    if (targetIndex < 0 || targetIndex >= gameList.length) {
      return false;
    }

    const targetGame = gameList[targetIndex];
    const rng = this.seededRandom(payload.seed);
    const rngB = this.seededRandom(payload.seed + 1);
    const rngC = this.seededRandom(payload.seed + 2);
    this.slotResultGame.set(targetGame);
    this.reelTrackA.set(this.buildReelStrip(targetGame, gameList, rng));
    this.reelTrackB.set(this.buildReelStrip(targetGame, gameList, rngB));
    this.reelTrackC.set(this.buildReelStrip(targetGame, gameList, rngC));
    this.lastCarouselScrollIdx = -1;
    this.carouselSpinStartAt = performance.now();
    this.carouselSpinTargetIndex = targetIndex;
    this.lastCarouselStepAt = 0;
    const initialIdx = this.gameIndexAtReelCenter(1);
    this.carouselHighlightIndex.set(initialIdx ?? 0);
    this.showPickReveal.set(false);

    const n = gameList.length;
    const cr = Math.floor(this.reelVisibleRows / 2);
    const centerIndex = this.reelCenterIndex(n);
    const startTopRow = 6 * n + centerIndex - cr;
    // Anchor = current top row so `normalizeOffsetToMiddle` matches the repeated block size `n` (same as setup)
    this.reelBaseStartRow = [startTopRow, startTopRow, startTopRow];
    this.reelRows = [startTopRow, startTopRow, startTopRow];
    const h = this.reelItemHeight;
    this.reelOffsets.set([startTopRow * h, startTopRow * h, startTopRow * h]);

    this.isSpinning.set(true);
    this.isScreenShaking.set(false);
    this.gameError.set(null);
    const start = performance.now();
    /** Stagger stops: reel0 → +150ms → +300ms, all land on `targetGame` in the center row. */
    const stopStaggerMs = 150;
    this.reelRuntime = [0, 1, 2].map((reelIdx) => {
      const startOffset = this.reelOffsets()[reelIdx] ?? 0;
      return {
        offset: startOffset,
        startOffset,
        targetOffset: this.targetOffsetForReel(reelIdx, startOffset),
        stopAtMs: start + 1200 + reelIdx * stopStaggerMs,
        settleDurationMs: 400,
        done: false
      };
    });

    this.startTickSound(22, 2300);

    if (this.slotAnimationFrameId !== null) {
      cancelAnimationFrame(this.slotAnimationFrameId);
      this.slotAnimationFrameId = null;
    }

    let lastFrame = performance.now();
    let finishedReels = 0;
    const animate = (now: number) => {
      const dt = Math.min(0.05, (now - lastFrame) / 1000);
      lastFrame = now;
      const nextOffsets = [...this.reelOffsets()];

      for (let i = 0; i < 3; i++) {
        const reel = this.reelRuntime[i];
        if (!reel || reel.done) {
          continue;
        }

        if (now < reel.stopAtMs) {
          const spinVelocity = 3300 - i * 180;
          reel.offset = this.normalizeOffsetToMiddle(i, reel.offset + spinVelocity * dt);
          nextOffsets[i] = reel.offset;
          continue;
        }

        const progress = Math.min(1, (now - reel.stopAtMs) / reel.settleDurationMs);
        // Slight mechanical overshoot for a more natural stop.
        const c1 = 1.12;
        const c3 = c1 + 1;
        const eased = 1 + c3 * Math.pow(progress - 1, 3) + c1 * Math.pow(progress - 1, 2);
        reel.offset = this.normalizeOffsetToMiddle(
          i,
          reel.startOffset + (reel.targetOffset - reel.startOffset) * eased
        );
        nextOffsets[i] = reel.offset;

        if (progress >= 1) {
          reel.offset = this.normalizeOffsetToMiddle(i, reel.targetOffset);
          nextOffsets[i] = reel.offset;
          reel.done = true;
          finishedReels += 1;
        }
      }

      this.reelOffsets.set(nextOffsets);
      this.updateCarouselHighlightStepped(now, targetIndex);

      if (finishedReels >= 3 || this.reelRuntime.every((r) => r.done)) {
        this.slotAnimationFrameId = null;
        const stableOffsets = this.reelOffsets().map((offset, idx) => this.normalizeOffsetToMiddle(idx, offset));
        this.reelOffsets.set(stableOffsets);
        this.stopTickSound();
        this.selectedGameIndex.set(targetIndex);
        this.currentGameName.set(targetGame.name);
        if (!this.isAttractDemo()) {
          this.recordRandomPick(targetGame);
        }
        this.playWinnerFanfare();
        this.triggerScreenShake();
        this.isSpinning.set(false);
        this.lastCarouselScrollIdx = -1;
        this.carouselHighlightIndex.set(targetIndex);
        document.getElementById(`game-card-${targetIndex}`)?.scrollIntoView({block: 'nearest', behavior: 'auto'});
        if (this.isAttractDemo()) {
          this.startAttractReveal();
        } else {
          this.startLaunchCountdown(targetIndex);
        }
        return;
      }

      this.slotAnimationFrameId = requestAnimationFrame(animate);
    };

    this.slotAnimationFrameId = requestAnimationFrame(animate);
    return true;
  }

  /** Welches Spiel in der rechten Liste gerade der Mitte der Mittelwalze entspricht. */
  private gameIndexAtReelCenter(reel: number): number | null {
    const list = this.games();
    const n = list.length;
    if (!n) {
      return null;
    }
    const track = this.trackForReel(reel);
    if (!track.length) {
      return null;
    }
    const h = this.reelItemHeight;
    const centerRowOffset = Math.floor(this.reelVisibleRows / 2);
    const topRow = Math.floor((this.reelOffsets()[reel] ?? 0) / h);
    const centerRow = Math.max(0, Math.min(topRow + centerRowOffset, track.length - 1));
    const game = track[centerRow];
    if (!game) {
      return null;
    }
    const idx = list.findIndex((g) => HomeComponent.gameEquals(g, game));
    return idx >= 0 ? idx : null;
  }

  private scrollCarouselToIndex(idx: number) {
    if (this.lastCarouselScrollIdx === idx) {
      return;
    }
    this.lastCarouselScrollIdx = idx;
    document.getElementById(`game-card-${idx}`)?.scrollIntoView({block: 'nearest', behavior: 'auto'});
  }

  /** Rechte Liste: gelber Rahmen springt langsam von Karte zu Karte (nicht jedes Walzen-Frame). */
  private updateCarouselHighlightStepped(now: number, targetIndex: number) {
    const n = this.games().length;
    if (!n || !this.isSpinning()) {
      return;
    }

    const elapsed = now - this.carouselSpinStartAt;
    const spinPhaseMs = 2000;
    const progress = Math.min(1, elapsed / spinPhaseMs);
    const stepGap = this.carouselStepMinMs + progress * 100;

    if (now - this.lastCarouselStepAt < stepGap) {
      return;
    }
    this.lastCarouselStepAt = now;

    const current = this.carouselHighlightIndex() ?? 0;
    let next = current;

    if (progress >= 0.8) {
      if (current !== targetIndex) {
        const forward = (targetIndex - current + n) % n;
        const backward = (current - targetIndex + n) % n;
        next = forward <= backward ? (current + 1) % n : (current - 1 + n) % n;
      }
    } else {
      next = (current + 1) % n;
    }

    if (next !== current) {
      this.carouselHighlightIndex.set(next);
      this.scrollCarouselToIndex(next);
    }
  }

  private setupReels() {
    const list = this.games();
    const gameCount = list.length;
    if (!gameCount) {
      return;
    }

    const g0 = list[0];
    this.reelTrackA.set(this.buildReelStrip(g0, list));
    this.reelTrackB.set(this.buildReelStrip(g0, list));
    this.reelTrackC.set(this.buildReelStrip(g0, list));

    const centerIndex = this.reelCenterIndex(gameCount);
    const baseRow = this.idleTopRowForCenteredResult(gameCount, centerIndex);
    this.reelBaseStartRow = [baseRow, baseRow, baseRow];
    this.reelRows = [baseRow, baseRow, baseRow];
    const h = this.reelItemHeight;
    this.reelOffsets.set([baseRow * h, baseRow * h, baseRow * h]);
    this.slotResultGame.set(null);
    this.scheduleAttractIdle();
  }

  private recordRandomPick(game: GameEntry) {
    this.randomPickHistory.update((prev) => [game, ...prev].slice(0, 10));
  }

  private trackForReel(reel: number): GameEntry[] {
    if (reel === 0) return this.reelTrackA();
    if (reel === 1) return this.reelTrackB();
    return this.reelTrackC();
  }

  private normalizeOffsetToMiddle(reel: number, rawOffset: number): number {
    const gameCount = Math.max(this.games().length, 1);
    const trackLength = this.trackForReel(reel).length;
    if (!trackLength) {
      return Math.max(0, rawOffset);
    }

    const totalHeight = trackLength * this.reelItemHeight;
    const blockHeight = gameCount * this.reelItemHeight;
    const middleBaseOffset = this.reelBaseStartRow[reel] * this.reelItemHeight;
    const normalizedInBlock =
      ((rawOffset - middleBaseOffset) % blockHeight + blockHeight) % blockHeight;
    let safeOffset = middleBaseOffset + normalizedInBlock;

    const maxSafeOffset = Math.max(0, totalHeight - this.reelVisibleRows * this.reelItemHeight);
    if (safeOffset > maxSafeOffset) safeOffset = maxSafeOffset;
    if (safeOffset < 0) safeOffset = 0;

    if (rawOffset < -this.reelItemHeight || rawOffset > totalHeight + this.reelItemHeight) {
      console.debug('[slot] offset out of safe bounds', {reel, rawOffset, totalHeight, safeOffset});
    }

    return safeOffset;
  }

  /**
   * Stops with center row = strip center (`centerIndex` in every repeated block) where `result` was fixed.
   * `topRow = b * n + (centerIndex - centerRow)`; advance `b` for extra spins, staggered by reel.
   */
  private targetOffsetForReel(reel: number, currentOffset: number): number {
    const n = this.games().length;
    const h = this.reelItemHeight;
    const centerRow = Math.floor(this.reelVisibleRows / 2);
    const trackLength = this.trackForReel(reel).length;
    const maxTopRow = Math.max(0, trackLength - this.reelVisibleRows);
    if (!trackLength || n === 0) {
      this.reelRows[reel] = 0;
      return 0;
    }
    if (n === 1) {
      const minTR = Math.floor(currentOffset / h) + (2 + reel);
      const tr = Math.min(minTR, maxTopRow);
      this.reelRows[reel] = tr;
      return tr * h;
    }

    const currentTopRow = Math.floor(currentOffset / h);
    const centerIndex = this.reelCenterIndex(n);
    const top0 = centerIndex - centerRow;
    const minAdvanceRows = (2 + reel) * n;
    const minTR = currentTopRow + minAdvanceRows;
    const bMin = Math.ceil((minTR - top0) / n);
    const bMax = Math.max(0, Math.floor((maxTopRow - top0) / n));
    const b = Math.max(0, Math.min(Math.max(bMin, 0), bMax));
    const topRow = b * n + top0;

    this.reelRows[reel] = topRow;
    return topRow * h;
  }

  private startLaunchCountdown(gameIndex: number) {
    if (this.launchCountdownInterval) {
      clearInterval(this.launchCountdownInterval);
      this.launchCountdownInterval = null;
    }

    let remaining = 5;
    this.showPickReveal.set(true);
    this.launchCountdown.set(remaining);

    this.launchCountdownInterval = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        this.launchCountdown.set(null);
        this.showPickReveal.set(false);
        if (this.launchCountdownInterval) {
          clearInterval(this.launchCountdownInterval);
          this.launchCountdownInterval = null;
        }
        if (!this.usingMockData()) {
          // @ts-ignore
          window.api.launchGameByIndex(gameIndex);
        }
        this.scheduleAttractIdle();
        return;
      }
      this.launchCountdown.set(remaining);
    }, 1000);
  }

  private clearAttractTimers() {
    if (this.attractIdleTimeout) {
      clearTimeout(this.attractIdleTimeout);
      this.attractIdleTimeout = null;
    }
    if (this.attractRevealTimeout) {
      clearTimeout(this.attractRevealTimeout);
      this.attractRevealTimeout = null;
    }
  }

  private scheduleAttractIdle() {
    if (!this.fairMode()) {
      return;
    }
    if (this.attractIdleTimeout) {
      clearTimeout(this.attractIdleTimeout);
      this.attractIdleTimeout = null;
    }
    if (
      this.isSpinning() ||
      this.isPulling() ||
      this.showPickReveal() ||
      this.showReturnOverlay() ||
      this.launchCountdown() !== null ||
      this.isAttractDemo()
    ) {
      return;
    }
    this.attractIdleTimeout = setTimeout(() => {
      this.attractIdleTimeout = null;
      this.startAttractDemo();
    }, this.attractIdleMs);
  }

  private startAttractDemo() {
    if (!this.fairMode()) {
      return;
    }
    if (
      this.isSpinning() ||
      this.isPulling() ||
      this.showPickReveal() ||
      this.showReturnOverlay() ||
      this.launchCountdown() !== null ||
      this.games().length === 0
    ) {
      this.scheduleAttractIdle();
      return;
    }
    this.startLeverPullSequence({attract: true});
  }

  private startAttractReveal() {
    this.showPickReveal.set(true);
    this.launchCountdown.set(null);
    if (this.attractRevealTimeout) {
      clearTimeout(this.attractRevealTimeout);
    }
    this.attractRevealTimeout = setTimeout(() => {
      this.attractRevealTimeout = null;
      this.clearAttractReveal();
      this.scheduleAttractIdle();
    }, this.attractRevealMs);
  }

  private clearAttractReveal() {
    if (this.attractRevealTimeout) {
      clearTimeout(this.attractRevealTimeout);
      this.attractRevealTimeout = null;
    }
    this.showPickReveal.set(false);
    this.isAttractDemo.set(false);
  }

  private cancelAttract() {
    this.clearAttractTimers();
    if (this.isAttractDemo() && !this.isSpinning() && !this.isPulling()) {
      this.showPickReveal.set(false);
      this.isAttractDemo.set(false);
    }
  }

  private noteUserActivity() {
    if (!this.fairMode()) {
      return;
    }
    if (this.attractIdleTimeout) {
      clearTimeout(this.attractIdleTimeout);
      this.attractIdleTimeout = null;
    }
  }

  private onGameSessionClosed() {
    this.cancelAttract();
    this.showPickReveal.set(false);
    this.launchCountdown.set(null);
    if (this.launchCountdownInterval) {
      clearInterval(this.launchCountdownInterval);
      this.launchCountdownInterval = null;
    }
    this.gameError.set(null);

    if (this.fairMode()) {
      this.showReturnOverlay.set(true);
      if (this.returnOverlayTimeout) {
        clearTimeout(this.returnOverlayTimeout);
      }
      this.returnOverlayTimeout = setTimeout(() => {
        this.returnOverlayTimeout = null;
        this.showReturnOverlay.set(false);
        this.scheduleAttractIdle();
      }, this.returnOverlayMs);
      return;
    }

    this.scheduleAttractIdle();
  }

  private triggerScreenShake() {
    this.isScreenShaking.set(true);
    if (this.shakeTimeout) {
      clearTimeout(this.shakeTimeout);
    }
    this.shakeTimeout = setTimeout(() => {
      this.isScreenShaking.set(false);
      this.shakeTimeout = null;
    }, 520);
  }

  private ensureAudioContext(): AudioContext | null {
    try {
      if (!this.audioCtx) {
        this.audioCtx = new AudioContext();
      }
      if (this.audioCtx.state === 'suspended') {
        void this.audioCtx.resume();
      }
      return this.audioCtx;
    } catch (e) {
      return null;
    }
  }

  private startTickSound(cardsPassed: number, durationMs: number) {
    this.stopTickSound();
    for (let i = 1; i <= cardsPassed; i++) {
      const progress = i / cardsPassed;
      // Inverse ease-out quint: very fast start, clearly slower ending.
      const easedTime = 1 - Math.pow(1 - progress, 1 / 5);
      const whenMs = Math.floor(durationMs * easedTime);
      const timeoutId = setTimeout(() => {
        if (!this.isSpinning()) {
          return;
        }
        const toneProgress = Math.min(1, i / cardsPassed);
        const freq = 1600 - toneProgress * 900;
        const volume = 0.07 - toneProgress * 0.035;
        const duration = 0.045 + toneProgress * 0.03;
        this.playTickSound(freq, Math.max(0.02, volume), duration);
      }, whenMs);
      this.tickTimeouts.push(timeoutId);
    }
  }

  private stopTickSound() {
    this.tickTimeouts.forEach((id) => clearTimeout(id));
    this.tickTimeouts = [];
  }

  private playTickSound(freq = 1100, peakGain = 0.06, durationSec = 0.055) {
    const ctx = this.ensureAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(freq, now);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(peakGain, now + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + durationSec);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + durationSec + 0.005);
  }

  private playWinnerFanfare() {
    const ctx = this.ensureAudioContext();
    if (!ctx) return;
    const notes = [523.25, 659.25, 783.99, 1046.5];
    const now = ctx.currentTime + 0.02;

    notes.forEach((freq, i) => {
      const start = now + i * 0.11;
      const duration = i === notes.length - 1 ? 0.38 : 0.18;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = i === notes.length - 1 ? 'sawtooth' : 'triangle';
      osc.frequency.setValueAtTime(freq, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.11, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + duration + 0.02);
    });
  }

  protected async autoConnect() {
    try {
      this.statusMessage.set('Verbinden...');
      this.gameError.set(null);
      const result = await window.api!.autoConnect(this.serverUrl(), this.serverPort());
      if (result && result.success) {
        if (this.clientRetryInterval) {
          clearInterval(this.clientRetryInterval);
          this.clientRetryInterval = null;
        }
        if (result.role === 'server' || result.role === 'client') {
          this.connectionRole.set(result.role);
        }
        this.isConnected.set(true);
        if (result.role === 'server') {
          this.hasServer.set(true);
          this.statusMessage.set('Warte auf zweiten Automaten...');
        } else {
          this.isClient.set(true);
          this.statusMessage.set('Mit Server verbunden');
        }
      } else {
        const msg = result?.error || 'Verbindung fehlgeschlagen';
        this.statusMessage.set(msg);
        this.gameError.set(this.formatConnectionError(msg));
      }
    } catch (e) {
      console.error('Auto-connect error:', e);
      this.statusMessage.set('Verbindung fehlgeschlagen');
      this.gameError.set(
        this.formatConnectionError(
          'Verbindung fehlgeschlagen: Unerwarteter Fehler beim Verbindungsaufbau. Netzwerk und Firewall pruefen.'
        )
      );
    }
  }

  protected async createServer() {
    // @ts-ignore
    const success = (await window.api.createServerWithPort(this.serverPort())).success;
    console.log(success);
    this.hasServer.set(success);
    if (success) {
      this.connectionRole.set('server');
      this.isConnected.set(true);
    }
  }

  protected async connect() {
    // @ts-ignore
    const success = (await window.api.connectWithUrl(this.serverUrl())).success;
    console.log(success);
    this.isConnected.set(success);
    if (success) {
      this.connectionRole.set('client');
      this.isClient.set(true);
    }
  }

  protected async disconnect() {
    // @ts-ignore
    await window.api.disconnectFromServer();
    this.isConnected.set(false);
    this.connectionRole.set('disconnected');
    this.isClient.set(false);
  }

  protected closeGame() {
    if (this.usingMockData()) {
      return;
    }
    // @ts-ignore
    window.api.closeGame();
  }

  protected restartGame() {
    if (this.isSpinning() || this.isPulling() || this.usingMockData()) {
      return;
    }
    const idx = this.selectedGameIndex();
    if (idx === null || this.games().length === 0) return;
    this.closeGame();
    setTimeout(() => {
      window.api?.launchGameByIndex(idx);
    }, 600);
  }

  private startGamepadLoop() {
    if (this.animationFrameId !== null) {
      return;
    }
    const loop = () => {
      this.readGamepad();
      this.animationFrameId = window.requestAnimationFrame(loop);
    };
    this.animationFrameId = window.requestAnimationFrame(loop);
  }

  private stopGamepadLoop() {
    if (this.animationFrameId !== null) {
      window.cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  private readGamepad() {
    const nav: any = navigator;
    if (!nav.getGamepads) {
      return;
    }
    const pads = (nav.getGamepads() as (Gamepad | null)[])
      .filter((p): p is Gamepad => !!p && p.connected);
    if (!pads.length) {
      this.lastButtonStates = {};
      return;
    }

    const isPressedAny = (buttonIndex: number) =>
      pads.some((pad) => !!pad.buttons[buttonIndex] && pad.buttons[buttonIndex].pressed);

    const isComboPressedOnAnyPad = (firstIndex: number, secondIndex: number) =>
      pads.some((pad) =>
        !!pad.buttons[firstIndex] && !!pad.buttons[secondIndex] &&
        pad.buttons[firstIndex].pressed && pad.buttons[secondIndex].pressed
      );

    const handleButtonEdgeAny = (buttonIndex: number, onPressed: () => void) => {
      const key = `btn:${buttonIndex}`;
      const prev = this.lastButtonStates[key] ?? false;
      const curr = isPressedAny(buttonIndex);
      if (!prev && curr) {
        onPressed();
      }
      this.lastButtonStates[key] = curr;
    };

    const backPressed = isPressedAny(8);

    // Start + Back -> Quit app
    if (isComboPressedOnAnyPad(8, 9)) {
      if (!this.lastBothPressed) {
        this.lastBothPressed = true;
        // @ts-ignore
        window.api?.quitApp?.();
      }
    } else {
      this.lastBothPressed = false;
    }

    // Back + LB -> Spiel abbrechen und zum Launcher zurueck
    if (isComboPressedOnAnyPad(8, 4)) {
      if (!this.lastBackLbPressed) {
        this.lastBackLbPressed = true;
        this.closeGame();
      }
    } else {
      this.lastBackLbPressed = false;
    }

    // Alle Hauptbuttons starten das Spiel.
    const play = () => {
      if (backPressed || this.isPulling() || this.isSpinning()) {
        return;
      }
      this.onPlayPressed();
    };
    handleButtonEdgeAny(0, play);
    handleButtonEdgeAny(1, play);
    handleButtonEdgeAny(2, play);
    handleButtonEdgeAny(3, play);
    handleButtonEdgeAny(9, play);

    // D‑Pad – Mode (left/right) und Spielauswahl (up/down); Messemodus bleibt Slot-only.
    if (!this.fairMode()) {
      handleButtonEdgeAny(14, () => {
        const nextMode = this.mode() === 'random' ? 'manual' : 'random';
        this.setMode(nextMode);
      });
      handleButtonEdgeAny(15, () => {
        const nextMode = this.mode() === 'random' ? 'manual' : 'random';
        this.setMode(nextMode);
      });
      handleButtonEdgeAny(12, () => {
        if (this.mode() === 'manual' && this.games().length > 0) {
          const current = this.selectedGameIndex() ?? 0;
          const count = this.games().length;
          const next = (current - 1 + count) % count;
          this.selectedGameIndex.set(next);
        }
      });
      handleButtonEdgeAny(13, () => {
        if (this.mode() === 'manual' && this.games().length > 0) {
          const current = this.selectedGameIndex() ?? 0;
          const count = this.games().length;
          const next = (current + 1) % count;
          this.selectedGameIndex.set(next);
        }
      });

      // Left joystick navigation (arcade lever support) with cooldown.
      const now = performance.now();
      if (now - this.lastAxisNavigateAt >= 180) {
        const leftPressed = pads.some((pad) => (pad.axes?.[0] ?? 0) <= -0.6);
        const rightPressed = pads.some((pad) => (pad.axes?.[0] ?? 0) >= 0.6);
        const upPressed = pads.some((pad) => (pad.axes?.[1] ?? 0) <= -0.6);
        const downPressed = pads.some((pad) => (pad.axes?.[1] ?? 0) >= 0.6);

        if (leftPressed || rightPressed) {
          const nextMode = this.mode() === 'random' ? 'manual' : 'random';
          this.setMode(nextMode);
          this.lastAxisNavigateAt = now;
        } else if (upPressed && this.mode() === 'manual' && this.games().length > 0) {
          const current = this.selectedGameIndex() ?? 0;
          const count = this.games().length;
          this.selectedGameIndex.set((current - 1 + count) % count);
          this.lastAxisNavigateAt = now;
        } else if (downPressed && this.mode() === 'manual' && this.games().length > 0) {
          const current = this.selectedGameIndex() ?? 0;
          const count = this.games().length;
          this.selectedGameIndex.set((current + 1) % count);
          this.lastAxisNavigateAt = now;
        }
      }
    }
  }

  @HostListener('window:keydown', ['$event'])
  protected handleKeydown(event: KeyboardEvent) {
    const key = event.key;

    if (event.ctrlKey && event.shiftKey && (key === 'Q' || key === 'q')) {
      // @ts-ignore
      window.api?.quitApp?.();
      event.preventDefault();
      return;
    }

    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      if (this.fairMode() || this.isSpinning() || this.isPulling()) {
        return;
      }
      const nextMode = this.mode() === 'random' ? 'manual' : 'random';
      this.setMode(nextMode);
      event.preventDefault();
      return;
    }

    if (key === 'ArrowUp' || key === 'ArrowDown') {
      if (this.fairMode() || this.isSpinning() || this.isPulling()) {
        return;
      }
      if (this.mode() === 'manual' && this.games().length > 0) {
        const current = this.selectedGameIndex() ?? 0;
        const count = this.games().length;
        const delta = key === 'ArrowDown' ? 1 : -1;
        const next = (current + delta + count) % count;
        this.selectedGameIndex.set(next);
        event.preventDefault();
      }
      return;
    }

    if (key === 'Enter') {
      this.onPlayPressed();
      event.preventDefault();
      return;
    }

    if (key === 'Escape') {
      this.closeGame();
      event.preventDefault();
    }
  }
}
