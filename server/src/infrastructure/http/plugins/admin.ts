import type { FastifyPluginAsync } from 'fastify';
import type { AuthService } from '../../../application/auth-service.js';
import type { MemberMergeService } from '../../../application/member-merge-service.js';
import { directoryMemberDto, memberDto } from '../dto.js';
import { id, idParams, nullableText, object, query, text } from '../schema.js';
import { limit } from '../rate-limit.js';
import type { RateLimits } from '../rate-limit.js';
import '../session.js'; // augmentation de type : request.authMember

/**
 * Routes réservées à l'administrateur de l'instance — le compte du bootstrap, ou celui que
 * l'opérateur a désigné (`npm run admin:designate`).
 *
 * Elles vivent sous `/api/admin` plutôt que d'élargir les routes existantes : `/api/members` reste
 * cadré sur le périmètre relationnel de son demandeur, et rien de ce qui est ici ne s'ouvre par
 * inadvertance à un membre ordinaire. Le refus, lui, est rendu avant toute lecture des comptes
 * visés : il dit « geste réservé », jamais si tel identifiant existe.
 */
export interface AdminRoutesOptions {
  authService: AuthService;
  mergeService: MemberMergeService;
  rateLimits: RateLimits;
}

/** Les deux comptes de la fusion, tels qu'ils circulent en paramètres de requête. */
const mergePair = { absorbedId: id, keptId: id };

export const adminRoutes: FastifyPluginAsync<AdminRoutesOptions> = async (
  app,
  { authService, mergeService, rateLimits },
) => {
  /**
   * Tous les membres de l'instance. Un doublon naît justement de la perte du dernier cercle
   * commun : l'écran de fusion ne peut pas montrer les deux comptes en se cadrant sur ce qui
   * n'existe plus.
   */
  app.get('/api/admin/members', async (request) => {
    const entries = await mergeService.listMembers(request.authMember.id);
    return entries.map(directoryMemberDto);
  });

  /**
   * Ce que la fusion déplacerait. Sans ce décompte, la confirmation se ferait à l'aveugle sur un
   * geste qu'aucune route ne défait — c'est la posture de la suppression d'équipement, qui annonce
   * ce qu'elle emporte avant de l'emporter.
   */
  app.get<{ Querystring: { absorbedId: string; keptId: string } }>(
    '/api/admin/members/merge-preview',
    { schema: { querystring: { ...query(mergePair), required: ['absorbedId', 'keptId'] } } },
    async (request) => {
      const { absorbedId, keptId } = request.query;
      return mergeService.preview(request.authMember.id, absorbedId, keptId);
    },
  );

  /**
   * Lien de réinitialisation pour un membre qui a perdu son mot de passe. Il vit ici parce qu'il
   * est réservé à l'administrateur — la garde est dans le service, comme pour la fusion — et
   * parce qu'il remplace précisément ce que la fusion servait à rattraper : recréer la personne,
   * puis réunir les deux comptes.
   *
   * Le code n'est rendu qu'une fois, dans cette réponse : rien ne le garde côté client, et
   * l'administrateur le transmet hors application (WhatsApp, SMS…), comme un lien de première
   * connexion. En base et dans le chemin des routes publiques qui le consomment, il est en
   * revanche en clair, comme un code d'invitation : limite connue, documentée au README, à
   * corriger pour les deux codes à la fois.
   */
  app.post<{ Params: { id: string } }>(
    '/api/admin/members/:id/password-reset',
    {
      // Chaque appel émet de quoi reprendre un compte en service : plafond serré, comme la fusion.
      config: { rateLimit: limit(rateLimits.sensitive) },
      schema: { params: idParams },
    },
    async (request, reply) => {
      const { member, resetCode } = await authService.startPasswordReset(request.params.id, request.authMember.id);
      // La trace du geste part au journal des gestes sensibles, depuis le service.
      return reply.status(201).send({ memberName: member.name, resetCode });
    },
  );

  app.post<{
    Body: { absorbedId: string; keptId: string; name?: string; email?: string | null };
  }>(
    '/api/admin/members/merge',
    {
      // Une identité absorbée, des sessions révoquées, quinze tables réécrites : le geste le plus
      // lourd de l'API, et il n'est pas de ceux qu'on répète.
      config: { rateLimit: limit(rateLimits.sensitive) },
      schema: { body: object({ ...mergePair, name: text(120), email: nullableText(254) }, ['absorbedId', 'keptId']) },
    },
    async (request, reply) => {
      const { absorbedId, keptId, name, email } = request.body;
      const { member, counts } = await mergeService.merge(request.authMember.id, absorbedId, keptId, { name, email });
      // La trace du geste part au journal des gestes sensibles, depuis le service : elle y porte
      // les compteurs et le nom du compte disparu, que cette réponse ne rend plus.
      return reply.send({ member: memberDto(member), counts });
    },
  );
};
