import { useEffect } from 'react';

import { applyEvent } from '@/lib/call';
import { stopDemo } from '@/lib/demo';
import { parseServerEvent } from '@/lib/protocol';
import { webSocketUrl } from '@/lib/server';
import { connectSimulation } from '@/lib/simulation';
import { createStore, settingsStore, useStore } from '@/lib/store';

export type ConnectionStatus = 'not-set-up' | 'connecting' | 'online' | 'offline';

export const connectionStore = createStore<ConnectionStatus>('not-set-up');

/**
 * Keeps one WebSocket open to the server while the app runs, reconnecting with backoff.
 * Every frame is a JSON event from protocol.ts.
 */
function connect(url: string): () => void {
  let ws: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let closed = false;

  const open = () => {
    connectionStore.set('connecting');
    ws = new WebSocket(url);
    ws.onopen = () => {
      attempt = 0;
      connectionStore.set('online');
    };
    ws.onmessage = (msg) => {
      if (typeof msg.data !== 'string') return;
      const event = parseServerEvent(msg.data);
      if (!event) {
        console.warn('Ignoring unknown server message', msg.data.slice(0, 200));
        return;
      }
      // A real call takes over from any demo that is playing.
      if (event.type === 'call.started') stopDemo();
      applyEvent(event, false);
    };
    ws.onerror = () => {
      // onclose follows and handles the retry.
    };
    ws.onclose = () => {
      ws = null;
      if (closed) return;
      connectionStore.set('offline');
      const delay = Math.min(15000, 1000 * 2 ** attempt);
      attempt += 1;
      retry = setTimeout(open, delay);
    };
  };

  open();
  return () => {
    closed = true;
    if (retry) clearTimeout(retry);
    ws?.close();
    connectionStore.set('not-set-up');
  };
}

/** Web simulation: follow calls on Abhi's agent server (see simulation.ts). */
function connectSim(url: string, token: string): () => void {
  connectionStore.set('connecting');
  const stop = connectSimulation(
    url,
    token,
    (event) => {
      if (event.type === 'call.started') stopDemo();
      applyEvent(event, false);
    },
    (online) => connectionStore.set(online ? 'online' : 'offline'),
  );
  return () => {
    stop();
    connectionStore.set('not-set-up');
  };
}

/**
 * Mount once at the root. Connects to the server picked in Setup (phone or web simulation)
 * and reconnects whenever the switch, an address or the phone number changes.
 */
export function useServerConnection() {
  const { backend, serverUrl, simServerUrl, simToken, myPhone } = useStore(settingsStore);
  useEffect(() => {
    if (backend === 'web') {
      if (!simServerUrl.trim()) {
        connectionStore.set('not-set-up');
        return;
      }
      return connectSim(simServerUrl, simToken);
    }
    if (!serverUrl.trim() || !myPhone.trim()) {
      connectionStore.set('not-set-up');
      return;
    }
    return connect(webSocketUrl(serverUrl, myPhone));
  }, [backend, serverUrl, simServerUrl, simToken, myPhone]);
}
