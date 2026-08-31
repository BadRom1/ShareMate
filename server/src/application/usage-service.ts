import { UsageRecord } from '../domain/usage/usage-record.js';
import { computeMaintenanceStatus } from '../domain/usage/maintenance-alert.js';
import type { MaintenanceStatus } from '../domain/usage/maintenance-alert.js';
import { chainOrder, computeDurations } from '../domain/usage/usage-duration.js';
import { roundMeterValue } from '../domain/usage/meter-value.js';
import { DomainError, NotFoundError } from '../domain/shared/domain-error.js';
import { accessibleEquipmentIds, equipmentForMember, equipmentsForMember } from './equipment-access.js';
import type { Equipment } from '../domain/equipment/equipment.js';
import type { Clock, EquipmentRepository, IdGenerator, Notifier, UsageRecordRepository } from './ports.js';

export interface RecordUsageInput {
  equipmentId: string;
  memberId: string;
  /** Relevé de compteur en fin d'utilisation. Optionnel si `duration` est fournie. */
  meterReading?: number | null;
  /** Durée d'utilisation (heures/km) : le compteur est alors calculé depuis le compteur au départ. */
  duration?: number | null;
  /**
   * Compteur relevé au départ. Par défaut le dernier relevé connu — l'écart, quand il y en a un,
   * est précisément ce que personne n'a saisi.
   */
  startReading?: number | null;
  /**
   * À qui attribuer le segment laissé entre le dernier relevé connu et le compteur au départ.
   * `null` (défaut) : le segment existe, en attente que quelqu'un le reconnaisse.
   */
  gapMemberId?: string | null;
  fuelAddedLiters?: number | null;
  notes?: string | null;
  isMaintenance?: boolean;
}

/**
 * Correction d'un relevé déjà saisi. Chaque champ omis reste tel quel ; `memberId`
 * réattribue le relevé — et avec lui sa durée — à un autre membre du cercle.
 */
export interface UpdateUsageInput {
  meterReading?: number;
  startReading?: number | null;
  memberId?: string | null;
  fuelAddedLiters?: number | null;
  notes?: string | null;
  isMaintenance?: boolean;
}

/**
 * Ordre de lecture d'un historique : du plus récent au plus ancien, le compteur départageant
 * deux relevés du même instant — une saisie et le segment qu'elle met au jour partagent leur
 * date, et se lisent alors dans l'ordre de la chaîne, le plus haut d'abord.
 */
function byMostRecent(a: UsageRecord, b: UsageRecord): number {
  return b.recordedAt.getTime() - a.recordedAt.getTime() || b.meterReading - a.meterReading;
}

/** Relevé accompagné de la durée attribuée à son membre. */
export interface UsageEntry {
  record: UsageRecord;
  duration: number | null;
}

/** Relevé enregistré, accompagné du segment que sa saisie a mis au jour, s'il y en avait un. */
export interface RecordUsageResult extends UsageEntry {
  gap: UsageEntry | null;
}

export class UsageService {
  constructor(
    private readonly usageRecords: UsageRecordRepository,
    private readonly equipments: EquipmentRepository,
    private readonly idGenerator: IdGenerator,
    private readonly clock: Clock,
    private readonly notifier: Notifier,
  ) {}

  async recordUsage(input: RecordUsageInput): Promise<RecordUsageResult> {
    const equipment = await equipmentForMember(this.equipments, input.equipmentId, input.memberId);
    const existing = await this.usageRecords.findByEquipmentId(input.equipmentId);
    const lastReading = existing.length > 0 ? Math.max(...existing.map((u) => u.meterReading)) : null;
    const startReading = input.startReading == null ? lastReading : roundMeterValue(input.startReading);
    const meterReading = this.resolveMeterReading(input, startReading);
    if (lastReading !== null && meterReading < lastReading) {
      throw new DomainError(
        `Le relevé de compteur (${meterReading}) ne peut pas être inférieur au dernier relevé connu (${lastReading}).`,
      );
    }
    if (startReading !== null && lastReading !== null && startReading < lastReading) {
      throw new DomainError(
        `Le compteur au départ (${startReading}) ne peut pas être inférieur au dernier relevé connu (${lastReading}).`,
      );
    }

    // Le relevé du membre se construit — donc se valide — avant que quoi que ce soit ne soit
    // écrit : une saisie refusée (carburant négatif, départ au-delà de l'arrivée) ne doit pas
    // laisser derrière elle le segment qu'elle allait ouvrir.
    const record = UsageRecord.create({
      id: this.idGenerator.next(),
      equipmentId: input.equipmentId,
      memberId: input.memberId,
      recordedAt: this.clock.now(),
      meterReading,
      startReading,
      fuelAddedLiters: input.fuelAddedLiters ?? null,
      notes: input.notes ?? null,
      isMaintenance: input.isMaintenance ?? false,
    });

    // L'engin a tourné entre le dernier relevé et le compteur trouvé au départ : ces heures
    // existent, elles ne sont pas à celui qui les constate. Elles deviennent un relevé à part,
    // attribué à qui il désigne, ou laissé en attente.
    const gap =
      startReading !== null && lastReading !== null && startReading > lastReading
        ? await this.recordGap(equipment, lastReading, startReading, input.gapMemberId ?? null)
        : null;
    await this.usageRecords.save(record);
    const after = [...existing, ...(gap ? [gap.record] : []), record];
    await this.notifyIfMaintenanceReached(equipment, existing, after);
    return {
      record,
      duration: startReading === null ? null : roundMeterValue(record.meterReading - startReading),
      gap,
    };
  }

