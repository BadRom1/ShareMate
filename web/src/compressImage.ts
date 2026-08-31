/**
 * Compression des images au moment où on les choisit, avant tout téléversement.
 *
 * Une photo prise au téléphone pèse aujourd'hui 4 à 12 Mo pour 4000 pixels de large. Rien ici ne
 * s'en sert : un justificatif se lit, une pièce jointe se regarde sur un écran de téléphone, un
 * document photographié s'imprime au mieux en A4. Le reste, ce sont des octets qui traversent le
 * réseau du membre, remplissent les 500 Mo alloués à l'équipement, et se retéléchargent à chaque
 * consultation.
 *
 * Le travail se fait donc chez celui qui envoie, avant la requête : c'est le seul endroit où la
 * compression économise aussi le téléversement lui-même — souvent le trajet le plus lent, fait
 * depuis un chantier en 4G. Le serveur, lui, garde ses plafonds inchangés : ils bornent ce qui
 * arrive, quoi qu'il arrive.
 *
 * Rien n'est jamais dégradé sans gain : si l'image compressée n'est pas plus légère que
 * l'originale, ou si le navigateur ne sait pas la relire, c'est le fichier d'origine qui part.
 */

/**
 * Côté le plus long d'une image après compression. 2000 px couvre l'usage réel — plein écran sur
 * un ordinateur, un zoom confortable sur un numéro de série, une impression A4 correcte — sans
 * garder les détails d'un capteur de 12 Mpx que personne ne regardera.
 */
export const MAX_IMAGE_DIMENSION = 2000;

/**
 * Qualité d'encodage. À 0,82 l'œil ne distingue pas la photo de son original sur les images
 * naturelles, et le poids tombe d'un ordre de grandeur ; plus bas, les aplats d'un document
 * scanné commencent à marbrer.
 */
export const IMAGE_QUALITY = 0.82;

/**
 * Formats recompressés. Le GIF est laissé tel quel : il peut être animé, et le canevas n'en
 * garderait que la première image. Tout ce qui n'est pas une image (PDF, bureautique, texte) sort
 * d'ici intact — c'est la majorité des dépôts du dossier.
 */
const COMPRESSIBLE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

type Canvas = HTMLCanvasElement | OffscreenCanvas;

/**
 * Image allégée, ou le fichier d'origine si rien n'était à gagner.
 *
 * Ne rejette jamais : un navigateur sans canevas, un fichier illisible ou un encodeur absent
 * rendent l'original. Refuser le dépôt parce que la compression a échoué remplacerait une image
 * lourde — qui marche — par une erreur.
 */
export async function compressImage(file: File): Promise<File> {
  if (!COMPRESSIBLE_TYPES.has(file.type)) return file;
  try {
    const bitmap = await decode(file);
    try {
      const { width, height } = fitted(bitmap.width, bitmap.height);
      const compressed = await encode(bitmap, width, height);
      // Une image déjà petite, ou déjà compressée serré, ressort parfois plus lourde qu'elle
      // n'entrait : on garde alors l'original, qui est à la fois plus léger et intact.
      if (!compressed || compressed.size >= file.size) return file;
      return new File([compressed], renamed(file.name, compressed.type), {
        type: compressed.type,
        lastModified: file.lastModified,
      });
    } finally {
      bitmap.close();
    }
  } catch {
    return file;
  }
}

/**
 * Fichier choisi par un membre, retenu tout de suite puis remplacé par sa version allégée dès
 * qu'elle est prête.
 *
 * Attendre la compression pour retenir quoi que ce soit laissait un trou : pendant ces quelques
 * centaines de millisecondes le formulaire se croyait sans fichier, un envoi lancé là partait sans
 * la pièce jointe — et l'image, arrivée trop tard, se collait au message *suivant*. Retenir
 * l'original d'abord ferme le trou : envoyer pendant la compression envoie la photo entière,
 * exactement ce qui se passait avant qu'on la compresse.
 *
 * Le remplacement ne se fait que si l'original est toujours celui qui est retenu. C'est l'identité
 * du fichier qui l'arbitre, et non l'ordre d'arrivée des compressions : un second choix, un envoi
 * parti, un formulaire vidé — dans les trois cas ce qui est retenu n'est plus l'original, et la
 * version allégée est simplement abandonnée.
 *
 * `retain` a la signature d'un `setState` fonctionnel de React, qui est le seul moyen de décider
 * au vu de la valeur courante plutôt qu'au vu de celle qu'un rendu passé avait capturée.
 */
