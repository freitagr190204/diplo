// main.js
'use strict';

const {app, BrowserWindow, globalShortcut, Menu} = require('electron');
const path = require('path');
const {ipcMain} = require('electron');
const {execFile, spawn} = require('child_process');
const fs = require("node:fs/promises");
const fsSync = require('node:fs');
const { Server } = require('socket.io');
const io = require('socket.io-client');
const os = require('os');

app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

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
    width: 1280,
    height: 720,
    fullscreen: true,
    kiosk: true,
    frame: false,
    autoHideMenuBar: true,
    focusable: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      backgroundThrottling: false,
    }
  });

  mainWindow = win;
  win.setMenuBarVisibility(false);
  win.setAlwaysOnTop(true, 'screen-saver');
  win.webContents.setBackgroundThrottling(false);

  win.on('blur', () => {
    scheduleClaimLauncherFocus();
  });
  win.on('leave-full-screen', () => {
    if (holdLauncherFocus) {
      scheduleClaimLauncherFocus();
    }
  });
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
  
  win.on('close', () => {
    requestCloseGameSession();
  });
  
  return win;
}

let serverSocket;
let clientSocket;
let gameProcess = null;
/** Keep the launcher in the foreground unless a game is running. */
let holdLauncherFocus = true;
let claimFocusTimer = null;
let gameLaunchStartedAt = 0;
let gameEndHandled = false;
let gameSessionActive = false;
let isServer = false;
let isClient = false;
let connectionStatus = 'disconnected'; // disconnected, server, client
let gameFiles = [];
let mainWindow = null;
let processMonitorInterval = null;
/** Client wartet auf slotSpin-Antwort fuer lokalen Hebelzug (kein zweites slotSpinBegin). */
let clientSpinAwaitingInvoke = false;
/** Blocks a second slot spin until launch/return (spin + countdown + client wait). */
let slotSpinLockedUntil = 0;
let autoConnectInFlight = null;

const SERVER_IP = '192.168.10.1';
const CLIENT_IP = '192.168.10.2';
const SOCKET_PORT = 4203;

function getLocalIPv4() {
  const nets = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      const family = net.family === 'IPv4' || net.family === 4;
      if (family && !net.internal) {
        addresses.push(net.address);
      }
    }
  }
  if (addresses.includes(SERVER_IP)) {
    return SERVER_IP;
  }
  if (addresses.includes(CLIENT_IP)) {
    return CLIENT_IP;
  }
  return addresses[0] || null;
}

function getLinkedClientCount() {
  if (isServer && serverSocket?.sockets?.sockets) {
    return serverSocket.sockets.sockets.size;
  }
  return 0;
}

function getRoleByIP() {
  const ip = getLocalIPv4();
  if (ip === SERVER_IP) return 'server';
  if (ip === CLIENT_IP) return 'client';
  return 'unknown';
}

function scheduleClaimLauncherFocus() {
  if (!holdLauncherFocus || gameSessionActive) {
    return;
  }
  if (claimFocusTimer) {
    clearTimeout(claimFocusTimer);
  }
  claimFocusTimer = setTimeout(() => {
    claimFocusTimer = null;
    claimLauncherFocus();
  }, 80);
}

function claimLauncherFocus() {
  if (!holdLauncherFocus || gameSessionActive || !mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  try {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    if (!mainWindow.isVisible()) {
      mainWindow.show();
    }
    if (!mainWindow.isFullScreen()) {
      mainWindow.setFullScreen(true);
    }
    if (typeof mainWindow.setKiosk === 'function') {
      mainWindow.setKiosk(true);
    }
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
    mainWindow.show();
    mainWindow.focus();
    if (typeof mainWindow.moveTop === 'function') {
      mainWindow.moveTop();
    }
    app.focus({ steal: true });
  } catch (e) {
    console.error('Failed to reclaim launcher focus:', e);
  }
}

function releaseLauncherFocus() {
  holdLauncherFocus = false;
  if (claimFocusTimer) {
    clearTimeout(claimFocusTimer);
    claimFocusTimer = null;
  }
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  try {
    mainWindow.setAlwaysOnTop(false);
    if (typeof mainWindow.setKiosk === 'function') {
      mainWindow.setKiosk(false);
    }
    mainWindow.blur();
    mainWindow.minimize();
  } catch (e) {
    console.error('Failed to release launcher focus:', e);
  }
}

function notifyGameStarted() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  try {
    mainWindow.webContents.send('gameStarted');
  } catch (e) {
    console.error('Failed to send gameStarted to renderer:', e);
  }
}

