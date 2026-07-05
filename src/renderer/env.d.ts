import type { UchatAPI } from '@shared/types';

declare global {
  interface Window {
    uchat: UchatAPI;
  }
}

export {};

