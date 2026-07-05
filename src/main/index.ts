import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
import { UCHAT_IPC } from '@shared/ipc';
import type { JoinRoomInput, NetworkEvent, SendMessageInput, SetProfileInput } from '@shared/types';
import { createUchatAppService, type UchatAppService } from './appService';
import { createJsonFileStorage } from './storage/jsonFileStorage';

let mainWindow: BrowserWindow | null = null;

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
      sandbox: true
    }
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
};

const emitNetworkEvent = (event: NetworkEvent): void => {
  mainWindow?.webContents.send(UCHAT_IPC.networkEvent, event);
};

const registerIpcHandlers = (service: UchatAppService): void => {
  ipcMain.handle(UCHAT_IPC.getAppState, () => service.getAppState());

  ipcMain.handle(UCHAT_IPC.setProfile, (_event, input: SetProfileInput) => service.setProfile(input));

  ipcMain.handle(UCHAT_IPC.joinRoom, (_event, input: JoinRoomInput) => service.joinRoom(input));

  ipcMain.handle(UCHAT_IPC.listPeers, () => service.listPeers());
  ipcMain.handle(UCHAT_IPC.listConversations, () => service.listConversations());

  ipcMain.handle(UCHAT_IPC.sendMessage, (_event, input: SendMessageInput) => service.sendMessage(input));
};

app.whenReady().then(() => {
  const storage = createJsonFileStorage(join(app.getPath('userData'), 'storage.json'));
  const service = createUchatAppService(storage, emitNetworkEvent);
  registerIpcHandlers(service);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
