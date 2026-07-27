import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { Member } from '../../../domain/member/member.js';
import type { AuthService, AuthSession } from '../../../application/auth-service.js';
import { memberDto } from '../dto.js';
import { SESSION_COOKIE, isNativeClient, sessionToken } from '../session.js';

/** Limite anti force-brute des routes d'authentification publiques. */
const AUTH_RATE_LIMIT = { max: 10, timeWindow: '1 minute' };

export interface AuthRoutesOptions {
  authService: AuthService;
  /** Cookie de session en `Secure` (obligatoire derrière HTTPS en production). */
  cookieSecure: boolean;
}

export const authRoutes: FastifyPluginAsync<AuthRoutesOptions> = async (app, { authService, cookieSecure }) => {
  function setSessionCookie(reply: FastifyReply, session: AuthSession): void {
    reply.setCookie(SESSION_COOKIE, session.token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: cookieSecure,
      expires: session.expiresAt,
    });
  }

  /**
   * Établit la session : cookie (web) et, pour l'app native, le token dans le corps pour
   * qu'elle le stocke et le renvoie ensuite en `Authorization: Bearer`.
   */
  function authenticated(request: FastifyRequest, reply: FastifyReply, member: Member, session: AuthSession) {
    setSessionCookie(reply, session);
    const body: { member: ReturnType<typeof memberDto>; token?: string } = { member: memberDto(member) };
    if (isNativeClient(request)) {
      body.token = session.token;
    }
    return body;
  }

  app.get('/api/auth/me', { config: { public: true } }, async (request) => {
    const token = sessionToken(request);
    const member = token ? await authService.authenticate(token) : null;
    return {
      member: member ? memberDto(member) : null,
      needsBootstrap: await authService.needsBootstrap(),
    };
  });

  app.post<{ Body: { name: string; email?: string | null; password: string } }>(
    '/api/auth/bootstrap',
    { config: { public: true, rateLimit: AUTH_RATE_LIMIT } },
    async (request, reply) => {
      const { member, session } = await authService.bootstrap(request.body);
      return reply.status(201).send(authenticated(request, reply, member, session));
    },
  );

  app.post<{ Body: { identifier: string; password: string } }>(
    '/api/auth/login',
    { config: { public: true, rateLimit: AUTH_RATE_LIMIT } },
    async (request, reply) => {
      const { member, session } = await authService.login(request.body.identifier, request.body.password);
      return reply.send(authenticated(request, reply, member, session));
    },
  );

  app.post('/api/auth/logout', async (request, reply) => {
    const token = sessionToken(request);
    if (token) {
      await authService.logout(token);
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.status(204).send();
  });

  app.get<{ Params: { code: string } }>(
    '/api/auth/invites/:code',
    { config: { public: true, rateLimit: AUTH_RATE_LIMIT } },
    async (request) => {
      const member = await authService.inviteInfo(request.params.code);
      return { memberName: member.name };
    },
  );

  app.post<{ Params: { code: string }; Body: { password: string } }>(
    '/api/auth/invites/:code/redeem',
    { config: { public: true, rateLimit: AUTH_RATE_LIMIT } },
    async (request, reply) => {
      const { member, session } = await authService.redeemInvite(request.params.code, request.body.password);
      return reply.send(authenticated(request, reply, member, session));
    },
  );

  app.post<{ Body: { currentPassword: string; newPassword: string } }>('/api/auth/password', async (request, reply) => {
    const session = await authService.changePassword(
      request.authMember.id,
      request.body.currentPassword,
      request.body.newPassword,
    );
    // Le changement révoque toutes les sessions du membre, celle-ci comprise : on repose le cookie
    // (et on rend le jeton à l'app native) pour ne pas déconnecter l'auteur de son propre geste.
    return reply.send(authenticated(request, reply, request.authMember, session));
  });
};