function notifyGameClosed() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  try {
    mainWindow.webContents.send('gameClosed');
  } catch (e) {
    console.error('Failed to send gameClosed to renderer:', e);
  }
}

function isSlotSpinLocked() {
  return gameSessionActive || !!gameProcess || Date.now() < slotSpinLockedUntil;
}

function lockSlotSpin() {
  slotSpinLockedUntil = Date.now() + 25000;
}

function clearSlotSpinLock() {
  slotSpinLockedUntil = 0;
}

function killGameProcessTree() {
  if (!gameProcess) {
    return;
  }
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(gameProcess.pid), '/F', '/T'], { stdio: 'ignore' });
    } else {
      gameProcess.kill('SIGTERM');
    }
  } catch (e) {
    console.error('Failed to kill game process:', e);
  }
  gameProcess = null;
}

function restoreLauncherAfterGame() {
  const wasActive = gameSessionActive || !!gameProcess || Date.now() < slotSpinLockedUntil;
  gameSessionActive = false;
  clearSlotSpinLock();
  holdLauncherFocus = true;
  claimLauncherFocus();
  if (wasActive) {
    notifyGameClosed();
  }
}

function applyRemoteCloseGame() {
  gameEndHandled = true;
  if (processMonitorInterval) {
    clearInterval(processMonitorInterval);
    processMonitorInterval = null;
  }
  killGameProcessTree();
  restoreLauncherAfterGame();
}

function emitCloseGameToPeer() {
  if (isClient && clientSocket && clientSocket.connected) {
    clientSocket.emit('closeGame');
  } else if (isServer && serverSocket) {
    serverSocket.sockets.emit('closeGame');
  }
}

function requestCloseGameSession() {
  if (!gameSessionActive && !gameProcess && Date.now() >= slotSpinLockedUntil) {
    return;
  }
  gameEndHandled = true;
  if (processMonitorInterval) {
    clearInterval(processMonitorInterval);
    processMonitorInterval = null;
  }
  killGameProcessTree();
  emitCloseGameToPeer();
  restoreLauncherAfterGame();
}

