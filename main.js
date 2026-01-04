// main.js
'use strict';

const {app, BrowserWindow} = require('electron');
const path = require('path');
const {ipcMain} = require('electron');
const {execFile, spawn} = require('child_process');
const fs = require("node:fs/promises");
const { Server } = require('socket.io');
const io = require('socket.io-client');
const os = require('os');

// Configuration: load games from a human-readable file in C:\Dashboard\Games
// File format (games.txt), one game per line:
//   Spacegame;C:\Dashboard\Games\Spacegame\start.bat
//   JumpAndRun;C:\Dashboard\Games\JumpAndRun\start.bat
// Lines starting with # or empty lines are ignored.
const GAMES_CONFIG_FILE = process.platform === 'win32'
  ? 'C:\\Dashboard\\Games\\games.txt'
  : null;

/** @type {{ name: string; batchPath: string; }[]} */
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
  const _ = win.loadURL("http://localhost:4200");
  
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
let isServer = false;
let isClient = false;
let connectionStatus = 'disconnected'; // disconnected, server, client
let gameFiles = [];
let mainWindow = null;
let processMonitorInterval = null;

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
      const batchPath = parts.slice(1).join(';').trim();
      if (!name || !batchPath) {
        console.warn('Skipping invalid game entry (missing name or path):', line);
        continue;
      }
      parsed.push({ name, batchPath });
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
});
app.on('window-all-closed', () => {
  // Close any running games before quitting
  closeGameAndNotify();
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

ipcMain.on('launchGame', async () => {
  if (isClient && clientSocket && clientSocket.connected) {
    // Client sends request to server (server will pick a random game)
    console.log('Client: sending launch command request to server');
    clientSocket.emit('launchGame');
  } else if (isServer && serverSocket) {
    if (!GAMES.length) {
      console.error('No games configured in GAMES array');
      return;
    }
    const gameIndex = getRandomInt(0, GAMES.length);
    console.log('Server: launching game as server with index', gameIndex, 'name:', GAMES[gameIndex]?.name);
    launchGame(gameIndex);
    // Broadcast to all clients so they launch the same game index
    serverSocket.sockets.emit('launchGame', gameIndex);
  } else {
    console.log('Not connected - attempting auto-connect and launch');
    // Try to auto-connect first
    // This will be handled by the frontend
  }
});

ipcMain.on('closeGame', () => {
  if (gameProcess) {
    console.log('Closing game process');
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
});
ipcMain.handle('createWsServer', async (event, port) => {
  try {
    serverSocket = new Server(port, {
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

      cs.on('launchGame', () => {
        if (!GAMES.length) {
          console.error('No games configured in GAMES array');
          return;
        }
        const gameIndex = getRandomInt(0, GAMES.length);
        console.log('Server: Launching game on server (batch file) with index', gameIndex, 'name:', GAMES[gameIndex]?.name);
        launchGame(gameIndex);
        // Broadcast to all clients
        serverSocket.sockets.emit('launchGame', gameIndex);
      });
      
      cs.on('closeGame', () => {
        console.log('Server: Client requested game close - closing server game and notifying all clients');
        if (gameProcess) {
          try {
            console.log('Server: Attempting to close game process with PID:', gameProcess.pid);
            if (process.platform === 'win32') {
              // On Windows, try kill first, then use taskkill as fallback
              try {
                gameProcess.kill('SIGTERM');
                // Give it a moment, then force kill if still running
                setTimeout(() => {
                  if (gameProcess) {
                    console.log('Server: Force killing game process with taskkill');
                    spawn('taskkill', ['/pid', gameProcess.pid, '/F', '/T'], { stdio: 'ignore' });
                  }
                }, 500);
              } catch (e) {
                console.log('Server: Using taskkill to close game');
                spawn('taskkill', ['/pid', gameProcess.pid, '/F', '/T'], { stdio: 'ignore' });
              }
            } else {
              gameProcess.kill('SIGTERM');
              setTimeout(() => {
                if (gameProcess) {
                  gameProcess.kill('SIGKILL');
                }
              }, 1000);
            }
          } catch (e) {
            console.error('Error closing game:', e);
          }
          gameProcess = null;
          // Clear monitoring interval
          if (processMonitorInterval) {
            clearInterval(processMonitorInterval);
            processMonitorInterval = null;
          }
          console.log('Server: Game process closed');
        }
        // Broadcast to all clients (including the one that sent it, but that's okay)
        serverSocket.sockets.emit('closeGame');
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
      launchGame(gameIndex);
    });
    
    clientSocket.on('closeGame', () => {
      console.log('Client: received closeGame command - closing game');
      if (gameProcess) {
        try {
          console.log('Client: Attempting to close game process with PID:', gameProcess.pid);
          // Try to kill the process directly first
          if (process.platform === 'win32') {
            // On Windows, try kill first, then use taskkill as fallback
            try {
              gameProcess.kill('SIGTERM');
              // Give it a moment, then force kill if still running
              setTimeout(() => {
                if (gameProcess) {
                  console.log('Client: Force killing game process with taskkill');
                  spawn('taskkill', ['/pid', gameProcess.pid, '/F', '/T'], { stdio: 'ignore' });
                }
              }, 500);
            } catch (e) {
              console.log('Client: Using taskkill to close game');
              spawn('taskkill', ['/pid', gameProcess.pid, '/F', '/T'], { stdio: 'ignore' });
            }
          } else {
            gameProcess.kill('SIGTERM');
            setTimeout(() => {
              if (gameProcess) {
                gameProcess.kill('SIGKILL');
              }
            }, 1000);
          }
        } catch (e) {
          console.error('Error closing game:', e);
        }
        gameProcess = null;
        // Clear monitoring interval
        if (processMonitorInterval) {
          clearInterval(processMonitorInterval);
          processMonitorInterval = null;
        }
        console.log('Client: Game process closed');
      } else {
        console.log('Client: No game process to close');
      }
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
  return { status: connectionStatus, isServer, isClient };
});

ipcMain.handle('autoConnect', async (event, targetUrl, port) => {
  // Try to connect first, if fails, become server
  try {
    const urlWithProtocol = targetUrl.startsWith('http') ? targetUrl : `http://${targetUrl}`;
    const testSocket = io(urlWithProtocol, {
      timeout: 2000,
      reconnection: false
    });
    
    return new Promise((resolve) => {
      let resolved = false;
      
      const connectAsClient = async () => {
        try {
          console.log('Connecting to', targetUrl);
          const urlWithProtocol = targetUrl.startsWith('http') ? targetUrl : `http://${targetUrl}`;
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
            console.log('Client: received launchGame command with index', gameIndex);
            launchGame(gameIndex);
          });
          
          clientSocket.on('closeGame', () => {
            console.log('Client: received closeGame command');
            if (gameProcess) {
              if (process.platform === 'win32') {
                spawn('taskkill', ['/pid', gameProcess.pid, '/F', '/T']);
              } else {
                gameProcess.kill('SIGTERM');
              }
              gameProcess = null;
            }
          });
          
          clientSocket.on('disconnect', () => {
            console.log('Disconnected from server');
            connectionStatus = 'disconnected';
          });
          
          clientSocket.on('connect_error', (error) => {
            console.error('Connection error:', error);
          });
          
          return {success: true, url: targetUrl };
        } catch (error) {
          console.error('Error connecting:', error);
          return {success: false, error: error.message };
        }
      };
      
      const createAsServer = async () => {
        try {
          serverSocket = new Server(port, {
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

            cs.on('launchGame', () => {
              if (!GAMES.length) {
                console.error('No games configured in GAMES array');
                return;
              }
              const gameIndex = getRandomInt(0, GAMES.length);
              console.log('Server: Launching game on server (batch file) with index', gameIndex, 'name:', GAMES[gameIndex]?.name);
              launchGame(gameIndex);
              serverSocket.sockets.emit('launchGame', gameIndex);
            });
            
            cs.on('closeGame', () => {
              console.log('Server: Client requested game close - closing server game and notifying all clients');
              if (gameProcess) {
                try {
                  console.log('Server: Attempting to close game process with PID:', gameProcess.pid);
                  if (process.platform === 'win32') {
                    try {
                      gameProcess.kill('SIGTERM');
                      setTimeout(() => {
                        if (gameProcess) {
                          console.log('Server: Force killing game process with taskkill');
                          spawn('taskkill', ['/pid', gameProcess.pid, '/F', '/T'], { stdio: 'ignore' });
                        }
                      }, 500);
                    } catch (e) {
                      console.log('Server: Using taskkill to close game');
                      spawn('taskkill', ['/pid', gameProcess.pid, '/F', '/T'], { stdio: 'ignore' });
                    }
                  } else {
                    gameProcess.kill('SIGTERM');
                    setTimeout(() => {
                      if (gameProcess) {
                        gameProcess.kill('SIGKILL');
                      }
                    }, 1000);
                  }
                } catch (e) {
                  console.error('Error closing game:', e);
                }
                gameProcess = null;
                if (processMonitorInterval) {
                  clearInterval(processMonitorInterval);
                  processMonitorInterval = null;
                }
                console.log('Server: Game process closed');
              }
              serverSocket.sockets.emit('closeGame');
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
      };
      
      testSocket.on('connect', async () => {
        if (resolved) return;
        resolved = true;
        testSocket.close();
        // Server exists, become client
        const result = await connectAsClient();
        resolve({ success: true, role: 'client', ...result });
      });
      
      testSocket.on('connect_error', async () => {
        if (resolved) return;
        resolved = true;
        testSocket.close();
        // No server found, become server
        const result = await createAsServer();
        resolve({ success: true, role: 'server', ...result });
      });
      
      setTimeout(async () => {
        if (resolved) return;
        resolved = true;
        testSocket.close();
        // Timeout, become server
        const result = await createAsServer();
        resolve({ success: true, role: 'server', ...result });
      }, 2000);
    });
  } catch (error) {
    // On error, become server
    try {
      serverSocket = new Server(port, {
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

        cs.on('launchGame', () => {
          if (!GAMES.length) {
            console.error('No games configured in GAMES array');
            return;
          }
          const gameIndex = getRandomInt(0, GAMES.length);
          console.log('Server: Launching game on server (batch file) with index', gameIndex, 'name:', GAMES[gameIndex]?.name);
          launchGame(gameIndex);
          serverSocket.sockets.emit('launchGame', gameIndex);
        });
        
        cs.on('closeGame', () => {
          console.log('Server: Client requested game close - closing server game and notifying all clients');
          if (gameProcess) {
            try {
              console.log('Server: Attempting to close game process with PID:', gameProcess.pid);
              if (process.platform === 'win32') {
                try {
                  gameProcess.kill('SIGTERM');
                  setTimeout(() => {
                    if (gameProcess) {
                      console.log('Server: Force killing game process with taskkill');
                      spawn('taskkill', ['/pid', gameProcess.pid, '/F', '/T'], { stdio: 'ignore' });
                    }
                  }, 500);
                } catch (e) {
                  console.log('Server: Using taskkill to close game');
                  spawn('taskkill', ['/pid', gameProcess.pid, '/F', '/T'], { stdio: 'ignore' });
                }
              } else {
                gameProcess.kill('SIGTERM');
                setTimeout(() => {
                  if (gameProcess) {
                    gameProcess.kill('SIGKILL');
                  }
                }, 1000);
              }
            } catch (e) {
              console.error('Error closing game:', e);
            }
            gameProcess = null;
            if (processMonitorInterval) {
              clearInterval(processMonitorInterval);
              processMonitorInterval = null;
            }
            console.log('Server: Game process closed');
          }
          serverSocket.sockets.emit('closeGame');
        });
        
        cs.on('disconnect', () => {
          console.log('Client disconnected');
        });
      });
      console.log('created server on port', port);
      return { success: true, role: 'server', port };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
});

async function launchGame(gameIndex){
  // Close existing game if running
  if (gameProcess) {
    console.log('Closing existing game before launching new one');
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', gameProcess.pid, '/F', '/T']);
    } else {
      gameProcess.kill('SIGTERM');
    }
    gameProcess = null;
  }

  // Decide which batch/script to run based on current role and game index
  let command;
  let args = [];

  if (process.platform === 'win32') {
    if (!Number.isInteger(gameIndex) || gameIndex < 0 || gameIndex >= GAMES.length) {
      console.error('Invalid game index for launchGame:', gameIndex);
      return;
    }
    const game = GAMES[gameIndex];
    if (!game) {
      console.error('No game configuration found for index:', gameIndex);
      return;
    }

    if (!game.batchPath) {
      console.error('Batch path is not configured for game index', gameIndex);
      return;
    }

    // Both PCs run the same start.bat for the selected game.
    // One PC's start.bat should start the server version, the other PC's start.bat the client version.
    console.log('Launching batch for game:', game.name, 'path:', game.batchPath, 'role:', isServer ? 'server' : (isClient ? 'client' : 'unknown'));
    command = 'cmd.exe';
    args = ['/c', game.batchPath];

    if (!isServer && !isClient) {
      console.error('Cannot launch game: instance is neither server nor client');
      return;
    }
  } else {
    console.error('Batch-file based launch is currently only implemented for Windows');
    return;
  }

  gameProcess = spawn(command, args, {
    detached: false
  });
  console.log('Launched game process with PID:', gameProcess.pid);
  
  gameProcess.on('error', (error) => {
    console.error("Error running executable:", error);
    gameProcess = null;
  });
  
  gameProcess.on('exit', (code, signal) => {
    console.log(`Game process exited with code ${code} and signal ${signal}`);
    const wasGameProcess = gameProcess;
    gameProcess = null;
    
    // Clear monitoring interval
    if (processMonitorInterval) {
      clearInterval(processMonitorInterval);
      processMonitorInterval = null;
    }
    
    // Notify the other PC that game closed
    if (isClient && clientSocket && clientSocket.connected) {
      console.log('Client: Game closed - notifying server');
      clientSocket.emit('closeGame');
    } else if (isServer && serverSocket) {
      console.log('Server: Game closed - notifying all clients');
      serverSocket.sockets.emit('closeGame');
    }
  });
  
  // Monitor process on Windows - check if game process still exists
  if (process.platform === 'win32') {
    // Clear any existing monitor
    if (processMonitorInterval) {
      clearInterval(processMonitorInterval);
    }
    
    processMonitorInterval = setInterval(() => {
      if (gameProcess) {
        try {
          // Try to check if process exists - on Windows, this throws if process doesn't exist
          process.kill(gameProcess.pid, 0);
        } catch (e) {
          // Process doesn't exist - game was closed externally
          console.log('Game process no longer exists (detected by monitor) - notifying other PC');
          const wasGameProcess = gameProcess;
          gameProcess = null;
          if (processMonitorInterval) {
            clearInterval(processMonitorInterval);
            processMonitorInterval = null;
          }
          
          // Notify the other PC to close their game
          if (isClient && clientSocket && clientSocket.connected) {
            console.log('Client: Game closed externally - notifying server');
            clientSocket.emit('closeGame');
          } else if (isServer && serverSocket) {
            console.log('Server: Game closed externally - notifying all clients');
            serverSocket.sockets.emit('closeGame');
          }
        }
      } else {
        if (processMonitorInterval) {
          clearInterval(processMonitorInterval);
          processMonitorInterval = null;
        }
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
