import type { SqliteDb } from './database.js';
import { splitFromJson, splitToJson } from './repositories.js';
import type { SplitJson } from './repositories.js';
import { Expense } from '../../../domain/expense/expense.js';
import type { ExpenseCategory } from '../../../domain/expense/expense.js';
import { Money } from '../../../domain/shared/money.js';
import { DomainError, NotFoundError } from '../../../domain/shared/domain-error.js';
import type { MemberMergePlan, MemberMerger, MergeCounts } from '../../../application/ports.js';

/**
 * Repointages sans piège : une colonne, une valeur, rien qui puisse entrer en collision. Les
 * autres tables — celles qui portent une clé primaire composée, un montant à additionner ou un
 * identifiant hors de portée des clés étrangères — sont traitées une par une plus bas.
 */
const REPOINTAGES: { table: string; colonne: string; compteur: keyof MergeCounts }[] = [
  { table: 'reservations', colonne: 'member_id', compteur: 'reservations' },
  { table: 'usage_records', colonne: 'member_id', compteur: 'usageRecords' },
  { table: 'expenses', colonne: 'payer_id', compteur: 'expensesPaid' },
  { table: 'threads', colonne: 'author_id', compteur: 'threads' },
  { table: 'messages', colonne: 'author_id', compteur: 'messages' },
  { table: 'checklists', colonne: 'author_id', compteur: 'checklists' },
  { table: 'checklist_items', colonne: 'checked_by_id', compteur: 'checklistItems' },
  { table: 'documents', colonne: 'author_id', compteur: 'documents' },
  { table: 'notifications', colonne: 'recipient_id', compteur: 'notifications' },
  { table: 'push_subscriptions', colonne: 'member_id', compteur: 'pushSubscriptions' },
];

interface ExpenseRow {
  id: string;
  equipment_id: string;
  label: string;
  amount_cents: number;
  payer_id: string;
  date: string;
  category: string;
  split_json: string;
  receipt_path: string | null;
}

/** Repère d'annulation de l'aperçu : levé pour défaire la transaction, jamais rendu à l'appelant. */
const APERÇU_TERMINÉ = Symbol('aperçu de fusion terminé');

/**
 * Fusion de deux comptes du même membre, en une transaction SQLite.
 *
 * Le geste appartient à ce niveau et pas à la couche application : il touche quinze tables, dont
 * plusieurs se refuseraient à un repointage naïf (clés primaires composées, remboursement de soi
 * à soi, répartitions de dépense où les identifiants sont des clés JSON). Une fusion à moitié
 * faite laisserait l'instance dans un état que personne n'a décidé — d'où la transaction, et
 * d'où le geste entier derrière une seule méthode.
 *
 * L'aperçu **est** la fusion, défaite avant de rendre la main : les compteurs annoncés ne peuvent
 * donc pas s'écarter de ce que la fusion fera, et une fusion qui échouerait échoue déjà ici.
 */
export class SqliteMemberMerger implements MemberMerger {
  constructor(private readonly db: SqliteDb) {}

  async preview(absorbedId: string, keptId: string): Promise<MergeCounts> {
    // L'identité retenue ne déplace rien : l'aperçu garde celle du compte conservé.
    const kept = this.db.prepare('SELECT name, email FROM members WHERE id = ?').get(keptId) as
      { name: string; email: string | null } | undefined;
    if (!kept) {
      throw new NotFoundError(`Membre introuvable : ${keptId}`);
    }
    let compteurs: MergeCounts | null = null;
    try {
      this.db.transaction(() => {
        compteurs = this.appliquer({ absorbedId, keptId, name: kept.name, email: kept.email });
        throw APERÇU_TERMINÉ;
      })();
    } catch (error) {
      if (error !== APERÇU_TERMINÉ) throw error;
    }
    // Inatteignable : le corps de la transaction affecte les compteurs avant de lever.
    if (compteurs === null) {
      throw new Error('Aperçu de fusion sans résultat.');
    }
    return compteurs;
  }

  async merge(plan: MemberMergePlan): Promise<MergeCounts> {
    return this.db.transaction(() => this.appliquer(plan))();
  }

