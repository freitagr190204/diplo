// main.js
'use strict';

const {app, BrowserWindow, globalShortcut} = require('electron');
const path = require('path');
const {ipcMain} = require('electron');
const {execFile, spawn} = require('child_process');
const fs = require("node:fs/promises");
const fsSync = require('node:fs');
const { Server } = require('socket.io');
const io = require('socket.io-client');
const os = require('os');
const net = require('net');

const isDev = !app.isPackaged;

// Configuration: load games from a human-readable file in C:\Dashboard\Games
// File format (games.txt), one game per line:
//   Spacegame;C:\Dashboard\Games\Spacegame\start.bat
//   JumpAndRun;C:\Dashboard\Games\JumpAndRun\start.bat;C:\Dashboard\Games\JumpAndRun\cover.jpg
// Lines starting with # or empty lines are ignored.
const GAMES_CONFIG_FILE = process.platform === 'win32'
  ? 'C:\\Dashboard\\Games\\games.txt'
  : null;

/** @type {{ name: string; batchPath: string; imagePath?: string; }[]} */
let GAMES = [];

// Error Handling
process.on('uncaughtException', (error) => {
  console.error("Unexpected error: ", error);
});

function createWindow() {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    fullscreen: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      enableRemoteModule: false,
    }
  });

  mainWindow = win;
  const productionIndex = path.join(__dirname, 'dist', 'angular20', 'browser', 'index.html');

  if (isDev) {
    let didFallbackToFile = false;
    const loadBuiltAppFallback = () => {
      if (didFallbackToFile) {
        return;
      }
      didFallbackToFile = true;
      console.warn('Dev server unavailable - loading built Angular files instead.');
      win.loadFile(productionIndex).catch((error) => {
        console.error('Failed to load built Angular app:', error);
      });
    };

    win.webContents.once('did-fail-load', () => {
      loadBuiltAppFallback();
    });

    win.loadURL('http://localhost:4200').catch(() => {
      loadBuiltAppFallback();
    });
  } else {
    // Angular 20 with @angular/build:application outputs to dist/angular20/browser
    win.loadFile(productionIndex);
  }
  
  // Close game when window closes
  win.on('close', () => {
    // Close the game process if running
    if (gameProcess) {
      console.log('Window closing - closing game process');
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', gameProcess.pid, '/F', '/T']);
      } else {
        gameProcess.kill('SIGTERM');
      }
      gameProcess = null;
    }
    
    // Notify the other PC to close their game
    if (isClient && clientSocket && clientSocket.connected) {
      clientSocket.emit('closeGame');
    } else if (isServer && serverSocket) {
      serverSocket.sockets.emit('closeGame');
    }
  });
  
  return win;
}

let serverSocket;
let clientSocket;
let gameProcess = null;
/** True from spawn until the session is fully closed — blocks a second launch. */
let gameSessionActive = false;
/** When the tracked launcher process started (for detached-batch detection). */
let gameLaunchStartedAt = 0;
/** Name of the game currently being launched/running (for error messages). */
let activeGameName = '';
let yieldFocusTimer = null;
let yieldFocusAttempts = 0;
const GAME_WINDOW_PROCESS_NAMES = [
  'SuperStickman',
  'SuperStickmanServer',
  'Pacman',
  'Spacegame',
];
let isServer = false;
let isClient = false;
let connectionStatus = 'disconnected'; // disconnected, server, client
let gameFiles = [];
let mainWindow = null;
let processMonitorInterval = null;
/** Client wartet auf slotSpin-Antwort fuer lokalen Hebelzug (kein zweites slotSpinBegin). */
let clientSpinAwaitingInvoke = false;
/** True while closing because the peer asked us to (avoid close ping-pong). */
let closingFromRemote = false;
/** Prevents duplicate gameClosed events from exit + process monitor. */
let gameClosedNotified = false;
/** Ensures handleGameProcessEnded runs only once per launch. */
let gameEndHandled = false;
/** Keeps ARP warm on the server while waiting for the client PC. */
let serverPeerWarmupInterval = null;

const SERVER_IP = '192.168.10.1';
const CLIENT_IP = '192.168.10.2';
const SOCKET_PORT = 4203;

function getLocalIPv4() {
  const nets = os.networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        candidates.push(net.address);
      }
    }
  }
  const arcadeIp = candidates.find((a) => a === SERVER_IP || a === CLIENT_IP);
  if (arcadeIp) {
    return arcadeIp;
  }
  const arcadeSubnet = candidates.find((a) => a.startsWith('192.168.10.'));
  if (arcadeSubnet) {
    return arcadeSubnet;
  }
  return candidates[0] || null;
}

