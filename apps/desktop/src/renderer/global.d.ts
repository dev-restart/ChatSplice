import type { ChatSpliceBridge } from '../preload/index.js';

declare global {
  interface Window {
    readonly chatsplice: ChatSpliceBridge;
  }
}

export {};