  /**
   * Segment constaté entre deux compteurs : une durée réelle, dont l'auteur reste à confirmer.
   *
   * C'est la contrepartie de toute heure qu'un relevé relâche — à la saisie, à la correction, à
   * la suppression. Sans elle, ces heures quitteraient l'historique sans quitter le compteur :
   * invisibles, donc perdues pour le prorata comme pour l'entretien.
   */
  private async recordGap(
    equipment: Equipment,
    from: number,
    to: number,
    memberId: string | null,
  ): Promise<UsageEntry> {
    if (memberId !== null && !equipment.memberIds.includes(memberId)) {
      throw new DomainError(`Un relevé ne s'attribue qu'à un membre du cercle de l'équipement : ${memberId}`);
    }
    const record = UsageRecord.create({
      id: this.idGenerator.next(),
      equipmentId: equipment.id,
      memberId,
      recordedAt: this.clock.now(),
      meterReading: to,
      startReading: from,
      notes: null,
      isMaintenance: false,
    });
    await this.usageRecords.save(record);
    return { record, duration: roundMeterValue(to - from) };
  }

  /**
   * Corrige un relevé déjà saisi : compteur mal recopié, carburant oublié, ou relevé
   * porté par le mauvais membre. La correction appartient au cercle, pas à l'auteur :
   * celui qui constate l'erreur est rarement celui qui l'a commise.
   */
  async updateUsage(id: string, changes: UpdateUsageInput, requesterId: string): Promise<UsageEntry> {
    const existing = await this.recordForMember(id, requesterId);
    const equipment = await equipmentForMember(this.equipments, existing.equipmentId, requesterId);
    const memberId = changes.memberId === undefined ? existing.memberId : changes.memberId;
    if (memberId !== null && !equipment.memberIds.includes(memberId)) {
      throw new DomainError(`Un relevé ne s'attribue qu'à un membre du cercle de l'équipement : ${memberId}`);
    }
    const siblings = await this.usageRecords.findByEquipmentId(existing.equipmentId);
    const meterReading =
      changes.meterReading === undefined ? existing.meterReading : roundMeterValue(changes.meterReading);
    const startReading =
      changes.startReading === undefined
        ? existing.startReading
        : changes.startReading === null
          ? null
          : roundMeterValue(changes.startReading);
    this.assertFitsChain(meterReading, startReading, existing.id, siblings);
    const updated = UsageRecord.create({
      id: existing.id,
      equipmentId: existing.equipmentId,
      memberId,
      recordedAt: existing.recordedAt,
      meterReading,
      startReading,
      fuelAddedLiters: changes.fuelAddedLiters === undefined ? existing.fuelAddedLiters : changes.fuelAddedLiters,
      notes: changes.notes === undefined ? existing.notes : changes.notes,
      isMaintenance: changes.isMaintenance ?? existing.isMaintenance,
    });
    await this.usageRecords.save(updated);

    // « Je n'ai fait que deux heures sur les sept » : les cinq autres ont tourné pour quelqu'un.
    // Rétrécir un relevé les lui retire, il ne les efface pas — par le départ comme par l'arrivée.
    const rendus: [number, number][] = [];
    if (existing.startReading !== null && startReading !== null && startReading > existing.startReading) {
      rendus.push([existing.startReading, startReading]);
    }
    // Côté arrivée, seul un relevé plus haut atteste que l'engin a tourné jusque-là. Sans lui,
    // baisser le compteur corrige le compteur lui-même : il n'y a pas d'heures à rendre.
    if (
      meterReading < existing.meterReading &&
      siblings.some((r) => r.id !== existing.id && r.meterReading > meterReading)
    ) {
      rendus.push([meterReading, existing.meterReading]);
    }
    const released: UsageRecord[] = [];
    for (const [from, to] of rendus) {
      released.push((await this.recordGap(equipment, from, to, null)).record);
    }

    const after = [...siblings.map((r) => (r.id === updated.id ? updated : r)), ...released];
    await this.notifyIfMaintenanceReached(equipment, siblings, after);
    return { record: updated, duration: computeDurations(after).get(updated.id) ?? null };
  }

