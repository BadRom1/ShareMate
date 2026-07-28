# Audit de sécurité et de qualité de code — ShareMate

Audit réalisé sur la branche `claude/code-quality-security-audit-go7qaf`
(commit de base `d9b491e`), juillet 2026.

Périmètre : intégralité du code applicatif (`server/src`, `web/src`), configuration de build,
Dockerfile, CI, dépendances. Les projets natifs générés (`web/android`) ne sont pas audités.

Méthode : lecture intégrale des sources, exécution de la suite de tests (236 tests, 25 fichiers,
tous verts), du lint, du typecheck, de la couverture (96,8 % lignes) et de `npm audit`. Chaque
constat marqué **[vérifié]** a été reproduit par un test d'intégration exécuté contre l'application
réelle (`buildApp` + SQLite en mémoire), puis supprimé du dépôt.

---

## Synthèse

L'architecture est saine et rare à ce niveau de soin sur un projet de cette taille : hexagone
réellement respecté (et vérifié par ESLint), domaine pur et testé à 100 %, `Money` en centimes
entiers, `TimeRange` à fin exclusive, requêtes SQL exclusivement paramétrées, CI complète
(lint + format + types + couverture bloquante + audit npm + CodeQL + Dependabot), image Docker
non-root. Aucune injection SQL, aucun secret en dur, aucun `dangerouslySetInnerHTML`.

Le problème principal n'est pas technique mais **structurel** : le cloisonnement par cercle a été
construit avec beaucoup de rigueur sur tout ce qui pend à un équipement, mais **les routes de gestion
des membres sont restées hors de ce modèle**. Elles donnent à n'importe quel membre authentifié la
capacité de prendre le contrôle de n'importe quel compte de l'instance — ce qui annule intégralement
l'isolation des cercles.

| Sévérité | Nombre | Constats       |
| -------- | ------ | -------------- |
| Critique | 1      | S1             |
| Élevée   | 2      | S2, S3         |
| Moyenne  | 4      | S4, S5, S6, Q1 |
| Faible   | 6      | S7 → S12       |
| Qualité  | 11     | Q2 → Q12       |

---

## Suivi des corrections — 27 juillet 2026

Ajouté après coup. Le diagnostic ci-dessous n'a pas été retouché : il reste l'état des lieux daté
qu'il était, et chaque constat porte désormais sa ligne **Résolution**.

> **Ce tableau a été corrigé après relecture adversariale** : plusieurs statuts « corrigé » étaient
> faux ou partiels, et la relecture a trouvé cinq défauts que le diagnostic initial n'avait pas vus,
> dont un contournement d'authentification qui annulait la prémisse de S1, S2 et S4. Voir
> [Deuxième passe](#deuxième-passe--relecture-adversariale--27-juillet-2026), qui fait foi.

La suite de tests est passée de 236 à 441 (361 serveur, 80 front), tous verts.

| Constat | Statut                | Commit                          |
| ------- | --------------------- | ------------------------------- |
| S1      | Corrigé (2ᵉ passe)    | `5291d19`, `02d65e2`            |
| S2      | Corrigé               | `5291d19`                       |
| S3      | Corrigé               | `5291d19`                       |
| S4      | Corrigé (2ᵉ passe)    | `bfcf604`, `25ed70e`, `40bbb26` |
| S5      | Corrigé (2ᵉ passe)    | `2e70acf`, `d0358fe`            |
| S6      | Corrigé               | `9526070`                       |
| S7      | Corrigé               | `9ccd3b7`                       |
| S8      | Corrigé               | `4954ad7`                       |
| S9      | **Ouvert**            | —                               |
| S10     | Corrigé               | `9dcef5f`                       |
| S11     | Corrigé               | `5291d19`                       |
| S12     | Corrigé               | `2e70acf`                       |
| Dépend. | **Ouvert**            | —                               |
| Q1      | Corrigé               | `1601077`                       |
| Q2      | Corrigé (2ᵉ passe)    | `f4c97bc`, `381d33a`, `7ee5a5e` |
| Q3      | Corrigé (cache exclu) | `f068da5`, `2a47590`            |
| Q4      | Corrigé               | `3ad6ba8`                       |
| Q5      | Corrigé (2ᵉ passe)    | `a483676`, `40bbb26`            |
| Q6      | **Partiel**           | `1783773`, `f4d10b8`, `0acb9ad` |
| Q7      | Corrigé               | `c2a8e1c`                       |
| Q8      | Corrigé (2ᵉ passe)    | `0d3a030`, `f33c073`            |
| Q9      | Corrigé               | `a38adb2`                       |
| Q10     | Corrigé               | `2d25524`                       |
| Q11     | Corrigé               | `5291d19`                       |
| Q12     | Corrigé (2ᵉ passe)    | `af10429`, `f33c073`            |

**Ce qui reste ouvert**

- **S9** — `trustProxy` vaut toujours `true` en production (`main.ts`) : Fastify fait confiance à
  toute la chaîne `X-Forwarded-For`. Tant que le service n'est joignable que par le proxy Railway,
  le risque est nul ; il redevient réel le jour où une autre voie d'accès existe. Le README le dit
  maintenant explicitement dans « ce qui n'est pas protégé ».
- **Dépendances** — `npm audit` remonte toujours 23 vulnérabilités (22 high, 1 critique), toutes en
  dépendances de développement via `tar` transitif de `@capacitor/assets`. `npm run audit:prod`
  répond toujours 0 : l'artefact déployé n'est pas concerné, et la CI reste verte.
- **Q3, partiellement** — les filtres de périmètre sont descendus en SQL et les N+1 supprimés, mais
  les soldes et le plan de règlement sont toujours recalculés à chaque appel, sans cache. C'est
  assumé : le calcul est désormais cadré sur un seul équipement, pas sur l'instance.

**Constat ajouté à la relecture d'ensemble — doubles de test infidèles**

Les doubles en mémoire (`application/testing/in-memory.ts`), sur lesquels tourne toute la suite
unitaire de la couche application, rendaient leurs listes dans l'ordre d'insertion là où l'adapter
SQLite les trie (annuaire et équipements par nom, réservations par début, relevés par date,
dépenses et remboursements du plus récent au plus ancien) et sans le plafond de 100 notifications
appliqué en base. Aucun test n'échouait — les fixtures étaient déjà dans le bon ordre — mais la
suite n'attestait pas de ce que fait la production. L'ordre fait désormais partie du contrat écrit
dans `ports.ts`, et `infrastructure/persistence/sqlite/port-contract.test.ts` le joue à l'identique
sur les deux implémentations.

## Deuxième passe — relecture adversariale — 27 juillet 2026

Deux relecteurs ont audité le travail de remédiation ci-dessus, preuve à l'appui (tests exécutés
contre `buildApp`). Leur verdict d'ensemble : sept des douze constats de sécurité étaient réellement
et solidement traités (S3, S6, S7, S8, S10, S11, S12), mais **la prémisse sur laquelle S1, S2 et S4
étaient écrits était fausse**, deux régressions avaient été introduites par la vague de correctifs,
et quatre constats de qualité étaient donnés « corrigés » alors qu'ils étaient partiels.

Tous les constats ci-dessous ont été reproduits avant correction, et chacun porte un test qui
échouait avant et passe après.

### B1 — CRITIQUE — La garde de session se contournait par un chemin encodé

`app.ts` décidait d'exiger une session à partir de `request.raw.url`, **non décodé**, alors que le
routeur Fastify décode le pourcentage avant d'apparier. `POST /%61pi/uploads/receipts` atteignait
donc le handler de `/api/uploads/receipts` **sans aucune session** : dépôt anonyme de fichiers de
10 Mo sur le disque, jamais purgés (`purgeOrphanReceipts` ne rattrape que les fichiers d'une dépense
effacée) ; `DELETE /%61pi/notifications/device-tokens` détruisait le canal push d'un membre ;
`GET /%61pi/members` tournait avec `request.authMember` non posé et échouait en 500.

Le défaut **préexistait** à la vague de correctifs, qui ne l'a pas touché — mais il annulait
l'essentiel de S1, S2 et S4, et rendait fausse l'affirmation de Q2 selon laquelle « toute route
`/api/*` ou `/uploads/*` exige une session » et « les plugins de domaine en héritent ».

> **Résolution — corrigé (`381d33a`).** Le périmètre protégé n'est plus deviné d'un préfixe textuel :
> il est porté par la composition. Les plugins de domaine sont enregistrés dans un contexte Fastify
> encapsulé qui porte le hook `onRequest` ; toute route qu'ils déclarent exige une session sauf
> `config.public` explicite — refus par défaut. Les routes hors de ce contexte (front statique,
> `/api/health`) sont publiques par construction. Effet de bord assumé : une route d'API inconnue
> rend 404 sans session au lieu de 401, aucune route n'ayant été appariée.

### B2 — ÉLEVÉE — S1 n'était refermé qu'à moitié : les comptes jamais ouverts

