import { contextBridge, ipcRenderer } from 'electron';
import { UCHAT_IPC } from '@shared/ipc';
import type {
  ChatMessage,
  JoinRoomInput,
  LocalProfile,
  NetworkEvent,
  Peer,
  SendMessageInput,
  RetryMessageInput,
  SetProfileInput,
  UchatAPI,
  UchatAppState
} from '@shared/types';
import { parseJoinRoomInput, parseRetryMessageInput, parseSendMessageInput, parseSetProfileInput } from '@shared/validation';

const on = <Payload>(channel: string, callback: (payload: Payload) => void): (() => void) => {
  const listener = (_event: Electron.IpcRendererEvent, payload: Payload): void => {
    callback(payload);
  };

  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

const invokeValidated = <Input, Output>(
  channel: string,
  input: Input,
  parse: (value: unknown) => Input
): Promise<Output> => {
  try {
    return ipcRenderer.invoke(channel, parse(input)) as Promise<Output>;
  } catch (error) {
    return Promise.reject(error);
  }
};

const uchat: UchatAPI = {
  getAppState: () => ipcRenderer.invoke(UCHAT_IPC.getAppState),
  setProfile: (input) =>
    invokeValidated<SetProfileInput, LocalProfile>(UCHAT_IPC.setProfile, input, parseSetProfileInput),
  joinRoom: (input) =>
    invokeValidated<JoinRoomInput, UchatAppState>(UCHAT_IPC.joinRoom, input, parseJoinRoomInput),
  listPeers: () => ipcRenderer.invoke(UCHAT_IPC.listPeers),
  listConversations: () => ipcRenderer.invoke(UCHAT_IPC.listConversations),
  sendMessage: (input) =>
    invokeValidated<SendMessageInput, ChatMessage>(UCHAT_IPC.sendMessage, input, parseSendMessageInput),
  retryMessage: (input) =>
    invokeValidated<RetryMessageInput, ChatMessage>(UCHAT_IPC.retryMessage, input, parseRetryMessageInput),
  onPeerUpdated: (callback) => on<Peer>(UCHAT_IPC.peerUpdated, callback),
  onPeerRemoved: (callback) => on<string>(UCHAT_IPC.peerRemoved, callback),
  onMessageReceived: (callback) => on<ChatMessage>(UCHAT_IPC.messageReceived, callback),
  onNetworkEvent: (callback) => on<NetworkEvent>(UCHAT_IPC.networkEvent, callback)
};

contextBridge.exposeInMainWorld('uchat', Object.freeze(uchat));
