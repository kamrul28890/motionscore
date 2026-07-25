import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import electron from 'electron';

const { app, BrowserWindow, Menu, shell } = electron;

const desktopDir = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(desktopDir, '..');
let backendServer;
let backendOrigin = '';
let mainWindow;

function findProjectVenv(startDir) {
  let cursor = resolve(startDir);
  for (let depth = 0; depth < 7; depth += 1) {
    const candidate = join(cursor, '.venv', 'Scripts', 'python.exe');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return undefined;
}

function readBuildPythonFallback() {
  if (!app.isPackaged) return undefined;
  try {
    const metadataPath = join(
      app.getAppPath(),
      'desktop',
      'generated',
      'runtime.json',
    );
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
    return typeof metadata.developmentPython === 'string' &&
      existsSync(metadata.developmentPython)
      ? metadata.developmentPython
      : undefined;
  } catch {
    return undefined;
  }
}

function configureAnalyzerEnvironment() {
  const packagedRoot = process.resourcesPath;
  const analyzerScript = app.isPackaged
    ? join(packagedRoot, 'analyzer', 'extract_stems.py')
    : join(sourceRoot, 'packages', 'note-extractor', 'python', 'extract_stems.py');

  process.env.PORT = '0';
  process.env.MOTIONSCORE_PROJECT_ROOT = app.isPackaged ? packagedRoot : sourceRoot;
  process.env.MOTIONSCORE_ANALYZER_SCRIPT = analyzerScript;
  process.env.MOTIONSCORE_CLIENT_DIST = app.isPackaged
    ? join(app.getAppPath(), 'packages', 'web', 'dist', 'client')
    : join(sourceRoot, 'packages', 'web', 'dist', 'client');

  if (!process.env.PYTHON) {
    const bundledPython = join(packagedRoot, 'python', 'Scripts', 'python.exe');
    const discoveredPython =
      (existsSync(bundledPython) ? bundledPython : undefined) ??
      findProjectVenv(app.isPackaged ? packagedRoot : sourceRoot) ??
      readBuildPythonFallback();
    if (discoveredPython) process.env.PYTHON = discoveredPython;
  }
}

async function startBackend() {
  configureAnalyzerEnvironment();
  const serverEntry = app.isPackaged
    ? join(app.getAppPath(), 'desktop', 'generated', 'server.mjs')
    : join(sourceRoot, 'desktop', 'generated', 'server.mjs');
  const module = await import(pathToFileURL(serverEntry).href);
  backendServer = module.server;
  if (!backendServer.listening) await once(backendServer, 'listening');

  const address = backendServer.address();
  if (!address || typeof address === 'string') {
    throw new Error('MotionScore could not determine its local server address.');
  }
  backendOrigin = `http://127.0.0.1:${address.port}`;
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    title: 'MotionScore',
    width: 1500,
    height: 980,
    minWidth: 1040,
    minHeight: 720,
    backgroundColor: '#0d0f13',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  Menu.setApplicationMenu(null);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(backendOrigin)) event.preventDefault();
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = undefined;
  });
  await mainWindow.loadURL(backendOrigin);
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady()
    .then(startBackend)
    .then(createWindow)
    .catch((error) => {
      console.error('[motionscore-desktop] startup failed', error);
      app.quit();
    });
}

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  if (backendServer?.listening) backendServer.close();
});