  /** Corps de la fusion, à jouer dans une transaction. */
  private appliquer(plan: MemberMergePlan): MergeCounts {
    const { absorbedId, keptId } = plan;
    if (absorbedId === keptId) {
      throw new DomainError('Un compte ne se fusionne pas avec lui-même.');
    }
    const compteurs: MergeCounts = {
      circles: 0,
      circlesMerged: 0,
      reservations: 0,
      usageRecords: 0,
      expensesPaid: 0,
      expenseSplits: 0,
      reimbursements: 0,
      reimbursementsRemoved: 0,
      threads: 0,
      messages: 0,
      checklists: 0,
      checklistItems: 0,
      documents: 0,
      notifications: 0,
      notificationPreferences: 0,
      notificationPreferencesDropped: 0,
      pushSubscriptions: 0,
      invitedMembers: 0,
      sessionsRevoked: 0,
    };

    const communs = this.fusionnerCercles(absorbedId, keptId, compteurs);
    for (const { table, colonne, compteur } of REPOINTAGES) {
      compteurs[compteur] = this.db
        .prepare(`UPDATE ${table} SET ${colonne} = ? WHERE ${colonne} = ?`)
        .run(keptId, absorbedId).changes;
    }
    this.fusionnerRemboursements(absorbedId, keptId, compteurs);
    this.fusionnerRépartitions(absorbedId, keptId, compteurs);
    this.fusionnerPréférences(absorbedId, keptId, compteurs);
    this.repointerInvitations(absorbedId, keptId, compteurs);

    // L'accès de l'absorbé disparaît avant lui : son mot de passe (ou son code d'invitation encore
    // valable) est une seconde façon d'entrer dans une identité désormais vide, et ses sessions
    // laisseraient un appareil connecté sur un compte que plus rien n'alimente.
    this.db.prepare('DELETE FROM member_credentials WHERE member_id = ?').run(absorbedId);
    compteurs.sessionsRevoked = this.db.prepare('DELETE FROM sessions WHERE member_id = ?').run(absorbedId).changes;

    this.db.prepare('UPDATE members SET name = ?, email = ? WHERE id = ?').run(plan.name, plan.email, keptId);

    // Les clés étrangères sont armées (voir `openDatabase`) : cette suppression est elle-même la
    // vérification que plus aucune des six tables qu'elles couvrent ne nomme l'absorbé. Elle
    // échoue plutôt que de laisser un orphelin, et la transaction entière est défaite.
    const disparu = this.db.prepare('DELETE FROM members WHERE id = ?').run(absorbedId).changes;
    if (disparu === 0) {
      throw new NotFoundError(`Membre introuvable : ${absorbedId}`);
    }
    this.renuméroterCercles(communs);
    this.vérifierRépartitions(absorbedId);
    return compteurs;
  }

  /**
   * Cercles d'équipement. La clé primaire est `(equipment_id, member_id)` : là où les deux comptes
   * figurent, repointer violerait la clé — c'est la même personne inscrite deux fois, une ligne
   * doit disparaître. Renvoie les équipements concernés, dont les positions seront resserrées.
   */
  private fusionnerCercles(absorbedId: string, keptId: string, compteurs: MergeCounts): string[] {
    const communs = (
      this.db
        .prepare(
          `SELECT absorbé.equipment_id AS equipment_id
             FROM equipment_members absorbé
             JOIN equipment_members conservé
               ON conservé.equipment_id = absorbé.equipment_id AND conservé.member_id = ?
            WHERE absorbé.member_id = ?`,
        )
        .all(keptId, absorbedId) as { equipment_id: string }[]
    ).map((r) => r.equipment_id);

    const supprimer = this.db.prepare('DELETE FROM equipment_members WHERE equipment_id = ? AND member_id = ?');
    for (const equipmentId of communs) {
      supprimer.run(equipmentId, absorbedId);
    }
    compteurs.circlesMerged = communs.length;
    compteurs.circles = this.db
      .prepare('UPDATE equipment_members SET member_id = ? WHERE member_id = ?')
      .run(keptId, absorbedId).changes;
    return communs;
  }

  /**
   * Positions resserrées sur 0..n-1 dans les cercles où une ligne vient de disparaître. L'ordre
   * d'affichage est celui des positions : le trou qu'y laisse la fusion ne se voit pas, mais la
   * prochaine réécriture du cercle repartirait d'une numérotation dont ce dépôt n'est pas l'auteur.
   */
  private renuméroterCercles(equipmentIds: readonly string[]): void {
    // Les positions se lisent d'abord, se réécrivent ensuite. Un `UPDATE` qui les recalculerait
    // par sous-requête corrélée compterait des lignes que le même `UPDATE` vient de déplacer, et
    // rendrait deux membres à la même position — l'ordre du cercle deviendrait celui du hasard.
    const lire = this.db.prepare(
      'SELECT member_id FROM equipment_members WHERE equipment_id = ? ORDER BY position, member_id',
    );
    const écrire = this.db.prepare(
      'UPDATE equipment_members SET position = ? WHERE equipment_id = ? AND member_id = ?',
    );
    for (const equipmentId of equipmentIds) {
      const cercle = lire.all(equipmentId) as { member_id: string }[];
      cercle.forEach((ligne, position) => écrire.run(position, equipmentId, ligne.member_id));
    }
  }

  /**
   * Remboursements. Ceux qui allaient d'un compte à l'autre deviendraient des remboursements de
   * soi à soi : ils sont supprimés. Ils ne pèsent rien dans les soldes — le même membre y serait
   * à la fois créditeur et débiteur du même montant —, et « Damien → Damien » à l'écran
   * n'expliquerait rien à personne. Le journal en garde le compte.
   */
  private fusionnerRemboursements(absorbedId: string, keptId: string, compteurs: MergeCounts): void {
    compteurs.reimbursementsRemoved = this.db
      .prepare(
        `DELETE FROM reimbursements
          WHERE (from_member_id = ? AND to_member_id = ?)
             OR (from_member_id = ? AND to_member_id = ?)
             OR (from_member_id = ? AND to_member_id = ?)`,
      )
      .run(absorbedId, keptId, keptId, absorbedId, absorbedId, absorbedId).changes;
    const de = this.db
      .prepare('UPDATE reimbursements SET from_member_id = ? WHERE from_member_id = ?')
      .run(keptId, absorbedId).changes;
    const vers = this.db
      .prepare('UPDATE reimbursements SET to_member_id = ? WHERE to_member_id = ?')
      .run(keptId, absorbedId).changes;
    compteurs.reimbursements = de + vers;
  }