function spawnGameBatch(batchPath, role, workDir) {
  if (process.platform === 'win32') {
    return spawn('cmd.exe', ['/d', '/s', '/c', `call "${batchPath}" ${role}`], {
      cwd: workDir,
      detached: false,
      windowsHide: false,
    });
  }
  return spawn(batchPath, [role], {
    cwd: workDir,
    detached: false,
  });
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
    if (isSlotSpinLocked()) {
      return;
    }
    const payload = generateSlotSpinPayload();
    if (!payload) {
      return;
    }
    console.log('Server: slot spin requested — index', payload.targetIndex, 'seed', payload.seed);
    lockSlotSpin();
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
  requestCloseGameSession();
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
  Menu.setApplicationMenu(null);
  await loadGamesConfig();
  createWindow();
  claimLauncherFocus();
  globalShortcut.register('Control+Shift+Q', () => {
    console.log('Ctrl+Shift+Q pressed - quitting');
    app.quit();
  });
  globalShortcut.register('Control+Shift+E', () => {
    console.log('Ctrl+Shift+E pressed - ending game session');
    requestCloseGameSession();
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
  if (gameSessionActive || gameProcess) {
    console.warn('Ignoring launch — a game is already running');
    return;
  }
  if (!GAMES.length) {
    await loadGamesConfig();
  }
  if (!GAMES.length) {
    notifyGameError('Keine Spiele geladen. Bitte C:\\Dashboard\\Games\\games.txt pruefen.');
    return;
  }
  let indexToLaunch = gameIndex;
  if (!Number.isInteger(indexToLaunch)) {
    indexToLaunch = getRandomInt(0, GAMES.length);
  }
  if (indexToLaunch < 0 || indexToLaunch >= GAMES.length) {
    notifyGameError('Ungueltiger Spielindex. Bitte games.txt pruefen.');
    return;
  }
  console.log('Launching locally with index', indexToLaunch, 'name:', GAMES[indexToLaunch]?.name);
  notifyGameSelected(indexToLaunch);
  launchGame(indexToLaunch);
});

ipcMain.on('closeGame', () => {
  requestCloseGameSession();
});

ipcMain.on('refocusLauncher', () => {
  scheduleClaimLauncherFocus();
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

      cs.on('closeGame', () => {
        console.log('Server: Client requested game close');
        applyRemoteCloseGame();
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
    
    attachClientPassiveSlotSpinListener();

    clientSocket.on('closeGame', () => {
      console.log('Client: received closeGame command');
      applyRemoteCloseGame();
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

function waitForExistingClient(serverUrl, timeoutMs) {
  return new Promise((resolve) => {
    if (clientSocket?.connected) {
      resolve({ success: true, role: 'client', url: serverUrl });
      return;
    }
    if (!clientSocket) {
      resolve({ success: false, error: 'Nicht verbunden' });
      return;
    }
    const onConnect = () => {
      cleanup();
      resolve({ success: true, role: 'client', url: serverUrl });
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve({
        success: false,
        error:
          'Verbindungs-Timeout (6 s): Dieser PC (192.168.10.2) hat innerhalb von 6 Sekunden keine Antwort vom Server-PC (192.168.10.1) auf Port 4203 erhalten. Bitte zuerst den Launcher auf dem Server-PC starten, LAN-Kabel pruefen und die Windows-Firewall fuer Port 4203 freigeben.'
      });
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      clientSocket?.off('connect', onConnect);
    };
    clientSocket.once('connect', onConnect);
  });
}

ipcMain.handle('autoConnect', async (event, targetUrl, port) => {
  if (autoConnectInFlight) {
    return autoConnectInFlight;
  }
  autoConnectInFlight = doAutoConnect(targetUrl, port).finally(() => {
    autoConnectInFlight = null;
  });
  return autoConnectInFlight;
});

async function doAutoConnect(targetUrl, port) {
  const portNum = parseInt(String(port), 10) || SOCKET_PORT;
  const roleByIP = getRoleByIP();
  const serverUrl = `http://${SERVER_IP}:${portNum}`;

  if (isServer && serverSocket) {
    return { success: true, role: 'server', port: portNum };
  }
  if (isClient && clientSocket?.connected) {
    return { success: true, role: 'client', url: serverUrl };
  }

  const setupClientListeners = () => {
    clientSocket.on('connect', () => {
      connectionStatus = 'client';
      console.log('Connected to server');
    });
    attachClientPassiveSlotSpinListener();
    clientSocket.on('closeGame', () => {
      console.log('Client: received closeGame');
      applyRemoteCloseGame();
    });
    clientSocket.on('disconnect', () => { connectionStatus = 'disconnected'; });
    clientSocket.on('connect_error', (err) => console.error('Connection error:', err));
  };

  const setupServerListeners = () => {
    serverSocket.on('connection', (cs) => {
      console.log('New client connected');
      attachSlotSpinHandlers(cs);
      cs.on('closeGame', () => {
        console.log('Server: client requested closeGame');
        applyRemoteCloseGame();
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
      return { success: true, role: 'server', port: portNum };
    } catch (e) {
      console.error('Error creating server:', e);
      return { success: false, error: e.message };
    }
  }

  if (roleByIP === 'client') {
    if (clientSocket) {
      return waitForExistingClient(serverUrl, 6000);
    }
    return new Promise((resolve) => {
      clientSocket = io(serverUrl, {
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionAttempts: Infinity,
        timeout: 5000
      });
      isClient = true;
      isServer = false;
      connectionStatus = 'client';
      setupClientListeners();

      const onConnect = () => {
        clientSocket.off('connect', onConnect);
        resolve({ success: true, role: 'client', url: serverUrl });
      };

      clientSocket.once('connect', onConnect);

      setTimeout(() => {
        if (clientSocket && !clientSocket.connected) {
          clientSocket.off('connect', onConnect);
          resolve({
            success: false,
            error:
              'Verbindungs-Timeout (6 s): Dieser PC (192.168.10.2) hat innerhalb von 6 Sekunden keine Antwort vom Server-PC (192.168.10.1) auf Port ' +
              portNum +
              ' erhalten. Bitte zuerst den Launcher auf dem Server-PC starten, LAN-Kabel pruefen und die Windows-Firewall fuer Port ' +
              portNum +
              ' freigeben.'
          });
        }
      }, 6000);
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
}

ipcMain.handle('getGames', async () => {
  return GAMES;
});

ipcMain.handle('beginRandomSpin', async () => {
  if (isSlotSpinLocked()) {
    return { error: 'Spiel laeuft bereits.' };
  }
  if (isClient && clientSocket && clientSocket.connected) {
    lockSlotSpin();
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
        if (payload?.error) {
          clearSlotSpinLock();
        }
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
          'Kein zweiter Automat verbunden: Bitte zuerst den Launcher auf PC 2 (192.168.10.2) starten und warten, bis die Verbindung steht.'
      };
    }
    const payload = generateSlotSpinPayload();
    if (!payload) {
      return { error: 'Keine Spiele geladen — Spin nicht moeglich.' };
    }
    lockSlotSpin();
    notifySlotSpin(payload, false);
    return payload;
  }

  return {
    error: 'Nicht verbunden: Bitte warten, bis beide Automaten verbunden sind.'
  };
});

function handleLocalGameEnded() {
  if (gameEndHandled) {
    return;
  }
  gameEndHandled = true;
  if (processMonitorInterval) {
    clearInterval(processMonitorInterval);
    processMonitorInterval = null;
  }
  const elapsed = gameLaunchStartedAt ? Date.now() - gameLaunchStartedAt : Infinity;
  gameProcess = null;

  if (elapsed < 3000) {
    console.warn('start.bat exited after', elapsed, 'ms — keeping session (no start /wait?). Use Ctrl+Shift+E to return.');
    notifyGameError(
      'start.bat wurde sofort beendet (kein start /wait?). Das Spiel des Partners laeuft weiter. Ctrl+Shift+E bringt diesen Launcher zurueck.'
    );
    return;
  }

  emitCloseGameToPeer();
  restoreLauncherAfterGame();
}

async function launchGame(gameIndex){
  if (gameSessionActive || gameProcess) {
    console.warn('Ignoring launch — a game is already running');
    return;
  }

  if (process.platform !== 'win32') {
    console.error('Batch-file based launch is currently only implemented for Windows');
    return;
  }

  if (!Number.isInteger(gameIndex) || gameIndex < 0 || gameIndex >= GAMES.length) {
    console.error('Invalid game index for launchGame:', gameIndex);
    notifyGameError('Invalid game configuration. Please check games.txt (index out of range).');
    return;
  }
  const game = GAMES[gameIndex];
  if (!game) {
    notifyGameError('No game found for the selected entry. Please check games.txt.');
    return;
  }
  if (!game.batchPath) {
    notifyGameError('No start script configured for this game. Please check games.txt.');
    return;
  }
  if (!isServer && !isClient) {
    console.error('Cannot launch game: instance is neither server nor client');
    notifyGameError('Spielstart fehlgeschlagen: Dieser PC ist weder Server noch Client.');
    return;
  }

  const batchPath = path.normalize(game.batchPath);
  if (!fsSync.existsSync(batchPath)) {
    notifyGameError(`Start-Skript nicht gefunden: ${batchPath}`);
    return;
  }

  const workDir = path.dirname(batchPath);
  const role = isServer ? 'server' : 'client';
  console.log('Launching batch for game:', game.name, 'path:', batchPath, 'role:', role);

  gameSessionActive = true;
  gameEndHandled = false;
  notifyGameStarted();
  releaseLauncherFocus();

  if (role === 'client') {
    console.log('Client: waiting 5s so the host game can listen first...');
    await new Promise((resolve) => setTimeout(resolve, 5000));
    if (!gameSessionActive || gameEndHandled) {
      console.warn('Launch aborted after client wait — session already closed');
      return;
    }
  }

  gameLaunchStartedAt = Date.now();
  gameProcess = spawnGameBatch(batchPath, role, workDir);
  console.log('Launched game process with PID:', gameProcess.pid);

  gameProcess.on('error', (error) => {
    console.error("Error running executable:", error);
    notifyGameError(error?.message || 'Could not start the game process. Please check the start.bat path.');
    gameProcess = null;
    gameEndHandled = true;
    restoreLauncherAfterGame();
  });

  gameProcess.on('exit', (code, signal) => {
    console.log(`Game process exited with code ${code} and signal ${signal}`);
    handleLocalGameEnded();
  });

  if (processMonitorInterval) {
    clearInterval(processMonitorInterval);
  }
  processMonitorInterval = setInterval(() => {
    if (!gameProcess) {
      clearInterval(processMonitorInterval);
      processMonitorInterval = null;
      return;
    }
    try {
      process.kill(gameProcess.pid, 0);
    } catch (e) {
      console.log('Game process no longer exists (detected by monitor)');
      handleLocalGameEnded();
    }
  }, 300);
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