/** Try a short TCP connect to warm ARP and verify the peer port is reachable. */
function probeTcpPort(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    if (!host || !port) {
      resolve(false);
      return;
    }
    const socket = new net.Socket();
    let settled = false;
    const finish = (ok) => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        socket.destroy();
      } catch (_) {
        /* ignore */
      }
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    try {
      socket.connect(port, host);
    } catch (_) {
      finish(false);
      return;
    }
    setTimeout(() => finish(false), timeoutMs + 200);
  });
}

function pingHostOnce(host) {
  return new Promise((resolve) => {
    const pingExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'ping.exe');
    const args = ['-n', '1', '-w', '1200', host];
    const proc = spawn(pingExe, args, { stdio: 'ignore' });
    const done = () => resolve();
    proc.on('close', done);
    proc.on('error', done);
    setTimeout(() => {
      try {
        proc.kill();
      } catch (_) {
        /* ignore */
      }
      done();
    }, 2000);
  });
}

/** Resolve L2/L3 neighbor (ARP) before Socket.IO — avoids needing a manual ping on cold links. */
async function warmupPeerNetwork(host, attempts = 5, port = null) {
  if (!host || process.platform !== 'win32') {
    return;
  }
  for (let i = 0; i < attempts; i++) {
    await pingHostOnce(host);
    if (port) {
      await probeTcpPort(host, port);
    }
    if (i < attempts - 1) {
      await new Promise((r) => setTimeout(r, 400));
    }
  }
}

function clearServerPeerWarmup() {
  if (serverPeerWarmupInterval) {
    clearInterval(serverPeerWarmupInterval);
    serverPeerWarmupInterval = null;
  }
}

/** Ping the client PC periodically until a Socket.IO client connects. */
function startServerPeerWarmup() {
  clearServerPeerWarmup();
  if (!isServer || process.platform !== 'win32') {
    return;
  }
  serverPeerWarmupInterval = setInterval(() => {
    if (!isServer || getLinkedClientCount() > 0) {
      clearServerPeerWarmup();
      return;
    }
    warmupPeerNetwork(CLIENT_IP, 2).catch(() => {});
  }, 5000);
}

function getRoleByIP() {
  const ip = getLocalIPv4();
  if (ip === SERVER_IP) return 'server';
  if (ip === CLIENT_IP) return 'client';
  return 'unknown';
}

function normalizeGameIndex(gameIndex) {
  if (gameIndex === undefined || gameIndex === null || gameIndex === '') {
    return null;
  }
  const n = Number(gameIndex);
  return Number.isInteger(n) ? n : null;
}

function notifyGameSelected(gameIndex) {
  if (!mainWindow || !Array.isArray(GAMES)) {
    return;
  }
  if (!Number.isInteger(gameIndex) || gameIndex < 0 || gameIndex >= GAMES.length) {
    return;
  }
  const game = GAMES[gameIndex];
  try {
    mainWindow.webContents.send('gameSelected', {
      index: gameIndex,
      name: game?.name || '',
      batchPath: game?.batchPath || ''
    });
  } catch (e) {
    console.error('Failed to send gameSelected to renderer:', e);
  }
}

function notifyGameError(message) {
  if (!mainWindow) {
    return;
  }
  try {
    mainWindow.webContents.send('gameError', {
      message: message || 'Failed to start game.'
    });
  } catch (e) {
    console.error('Failed to send gameError to renderer:', e);
  }
}

function clearYieldFocusTimer() {
  if (yieldFocusTimer) {
    clearInterval(yieldFocusTimer);
    yieldFocusTimer = null;
  }
  yieldFocusAttempts = 0;
}

function focusGameWindowOnce() {
  if (process.platform !== 'win32') {
    return;
  }
  const names = GAME_WINDOW_PROCESS_NAMES.map((n) => `'${n}'`).join(',');
  const ps = `
    $names = @(${names})
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class NativeFocus {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
}
"@
    Get-Process | Where-Object { $names -contains $_.ProcessName -and $_.MainWindowHandle -ne [IntPtr]::Zero } | ForEach-Object {
      [NativeFocus]::ShowWindowAsync($_.MainWindowHandle, 9) | Out-Null
      [NativeFocus]::SetForegroundWindow($_.MainWindowHandle) | Out-Null
    }
  `;
  spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], {
    stdio: 'ignore',
    windowsHide: true,
  });
}

