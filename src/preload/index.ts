import { contextBridge, ipcRenderer } from 'electron';
import { UCHAT_IPC } from '@shared/ipc';
import type { ChatMessage, NetworkEvent, Peer, UchatAPI } from '@shared/types';

const on = <Payload>(channel: string, callback: (payload: Payload) => void): (() => void) => {
  const listener = (_event: Electron.IpcRendererEvent, payload: Payload): void => {
    callback(payload);
  };

  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

const uchat: UchatAPI = {
  getAppState: () => ipcRenderer.invoke(UCHAT_IPC.getAppState),
  setProfile: (input) => ipcRenderer.invoke(UCHAT_IPC.setProfile, input),
  joinRoom: (input) => ipcRenderer.invoke(UCHAT_IPC.joinRoom, input),
  listPeers: () => ipcRenderer.invoke(UCHAT_IPC.listPeers),
  listConversations: () => ipcRenderer.invoke(UCHAT_IPC.listConversations),
  sendMessage: (input) => ipcRenderer.invoke(UCHAT_IPC.sendMessage, input),
  onPeerUpdated: (callback) => on<Peer>(UCHAT_IPC.peerUpdated, callback),
  onMessageReceived: (callback) => on<ChatMessage>(UCHAT_IPC.messageReceived, callback),
  onNetworkEvent: (callback) => on<NetworkEvent>(UCHAT_IPC.networkEvent, callback)
};

contextBridge.exposeInMainWorld('uchat', Object.freeze(uchat));

