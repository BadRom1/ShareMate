import { describe, expect, it } from 'vitest';
import { NotificationPreference } from './preference.js';
import { DomainError } from '../shared/domain-error.js';
import type { NotificationType } from './notification-type.js';

describe('NotificationPreference', () => {
  it('conserve le réglage d’un type connu', () => {
    const pref = NotificationPreference.create({ memberId: 'm1', type: 'MESSAGE_POSTED', inApp: false, push: true });
    expect(pref).toMatchObject({ memberId: 'm1', type: 'MESSAGE_POSTED', inApp: false, push: true });
  });

  it('refuse un type inconnu : la préférence ne serait jamais relue', () => {
    const inconnu = 'PIGEON_VOYAGEUR' as NotificationType;
    expect(() => NotificationPreference.create({ memberId: 'm1', type: inconnu, inApp: true, push: true })).toThrow(
      DomainError,
    );
  });

  it('vaut tout activé par défaut', () => {
    expect(NotificationPreference.default('m1', 'EXPENSE_ADDED')).toMatchObject({ inApp: true, push: true });
  });
});