  /**
   * Répartitions de dépense. Les identifiants y sont des entrées de tableau et des clés d'objet
   * dans `split_json`, hors de portée des clés étrangères : aucun `UPDATE` ne les atteint, et une
   * dépense oubliée ici garderait pour toujours la part d'un compte qui n'existe plus.
   *
   * La règle de réécriture appartient au domaine (`Expense.mergeMembers`) : elle sait quand
   * renommer et quand additionner. On la fait passer par `Expense.create` — sa validation est
   * celle du rechargement, donc une dépense écrite ici est une dépense que l'application relira.
   */
  private fusionnerRépartitions(absorbedId: string, keptId: string, compteurs: MergeCounts): void {
    // `instr` et non `LIKE` : l'identifiant est opaque, il n'a pas à être lu comme un motif. Le
    // filtre ne sert qu'à écarter le gros des dépenses — il rend un sur-ensemble, jamais moins.
    const rows = this.db
      .prepare('SELECT * FROM expenses WHERE instr(split_json, ?) > 0')
      .all(absorbedId) as ExpenseRow[];
    const écrire = this.db.prepare('UPDATE expenses SET split_json = ? WHERE id = ?');
    for (const row of rows) {
      const dépense = Expense.create({
        id: row.id,
        equipmentId: row.equipment_id,
        label: row.label,
        amount: Money.fromCents(row.amount_cents),
        payerId: row.payer_id,
        date: new Date(row.date),
        category: row.category as ExpenseCategory,
        split: splitFromJson(JSON.parse(row.split_json) as SplitJson),
        receiptPath: row.receipt_path,
      });
      const fusionnée = JSON.stringify(splitToJson(dépense.mergeMembers(absorbedId, keptId).split));
      if (fusionnée === row.split_json) continue;
      écrire.run(fusionnée, row.id);
      compteurs.expenseSplits += 1;
    }
  }

  /**
   * Préférences de notification. La clé primaire est `(member_id, type)` : pour un type réglé des
   * deux côtés, celles du compte conservé l'emportent — c'est l'identité qui continue, et son
   * titulaire retrouvera ses propres réglages. Celles de l'absorbé ne sont reprises que sur les
   * types que le conservé n'avait jamais réglés, où elles ne remplacent qu'un défaut.
   */
  private fusionnerPréférences(absorbedId: string, keptId: string, compteurs: MergeCounts): void {
    const conservés = (
      this.db.prepare('SELECT type FROM notification_preferences WHERE member_id = ?').all(keptId) as {
        type: string;
      }[]
    ).map((r) => r.type);
    const abandonner = this.db.prepare('DELETE FROM notification_preferences WHERE member_id = ? AND type = ?');
    for (const type of conservés) {
      compteurs.notificationPreferencesDropped += abandonner.run(absorbedId, type).changes;
    }
    compteurs.notificationPreferences = this.db
      .prepare('UPDATE notification_preferences SET member_id = ? WHERE member_id = ?')
      .run(keptId, absorbedId).changes;
  }

  /**
   * Invitations. Les invités de l'absorbé passent au conservé, qui reste leur seul lien tant
   * qu'aucun cercle ne les réunit. Un compte invité par l'autre deviendrait son propre invitant :
   * ce lien-là s'efface, il ne décrit plus rien.
   */
  private repointerInvitations(absorbedId: string, keptId: string, compteurs: MergeCounts): void {
    this.db.prepare('UPDATE members SET invited_by = NULL WHERE id = ? AND invited_by = ?').run(keptId, absorbedId);
    compteurs.invitedMembers = this.db
      .prepare('UPDATE members SET invited_by = ? WHERE invited_by = ? AND id <> ?')
      .run(keptId, absorbedId, keptId).changes;
  }

  /**
   * Dernier rempart, là où les clés étrangères ne vont pas : plus une seule répartition ne doit
   * nommer l'absorbé. Levée ici, l'erreur défait la transaction — mieux vaut pas de fusion qu'une
   * dépense qui garde la part d'un compte disparu.
   */
  private vérifierRépartitions(absorbedId: string): void {
    const { restantes } = this.db
      .prepare('SELECT COUNT(*) AS restantes FROM expenses WHERE instr(split_json, ?) > 0')
      .get(absorbedId) as { restantes: number };
    if (restantes > 0) {
      throw new DomainError(
        `Fusion interrompue : ${restantes} répartition(s) de dépense nomment encore le compte absorbé.`,
      );
    }
  }
}
