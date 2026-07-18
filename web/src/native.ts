/**
 * Pont vers l'environnement natif Capacitor.
 *
 * En WebView native, les cookies cross-origin ne sont pas fiables : l'authentification
 * repose donc sur un token de session stocké dans le stockage natif (`@capacitor/preferences`)
 * et renvoyé au serveur via `Authorization: Bearer`. En web, ce module est inerte
 * (`isNative === false`) et l'auth reste sur le cookie httpOnly.
 */
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';

export const isNative = Capacitor.isNativePlatform();

const TOKEN_KEY = 'sharemate_session_token';
let token: string | null = null;

/** Charge le token persisté en mémoire. À appeler une fois au démarrage (no-op en web). */
export async function loadToken(): Promise<void> {
  if (!isNative) return;
  token = (await Preferences.get({ key: TOKEN_KEY })).value;
}

/** Persiste (ou efface, avec `null`) le token de session. */
export async function setToken(value: string | null): Promise<void> {
  token = value;
  if (!isNative) return;
  if (value) {
    await Preferences.set({ key: TOKEN_KEY, value });
  } else {
    await Preferences.remove({ key: TOKEN_KEY });
  }
}

export function getToken(): string | null {
  return token;
}
