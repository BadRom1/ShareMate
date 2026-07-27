import type { FastifyRequest } from 'fastify';
import type { Member } from '../../domain/member/member.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Membre authentifié, posé par le hook de session sur les routes protégées. */
    authMember: Member;
  }
  interface FastifyContextConfig {
    /** Route accessible sans session (login, invitation, santé…). */
    public?: boolean;
  }
}

export const SESSION_COOKIE = 'sharemate_session';

/** En-tête posé par l'app native pour recevoir le token de session dans le corps. */
export const CLIENT_HEADER = 'x-sharemate-client';

/**
 * Token de session, depuis le cookie (web) ou l'en-tête `Authorization: Bearer` (app native,
 * où les cookies cross-origin ne sont pas fiables en WebView).
 */
export function sessionToken(request: FastifyRequest): string | undefined {
  const cookieToken = request.cookies[SESSION_COOKIE];
  if (cookieToken) return cookieToken;
  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    const token = header.slice('Bearer '.length).trim();
    if (token) return token;
  }
  return undefined;
}

/** L'app native s'annonce pour recevoir le token de session (le web reste sur cookie httpOnly). */
export function isNativeClient(request: FastifyRequest): boolean {
  return request.headers[CLIENT_HEADER] === 'native';
}