  /**
   * Supprime un relevé saisi par erreur.
   *
   * Tant qu'un relevé plus haut existe, le compteur atteste que l'engin a bien tourné pendant
   * l'intervalle supprimé : ces heures restent, en attente d'attribution, et seuls l'auteur et
   * les détails du relevé s'en vont. Le dernier relevé de la chaîne, lui, n'est attesté par rien
   * au-dessus de lui : il disparaît entièrement, et le compteur revient au relevé précédent.
   */
  async deleteUsage(id: string, requesterId: string): Promise<UsageEntry | null> {
    const existing = await this.recordForMember(id, requesterId);
    const equipment = await equipmentForMember(this.equipments, existing.equipmentId, requesterId);
    const siblings = await this.usageRecords.findByEquipmentId(existing.equipmentId);
    // Heures attestées : un relevé plus haut prouve que l'engin a tourné pendant cet intervalle.
    const départ = existing.startReading;
    const attesté =
      départ !== null && existing.meterReading > départ && siblings.some((r) => r.meterReading > existing.meterReading);
    if (attesté && existing.memberId === null) {
      throw new DomainError(
        'Ces heures sont attestées par un relevé plus haut : elles ne peuvent pas disparaître. ' +
          'Attribuez-les à un membre, ou corrigez le relevé qui les suit.',
      );
    }
    await this.usageRecords.delete(id);
    const released = attesté ? await this.recordGap(equipment, départ, existing.meterReading, null) : null;

    // Supprimer une maintenance déclarée éloigne d'autant le dernier entretien connu :
    // la suppression aussi peut faire basculer l'équipement en alerte.
    await this.notifyIfMaintenanceReached(equipment, siblings, [
      ...siblings.filter((r) => r.id !== id),
      ...(released ? [released.record] : []),
    ]);
    return released;
  }

  /**
   * Un relevé se corrige, il ne se déplace pas dans la chaîne : son compteur reste borné par
   * celui d'avant et celui d'après. Sans cette borne, une correction réordonnerait la chaîne et
   * redistribuerait en silence les durées des voisins.
   *
   * Son départ est borné de la même façon par le relevé précédent : plus bas, il recouvrirait
   * des heures déjà portées par quelqu'un d'autre, et les mêmes heures compteraient deux fois.
   */
  private assertFitsChain(
    meterReading: number,
    startReading: number | null,
    id: string,
    siblings: readonly UsageRecord[],
  ): void {
    const chain = [...siblings].sort(chainOrder);
    const index = chain.findIndex((r) => r.id === id);
    const previous = chain[index - 1];
    const next = chain[index + 1];
    if (previous && meterReading < previous.meterReading) {
      throw new DomainError(
        `Le relevé de compteur (${meterReading}) ne peut pas être inférieur au relevé précédent (${previous.meterReading}).`,
      );
    }
    if (next && meterReading > next.meterReading) {
      throw new DomainError(
        `Le relevé de compteur (${meterReading}) ne peut pas être supérieur au relevé suivant (${next.meterReading}).`,
      );
    }
    if (previous && startReading !== null && startReading < previous.meterReading) {
      throw new DomainError(
        `Le compteur au départ (${startReading}) ne peut pas être inférieur au relevé précédent (${previous.meterReading}).`,
      );
    }
  }

  /**
   * Relevé demandé, à condition que le demandeur partage le cercle de son équipement.
   * Le refus emprunte le message d'absence du relevé : hors du cercle, il n'existe pas.
   */
  private async recordForMember(id: string, requesterId: string): Promise<UsageRecord> {
    const absent = `Relevé introuvable : ${id}`;
    const existing = await this.usageRecords.findById(id);
    if (!existing) {
      throw new NotFoundError(absent);
    }
    await equipmentForMember(this.equipments, existing.equipmentId, requesterId, absent);
    return existing;
  }