/** Minimize the launcher and keep trying to foreground the Unity game. */
function yieldFocusToGame() {
  if (process.platform !== 'win32') {
    return;
  }
  clearYieldFocusTimer();
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.blur();
      mainWindow.minimize();
    }
  } catch (e) {
    console.error('Failed to minimize launcher for game focus:', e);
  }
  const tryFocus = () => {
    yieldFocusAttempts += 1;
    focusGameWindowOnce();
    if (yieldFocusAttempts >= 15) {
      clearYieldFocusTimer();
    }
  };
  tryFocus();
  yieldFocusTimer = setInterval(tryFocus, 800);
}

function notifyGameStarted(gameIndex, gameName) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  try {
    mainWindow.webContents.send('gameStarted', { index: gameIndex, name: gameName || '' });
  } catch (e) {
    console.error('Failed to send gameStarted to renderer:', e);
  }
}

/** Bring the launcher back to the foreground after a game ends. */
function focusLauncherWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  try {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.setFullScreen(true);
    mainWindow.show();
    mainWindow.focus();
  } catch (e) {
    console.error('Failed to focus launcher window:', e);
  }
}

/** Tell the renderer both cabinets should return to the launcher UI. */
function notifyGameClosed() {
  if (gameClosedNotified) {
    return;
  }
  gameClosedNotified = true;
  gameSessionActive = false;
  clearYieldFocusTimer();
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  try {
    mainWindow.webContents.send('gameClosed');
  } catch (e) {
    console.error('Failed to send gameClosed to renderer:', e);
  }
  focusLauncherWindow();
}

function broadcastCloseGameToPeer() {
  if (isClient && clientSocket && clientSocket.connected) {
    clientSocket.emit('closeGame');
  } else if (isServer && serverSocket) {
    serverSocket.sockets.emit('closeGame');
  }
}

function clearProcessMonitor() {
  if (processMonitorInterval) {
    clearInterval(processMonitorInterval);
    processMonitorInterval = null;
  }
}

function killGameProcessHandle(proc) {
  if (!proc) {
    return;
  }
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', proc.pid, '/F', '/T'], { stdio: 'ignore' });
    } else {
      proc.kill('SIGTERM');
    }
  } catch (e) {
    console.error('Error killing game process:', e);
  }
}

/** start.bat exited — return both cabinets unless the script detached immediately. */
function handleGameProcessEnded(fromRemote) {
  if (gameEndHandled) {
    return;
  }
  gameEndHandled = true;

  const elapsed = gameLaunchStartedAt ? Date.now() - gameLaunchStartedAt : Infinity;
  gameProcess = null;
  gameLaunchStartedAt = 0;
  clearProcessMonitor();

  const wasRemoteClose = fromRemote || closingFromRemote;
  closingFromRemote = false;

  // Batches without "start /wait" exit immediately; do not ping closeGame to the peer.
  if (!wasRemoteClose && elapsed < 3000) {
    const label = activeGameName || 'Spiel';
    console.warn(label, 'start script exited after', elapsed, 'ms — skipping peer closeGame.');
    activeGameName = '';
    return;
  }

  activeGameName = '';
  if (!wasRemoteClose) {
    console.log('Game closed locally - notifying peer to return');
    broadcastCloseGameToPeer();
  }
  notifyGameClosed();
}

/** Close local game because the peer ended their session (no re-broadcast). */
function handlePeerCloseGame() {
  console.log('Peer requested game close — returning both cabinets to launcher');
  if (gameProcess) {
    closingFromRemote = true;
    const proc = gameProcess;
    gameProcess = null;
    clearProcessMonitor();
    killGameProcessHandle(proc);
  }
  notifyGameClosed();
}

/** Shared random slot outcome for both arcade cabinets (index + seed for identical reel shuffle). */
function generateSlotSpinPayload() {
  const n = GAMES.length;
  if (!n) {
    return null;
  }
  const targetIndex = getRandomInt(0, n);
  const seed = getRandomInt(1, 2147483646);
  return { targetIndex, seed };
}

function notifySlotSpin(payload, notifyLocalRenderer = true) {
  if (!payload) {
    return;
  }
  if (notifyLocalRenderer && mainWindow) {
    try {
      mainWindow.webContents.send('slotSpinBegin', payload);
    } catch (e) {
      console.error('Failed to send slotSpinBegin to renderer:', e);
    }
  }
  if (isServer && serverSocket) {
    serverSocket.sockets.emit('slotSpin', payload);
  }
}

