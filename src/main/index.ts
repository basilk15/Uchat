import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
import { UCHAT_IPC } from '@shared/ipc';
import type { ChatMessage, NetworkEvent, Peer } from '@shared/types';
import { parseJoinRoomInput, parseSendMessageInput, parseSetProfileInput } from '@shared/validation';
import { createUchatAppService, type UchatAppService } from './appService';
import { createSqliteStorage } from './storage/sqliteStorage';
import { resolveRendererUrlToLoad } from './rendererUrl';

let mainWindow: BrowserWindow | null = null;
let appService: UchatAppService | null = null;
let cleanupStarted = false;

if (process.platform === 'linux') {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
}

const createWindow = (): void => {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 720,
    minWidth: 860,
    minHeight: 560,
    title: 'Uchat',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error(`[uchat] Preload failed at ${preloadPath}:`, error);
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[uchat] Renderer process exited: ${details.reason} (${details.exitCode}).`);
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (isMainFrame) {
      console.error(`[uchat] Renderer failed to load ${validatedURL}: ${errorCode} ${errorDescription}.`);
    }
  });

  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 2) {
      console.error(`[uchat:renderer] ${message} (${sourceId}:${line})`);
    }
  });

  const rendererUrl = resolveRendererUrlToLoad({
    isPackaged: app.isPackaged,
    rendererUrl: process.env.ELECTRON_RENDERER_URL
  });

  if (rendererUrl) {
    void mainWindow.loadURL(rendererUrl);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
};

const emitNetworkEvent = (event: NetworkEvent): void => {
  mainWindow?.webContents.send(UCHAT_IPC.networkEvent, event);
};

const emitPeerUpdated = (peer: Peer): void => {
  mainWindow?.webContents.send(UCHAT_IPC.peerUpdated, peer);
};

const emitPeerRemoved = (peerId: string): void => {
  mainWindow?.webContents.send(UCHAT_IPC.peerRemoved, peerId);
};

const emitMessageReceived = (message: ChatMessage): void => {
  mainWindow?.webContents.send(UCHAT_IPC.messageReceived, message);
};

const registerIpcHandlers = (service: UchatAppService): void => {
  ipcMain.handle(UCHAT_IPC.getAppState, () => service.getAppState());

  ipcMain.handle(UCHAT_IPC.setProfile, (_event, input: unknown) =>
    service.setProfile(parseSetProfileInput(input))
  );

  ipcMain.handle(UCHAT_IPC.joinRoom, (_event, input: unknown) => service.joinRoom(parseJoinRoomInput(input)));

  ipcMain.handle(UCHAT_IPC.listPeers, () => service.listPeers());
  ipcMain.handle(UCHAT_IPC.listConversations, () => service.listConversations());

  ipcMain.handle(UCHAT_IPC.sendMessage, (_event, input: unknown) =>
    service.sendMessage(parseSendMessageInput(input))
  );
};

app.whenReady().then(() => {
  const storage = createSqliteStorage(join(app.getPath('userData'), 'uchat.sqlite3'));
  const service = createUchatAppService(storage, emitNetworkEvent, {
    onPeerUpdated: emitPeerUpdated,
    onPeerRemoved: emitPeerRemoved,
    onMessageReceived: emitMessageReceived
  });
  appService = service;
  registerIpcHandlers(service);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', (event) => {
  if (!appService || cleanupStarted) {
    return;
  }

  event.preventDefault();
  cleanupStarted = true;
  void appService.cleanup().finally(() => {
    app.quit();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