export function pickCompressed(
  file: File | null,
  retain: (update: (current: File | null) => File | null) => void,
): void {
  retain(() => file);
  if (!file) return;
  void compressImage(file).then((lighter) => {
    if (lighter === file) return;
    retain((current) => (current === file ? lighter : current));
  });
}

/**
 * Pixels de l'image. `createImageBitmap` décode hors du fil principal — l'interface ne se fige pas
 * pendant les quelques centaines de millisecondes que prend une photo de 12 Mpx — et
 * `from-image` applique l'orientation EXIF : sans elle, une photo prise à la verticale repartirait
 * couchée, l'étiquette d'orientation étant perdue au réencodage.
 */
async function decode(file: File): Promise<ImageBitmap> {
  if (typeof createImageBitmap !== 'function') {
    throw new Error('createImageBitmap indisponible');
  }
  return createImageBitmap(file, { imageOrientation: 'from-image' });
}

/** Dimensions ramenées sous le plafond, proportions gardées. Une petite image n'est pas agrandie. */
export function fitted(width: number, height: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= MAX_IMAGE_DIMENSION) return { width, height };
  const ratio = MAX_IMAGE_DIMENSION / longest;
  return { width: Math.round(width * ratio), height: Math.round(height * ratio) };
}

/**
 * Encodage de l'image redimensionnée. Le WebP d'abord : à qualité égale il pèse un tiers de moins
 * que le JPEG, et le serveur l'accepte partout où il accepte une image.
 */
async function encode(bitmap: ImageBitmap, width: number, height: number): Promise<Blob | null> {
  // L'échec est rattrapé ici, pas plus haut : un encodeur qui refuse le WebP en levant plutôt
  // qu'en rendant autre chose ferait sinon abandonner la compression entière, là où il suffit de
  // demander l'autre format.
  const webp = await paint(bitmap, width, height, 'image/webp').catch(() => null);
  if (webp?.type === 'image/webp') return webp;
  // Le navigateur ne sait pas écrire le WebP (Safari d'avant 16.4) : selon la manière dont il le
  // signale, il rend un PNG — plus lourd que la photo d'origine — ou lève. On repasse en JPEG.
  return paint(bitmap, width, height, 'image/jpeg');
}

/** Dessine l'image à la taille voulue et l'encode. `null` si le contexte 2D n'est pas disponible. */
async function paint(bitmap: ImageBitmap, width: number, height: number, type: string): Promise<Blob | null> {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!context) return null;
  if (type === 'image/jpeg') {
    // Le JPEG ignore la transparence : sans ce fond, les zones transparentes d'un PNG sortiraient
    // noires — une capture d'écran deviendrait illisible.
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
  }
  context.drawImage(bitmap, 0, 0, width, height);
  return toBlob(canvas, type);
}

function createCanvas(width: number, height: number): Canvas {
  // Le canevas hors écran garde le travail hors du DOM ; là où il manque, un canevas ordinaire,
  // jamais attaché au document, fait la même chose.
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function toBlob(canvas: Canvas, type: string): Promise<Blob | null> {
  if ('convertToBlob' in canvas) return canvas.convertToBlob({ type, quality: IMAGE_QUALITY });
  return new Promise((resolve) => canvas.toBlob(resolve, type, IMAGE_QUALITY));
}

/**
 * Nom du fichier réencodé : même base, extension de la sortie. L'extension n'est pas cosmétique —
 * c'est elle que le serveur lit pour décider du format accepté et du type qu'il servira en retour.
 */
export function renamed(filename: string, type: string): string {
  const extension = type === 'image/webp' ? '.webp' : '.jpg';
  const dot = filename.lastIndexOf('.');
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  return `${base}${extension}`;
}