La garde `existing?.hasPassword` ne mord qu'après la première connexion. Entre la création d'un
membre et son redeem, la chaîne d'origine — annuaire, régénération d'invitation, redeem —
fonctionnait intégralement : l'attaquant choisissait le mot de passe, héritait des cercles de sa
cible (y compris ceux où il n'était pas) et enfermait le titulaire dehors définitivement. Le champ
`hasPassword`, **ajouté par le correctif de S1 lui-même**, lui désignait les comptes prenables.

> **Résolution — corrigé (`02d65e2`).** La régénération est réservée au titulaire et à son invitant.
> Le cercle commun ne suffit plus : il se compose sans l'intéressé (voir B3), donc il ne peut pas
> ouvrir un geste de reprise de compte. Hors de ce couple, le refus reste masqué en « membre
> introuvable ».

### B3 — ÉLEVÉE — Le prédicat de périmètre était inscriptible par l'attaquant

`POST /api/equipments` et `PUT /api/equipments/:id` acceptaient n'importe quel `memberIds` : il
suffisait de connaître un identifiant pour inscrire son porteur dans un cercle, sans son accord.
Le périmètre — sur lequel reposent le cadrage de l'annuaire (S2) et la garde de S1 — s'écrivait donc
à la demande par celui qu'il était censé borner.

> **Résolution — corrigé (`02d65e2`).** Un membre ne peut inscrire dans un cercle que des membres de
> son propre périmètre relationnel (`member-scope.ts` : soi-même, ses cercles, son invitant et ses
> invités). Un identifiant hors périmètre reçoit le message d'un identifiant inconnu, pour ne pas
> les distinguer. Le périmètre reste extensible de proche en proche — c'est ce qui permet de composer
> un cercle — mais chaque ajout est fait par quelqu'un qui a déjà une relation avec l'ajouté, et il
> ne porte aucun geste irréversible : la régénération d'invitation, elle, s'en tient à l'invitant.

### B4 — MOYENNE — Régression : oracle d'énumération d'emails (introduit par `af10429`)

L'invariant d'unicité d'email ajouté au titre de Q12 répondait 409 « Cette adresse email est déjà
utilisée par un autre membre » pour toute adresse présente **dans l'instance entière**. N'importe
quel membre authentifié énumérait ainsi, adresse par adresse, les comptes des autres cercles :
exactement le canal que le cadrage de l'annuaire (S2) devait fermer.

> **Résolution — corrigé (`02d65e2`).** La collision n'est plus cherchée que dans le périmètre du
> demandeur, où il voit déjà ces adresses — le refus ne lui apprend rien. Hors périmètre, le doublon
> est accepté. L'ambiguïté que l'invariant visait reste théorique : `login` n'ouvre que le compte
> dont le mot de passe correspond, et l'attaquant ne le connaît pas. Une garde à l'échelle de
> l'instance ne peut pas exister sans répondre « cette adresse est prise » à qui la sonde.

### B5 — MOYENNE — Aucun contrôle de propriétaire sur les canaux push

`DELETE /api/notifications/subscriptions` et `/device-tokens` supprimaient sur la seule connaissance
de l'endpoint ou du jeton : `unsubscribeWebPush(endpoint)` et `unregisterDeviceToken(token)` ne
prenaient pas d'identifiant de membre. Or ces valeurs circulent et ne prouvent rien. Effet : coupure
silencieuse des alertes push d'un tiers — dont la notification `EQUIPMENT_CIRCLE_CHANGED` que le
correctif de S10 avait ajoutée pour qu'une éviction ne passe pas inaperçue.

> **Résolution — corrigé (`926609d`).** Les deux ports prennent le membre en premier paramètre et
> n'effacent que ses lignes (`WHERE … AND member_id = ?`). Réponse 204 dans tous les cas, pour ne pas
> faire de la route un oracle sur l'appartenance d'un endpoint.

### B6 — ÉLEVÉE — S5 : un 500 restait déclenchable par un corps de requête

Le motif `isoDate` ne porte que la _forme_ d'une date, et le commentaire de `schema.ts` promettait au
domaine une validité calendaire qu'aucune entité ne vérifiait. `date: '9999-99-99'` traversait le
schéma, `new Date` rendait une Invalid Date et la chaîne cassait à `toISOString()` — un 500 sur un
corps de requête, ce que S5 devait supprimer. Symétriquement, `acquisitionDate: '2026-02-31'` était
accepté puis **réécrit en silence** au 3 mars : la donnée enregistrée n'était pas celle saisie.

> **Résolution — corrigé (`d0358fe`).** `parseIsoDate` (domaine) refuse les deux, en vérifiant le
> calendrier sur le texte — seul endroit où il est lisible sans dépendre du fuseau du serveur.
> `Equipment`, `Expense`, `UsageRecord` et `Reimbursement` reçoivent le garde-fou qu'avait déjà
> `TimeRange` : une Invalid Date n'entre plus dans le domaine.

### B7 — FAIBLE — S5 : `coerceTypes: true` promouvait `null` en `0`

Un champ obligatoire envoyé à `null` par le front devenait une valeur d'achat de 0 € ou un montant
nul dans un calcul de soldes. Le commentaire de `schema.ts` justifiait deux écarts aux défauts
Fastify par la rigueur, sans mentionner cette conversion, qui va dans le sens inverse.

> **Résolution — corrigé (`d0358fe`).** La coercition n'était utile nulle part — aucun paramètre
> d'URL ni de querystring n'est déclaré autrement que `string` — elle est coupée (`coerceTypes: false`).

### B8 — FAIBLE — Régression : querystring fermée par `additionalProperties: false`

La seule route dotée d'un schéma de querystring refusait la requête entière pour un paramètre
inconnu : un anti-cache, un `utm_*` collé par un partage faisait échouer la lecture des notifications
en 400. Une URL n'est pas maîtrisée par le seul client.

> **Résolution — corrigé (`d0358fe`).** Brique `query()` distincte, sans `additionalProperties: false` :
> on valide ce qu'on lit, on ignore le reste. Les corps restent fermés.

### B9 — MOYENNE — S4 : la purge des caches hors ligne n'était câblée que sur la déconnexion

`purgeOfflineCaches()` n'était appelée que depuis `api.logout` — le seul chemin qu'un intrus
n'emprunte jamais, et celui que le changement de mot de passe (S3) n'emprunte pas non plus. Son
appareil prenait un 401 et gardait jusqu'à 24 h de réponses d'API lisibles (cache `sharemate-api`,
NetworkFirst : dépenses, soldes, messages, annuaire). Le geste réflexe après compromission
n'expulsait donc l'attaquant qu'à moitié.

> **Résolution — corrigé (`40bbb26`).** Le jeton natif et les caches tombent dans le traitement
> global du 401, avant le retour à l'écran de connexion. Les 401 des routes d'authentification en
> restent exclus : un mot de passe refusé n'est pas une session perdue.

### B10 — MOYENNE — Q3 : le scan complet et le N+1 subsistaient sur l'annuaire

`listVisibleMembers` — la route la plus chaude, appelée à chaque ouverture de page, et précisément la
vue créée par S2 — relisait tous les membres de l'instance pour les filtrer en mémoire, avec une
requête `credentials.findByMemberId` par membre. `findAll()` était le seul `findAll` survivant du
dépôt, et il était branché là.

> **Résolution — corrigé (`2a47590`).** `findAll` cède la place à `findByIds` et `findInvitedBy`, et
> `CredentialRepository` gagne `findMemberIdsWithPassword` : l'annuaire tient en deux interrogations
> bornées au périmètre. Plus aucun port ne rend la table entière. Un test compte les appels.

### B11 — MOYENNE — Q8 : la perte de données avait changé de granularité, pas de nature

La migration 6 remettait à NULL, au démarrage et sans une ligne de journal, tout email jugé mal formé
ou en doublon. L'email est l'identifiant de connexion : le membre concerné perdait son moyen d'entrer
sans savoir pourquoi. `refuserSchémaIncompatible`, dix lignes plus bas, adopte la posture inverse
pour un dommage moindre.

> **Résolution — corrigé (`f33c073`).** Même posture que pour un schéma incompatible : refus de
> démarrer, en nommant chaque rangée (identifiant, nom, adresse, motif) et en rappelant la
> sauvegarde. La migration étant transactionnelle, rien n'est écrit tant que l'opérateur n'a pas
> tranché. Reste appliqué en silence ce qui n'est pas une perte : rognage des espaces, passage à NULL
> d'un champ vide.

### B12 — MOYENNE — Q6 : une page sur trois découpée, les deux autres avaient grossi

Lignes avant → après la première vague : DiscussionsPage 625 → **640**, ChecklistsPage 542 → **550**,
EquipmentsPage 381 → **446**, CalendarPage 840 → 557. Q6 se déclarait « corrigé » sans réserve.

> **Résolution — PARTIEL (`0acb9ad`).** L'arbre des messages sort de `DiscussionsPage` dans
> `pages/discussions/MessageTree` avec les cinq états et les deux effets qui lui appartenaient
> (640 → 452 lignes). Le `key={openThread.id}` remplace l'effet de remise à zéro sur `openThreadId` —
> exactement le motif qui avait produit la régression du fil refermé. **`ChecklistsPage` (550 lignes)
> reste à découper** : le constat est requalifié partiel plutôt que déclaré clos.

### B13 — MOYENNE — Q5 : un test attestait d'autre chose que de son titre

« conserve la donnée précédente pendant un rechargement » n'assertionnait rien pendant le
rechargement, seulement la valeur finale : un `reload` qui remettrait `data` à null pendant le
chargement — le clignotement que le hook supprime — serait resté vert. Et quatre pages sur six
n'avaient aucun test, dont `EquipmentsPage`, seule à porter un geste irréversible.

> **Résolution — corrigé (`40bbb26`).** La promesse est suspendue et l'état intermédiaire vérifié.
> `EquipmentsPage` (quitter le cercle : confirmation, absence pour le dernier membre, refus serveur)
> et `DiscussionsPage` (ouverture par lien de notification, réponse à un message) sont testées.

### B14 — FAIBLE — Q12 : le seul code mort que la branche ait touché était resté

`NOTIFICATION_TYPE_LABELS` n'avait aucun appelant depuis sa création ; le front porte sa propre table
(`format.ts`), et la vague de correctifs y avait ajouté une entrée.

> **Résolution — corrigé (`f33c073`).** Supprimé. Les libellés d'interface n'ont pas leur place dans
> le domaine.

### B15 — FAIBLE — Q2 : convention de langue cassée à moitié

Le refactoring avait introduit des identifiants français dans le code de production
(`déclarerFonctions`, `dérivationFaite`, `historiques`, `jokers`, `COÛT_COURANT`, clés d'audit
`retires`/`ajoutes`/`restants`), là où le dépôt était uniformément anglais hors tests.

> **Résolution — corrigé (`7ee5a5e`).** Les identifiants repassent en anglais, et la convention est
> écrite dans le README plutôt que déduite du code : le français est la langue de ce qui se lit
> (commentaires, messages, libellés, titres de tests, commits), l'anglais celle de ce qui s'exécute.

### Ce qui reste ouvert après cette passe

- **S9** — `trustProxy: true` en production (inchangé). Il aggrave B1 tant qu'il est ouvert : la clé
  du rate-limit par IP est forgeable, donc le plafond de 20 téléversements par minute l'est aussi.
- **Dépendances** — inchangé : 23 vulnérabilités en dépendances de développement, `audit:prod` à 0.
- **Q3, le cache des soldes** — inchangé, assumé.
- **Q6, `ChecklistsPage`** — 550 lignes, à découper.
- **Consentement à l'entrée dans un cercle** — B3 borne qui peut inscrire qui, mais l'inscription
  reste unilatérale à l'intérieur du périmètre. La vraie réponse est une invitation que l'intéressé
  accepte ; elle demande un modèle de données et un écran, hors du champ de cette passe.
- **Comptes fantômes** — chaque `POST /api/members` refusé pour doublon laisse un membre et un code
  d'invitation en base. Sans effet sur le cloisonnement, mais la table se salit.

---

## 1. Sécurité

### S1 — CRITIQUE — Prise de contrôle de n'importe quel compte par n'importe quel membre [vérifié]

**Où** : `server/src/infrastructure/http/app.ts:408-411`, `server/src/application/auth-service.ts:77-88`
et `:100-109`.

```ts
// app.ts — aucune vérification autre que « une session existe »
app.post<{ Params: { id: string } }>('/api/members/:id/invite', async (request, reply) => {
  const inviteCode = await authService.regenerateInvite(request.params.id); // ← id arbitraire
  return reply.status(201).send({ inviteCode });
});
```

`regenerateInvite` accepte l'identifiant de **n'importe quel** membre, et `redeemInvite` redéfinit le
mot de passe **sans demander l'ancien**. La chaîne d'exploitation est immédiate :

1. Bob (membre lambda, dans son propre cercle) appelle `GET /api/members` → il obtient l'`id` de tous
   les comptes de l'instance, y compris celui du compte initial (S2).
2. `POST /api/members/<id-d-alice>/invite` → `201` + un code d'invitation valide pour Alice.
3. `POST /api/auth/invites/<code>/redeem` avec un mot de passe choisi par lui → `200`, session
   ouverte **en tant qu'Alice**, et le mot de passe d'Alice est écrasé.

PoC exécuté : les trois étapes passent, et `POST /api/auth/login {identifier: 'Alice', password:
'pwned-par-bob'}` répond `200`. Aucune alerte, aucune trace côté victime, et sa session existante
reste par ailleurs valide (S3).

**Impact** : lecture et écriture de la totalité des données de tous les cercles, exfiltration des
justificatifs, modification des soldes. Le travail de cloisonnement du commit `0fb1e49` est
entièrement contournable en trois requêtes.

**Correctif recommandé** (par ordre de priorité) :

1. **Immédiat** — restreindre la régénération d'invitation aux membres avec lesquels le demandeur
   partage au moins un cercle, et refuser en masquant (404) sinon :

   ```ts
   // application/auth-service.ts
   async regenerateInvite(memberId: string, requesterId: string): Promise<string> {
     const absent = `Membre introuvable : ${memberId}`;
     if (memberId !== requesterId && !(await this.sharesCircleWith(requesterId, memberId))) {
       throw new ForbiddenError(absent); // rendu en 404 par l'error handler
     }
     ...
   }
   ```

2. **Structurel** — dissocier « inviter » de « réinitialiser un mot de passe ». Un code
   d'invitation ne doit pouvoir définir un mot de passe que sur un compte **qui n'en a pas encore**
   (`credential.hasPassword === false`, propriété déjà exposée par le domaine mais jamais utilisée) :

   ```ts
   async redeemInvite(code: string, password: string): Promise<AuthResult> {
     const credential = await this.credentials.findByInviteCode(code);
     if (!credential) throw new NotFoundError('Invitation invalide ou déjà utilisée.');
     if (credential.hasPassword) {
       throw new ConflictError('Ce compte a déjà un mot de passe : connectez-vous.');
     }
     ...
   }
   ```

   La réinitialisation d'un mot de passe perdu devient alors un geste distinct, qui doit exiger une
   preuve hors bande (lien par email) ou, à défaut sur ce MVP, la double confirmation d'un autre
   membre du cercle.

3. Journaliser (`warn`) toute régénération d'invitation portant sur un autre membre que soi.

> **Résolution — corrigé en deux temps (`5291d19`, puis `02d65e2`).** La première correction
> ne fermait la chaîne que sur les comptes déjà pourvus d'un mot de passe : voir
> [B2](#b2--élevée--s1-nétait-refermé-quà-moitié--les-comptes-jamais-ouverts).
> Les deux volets ont été retenus. `regenerateInvite` exige
> désormais que la cible soit dans le périmètre du demandeur (lui-même, un cercle partagé, ou
> quelqu'un qu'il a invité) et refuse un compte qui a déjà un mot de passe ; `redeemInvite` refuse
> de même, ce qui neutralise au passage les codes émis par la version vulnérable. Une migration
> révoque ceux qui restaient en base. Hors périmètre, le refus est masqué en 404 du message exact
> d'un membre inexistant ; toute régénération visant un autre membre est tracée en `warn`.
> Conséquence assumée et documentée dans le README : sans preuve hors bande, un mot de passe perdu
> ne se réinitialise plus.

### S2 — ÉLEVÉE — L'annuaire des membres est global, sans cloisonnement [vérifié]

**Où** : `app.ts:403-416`.

- `GET /api/members` renvoie **tous** les membres de l'instance avec leur email, quel que soit le
  cercle du demandeur. PoC : Bob, qui ne partage aucun équipement avec Alice, lit
  `{name: 'Alice', email: 'alice@example.test'}`.
- `POST /api/members` permet à n'importe quel membre de créer un nombre illimité de comptes, sans
  quota ni rate-limit, chacun assorti d'un code d'invitation valide.

**Impact** : fuite de données personnelles (RGPD : nom + email de tiers sans lien avec l'utilisateur)
et fourniture directe des identifiants nécessaires à S1. Contredit frontalement la promesse du README
(« hors du cercle, la ressource se comporte comme inexistante »).

**Correctif** : cadrer l'annuaire sur le périmètre du demandeur, comme le fait déjà
`equipmentsForMember` :

```ts
// application/member-service.ts
async listVisibleMembers(requesterId: string): Promise<Member[]> {
  const circles = await equipmentsForMember(this.equipments, requesterId);
  const visible = new Set([requesterId, ...circles.flatMap((e) => e.memberIds)]);
  return (await this.members.findAll()).filter((m) => visible.has(m.id));
}
```

Le front consomme `listMembers()` pour afficher les noms dans le calendrier, les dépenses et les
discussions — tous ces usages restent couverts par le périmètre ci-dessus. Prévoir en complément une
recherche explicite par email exact pour le cas « ajouter un membre existant à mon cercle », qui est
le seul besoin légitime de sortir du périmètre.

> **Résolution — corrigé (`5291d19`).** `MemberService.listVisibleMembers` cadre l'annuaire sur le
> périmètre du demandeur. La recherche par email exact n'a pas été retenue : `members.invited_by`,
> désormais persisté, garde un invité visible de son invitant tant qu'aucun cercle ne les réunit, ce
> qui couvre le besoin « ajouter la personne que je viens de créer » sans rouvrir de canal de
> recherche sur l'instance. Réunir deux membres qui ne partagent aucun cercle passe par un tiers qui
> les voit tous les deux. `POST /api/members` reste ouvert à tout membre — c'est le modèle de
> cooptation, désormais énoncé dans le README — mais est plafonné à 20 appels/minute/IP (S6).

### S3 — ÉLEVÉE — Aucune révocation de session [vérifié]

**Où** : `auth-service.ts:146-153` (`changePassword`) et `:100-109` (`redeemInvite`).

Changer son mot de passe ne supprime aucune session existante. PoC : après un `POST
/api/auth/password` réussi, l'ancien cookie continue de répondre `200` sur `/api/auth/me`.

**Impact** : le geste réflexe après une compromission (« je change mon mot de passe ») n'expulse pas
l'attaquant. Combiné à S1, un compte repris reste accessible même après réaction de la victime. Les
sessions durent 30 jours en expiration glissante, donc indéfiniment tant qu'elles sont utilisées.

**Correctif** : ajouter `deleteByMemberId(memberId)` au `SessionRepository` et l'appeler dans
`changePassword` et `redeemInvite`, en conservant (ou en rouvrant) la seule session courante :

```sql
DELETE FROM sessions WHERE member_id = ?
```

Exposer également une action « déconnecter tous mes appareils » dans `UserMenu`.

> **Résolution — corrigé (`5291d19`).** `SessionRepository.deleteByMemberId` révoque toutes les
> sessions du membre au changement de mot de passe **et** à la consommation d'une invitation ;
> l'auteur du geste en reçoit une neuve (cookie reposé, jeton Bearer rendu à l'app native), sinon il
> se déconnecterait lui-même. `POST /api/auth/password` répond donc 200 et non plus 204. L'action
> « déconnecter tous mes appareils » du `UserMenu` n'a pas été ajoutée : le geste réflexe
> (changer son mot de passe) produit désormais le même effet, un second bouton serait redondant.

### S4 — MOYENNE — Les justificatifs ne sont pas cloisonnés par cercle [vérifié]

**Où** : `app.ts:291-305` (le hook n'exige qu'une session sur `/uploads/`), `app.ts:878-882`.

`/uploads/*` est servi par `@fastify/static` derrière le seul contrôle « une session valide existe ».
Aucun contrôle de cercle n'est consulté : un membre d'un autre cercle qui obtient un chemin de
justificatif (via une capture d'écran, un lien partagé, le cache du service worker, ou S1) le lit
sans obstacle. Les noms sont des UUID v4, ce qui rend l'énumération impraticable — c'est une
protection par obscurité, pas un contrôle d'accès.

**Correctif** : remplacer le service statique par une route applicative qui résout le fichier via la
dépense qui le porte, et applique `equipmentForMember` :

```ts
app.get<{ Params: { name: string } }>('/uploads/:name', async (request, reply) => {
  const expense = await expenseService.findByReceiptName(request.params.name, request.authMember.id);
  return reply.sendFile(expense.receiptFileName, uploadsDir);
});
```

Corollaires à traiter au passage : les fichiers ne sont **jamais supprimés** quand la dépense qui les
porte l'est (`expense-service.ts:153-162`) — croissance monotone du volume ; et le cache
`CacheFirst` du service worker (`vite.config.ts`, `sharemate-uploads`, 30 jours) conserve les
justificatifs sur l'appareil bien après une déconnexion.

> **Résolution — corrigé en deux temps (`bfcf604`, `25ed70e`, puis `40bbb26`).** La purge des caches
> hors ligne n'était câblée que sur la déconnexion volontaire : voir
> [B9](#b9--moyenne--s4--la-purge-des-caches-hors-ligne-nétait-câblée-que-sur-la-déconnexion).
> `GET /uploads/:name` est devenu une route
> applicative qui remonte à la dépense portant le fichier et lui applique `equipmentForMember` ;
> hors cercle, la réponse est celle d'un justificatif jamais déposé. Deux corollaires ont dû être
> traités pour que la règle tienne : un justificatif ne peut plus être rattaché à deux dépenses
> (sans quoi recopier le chemin d'un fichier d'un autre cercle rouvrait l'accès), et les fichiers
> sont supprimés avec la dépense qui les porte, via le port `ReceiptStorage`. Côté client
> (`25ed70e`), `/uploads/*` passe en `NetworkOnly` et la déconnexion vide les caches `sharemate-*` :
> un cache rendrait le fichier à un droit révoqué sans jamais consulter le contrôle d'accès.

### S5 — MOYENNE — Aucune validation des corps de requête [vérifié]

**Où** : toutes les routes de `app.ts`. Les génériques `app.post<{ Body: ... }>` sont des annotations
TypeScript sans aucune contrepartie à l'exécution — Fastify n'a pas de schéma JSON à appliquer.

PoC, trois cas parmi beaucoup :

| Requête                                                             | Attendu | Obtenu  |
| ------------------------------------------------------------------- | ------- | ------- |
| `POST /api/auth/login` avec `{}`                                    | 400     | **500** |
| `PUT /api/notifications/preferences` avec `preferences: "x"`        | 400     | **500** |
| `POST /api/equipments` avec `{name: 'Tracteur'}` (champs manquants) | 400     | **500** |

**Impact** : erreurs 500 déclenchables sans authentification sur les routes publiques, bruit dans les
logs, absence de message exploitable côté client, et surface d'attaque non caractérisée sur toutes
les routes internes (types réellement reçus ≠ types déclarés, ce qui invalide le raisonnement de
sûreté qu'on tire du typage partout en aval).

**Correctif** : Fastify embarque Ajv — déclarer les schémas sur chaque route :

```ts
app.post(
  '/api/auth/login',
  {
    config: { public: true, rateLimit: AUTH_RATE_LIMIT },
    schema: {
      body: {
        type: 'object',
        required: ['identifier', 'password'],
        additionalProperties: false,
        properties: {
          identifier: { type: 'string', minLength: 1, maxLength: 200 },
          password: { type: 'string', minLength: 8, maxLength: 512 },
        },
      },
    },
  },
  handler,
);
```

L'error handler traite déjà `httpError.validation` (`app.ts:330-333`) : les schémas donneront
immédiatement des 400 propres. Alternative si vous préférez garder l'inférence de types :
`fastify-type-provider-zod`, qui dérive schéma **et** type d'une même source.

> **Résolution — corrigé en deux temps (`2e70acf`, puis `d0358fe`).** Un 500 restait déclenchable
> par une date calendairement impossible, et `coerceTypes` promouvait `null` en `0` : voir
> [B6](#b6--élevée--s5--un-500-restait-déclenchable-par-un-corps-de-requête), B7 et B8.
> Schémas Ajv sur le corps, les paramètres et la querystring
> de toutes les routes, briques communes dans `http/schema.ts` — sans dépendance ajoutée, l'option
> `fastify-type-provider-zod` n'ayant pas été retenue. Deux réglages Ajv s'écartent des défauts de
> Fastify et c'est délibéré : `removeAdditional: false` (un champ inconnu doit être refusé, pas
> supprimé en silence) et `coerceTypes: true` au lieu de `'array'` (un scalaire ne doit pas être
> promu en liste d'un élément). Les refus d'Ajv, en anglais brut, sont traduits par un
> `schemaErrorFormatter` qui nomme le champ fautif. Un test figeait un comportement discutable —
> `POST /api/reservations` acceptait un `memberId` puis l'écrasait silencieusement par celui de la
> session : le champ est maintenant refusé, ce qui est plus honnête qu'une usurpation ignorée.

### S6 — MOYENNE — Rate-limit trop étroit

**Où** : `app.ts:194` (`{ global: false }`), `app.ts:136`.

Seules les cinq routes d'authentification sont limitées (10 req/min/IP). Tout le reste de l'API est
sans plafond : `POST /api/members` (création illimitée de comptes), `POST /api/messages`,
`POST /api/uploads/receipts` (10 Mo par fichier, sans quota ni limite de débit), et surtout
`POST /api/auth/logout` et toutes les lectures qui déclenchent une écriture SQLite (S9/Q5).

**Correctif** : activer une limite globale par défaut, et conserver la limite serrée sur l'auth :

```ts
await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
```

Ajouter une limite spécifique plus basse sur `POST /api/uploads/receipts` et
`POST /api/members`.

> **Résolution — corrigé (`9526070`).** Trois plafonds par IP et par minute, réunis dans
> `http/rate-limit.ts` : global 300 (toute route, front statique compris), auth 10 (inchangé),
> sensible 20 sur `POST /api/members` et `POST /api/uploads/receipts`. Le 429 sort désormais en
> français, dans le format `{ error }` du reste de l'API. Les plafonds sont injectables
> (`AppDependencies.rateLimits`) : les parcours d'intégration enchaînent des dizaines de requêtes
> depuis la même adresse et les relèvent, mais chaque limite est testée pour elle-même, aux valeurs
> de production, sur des apps dédiées.
>
> **Correction de la résolution (`45b9456`, troisième passe).** L'affirmation « global 300, toute
> route » était fausse : le plafond ne couvrait pas les requêtes **anonymes sur les routes
> protégées**, soit l'essentiel de la surface d'API. @fastify/rate-limit attache son compteur au
> niveau de la route, et un hook de route s'exécute après les hooks de contexte — donc après la
> garde de session, qui rendait 401 avant tout comptage. Sonde sur `/api/equipments` avec
> global=5 : huit requêtes anonymes, huit 401, aucun 429. Le trou a été trouvé par CodeQL
> (« missing rate limiting » sur le hook de session), pas par cet audit ni par les deux passes de
> relecture, qui ont tous trois pris la limite globale pour acquise sans la sonder. Le comptage se
> fait désormais en un point unique, en `onRequest` à la racine, avant l'authentification, avec un
> plafond choisi par route (`config.limitPerMinute`) et une clé portant l'IP et le gabarit de route.
> Empiler un hook racine sur les plafonds par route ne fonctionnait pas : le greffon marque la
> requête (`rateLimitRan`) et refuse de la compter deux fois, ce qui désactivait silencieusement
> tous les plafonds serrés — trois tests l'ont montré au premier essai.

### S7 — FAIBLE — L'en-tête `Authorization` n'est pas expurgé des logs

**Où** : `server/src/main.ts:74`.

```ts
redact: ['req.headers.cookie', 'req.headers["set-cookie"]'],
```

Le token de session de l'app native transite en `Authorization: Bearer` et n'est pas dans la liste.
Le sérialiseur par défaut de Fastify ne logge pas les en-têtes, donc rien ne fuit **en l'état** —
mais l'intention affichée par le commentaire (« le token de session ne doit jamais apparaître dans
les logs ») n'est vraie que par accident, et le moindre `logger.info({ req })` ou sérialiseur
personnalisé la casse.

**Correctif** : ajouter `'req.headers.authorization'` à `redact`.

> **Résolution — corrigé (`9ccd3b7`).** `'req.headers.authorization'` ajouté à `redact`.

### S8 — FAIBLE — Paramètres scrypt implicites

**Où** : `server/src/infrastructure/tech/adapters.ts:17-35`.

`crypto.scrypt(password, salt, 32)` utilise les valeurs par défaut de Node (N=16384, r=8, p=1, soit
~16 Mo). C'est acceptable, mais en dessous des recommandations OWASP actuelles (N=2¹⁷ minimum pour
scrypt), et le coût n'est pas versionné : le jour où vous le durcissez, aucun mécanisme ne permet de
re-hacher les mots de passe existants.

**Correctif** : expliciter les paramètres et les stocker dans le hash pour permettre une migration
progressive au login.

```ts
const COST = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
// format : scrypt$N$r$p$sel$dérivé
```

Le format `scrypt:<sel>:<dérivé>` actuel n'est pas extensible ; `verify` doit accepter les deux
formats le temps de la transition. À défaut, argon2id (`node-argon2`) est le choix recommandé
aujourd'hui, au prix d'une dépendance native supplémentaire.

> **Résolution — corrigé (`4954ad7`).** Format `scrypt$N$r$p$sel$dérivé`, N = 2¹⁷ ; `verify` lit les
> paramètres dans le hachage et accepte encore l'ancien format en lecture, sous le coût implicite de
> Node figé dans l'adapter. `needsRehash`, nouveau sur le port `PasswordHasher`, fait re-hacher
> silencieusement à la connexion suivante : la migration est progressive, sans geste des membres.
> argon2id n'a pas été retenu (dépendance native supplémentaire). `maxmem` est calculé depuis le
> coût, faute de quoi Node refuserait la dérivation à N = 2¹⁷ (128 Mio contre 32 par défaut). Le
> coût est un paramètre de constructeur : les parcours d'intégration tournent à N = 2¹², le coût
> réel étant vérifié pour lui-même dans `tech/adapters.test.ts`.

### S9 — FAIBLE — `trustProxy: true` sans borne

**Où** : `main.ts:75`, `app.ts:159`.

En production, Fastify fait confiance à l'intégralité de la chaîne `X-Forwarded-For`. Si le service
devient joignable autrement que par le proxy Railway, un client peut forger l'en-tête et contourner
le rate-limit d'authentification.

**Correctif** : borner au nombre de sauts réels — `trustProxy: 1` — ou à la plage d'IP du proxy.

> **Résolution — OUVERT.** `main.ts` passe toujours `trustProxy: isProduction`, donc `true`. Le
> constat n'est pas traité. Il est en revanche assumé et écrit : le README le liste parmi « ce qui
> n'est pas protégé », avec sa condition de validité — tant que le service n'est joignable que par
> le proxy Railway, l'en-tête ne peut pas être forgé.

### S10 — FAIBLE — Un membre peut évincer tout le cercle d'un équipement

**Où** : `server/src/application/equipment-service.ts:67-84`.

`update` autorise tout membre du cercle à réécrire `memberIds`. Le seul garde-fou est
`Equipment.create` qui exige au moins un membre : un membre peut donc se retirer lui-même (rendant
l'équipement invisible pour lui et le sortant définitivement de sa vue), ou retirer tous les autres
et devenir seul détenteur d'un bien partagé, avec l'historique complet des dépenses et des soldes.

C'est peut-être un choix assumé (« le cercle se coopte », dit le commentaire), mais aucune trace n'en
est conservée et le geste est irréversible depuis l'interface. Le README ne le mentionne pas.

**Correctif** : au minimum, refuser qu'un membre se retire lui-même via `update` (geste dédié
« quitter le cercle »), notifier les membres retirés, et journaliser les changements de composition.

> **Résolution — corrigé (`9dcef5f`).** Les trois garde-fous ont été posés. `update` refuse que le
> demandeur s'exclue ; partir devient `leaveCircle` (`POST /api/equipments/:id/leave`), interdit au
> dernier membre — un cercle vide rendrait l'équipement invisible pour tous, donc irrécupérable :
> il supprime. Tout changement de composition notifie les retirés, les ajoutés **et** ceux qui
> restent (nouveau type `EQUIPMENT_CIRCLE_CHANGED`), pour qu'une éviction ne se déduise pas de
> l'absence d'un nom dans une liste. Le nouveau port `AuditLogger` envoie la trace dans les logs du
> serveur, hors de portée des membres concernés — contrairement à une notification, qu'ils peuvent
> effacer. La cooptation elle-même reste le modèle : le README l'énonce maintenant explicitement.

### S11 — FAIBLE — Les codes d'invitation n'expirent jamais

**Où** : `auth-service.ts:65-88`, `server/src/domain/auth/credential.ts`.

Un code (72 bits, entropie suffisante) reste valable indéfiniment jusqu'à consommation. Il est
partagé hors bande — SMS, WhatsApp, email — donc durablement exposé dans des historiques de
conversation.

**Correctif** : ajouter `invite_expires_at` à `member_credentials`, avec un TTL de 7 jours, et
vérifier l'expiration dans `findByInviteCode` / `inviteInfo` / `redeemInvite`.

> **Résolution — corrigé (`5291d19`).** `invite_expires_at` ajouté, TTL de 7 jours, expiration
> vérifiée par `MemberCredential.isInviteValid` à la lecture comme à la consommation. Inconnu,
> expiré et déjà utilisé partagent le même message : rien ne permet de sonder les codes. La
> migration date les invitations en attente et révoque celles posées au-dessus d'un mot de passe
> existant (vestiges de S1).

### S12 — FAIBLE — `receiptPath` accepté sans validation

**Où** : `app.ts:580-594` (le champ est repris tel quel), `web/src/pages/ExpensesPage.tsx:415`.

Le serveur stocke la chaîne fournie par le client, sans vérifier qu'elle correspond à un fichier
réellement téléversé. Le front la rend en `<a href={assetUrl(x.receiptPath)} target="_blank">`. Un
membre peut donc placer une URL externe arbitraire dans une dépense visible par tout son cercle
(hameçonnage crédible : le lien s'affiche comme un justificatif de l'application).

React 19 neutralise le cas `javascript:` (`sanitizeURL` remplace l'URL par un `throw`), ce qui écarte
l'XSS stocké — mais c'est une défense fortuite du framework, pas du code.

**Correctif** : valider côté serveur dans le schéma de la route
(`pattern: '^/uploads/[0-9a-f-]{36}\\.(png|jpe?g|webp|pdf)$'`), et vérifier l'existence du fichier.

> **Résolution — corrigé (`2e70acf`).** Le schéma de la route n'accepte plus que la forme
> réellement produite par le téléversement. L'existence du fichier n'est pas vérifiée : le contrôle
> couplerait la route dépense au stockage des justificatifs — désactivable — sans rien apporter,
> un UUID v4 n'étant pas devinable. Côté front, `receiptUrl()` applique le même filtre à
> l'affichage, ce qui couvre aussi les dépenses enregistrées avant cette validation.

### Points positifs relevés

- **Aucune injection SQL** : toutes les requêtes de `repositories.ts` sont paramétrées, y compris la
  seule construite par concaténation (`findByRecipient`, `app.ts` → `repositories.ts:755-765`), dont
  le fragment interpolé est une constante littérale.
- **Anti-énumération soignée et cohérente** : `equipment-access.ts` centralise la règle, le refus
  emprunte le message d'absence de la ressource d'entrée, et l'error handler rend `ForbiddenError`
  en 404 tout en gardant la vérité dans les logs (`app.ts:311-320`).
- **Sessions** : tokens de 32 octets aléatoires, stockés **hachés** (SHA-256), cookie `httpOnly` +
  `SameSite=Lax` + `Secure` en production, purge des sessions expirées à chaque ouverture.
  `SameSite=Lax` couvre le CSRF sur toutes les routes d'écriture (POST/PUT/DELETE).
- **Vérification de mot de passe à temps constant** (`crypto.timingSafeEqual`), avec contrôle de
  longueur préalable.
- **En-têtes** : CSP explicite, `frame-ancestors 'none'`, `object-src 'none'`, nosniff, HSTS via
  helmet. Le `'unsafe-inline'` sur `style-src` est justifié (styles React) et sans impact réel.
- **Upload** : extension en liste blanche, nom regénéré côté serveur (`randomUUID`), taille plafonnée
  à 10 Mo — le path traversal via `filename` est correctement neutralisé.
- **Récurrences plafonnées** à 52 occurrences (`recurrence.ts:6`), ce qui coupe l'amplification.
- **Chaîne d'approvisionnement** : `npm audit --omit=dev` → **0 vulnérabilité** en production.

### Dépendances

`npm audit` remonte 23 vulnérabilités (22 high, 1 critique) — **toutes en dépendances de
développement**, via `tar` transitif de `@capacitor/assets` (outil de génération d'icônes, exécuté à
la main). Aucun impact sur l'artefact déployé, ce que confirme `audit:prod`. À traiter tout de même :
`npm audit fix` suffit d'après le rapport, sinon déplacer la génération d'icônes hors du dépôt
(l'outil ne sert qu'une fois par changement de logo).

> **Résolution — OUVERT.** Le compte est inchangé : 23 vulnérabilités (22 high, 1 critique), toutes
> par `tar` transitif de `@capacitor/assets`, toutes en dépendances de développement.
> `npm run audit:prod` répond toujours 0 et la CI reste verte, l'artefact déployé n'étant pas
> concerné. Ni `npm audit fix` ni le déplacement de la génération d'icônes hors du dépôt n'ont été
> tentés.

---

## 2. Qualité de code

### Q1 — 401 au lieu de 403 : les gestes réservés à l'auteur déconnectent l'utilisateur

**Où** : `server/src/application/discussion-service.ts:226-228`, `app.ts:307-309`,
`web/src/api.ts:224-226`.

`assertAuthor` lève `UnauthorizedError`, rendu en **401**. Côté client, tout 401 hors
`/api/auth/*` déclenche `onUnauthorized` → retour à l'écran de connexion :

```ts
// web/src/api.ts
if (response.status === 401 && !url.startsWith('/api/auth/')) {
  onUnauthorized?.();
}
```

Conséquence : un membre du cercle qui tente de renommer ou supprimer le fil d'un autre est
**déconnecté de l'application**, au lieu de voir « Seul l'auteur peut renommer ce fil ». Le
comportement est verrouillé par les tests (`app.test.ts:729` et `:737` attendent 401), donc la
régression est figée dans la suite.

`UnauthorizedError` mélange deux notions distinctes : « pas de session » (401) et « session valide,
geste interdit » (403). Le second cas n'a rien à faire dans le premier code.

**Correctif** : introduire une erreur d'autorisation dédiée rendue en **403**, la lever dans
`assertAuthor`, et mettre à jour les trois tests. `ForbiddenError` reste réservé au refus **masqué**
(hors cercle → 404) : les deux cas sont légitimement différents et méritent deux types.

> **Résolution — corrigé (`1601077`).** `AuthorizationError`, rendue en 403, est levée par
> `assertAuthor` ; `ForbiddenError` reste le refus masqué en 404. Les deux tests qui figeaient le
> 401 attendent désormais 403, et un troisième couvre le renommage de fil décrit ici. Les autres
> usages d'`UnauthorizedError` (login, mot de passe actuel incorrect) relèvent bien du 401 et sont
> inchangés : ils portent sur `/api/auth/*`, hors du champ de la déconnexion automatique. Un test
> front (`a483676`) fige l'autre moitié de la propriété — un 403 ne déconnecte pas.

### Q2 — `app.ts` : 902 lignes, toutes les routes dans une seule fonction

`buildApp` instancie neuf services, configure six plugins, déclare l'error handler et **56 routes**.
Chaque nouveau domaine allonge la fonction. Les tests d'intégration correspondants (`app.test.ts`,
1220 lignes) suivent la même pente.

**Correctif** : découper en plugins Fastify par domaine, la composition restant dans `buildApp` :

```
infrastructure/http/
├── app.ts                 # plugins transverses, hook de session, error handler, composition
├── plugins/auth.ts        # /api/auth/*
├── plugins/equipments.ts  # /api/equipments/*
├── plugins/expenses.ts    # /api/expenses, /api/reimbursements, soldes
└── ...
```

Chaque plugin reçoit son service en paramètre — le câblage reste explicite, et `app.test.ts` peut se
scinder en fichiers alignés sur les plugins.

> **Résolution — corrigé en deux temps (`f4c97bc`, puis `381d33a`, `7ee5a5e`).** L'affirmation
> « les plugins de domaine héritent du hook de session » était fausse — le hook se contournait par un
> `%61` dans le chemin : voir [B1](#b1--critique--la-garde-de-session-se-contournait-par-un-chemin-encodé).
> Le refactoring avait aussi cassé à moitié la convention de langue (B15).
> Dix plugins dans `http/plugins/`, un par domaine, chacun
> déclarant en `options` les seuls services dont il a besoin. `buildApp` ne garde que le
> transverse : plugins Fastify, construction des services, hook de session, error handler,
> `/api/health`, composition — et le front statique, dont le repli SPA appelle `reply.sendFile`
> décoré sur la racine (un plugin encapsulé ne l'exposerait pas au gestionnaire 404). Le nom du
> cookie, la lecture du jeton et l'augmentation de type `declare module 'fastify'` vivent dans
> `http/session.ts`. Refactor à comportement constant : `app.test.ts` n'a pas été touché. Il n'a pas
> non plus été scindé — la suggestion de découpe des tests n'a pas été suivie.

### Q3 — Requêtes N+1 et scans complets systématiques

L'application relit toute une table pour répondre à presque chaque question :

| Emplacement                                         | Comportement                                                         |
| --------------------------------------------------- | -------------------------------------------------------------------- |
| `equipment-access.ts:45-47` + `repositories.ts:153` | `findAll()` puis **une requête par équipement** pour lire son cercle |
| `reservation-service.ts:149-152` (`calendar`)       | charge **toutes** les réservations de l'instance, filtre en mémoire  |
| `auth-service.ts:112-116` (`login`)                 | charge **tous** les membres à chaque tentative de connexion          |
| `usage-service.ts:102-117`                          | recharge l'historique complet de chaque équipement concerné          |
| `expense-service.ts` (soldes, plan de règlement)    | recalcul complet à chaque appel, sans cache                          |

À 5 utilisateurs et quelques équipements, c'est parfaitement tenable — et le choix « filtrer dans
l'application plutôt qu'en SQL » garde le domaine pur, ce qui est cohérent avec l'architecture. Mais
c'est un plafond de verre structurel : la roadmap mentionne le multi-groupes, qui rendra ces scans
proportionnels à la taille de **l'instance** et non à celle du cercle.

**Correctif** : quand le besoin se présentera, faire descendre le filtre dans les repositories —
`findByMemberCircle(memberId)`, `findByEquipmentIds(ids)`, `findByNameOrEmail(identifier)` — via des
jointures sur `equipment_members`. Les ports existent déjà, la signature change seule. Aucune urgence
aujourd'hui, mais à faire **avant** le multi-groupes, pas après.

> **Résolution — corrigé en deux temps (`f068da5`, puis `2a47590`), sauf le cache.** L'annuaire
> créé par S2 gardait le scan complet et le N+1 : voir
> [B10](#b10--moyenne--q3--le-scan-complet-et-le-n1-subsistaient-sur-lannuaire).
> Les ports ont gagné `findByMemberId`,
> `findByEquipmentIds` et `findByNameOrEmail` ; l'implémentation SQLite les sert par jointure sur
> `equipment_members` ou par `IN (…)`, et charge les cercles de toute une liste d'équipements en une
> interrogation au lieu d'une par ligne. La frontière tient : la couche application n'apprend rien
> de SQL et `equipmentsForMember` reste le point unique où la règle s'énonce.
> `findByNameOrEmail` s'appuie sur une fonction SQL `minuscule` déclarée à l'ouverture — `lower()`
> de SQLite ne replie que l'ASCII et aurait fait perdre la connexion insensible à la casse aux
> membres au nom accentué. Un canal auxiliaire d'énumération que la version en mémoire avait déjà
> a été refermé au passage : sans candidat porteur d'un mot de passe, `login` revenait sans aucune
> dérivation de clé, et le temps de réponse trahissait l'existence du compte malgré le message
> générique ; un hachage leurre de coût identique le referme, et un test compte les dérivations.
> **Non traité, délibérément** : les soldes et le plan de règlement sont toujours recalculés à
> chaque appel, sans cache. Ils sont désormais cadrés sur un seul équipement, pas sur l'instance.

### Q4 — Une écriture SQLite à chaque requête authentifiée

**Où** : `auth-service.ts:127-140`.

```ts
await this.sessions.save({ ...session, expiresAt: new Date(now.getTime() + SESSION_TTL_MS) });
```

L'expiration glissante réécrit la ligne de session **à chaque appel d'API**, y compris pour les
lectures. Sur SQLite en WAL avec un volume réseau Railway, chaque `GET` devient une transaction en
écriture — c'est aussi un point de contention et un amplificateur pour S6.

**Correctif** : ne prolonger que si la session arrive à moins d'un seuil de son expiration :

```ts
const remaining = session.expiresAt.getTime() - now.getTime();
if (remaining < SESSION_TTL_MS / 2) {
  await this.sessions.save({ ...session, expiresAt: new Date(now.getTime() + SESSION_TTL_MS) });
}
```

> **Résolution — corrigé (`3ad6ba8`).** Seuil retenu : le dernier tiers du TTL (10 jours sur 30)
> plutôt que la moitié. Les deux branches sont testées — une session loin de son échéance n'est pas
> réécrite, une session proche l'est. Corollaire traité dans `af10429` : `expires` du cookie était
> figé à l'échéance de la connexion, donc le navigateur l'oubliait pendant que la session serveur
> courait encore ; `authenticate` signale désormais une échéance repoussée et le hook de session
> repose le cookie, seulement pour les clients qui en ont un.

### Q5 — Aucun test du front

`vitest.config.ts:5` : `include: ['server/src/**/*.test.ts']`. Les 3 500 lignes de React
(`CalendarPage` 840 lignes, `DiscussionsPage` 625, `ChecklistsPage` 542) ne sont couvertes par
**aucun test**, et le seuil de couverture de 90 % ne porte que sur `domain/` et `application/` — il
donne donc une impression de sécurité qui ne vaut que pour la moitié du code.

**Correctif** : ajouter un projet Vitest `jsdom` + `@testing-library/react` couvrant en priorité les
comportements à risque : navigation par lien de notification (`App.tsx:102-116`), formulaire de
dépense et calcul des parts, et gestion du 401 global (Q1). Ne pas viser un pourcentage : viser les
chemins où une régression est silencieuse.

> **Résolution — corrigé en deux temps (`a483676`, puis `40bbb26`).** Un test n'attestait pas de ce
> que son titre annonçait, et quatre pages sur six n'étaient pas testées : voir
> [B13](#b13--moyenne--q5--un-test-attestait-dautre-chose-que-de-son-titre).
> Vitest passe en deux projets (`server` en Node, `web` en
> jsdom + `@testing-library/react`) : `npm test` lance les deux suites, 71 tests front s'ajoutant
> aux 323 du serveur. La configuration de couverture est inchangée, toujours cadrée sur le cœur
> métier — le front est visé sur les chemins listés ici, pas au pourcentage. Deux de ces tests ont
> échoué d'emblée et ont révélé un vrai bug : le fil désigné par un lien de notification ne
> s'ouvrait jamais, `DiscussionsPage` le refermant dans un effet sur `selectedId` qui s'exécute
> aussi au montage.

### Q6 — Composants de page trop gros, logique de chargement dupliquée

`CalendarPage` (840 lignes) mélange état de formulaire, appels API, calcul de grille calendaire et
rendu. Le triptyque `useState(data) / useState(error) / useCallback(load) / useEffect(load)` est
recopié à l'identique dans les six pages, avec à chaque fois le même
`catch (e) { setError(e instanceof Error ? e.message : 'Erreur.') }`.

**Correctif** : extraire un hook `useApiResource(loader)` renvoyant `{data, error, loading, reload}`,
et sortir de `CalendarPage` le calcul de grille (fonction pure, immédiatement testable) et le
formulaire de réservation (composant dédié).

> **Résolution — PARTIEL (`1783773`, `f4d10b8`, `0acb9ad`).** Une page sur trois avait été découpée,
> les deux autres avaient grossi ; `ChecklistsPage` (550 lignes) reste à découper : voir
> [B12](#b12--moyenne--q6--une-page-sur-trois-découpée-les-deux-autres-avaient-grossi).
> `useApiResource(loader)` rend
> `{data, error, loading, reload}` plus `clearError` — les pages affichent un bandeau unique et
> certaines le referment au clic, ce que ni `reload` ni un simple `error` ne permettent. Le hook
> ignore aussi les réponses hors séquence : deux changements de sélection rapprochés faisaient
> réapparaître les données de la précédente. Les erreurs d'écriture restent portées par la page
> (`actionError`) : elles ne viennent pas d'un chargement et ne doivent pas être effacées par son
> succès. `CalendarPage` passe de 840 à 563 lignes : le calcul de grille part dans
> `pages/calendar/grid.ts` (fonctions pures, 20 tests) et le formulaire dans
> `pages/calendar/ReservationForm.tsx`.

### Q7 — Dépendances de constructeur optionnelles

**Où** : `expense-service.ts:63-64`, `reservation-service.ts:45-46`, `usage-service.ts:33`,
`discussion-service.ts:47`.

```ts
private readonly members?: MemberRepository,
private readonly notifier?: Notifier,
```

Ces dépendances sont optionnelles pour la commodité des tests, mais elles sont **toujours** fournies
en production (`app.ts:240-257`). Le coût est réel : chaque usage est gardé par `if (this.notifier)`
ou `this.members?.`, et les branches « absent » — du code qui ne s'exécute jamais en production —
sont comptées dans la couverture.

**Correctif** : rendre les dépendances obligatoires et fournir un `NullNotifier` explicite dans les
tests qui n'en ont pas besoin. `app.ts:196-203` définit déjà exactement ce `noopPushSender` : le
motif est connu du code, il suffit de l'appliquer partout.

> **Résolution — corrigé (`c2a8e1c`).** `notifier` et `members` deviennent obligatoires dans les
> quatre services, les gardes disparaissent, et les tests qui n'observent pas les notifications
> reçoivent un `NullNotifier` explicite. Effet de bord voulu : la garde « au moins un destinataire »
> remonte devant la lecture du membre auteur, qui n'a plus lieu d'être quand il n'y a personne à
> notifier.

### Q8 — Migrations destructives, sans versionnement

**Où** : `server/src/infrastructure/persistence/sqlite/database.ts:19-43`.

Deux migrations existantes suppriment purement et simplement des tables (`DROP TABLE`) quand elles
détectent un schéma ancien — toutes les données du legacy sont perdues, silencieusement, au
démarrage. C'était sans doute acceptable avant la mise en production ; ça ne l'est plus maintenant
qu'il y a un volume Railway avec des données réelles.

Par ailleurs, `migrate()` est une suite de `CREATE TABLE IF NOT EXISTS` + `PRAGMA table_info` ad hoc,
sans table de version : impossible de savoir dans quel état est une base, ni de rejouer/annuler.

**Correctif** : introduire `PRAGMA user_version` et une liste ordonnée de migrations idempotentes ;
ne plus jamais supprimer de table sans sauvegarde préalable. Documenter la procédure de sauvegarde du
volume (`sqlite3 .backup`) dans le README, aujourd'hui absente.

> **Résolution — corrigé en deux temps (`0d3a030`, `2d25524`, puis `f33c073`).** La migration des
> emails avait remplacé une perte de table silencieuse par une perte de colonne, tout aussi
> silencieuse : voir
> [B11](#b11--moyenne--q8--la-perte-de-données-avait-changé-de-granularité-pas-de-nature).
> `PRAGMA user_version` est devenu le seul état de référence, en face d'une liste ordonnée de
> migrations idempotentes appliquées chacune dans sa propre transaction — la version n'avance que si
> l'étape a réussi entièrement. Une base antérieure vaut 0 et rejoue la liste sans rien détruire ;
> une base à jour ne rejoue plus rien. Les schémas incompatibles ne sont plus supprimés mais
> **refusés** : le démarrage échoue avec un message qui nomme la table et rappelle `sqlite3 .backup`
> — c'est à l'opérateur de trancher, sauvegarde en main. Le test qui garantissait la suppression de
> l'ancien schéma affirmait précisément le comportement corrigé : il a été remplacé par son inverse.
> La procédure de sauvegarde et la règle d'ajout d'une migration sont maintenant dans le README
> (section « Déploiement sur Railway »).

### Q9 — Enregistrements de plugins non attendus

**Où** : `app.ts:861` et `:878`, `:888`.

```ts
app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } }); // sans await
```

Les six autres `register` de la fonction sont `await`és. Fastify résout ces enregistrements à
`ready()`, donc le comportement est correct — mais l'incohérence masque l'ordre réel d'initialisation
et rendra le prochain bug d'ordonnancement de plugin difficile à lire.

> **Résolution — corrigé (`a38adb2`).** Les trois `register` restants (multipart, statique des
> justificatifs, statique du front) sont attendus comme les autres. Suite inchangée et verte, y
> compris les cas d'upload et de repli SPA qui dépendent de ces trois plugins.

### Q10 — Dérive de la documentation

Le README décrit un état du projet qui n'existe plus :

| Ligne du README                                         | Réalité                                                   |
| ------------------------------------------------------- | --------------------------------------------------------- |
| « Pas d'authentification au MVP (groupe de confiance) » | Authentification complète : scrypt, sessions, invitations |
| Arborescence : `domain/group/ # Group, Member`          | `domain/group/` n'existe pas ; `domain/member/` seul      |
| « 232 tests »                                           | 236                                                       |
| Roadmap : « Authentification légère (magic link) »      | Déjà réalisée sous une autre forme                        |

La section « Sécurité » du README, en revanche, décrit fidèlement et avec précision le cloisonnement
par cercle — ce qui rend l'omission de S1/S2 d'autant plus trompeuse : un lecteur en conclut que
l'isolation est complète.

**Correctif** : mettre le README à jour dans le même commit que les correctifs S1/S2, et y documenter
explicitement le modèle de menace retenu (qui peut inviter, qui peut voir qui, ce qui n'est pas
protégé).

> **Résolution — corrigé (`2d25524`).** Le README a été relu en entier, pas seulement sur les
> quatre écarts listés : arborescence remise en face des dossiers réels (`member/`, `auth/`,
> `notification/`, `http/plugins/`), le compte de tests remis à jour au lieu de 232, authentification et validation par
> schéma parmi les choix notables, discussions et notifications ajoutées aux fonctionnalités,
> roadmap reprise point par point. La section « Sécurité » est réécrite en modèle de menace
> explicite : qui peut entrer, qui voit qui, ce qui est protégé, et **ce qui ne l'est pas** —
> absence de rôles, cooptation, pas de chiffrement au repos, pas de réinitialisation de mot de
> passe, `trustProxy` (S9). La procédure de sauvegarde `sqlite3 .backup` et le versionnement des
> migrations (Q8) y sont documentés. `docs/notifications.md` a gagné le type
> `EQUIPMENT_CIRCLE_CHANGED` (S10) et le refus d'un type de préférence inconnu (Q12) ;
> `docs/deploiement-android.md` a été relu et n'a été périmé par aucune correction — la chaîne
> Capacitor, l'auth Bearer et les variables CORS sont inchangées.

### Q11 — Concurrence sur le bootstrap

**Où** : `auth-service.ts:51-62`. `needsBootstrap()` puis création : deux requêtes simultanées
peuvent créer deux « premiers comptes ». Le rate-limit rend l'exploitation peu probable et l'impact
est faible, mais la garde est illusoire telle qu'écrite.

**Correctif** : envelopper la vérification et l'insertion dans une transaction, ou s'appuyer sur une
contrainte d'unicité dédiée.

> **Résolution — corrigé (`5291d19`).** `CredentialRepository.saveFirst` conditionne l'insertion à
> une table vide en une seule instruction ; `needsBootstrap()` n'est plus qu'un raccourci
> d'affichage. Le membre du perdant reste en base sans accès : il ne peut pas se connecter, et
> l'annuaire ne le montre à personne (aucun cercle, aucun invitant).

### Q12 — Points de détail

- `NotificationPreference.create` (`domain/notification/preference.ts:22`) ne valide pas `type` : un
  client peut stocker une préférence pour un type inexistant. Sans impact (elle ne sera jamais lue),
  mais c'est le seul value object du domaine sans invariant.
- `member-service.ts:16-20` (`createMember`) est mort : `app.ts:403` passe par
  `authService.createMemberWithInvite`. Idem `getMember`, jamais appelé.
- `expense-service.ts:71-77` (`getEquipment`) est mort depuis le passage à `equipmentForMember`.
- `Member.create` n'applique aucune validation sur `email` (format, unicité) alors que le login s'en
  sert comme identifiant — deux membres peuvent partager le même email et `login` prendra le premier
  qui répond.
- `app.ts:266-274` : le cookie de session n'a pas `path` restreint autrement que `/`, ce qui est
  correct, mais `expires` fixé à la date d'expiration initiale n'est **pas** rafraîchi côté client
  lors de la prolongation glissante — la session serveur survit au cookie navigateur.

> **Résolution — corrigé en deux temps (`af10429`, puis `f33c073`, `02d65e2`).** L'invariant
> d'unicité d'email avait ouvert un oracle d'énumération (B4) et `NOTIFICATION_TYPE_LABELS`, code mort
> touché par la branche, était resté (B14). Les cinq points sont traités. `NotificationPreference`
> refuse un type inconnu, et le dépôt SQLite écarte symétriquement les rangées d'un type retiré du
> domaine, qui feraient sinon échouer la lecture de toutes les préférences du membre. Le code mort
> est supprimé (`MemberService.createMember` et `getMember`, `ExpenseService.getEquipment`).
> `Member.create` valide et rogne l'email ; l'unicité est vérifiée par `AuthService` et non par un
> index SQL, la comparaison devant suivre `String.toLowerCase` plutôt que le repli ASCII de SQLite.
> Une migration normalise l'existant — sans elle une seule adresse mal formée en base rendrait son
> membre impossible à charger, donc l'application inutilisable pour tout son cercle. Le cookie de
> session est reposé à chaque prolongation glissante (voir Q4).

---

## 3. Plan d'action recommandé

**Avant tout autre développement**

1. **S1** — cantonner `regenerateInvite` au périmètre du demandeur, et interdire à une invitation de
   réécrire un mot de passe existant. C'est la seule faille qui annule tout le modèle de sécurité.
2. **S2** — cadrer `GET /api/members` sur le périmètre du demandeur ; restreindre ou tracer
   `POST /api/members`.
3. **S3** — révoquer les sessions au changement de mot de passe et à la consommation d'invitation.

Ajouter dans le même mouvement des tests d'intégration figeant ces trois propriétés — le fichier
`app.test.ts` a déjà exactement le bon format pour ça (voir sa section « cloisonnement »).

**Court terme**

4. **S5** — schémas de validation sur toutes les routes (gain immédiat : plus aucun 500 sur entrée
   malformée).
5. **Q1** — 403 pour les gestes réservés à l'auteur, corriger les trois tests concernés.
6. **S4** — servir les justificatifs via une route contrôlée ; purger les fichiers orphelins.
7. **S6** — rate-limit global.
8. **S7**, **S12**, **Q9** — corrections d'une ligne.
9. **Q10** — remettre le README en phase avec le code.

**Moyen terme**

10. **Q2** — découper `app.ts` en plugins (rend le reste plus facile à faire).
11. **Q5** — premiers tests front sur les chemins à risque.
12. **Q8** — migrations versionnées + procédure de sauvegarde documentée, **avant** la prochaine
    évolution de schéma.
13. **S8**, **S11**, **Q4**, **Q7** — durcissement et nettoyage.
14. **Q3** — descendre les filtres en SQL, **avant** le multi-groupes annoncé dans la roadmap.

> **Résolution — les quatorze points sont faits**, dans cet ordre, ainsi que **S10**, **Q6**,
> **Q11** et **Q12** qui n'y figuraient pas. Une relecture adversariale a ensuite montré que
> plusieurs de ces « faits » étaient partiels ou faux, et a trouvé un contournement
> d'authentification que ce plan n'avait pas vu : quinze défauts supplémentaires, tous traités sauf
> ceux listés comme ouverts. Restent **S9** (`trustProxy` sans borne), les vulnérabilités de
> dépendances de développement, le cache des soldes (Q3) et `ChecklistsPage` (Q6). Voir
> « Deuxième passe » en tête de document, qui fait foi.