  /** Notifie le cercle au passage en alerte, jamais tant que l'équipement y était déjà. */
  private async notifyIfMaintenanceReached(
    equipment: Equipment,
    before: readonly UsageRecord[],
    after: readonly UsageRecord[],
  ): Promise<void> {
    const statusBefore = computeMaintenanceStatus(equipment, before);
    const statusAfter = computeMaintenanceStatus(equipment, after);
    if (statusBefore.alert || !statusAfter.alert) {
      return;
    }
    await this.notifier.notify({
      type: 'MAINTENANCE_ALERT',
      recipientIds: [...equipment.memberIds],
      title: `🔧 Entretien : ${equipment.name}`,
      body: `Le seuil d'entretien est atteint (${statusAfter.unitsSinceMaintenance ?? '?'} ${equipment.meterUnit === 'HOURS' ? 'h' : 'km'} depuis le dernier entretien).`,
      link: `/?tab=usage&equipment=${equipment.id}`,
    });
  }

  /** Compteur saisi directement, ou calculé « compteur au départ + durée ». */
  private resolveMeterReading(input: RecordUsageInput, startReading: number | null): number {
    if (input.meterReading != null) {
      return roundMeterValue(input.meterReading);
    }
    if (input.duration == null) {
      throw new DomainError("Indiquez le relevé de compteur ou la durée d'utilisation.");
    }
    if (!Number.isFinite(input.duration) || input.duration < 0) {
      throw new DomainError("La durée d'utilisation doit être un nombre positif.");
    }
    if (startReading === null) {
      throw new DomainError('Aucun relevé précédent pour cet équipement : saisissez le relevé de compteur.');
    }
    return roundMeterValue(startReading + input.duration);
  }

  async historyByEquipment(equipmentId: string, requesterId: string): Promise<UsageEntry[]> {
    await equipmentForMember(this.equipments, equipmentId, requesterId);
    const records = await this.usageRecords.findByEquipmentId(equipmentId);
    const durations = computeDurations(records);
    return records.sort(byMostRecent).map((record) => ({ record, duration: durations.get(record.id) ?? null }));
  }

  /** Historique d'un membre, borné aux équipements que le demandeur partage aussi. */
  async historyByMember(memberId: string, requesterId: string): Promise<UsageEntry[]> {
    const accessible = await accessibleEquipmentIds(this.equipments, requesterId);
    const records = (await this.usageRecords.findByMemberId(memberId)).filter((r) => accessible.has(r.equipmentId));
    // La durée dépend du relevé précédent sur l'équipement, quel qu'en soit l'auteur :
    // on recalcule donc sur l'historique complet des équipements concernés, chargé d'un seul coup.
    const durations = new Map<string, number | null>();
    for (const history of (await this.recordsByEquipment([...new Set(records.map((r) => r.equipmentId))])).values()) {
      for (const [id, duration] of computeDurations(history)) {
        durations.set(id, duration);
      }
    }
    return records.sort(byMostRecent).map((record) => ({ record, duration: durations.get(record.id) ?? null }));
  }

  async maintenanceStatus(equipmentId: string, requesterId: string): Promise<MaintenanceStatus> {
    const equipment = await equipmentForMember(this.equipments, equipmentId, requesterId);
    const records = await this.usageRecords.findByEquipmentId(equipmentId);
    return computeMaintenanceStatus(equipment, records);
  }

  /** Statuts en alerte, pour les seuls équipements du cercle du demandeur. */
  async alerts(requesterId: string): Promise<MaintenanceStatus[]> {
    const equipments = await equipmentsForMember(this.equipments, requesterId);
    const byEquipment = await this.recordsByEquipment(equipments.map((e) => e.id));
    return equipments.map((e) => computeMaintenanceStatus(e, byEquipment.get(e.id) ?? [])).filter((s) => s.alert);
  }

  /** Relevés de plusieurs équipements, indexés par équipement, en une seule interrogation. */
  private async recordsByEquipment(equipmentIds: string[]): Promise<Map<string, UsageRecord[]>> {
    const byEquipment = new Map<string, UsageRecord[]>(equipmentIds.map((id) => [id, []]));
    for (const record of await this.usageRecords.findByEquipmentIds(equipmentIds)) {
      byEquipment.get(record.equipmentId)?.push(record);
    }
    return byEquipment;
  }
}
