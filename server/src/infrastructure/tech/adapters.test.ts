import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { CURRENT_COST, ScryptPasswordHasher } from './adapters.js';

const scrypt = promisify<crypto.BinaryLike, crypto.BinaryLike, number, Buffer>(crypto.scrypt);

/** Coût réduit : ces tests vérifient le format et la migration, pas la lenteur de la dérivation. */
const COÛT_TEST = { N: 2 ** 12, r: 8, p: 1 };

/** Hachage tel que produit par la version antérieure : `scrypt:<sel>:<dérivé>`, coût implicite. */
async function hachageHérité(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, 32);
  return `scrypt:${salt}:${derived.toString('hex')}`;
}

describe('ScryptPasswordHasher', () => {
  it('produit un hachage versionné portant ses paramètres de coût', async () => {
    const hasher = new ScryptPasswordHasher(COÛT_TEST);
    const hash = await hasher.hash('motdepasse');
    expect(hash.startsWith(`scrypt$${COÛT_TEST.N}$${COÛT_TEST.r}$${COÛT_TEST.p}$`)).toBe(true);
    expect(hash.split('$')).toHaveLength(6);
  });

  it('sale chaque hachage : deux hachages du même mot de passe diffèrent', async () => {
    const hasher = new ScryptPasswordHasher(COÛT_TEST);
    expect(await hasher.hash('motdepasse')).not.toBe(await hasher.hash('motdepasse'));
  });

  it('vérifie un hachage au format versionné', async () => {
    const hasher = new ScryptPasswordHasher(COÛT_TEST);
    const hash = await hasher.hash('motdepasse');
    expect(await hasher.verify('motdepasse', hash)).toBe(true);
    expect(await hasher.verify('mauvais', hash)).toBe(false);
  });

  it('vérifie encore un hachage au format hérité, sous son coût implicite', async () => {
    const hasher = new ScryptPasswordHasher(COÛT_TEST);
    const hérité = await hachageHérité('motdepasse');
    expect(await hasher.verify('motdepasse', hérité)).toBe(true);
    expect(await hasher.verify('mauvais', hérité)).toBe(false);
  });

  it('signale à re-hacher les formats hérité et versionné moins coûteux', async () => {
    const hasher = new ScryptPasswordHasher(CURRENT_COST);
    expect(hasher.needsRehash(await hachageHérité('motdepasse'))).toBe(true);
    expect(hasher.needsRehash(await new ScryptPasswordHasher(COÛT_TEST).hash('motdepasse'))).toBe(true);
  });

  it('ne signale pas à re-hacher un hachage produit au coût courant', async () => {
    const hasher = new ScryptPasswordHasher(COÛT_TEST);
    expect(hasher.needsRehash(await hasher.hash('motdepasse'))).toBe(false);
  });

  it('rejette un hachage illisible sans le signaler à re-hacher', async () => {
    const hasher = new ScryptPasswordHasher(COÛT_TEST);
    for (const illisible of ['', 'nimportequoi', 'scrypt$0$8$1$sel$dérivé', 'bcrypt$1$2$3$4$5']) {
      expect(await hasher.verify('motdepasse', illisible)).toBe(false);
      expect(hasher.needsRehash(illisible)).toBe(false);
    }
  });

  it('dérive au coût recommandé par défaut (N = 2¹⁷, au-delà du maxmem par défaut de Node)', async () => {
    const hash = await new ScryptPasswordHasher().hash('motdepasse');
    expect(hash.startsWith(`scrypt$${2 ** 17}$8$1$`)).toBe(true);
  });
});