function attachSlotSpinHandlers(socket) {
  if (!socket) {
    return;
  }
  socket.on('requestSlotSpin', () => {
    if (gameSessionActive || gameProcess) {
      return;
    }
    const payload = generateSlotSpinPayload();
    if (!payload) {
      return;
    }
    console.log('Server: slot spin requested — index', payload.targetIndex, 'seed', payload.seed);
    notifySlotSpin(payload, true);
  });
}

function onClientPassiveSlotSpin(payload) {
  if (clientSpinAwaitingInvoke) {
    return;
  }
  console.log('Client: passive synced slot spin', payload?.targetIndex);
  notifySlotSpin(payload, true);
}

function attachClientPassiveSlotSpinListener() {
  if (!clientSocket) {
    return;
  }
  clientSocket.off('slotSpin', onClientPassiveSlotSpin);
  clientSocket.on('slotSpin', onClientPassiveSlotSpin);
}

// Helper function to close game and notify other PC
function closeGameAndNotify() {
  if (gameProcess) {
    console.log('Closing game process due to window close');
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', gameProcess.pid, '/F', '/T']);
    } else {
      gameProcess.kill('SIGTERM');
    }
    gameProcess = null;
  }
  
  // Notify the other PC
  if (isClient && clientSocket && clientSocket.connected) {
    clientSocket.emit('closeGame');
  } else if (isServer && serverSocket) {
    serverSocket.sockets.emit('closeGame');
  }
}

async function loadGamesConfig() {
  if (!GAMES_CONFIG_FILE) {
    console.warn('No games config file configured for this platform.');
    return;
  }
  try {
    const content = await fs.readFile(GAMES_CONFIG_FILE, 'utf-8');
    const lines = content.split(/\r?\n/);
    const parsed = [];
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) {
        continue;
      }
      const parts = line.split(';');
      if (parts.length < 2) {
        console.warn('Skipping invalid game line in config:', line);
        continue;
      }
      const name = parts[0].trim();
      const batchPath = parts[1].trim();
      const imagePath = parts.length >= 3 ? parts.slice(2).join(';').trim() : '';
      if (!name || !batchPath) {
        console.warn('Skipping invalid game entry (missing name or path):', line);
        continue;
      }
      if (/jumpandrun|superstickman|stickman/i.test(`${name} ${batchPath}`)) {
        console.log('Skipping JumpAndRun (disabled in launcher):', name);
        continue;
      }
      parsed.push({
        name,
        batchPath,
        ...(imagePath ? { imagePath } : {})
      });
    }
    GAMES = parsed;
    console.log('Loaded games from config:', GAMES);
  } catch (e) {
    console.error('Failed to read games config file:', GAMES_CONFIG_FILE, e);
  }
}

