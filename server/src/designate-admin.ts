import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './infrastructure/persistence/sqlite/database.js';

/**
 * Désignation de l'administrateur de l'instance — le compte autorisé à fusionner deux membres
 * en un.
 *
 * Sur une base neuve, rien à faire : `AuthService.bootstrap` marque le premier compte. Ce script
 * existe pour les bases antérieures à ce rôle, où **aucun repère ne le désigne** : la colonne
 * `invited_by` vaut NULL sur tous les membres d'avant, si bien que « le seul sans invitant » ne
 * nomme personne. Se tromper donne à quelqu'un le pouvoir d'absorber n'importe quel compte : le
 * script ne devine donc rien, il montre et attend qu'on tranche.
 *
 *     npm run admin:designate            # liste les comptes et propose un candidat
 *     npm run admin:designate -- <id>    # désigne ce compte, et lui seul
 *
 * L'ordre affiché est celui des insertions (`rowid`) : sur une base qui n'a jamais vu de fusion
 * ni de reprise à la main, le premier compte ouvert est le premier de la liste.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR ?? path.resolve(here, '../../data');
const databasePath = process.env.DATABASE_PATH ?? path.join(dataDir, 'sharemate.sqlite');
const cible = process.argv.slice(2).find((arg) => !arg.startsWith('-'));

interface Compte {
  rowid: number;
  id: string;
  name: string;
  email: string | null;
  is_admin: number;
  ouvert: number;
}

const db = openDatabase(databasePath);

const comptes = db
  .prepare(
    `SELECT m.rowid AS rowid, m.id, m.name, m.email, m.is_admin,
            (SELECT COUNT(*) FROM member_credentials c
              WHERE c.member_id = m.id AND c.password_hash IS NOT NULL) AS ouvert
       FROM members m ORDER BY m.rowid`,
  )
  .all() as Compte[];

if (comptes.length === 0) {
  console.error(`Aucun membre dans ${databasePath} : l’instance n’a pas encore été amorcée.`);
  db.close();
  process.exit(1);
}

/** Ligne lisible d'un compte : ce qui permet de le reconnaître, et ce qui le rend éligible. */
function ligne(compte: Compte): string {
  const marques = [compte.is_admin === 1 ? 'ADMINISTRATEUR' : null, compte.ouvert === 0 ? 'jamais ouvert' : null]
    .filter(Boolean)
    .join(', ');
  return (
    `${String(compte.rowid).padStart(3)}. ${compte.name}${compte.email ? ` <${compte.email}>` : ''}` +
    `\n     ${compte.id}${marques ? `  [${marques}]` : ''}`
  );
}

if (!cible) {
  const actuel = comptes.find((c) => c.is_admin === 1);
  console.log(`Base : ${databasePath}\n`);
  console.log(`${comptes.length} compte(s), dans l’ordre où ils ont été créés :\n`);
  console.log(comptes.map(ligne).join('\n'));
  if (actuel) {
    console.log(`\nAdministrateur actuel : ${actuel.name} (${actuel.id}).`);
  } else {
    const candidat = comptes.find((c) => c.ouvert > 0);
    console.log('\nCette instance n’a pas d’administrateur : la fusion de comptes n’est ouverte à personne.');
    if (candidat) {
      console.log(
        `Candidat le plus probable — premier compte inséré qui porte un mot de passe :\n` +
          `  ${candidat.name} (${candidat.id})`,
      );
    }
  }
  console.log(
    '\nRien n’a été écrit. Pour désigner un compte (le rôle est retiré à tout autre) :\n' +
      '  npm run admin:designate -- <identifiant>',
  );
  db.close();
  process.exit(0);
}

const compte = comptes.find((c) => c.id === cible);
if (!compte) {
  console.error(`Aucun compte ne porte l’identifiant « ${cible} » dans ${databasePath}.`);
  console.error('Relancez sans argument pour lister les comptes.');
  db.close();
  process.exit(1);
}
// Un compte jamais ouvert ne peut pas se connecter : le désigner ne donnerait le geste à
// personne, et laisserait le rôle attaché à une identité qu'un code d'invitation peut encore
// prendre. L'opérateur ouvre d'abord le compte, puis revient.
if (compte.ouvert === 0) {
  console.error(
    `« ${compte.name} » n’a pas de mot de passe : ce compte n’a jamais été ouvert et ne pourrait pas ` +
      'se connecter pour exercer le rôle. Désignez un compte en service.',
  );
  db.close();
  process.exit(1);
}

// Un seul administrateur à la fois : le rôle se déplace, il ne s'ajoute pas.
const désigner = db.transaction(() => {
  db.prepare('UPDATE members SET is_admin = 0 WHERE is_admin = 1 AND id <> ?').run(compte.id);
  db.prepare('UPDATE members SET is_admin = 1 WHERE id = ?').run(compte.id);
});
désigner();

const anciens = comptes.filter((c) => c.is_admin === 1 && c.id !== compte.id);
console.log(`« ${compte.name} » (${compte.id}) est désormais l’administrateur de l’instance.`);
if (anciens.length > 0) {
  console.log(`Rôle retiré à : ${anciens.map((c) => `${c.name} (${c.id})`).join(', ')}.`);
}
console.log('Le changement est immédiat : aucune session à rouvrir, aucun redémarrage à faire.');
db.close();
