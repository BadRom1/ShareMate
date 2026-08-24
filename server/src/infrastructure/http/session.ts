import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Member } from '../../domain/member/member.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Membre authentifié, posé par le hook de session sur les routes protégées. */
    authMember: Member;
  }
  interface FastifyContextConfig {
    /** Route accessible sans session (login, invitation, santé…). */
    public?: boolean;
    /**
     * Poids maximal accepté par cette route de dépôt. Le refus est émis par le greffon multipart
     * pendant la lecture du flux, donc hors de la route : c'est par là que le gestionnaire
     * d'erreurs retrouve le plafond à annoncer, qui n'est pas le même pour un justificatif que
     * pour un document.
     */
    maxFileBytes?: number;
  }
}

export const SESSION_COOKIE = 'sharemate_session';

/** Token de session, porté par le cookie httpOnly. */
export function sessionToken(request: FastifyRequest): string | undefined {
  return request.cookies[SESSION_COOKIE];
}

/**
 * Pose le cookie de session à l'échéance donnée. Repartagé entre l'ouverture de session et sa
 * prolongation glissante : sans repose, le cookie garde l'échéance initiale et le navigateur
 * l'oublie alors que la session serveur, elle, court toujours.
 */
export function setSessionCookie(reply: FastifyReply, token: string, expiresAt: Date, secure: boolean): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure,
    expires: expiresAt,
  });
}