// App Lifecycle
app.whenReady().then(async () => {
  await loadGamesConfig();
  createWindow();
  globalShortcut.register('Control+Shift+Q', () => {
    console.log('Ctrl+Shift+Q pressed - quitting');
    app.quit();
  });
});
app.on('window-all-closed', () => {
  globalShortcut.unregisterAll();
  closeGameAndNotify();
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

ipcMain.on('launchGame', async (event, gameIndex) => {
  if (!GAMES.length) {
    await loadGamesConfig();
  }
  let indexToLaunch = normalizeGameIndex(gameIndex);
  if (indexToLaunch === null) {
    if (!GAMES.length) {
      notifyGameError('Keine Spiele geladen. Bitte C:\\Dashboard\\Games\\games.txt pruefen.');
      return;
    }
    indexToLaunch = getRandomInt(0, GAMES.length);
  }
  if (!GAMES.length) {
    notifyGameError('Keine Spiele geladen. Bitte C:\\Dashboard\\Games\\games.txt pruefen.');
    return;
  }
  if (indexToLaunch < 0 || indexToLaunch >= GAMES.length) {
    notifyGameError('Ungueltiger Spielindex. Bitte games.txt pruefen.');
    return;
  }

  const role = getRoleByIP();

  // Client PC (.2): run local start.bat (client build of the game).
  if (role === 'client') {
    console.log('Client: launching game locally with index', indexToLaunch, 'name:', GAMES[indexToLaunch]?.name);
    notifyGameSelected(indexToLaunch);
    launchGame(indexToLaunch);
    return;
  }

  // Server PC (.1): run local start.bat (server/host build of the game).
  if (role === 'server') {
    const clientCount = getLinkedClientCount();
    if (clientCount === 0) {
      console.warn('Server launch: no Socket.IO client counted — launching locally anyway.');
    }
    console.log('Server: launching game locally with index', indexToLaunch, 'name:', GAMES[indexToLaunch]?.name);
    notifyGameSelected(indexToLaunch);
    launchGame(indexToLaunch);
    return;
  }

  console.log('Not connected — cannot launch game (unknown role)');
  notifyGameError('Nicht verbunden — Spiel kann nicht gestartet werden.');
});

ipcMain.on('closeGame', () => {
  if (gameProcess) {
    console.log('Closing game process');
    closingFromRemote = true;
    const proc = gameProcess;
    gameProcess = null;
    clearProcessMonitor();
    killGameProcessHandle(proc);
  }
  broadcastCloseGameToPeer();
  notifyGameClosed();
});
ipcMain.handle('createWsServer', async (event, port) => {
  try {
    const portNum = parseInt(String(port), 10) || SOCKET_PORT;
    serverSocket = new Server(portNum, {
      cors: {
        origin: "*",
        methods: ["GET", "POST"]
      }
    });
    isServer = true;
    isClient = false;
    connectionStatus = 'server';
    
    serverSocket.on('connection', (cs) => {
      console.log('New client connected');
      attachSlotSpinHandlers(cs);

      cs.on('launchGame', (gameIndex) => {
        if (!GAMES.length) {
          console.error('No games configured in GAMES array');
          return;
        }
        let indexToLaunch = gameIndex;
        if (!Number.isInteger(indexToLaunch)) {
          indexToLaunch = getRandomInt(0, GAMES.length);
        }
        if (indexToLaunch < 0 || indexToLaunch >= GAMES.length) {
          console.error('Invalid game index requested by client:', indexToLaunch);
          return;
        }
        console.log(
          'Server: Launching game on server (batch file) with index',
          indexToLaunch,
          'name:',
          GAMES[indexToLaunch]?.name
        );
        notifyGameSelected(indexToLaunch);
        launchGame(indexToLaunch);
        // Broadcast to all clients
        serverSocket.sockets.emit('launchGame', indexToLaunch);
      });
      
      cs.on('closeGame', () => {
        handlePeerCloseGame();
      });
      
      cs.on('disconnect', () => {
        console.log('Client disconnected');
      });
    });
    console.log('created server on port', port);
    return { success: true, port };
  } catch (error) {
    console.error('Error creating server:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('connectWithUrl', async (event, url) => {
  try {
    console.log('Connecting to', url);
    const urlWithProtocol = url.startsWith('http') ? url : `http://${url}`;
    clientSocket = io(urlWithProtocol, {
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: 5
    });
    
    isClient = true;
    isServer = false;
    connectionStatus = 'client';
    
    clientSocket.on('connect', () => {
      console.log('Connected to server');
    });
    
    clientSocket.on('launchGame', (gameIndex) => {
      console.log('Client: received launchGame command - launching client batch with index', gameIndex);
      notifyGameSelected(gameIndex);
      launchGame(gameIndex);
    });

    attachClientPassiveSlotSpinListener();

    clientSocket.on('closeGame', () => {
      handlePeerCloseGame();
    });
    
    clientSocket.on('disconnect', () => {
      console.log('Disconnected from server');
      connectionStatus = 'disconnected';
    });
    
    clientSocket.on('connect_error', (error) => {
      console.error('Connection error:', error);
    });
    
    return {success: true, url };
  } catch (error) {
    console.error('Error connecting:', error);
    return {success: false, error: error.message };
  }
});

ipcMain.handle('stopWsServer', async (event, port) => {
  if (serverSocket){
    clearServerPeerWarmup();
    serverSocket.close();
    serverSocket = null;
    isServer = false;
    connectionStatus = 'disconnected';
    console.log('stopping server');
    return { success: true };
  }
  return { success: false };
});

ipcMain.handle('disconnect', async (event) => {
  if(clientSocket){
    console.log('disconnecting from server');
    clientSocket.close();
    clientSocket = null;
    isClient = false;
    connectionStatus = 'disconnected';
  }
  return { success: true };
});

function getLinkedClientCount() {
  if (!isServer || !serverSocket) {
    return 0;
  }
  const namespace = serverSocket.sockets;
  if (namespace?.sockets instanceof Map) {
    return namespace.sockets.size;
  }
  if (namespace instanceof Map) {
    return namespace.size;
  }
  if (typeof serverSocket.engine?.clientsCount === 'number') {
    return Math.max(0, serverSocket.engine.clientsCount);
  }
  return 0;
}

ipcMain.handle('getConnectionStatus', async () => {
  const linkedClientCount = getLinkedClientCount();
  const clientOnline = isClient && !!clientSocket?.connected;
  let status = 'disconnected';
  if (isServer) {
    status = 'server';
  } else if (clientOnline) {
    status = 'client';
  }
  return {
    status,
    isServer,
    isClient: clientOnline,
    linkedClientCount,
    pairReady: clientOnline || (isServer && linkedClientCount > 0),
    gameSessionActive: gameSessionActive || !!gameProcess,
  };
});

ipcMain.on('quitApp', () => {
  app.quit();
});

ipcMain.handle('getLocalNetworkInfo', async () => {
  const ip = getLocalIPv4();
  const role = getRoleByIP();
  return { ip: ip || 'unknown', role };
});

ipcMain.handle('autoConnect', async (event, targetUrl, port) => {
  const portNum = parseInt(String(port), 10) || SOCKET_PORT;
  const roleByIP = getRoleByIP();
  const serverUrl = `http://${SERVER_IP}:${portNum}`;

  const setupClientListeners = () => {
    clientSocket.on('connect', () => {
      connectionStatus = 'client';
      console.log('Connected to server');
    });
    clientSocket.on('launchGame', (gameIndex) => {
      console.log('Client: received launchGame with index', gameIndex);
      notifyGameSelected(gameIndex);
      launchGame(gameIndex);
    });
    attachClientPassiveSlotSpinListener();
    clientSocket.on('closeGame', () => {
      handlePeerCloseGame();
    });
    clientSocket.on('disconnect', () => { connectionStatus = 'disconnected'; });
    clientSocket.on('connect_error', (err) => console.error('Connection error:', err));
  };

  const setupServerListeners = () => {
    serverSocket.on('connection', (cs) => {
      console.log('New client connected');
      clearServerPeerWarmup();
      attachSlotSpinHandlers(cs);
      cs.on('launchGame', (gameIndex) => {
        if (!GAMES.length) return;
        let idx = Number.isInteger(gameIndex) ? gameIndex : getRandomInt(0, GAMES.length);
        if (idx < 0 || idx >= GAMES.length) return;
        notifyGameSelected(idx);
        launchGame(idx);
        serverSocket.sockets.emit('launchGame', idx);
      });
      cs.on('closeGame', () => {
        handlePeerCloseGame();
      });
      cs.on('disconnect', () => console.log('Client disconnected'));
    });
  };

  if (roleByIP === 'server') {
    try {
      serverSocket = new Server(portNum, { cors: { origin: '*', methods: ['GET', 'POST'] } });
      isServer = true;
      isClient = false;
      connectionStatus = 'server';
      setupServerListeners();
      console.log('Server created on port', portNum, '(this PC is 192.168.10.1)');
      warmupPeerNetwork(CLIENT_IP, 3).catch(() => {});
      startServerPeerWarmup();
      return { success: true, role: 'server', port: portNum };
    } catch (e) {
      console.error('Error creating server:', e);
      return { success: false, error: e.message };
    }
  }

  if (roleByIP === 'client') {
    if (clientSocket) {
      clientSocket.removeAllListeners();
      clientSocket.close();
      clientSocket = null;
    }
    await warmupPeerNetwork(SERVER_IP, 5, portNum);
    return new Promise((resolve) => {
      let settled = false;
      const settle = (result) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(result);
      };

      clientSocket = io(serverUrl, {
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionAttempts: 30,
        timeout: 10000
      });
      isClient = true;
      isServer = false;
      setupClientListeners();

      clientSocket.on('connect_error', (err) => {
        console.error('Connection error (retrying):', err?.message || err);
      });

      clientSocket.once('connect', () => {
        connectionStatus = 'client';
        settle({ success: true, role: 'client', url: serverUrl });
      });

      setTimeout(() => {
        if (clientSocket?.connected) {
          return;
        }
        if (clientSocket) {
          clientSocket.close();
          clientSocket = null;
        }
        isClient = false;
        connectionStatus = 'disconnected';
        settle({
          success: false,
          error:
            'Verbindungs-Timeout (30 s): Dieser PC (192.168.10.2) hat innerhalb von 30 Sekunden keine stabile Verbindung zum Server-PC (192.168.10.1) auf Port ' +
            portNum +
            ' erhalten. Bitte zuerst den Launcher auf dem Server-PC starten, LAN-Kabel pruefen und die Windows-Firewall fuer Port ' +
            portNum +
            ' freigeben.'
        });
      }, 30000);
    });
  }

  const urlWithProtocol = targetUrl.startsWith('http') ? targetUrl : `http://${targetUrl}`;
  const testSocket = io(urlWithProtocol, { timeout: 2000, reconnection: false });
  return new Promise((resolve) => {
    let resolved = false;
    const connectAsClient = () => {
      clientSocket = io(urlWithProtocol, { reconnection: true, reconnectionDelay: 1000, reconnectionAttempts: 5 });
      isClient = true;
      isServer = false;
      connectionStatus = 'client';
      setupClientListeners();
      resolve({ success: true, role: 'client', url: targetUrl });
    };
    const createAsServer = () => {
      try {
        serverSocket = new Server(portNum, { cors: { origin: '*', methods: ['GET', 'POST'] } });
        isServer = true;
        isClient = false;
        connectionStatus = 'server';
        setupServerListeners();
        resolve({ success: true, role: 'server', port: portNum });
      } catch (e) {
        resolve({ success: false, error: e.message });
      }
    };
    testSocket.on('connect', () => {
      if (resolved) return;
      resolved = true;
      testSocket.close();
      connectAsClient();
    });
    testSocket.on('connect_error', () => {
      if (resolved) return;
      resolved = true;
      testSocket.close();
      createAsServer();
    });
    setTimeout(() => {
      if (resolved) return;
      resolved = true;
      testSocket.close();
      createAsServer();
    }, 2500);
  });
});

ipcMain.handle('getGames', async () => {
  return GAMES;
});

ipcMain.handle('beginRandomSpin', async () => {
  if (gameSessionActive || gameProcess) {
    return { error: 'Spiel laeuft bereits.' };
  }
  if (isClient && clientSocket && clientSocket.connected) {
    clientSpinAwaitingInvoke = true;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (payload) => {
        if (settled) {
          return;
        }
        settled = true;
        clientSpinAwaitingInvoke = false;
        clearTimeout(timer);
        clientSocket.off('slotSpin', onSpin);
        resolve(payload);
      };
      const onSpin = (payload) => finish(payload);
      const timer = setTimeout(() => {
        finish({
          error:
            'Spin-Timeout (10 s): Der Server-PC (192.168.10.1) hat die Zufallsziehung nicht beantwortet. Beide Launcher muessen verbunden sein — zuerst Server, dann Client starten.'
        });
      }, 10000);
      clientSocket.once('slotSpin', onSpin);
      clientSocket.emit('requestSlotSpin');
    });
  }

  if (isServer) {
    if (getLinkedClientCount() === 0) {
      return {
        error:
          'Kein zweiter Automat verbunden: Auf PC 1 (Server, 192.168.10.1) laeuft der Launcher, aber PC 2 (Client, 192.168.10.2) ist noch nicht verbunden. Bitte auch dort den Launcher starten und auf „verbunden“ warten, bevor ein Spiel gestartet wird.'
      };
    }
    const payload = generateSlotSpinPayload();
    if (!payload) {
      return { error: 'Keine Spiele geladen — Spin nicht moeglich.' };
    }
    notifySlotSpin(payload, false);
    return payload;
  }

  const payload = generateSlotSpinPayload();
  if (!payload) {
    return { error: 'Keine Spiele geladen — Spin nicht moeglich.' };
  }
  return payload;
});

async function launchGame(gameIndex){
  const index = normalizeGameIndex(gameIndex);
  if (index === null) {
    console.error('Invalid game index for launchGame:', gameIndex);
    notifyGameError('Ungueltiger Spielindex beim Start.');
    return;
  }
  gameIndex = index;

  if (!GAMES.length) {
    await loadGamesConfig();
  }

  if (gameSessionActive || gameProcess) {
    console.warn('Ignoring launch — a game is already running');
    yieldFocusToGame();
    return;
  }

  // Decide which batch/script to run based on current role and game index
  let workDir;
  let game;
  let batchPath;
  let role = getRoleByIP();

  if (process.platform === 'win32') {
    if (!Number.isInteger(gameIndex) || gameIndex < 0 || gameIndex >= GAMES.length) {
      console.error('Invalid game index for launchGame:', gameIndex);
      notifyGameError('Invalid game configuration. Please check games.txt (index out of range).');
      return;
    }
    game = GAMES[gameIndex];
    if (!game) {
      console.error('No game configuration found for index:', gameIndex);
      notifyGameError('No game found for the selected entry. Please check games.txt.');
      return;
    }

    if (!game.batchPath) {
      console.error('Batch path is not configured for game index', gameIndex);
      notifyGameError('No start script configured for this game. Please check games.txt.');
      return;
    }

    batchPath = path.normalize(game.batchPath);
    if (!fsSync.existsSync(batchPath)) {
      console.error('Batch file not found:', batchPath);
      notifyGameError(`Start-Skript nicht gefunden: ${batchPath}`);
      return;
    }

    workDir = path.dirname(batchPath);

    if (role !== 'server' && role !== 'client') {
      console.error('Cannot launch game: unknown arcade role for IP', getLocalIPv4());
      notifyGameError('Spielstart fehlgeschlagen: Dieser PC ist weder Server noch Client.');
      return;
    }

    console.log('Launching batch for game:', game.name, 'path:', batchPath, 'role:', role);
  } else {
    console.error('Batch-file based launch is currently only implemented for Windows');
    return;
  }

  const launchArgs = role === 'server' || role === 'client' ? [role] : [];

  gameSessionActive = true;
  gameClosedNotified = false;
  gameEndHandled = false;
  notifyGameStarted(gameIndex, game?.name);

  // Give the server/host build time to open its socket before the client connects.
  if (role === 'client') {
    console.log('Client: waiting 5s so server game can start first...');
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  const spawnOptions = {
    cwd: workDir,
    detached: false,
    windowsHide: false,
    shell: true,
  };
  gameProcess = spawn(batchPath, launchArgs, spawnOptions);
  gameLaunchStartedAt = Date.now();
  activeGameName = game?.name || '';
  console.log('Launched game process with PID:', gameProcess.pid);
  closingFromRemote = false;
  yieldFocusToGame();

  gameProcess.on('error', (error) => {
    console.error("Error running executable:", error);
    notifyGameError(error?.message || 'Could not start the game process. Please check the start.bat path.');
    gameEndHandled = true;
    gameProcess = null;
    gameLaunchStartedAt = 0;
    activeGameName = '';
    gameSessionActive = false;
    gameClosedNotified = true;
    clearYieldFocusTimer();
    focusLauncherWindow();
  });
  
  gameProcess.on('exit', (code, signal) => {
    console.log(`Game process exited with code ${code} and signal ${signal}`);
    handleGameProcessEnded(false);
  });
  
  // Monitor process on Windows - check if game process still exists
  if (process.platform === 'win32') {
    // Clear any existing monitor
    clearProcessMonitor();
    
    processMonitorInterval = setInterval(() => {
      if (gameProcess) {
        try {
          // Try to check if process exists - on Windows, this throws if process doesn't exist
          process.kill(gameProcess.pid, 0);
        } catch (e) {
          // Process doesn't exist - game was closed externally
          console.log('Game process no longer exists (detected by monitor)');
          handleGameProcessEnded(false);
        }
      } else {
        clearProcessMonitor();
      }
    }, 300); // Check every 300ms for faster detection
  }
}


function getRandomInt(min, max) {
  const minCeiled = Math.ceil(min);
  const maxFloored = Math.floor(max);
  return Math.floor(Math.random() * (maxFloored - minCeiled) + minCeiled); // The maximum is exclusive and the minimum is inclusive
}
async function getFilesOfGameDirectory(){
  // Game directory path
  let directory;
  if (process.platform === 'win32') {
    directory = 'C:\\Temp\\games';
  } else {
    directory = path.join(os.homedir(), '.local');
  }
  
  const files = [];
  try {
    const directoryFiles = await fs.readdir(directory);
    for (const file of directoryFiles) {
      const fullPath = path.join(directory, file);
      try {
        const stats = await fs.stat(fullPath);
        if (stats.isFile() && fullPath.endsWith(".exe")) {
          console.log('adding File', fullPath);
          files.push(fullPath);
        }
      } catch (e) {
        // Skip files that can't be accessed
      }
    }
  } catch (e) {
    console.error('Error reading directory:', e);
  }
  
  gameFiles = files;
  return files;
}
