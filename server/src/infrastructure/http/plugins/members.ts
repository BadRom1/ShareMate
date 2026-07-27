import type { FastifyPluginAsync } from 'fastify';
import type { AuthService } from '../../../application/auth-service.js';
import type { MemberService } from '../../../application/member-service.js';
import { directoryMemberDto, memberDto } from '../dto.js';
import { idParams, nullableText, object, text } from '../schema.js';
import { limit } from '../rate-limit.js';
import type { RateLimits } from '../rate-limit.js';
import '../session.js'; // augmentation de type : request.authMember

/** Membres : utilisateurs globaux, dont le cercle est porté par les équipements. */
export interface MemberRoutesOptions {
  authService: AuthService;
  memberService: MemberService;
  rateLimits: RateLimits;
}

export const memberRoutes: FastifyPluginAsync<MemberRoutesOptions> = async (
  app,
  { authService, memberService, rateLimits },
) => {
  app.post<{ Body: { name: string; email?: string | null } }>(
    '/api/members',
    {
      // Chaque appel ouvre un compte et émet un lien d'invitation : plafond serré.
      config: { rateLimit: limit(rateLimits.sensitive) },
      schema: { body: object({ name: text(120), email: nullableText(254) }, ['name']) },
    },
    async (request, reply) => {
      const { member, inviteCode } = await authService.createMemberWithInvite(request.body, request.authMember.id);
      return reply.status(201).send({ ...memberDto(member), hasPassword: false, inviteCode });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/members/:id/invite',
    { schema: { params: idParams } },
    async (request, reply) => {
      const inviteCode = await authService.regenerateInvite(request.params.id, request.authMember.id);
      if (request.params.id !== request.authMember.id) {
        // Geste sensible : le lien produit ouvre un compte qui n'est pas celui du demandeur.
        app.log.warn(
          { requesterId: request.authMember.id, targetId: request.params.id },
          'invitation régénérée pour un autre membre',
        );
      }
      return reply.status(201).send({ inviteCode });
    },
  );

  app.get('/api/members', async (request) => {
    const entries = await memberService.listVisibleMembers(request.authMember.id);
    return entries.map(directoryMemberDto);
  });
};
