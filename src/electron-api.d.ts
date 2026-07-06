export interface ElectronGameEntry {
  name: string;
  batchPath: string;
  imagePath?: string;
}

export interface SlotSpinPayload {
  targetIndex?: number;
  seed?: number;
  error?: string;
  ok?: boolean;
}

export interface ElectronApi {
  launchGame: () => void;
  launchRandomGame: () => void;
  launchGameByIndex: (index: number) => void;
  getGames: () => Promise<ElectronGameEntry[]>;
  onGameSelected: (callback: (payload: unknown) => void) => void;
  onGameError: (callback: (payload: unknown) => void) => void;
  closeGame: () => void;
  createServerWithPort: (port: string) => Promise<{ success: boolean }>;
  stopWsServer: () => Promise<unknown>;
  connectWithUrl: (url: string) => Promise<{ success: boolean }>;
  disconnectFromServer: () => Promise<unknown>;
  getConnectionStatus: () => Promise<{
    status: 'server' | 'client' | 'disconnected';
    isServer: boolean;
    isClient: boolean;
  }>;
  getLocalNetworkInfo: () => Promise<{ ip: string; role: 'server' | 'client' | 'unknown' }>;
  autoConnect: (
    targetUrl: string,
    port: string
  ) => Promise<{
    success: boolean;
    role?: 'server' | 'client';
    error?: string;
    url?: string;
    port?: number;
  }>;
  quitApp: () => void;
  beginRandomSpin: () => Promise<SlotSpinPayload | null>;
  onSlotSpinBegin: (callback: (payload: SlotSpinPayload) => void) => void;
}

declare global {
  interface Window {
    api?: ElectronApi;
  }
}

export {};
