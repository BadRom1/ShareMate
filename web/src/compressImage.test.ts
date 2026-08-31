import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_IMAGE_DIMENSION, compressImage, fitted, pickCompressed, renamed } from './compressImage';

/**
 * jsdom n'a ni décodeur d'image ni canevas : le navigateur est donc remplacé ici par un double qui
 * note ce qu'on lui demande de peindre et rend le blob qu'on lui dicte. Ce qui est vérifié, c'est
 * la décision — quoi compresser, à quelle taille, et quand renoncer — pas l'encodeur lui-même.
 */

interface CanvasStub {
  /** Dimensions passées au dernier `drawImage`, c'est-à-dire la taille de l'image encodée. */
  painted: { width: number; height: number } | null;
  /** Types demandés à l'encodeur, dans l'ordre. */
  encoded: string[];
  /** Fond peint avant l'image, s'il y en a eu un. */
  background: string | null;
}

/**
 * Installe un canevas hors écran factice. `webp` décrit ce que fait l'encodeur quand on lui demande
 * du WebP : il l'écrit, il rend un PNG à la place, ou il lève — les trois façons dont un navigateur
 * signale qu'il ne sait pas l'écrire.
 */
function installCanvas(options: { bytes: number; webp?: 'écrit' | 'png' | 'lève'; context?: boolean }): CanvasStub {
  const stub: CanvasStub = { painted: null, encoded: [], background: null };
  class FakeOffscreenCanvas {
    constructor(
      readonly width: number,
      readonly height: number,
    ) {}

    getContext() {
      if (options.context === false) return null;
      return {
        fillStyle: '',
        fillRect() {
          stub.background = this.fillStyle;
        },
        drawImage(_bitmap: unknown, _x: number, _y: number, width: number, height: number) {
          stub.painted = { width, height };
        },
      };
    }

    convertToBlob({ type }: { type: string }) {
      stub.encoded.push(type);
      const refus = type === 'image/webp' ? (options.webp ?? 'écrit') : 'écrit';
      if (refus === 'lève') return Promise.reject(new Error('format non pris en charge'));
      const rendu = refus === 'png' ? 'image/png' : type;
      return Promise.resolve(new Blob([new Uint8Array(options.bytes)], { type: rendu }));
    }
  }
  vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
  return stub;
}

function installDecoder(width: number, height: number) {
  const close = vi.fn();
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(() => Promise.resolve({ width, height, close })),
  );
  return close;
}

/** Fichier d'entrée du poids annoncé — le contenu n'est jamais lu, seul le décodeur factice l'est. */
function imageFile(name: string, type: string, bytes: number): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('compressImage', () => {
  it('allège une photo et la ramène sous la dimension maximale', async () => {
    installDecoder(4000, 3000);
    const canvas = installCanvas({ bytes: 200_000 });

    const compressed = await compressImage(imageFile('IMG_4213.JPG', 'image/jpeg', 5_000_000));

    expect(compressed.size).toBe(200_000);
    expect(compressed.type).toBe('image/webp');
    expect(compressed.name).toBe('IMG_4213.webp');
    expect(canvas.painted).toEqual({ width: MAX_IMAGE_DIMENSION, height: 1500 });
  });

  it('libère les pixels décodés, que la compression serve ou non', async () => {
    const close = installDecoder(4000, 3000);
    installCanvas({ bytes: 9_000_000 });

    await compressImage(imageFile('photo.jpg', 'image/jpeg', 5_000_000));

    expect(close).toHaveBeenCalled();
  });

  it('laisse passer ce qui n’est pas une image recompressable', async () => {
    installDecoder(4000, 3000);
    installCanvas({ bytes: 1000 });

    for (const original of [
      imageFile('facture.pdf', 'application/pdf', 5_000_000),
      // Le GIF peut être animé : le canevas n'en garderait que la première image.
      imageFile('anim.gif', 'image/gif', 5_000_000),
      imageFile('notes.txt', 'text/plain', 5_000),
    ]) {
      expect(await compressImage(original)).toBe(original);
    }
  });

  it('garde l’original quand la compression ne fait pas gagner d’octets', async () => {
    installDecoder(800, 600);
    installCanvas({ bytes: 90_000 });
    const original = imageFile('capture.png', 'image/png', 80_000);

    expect(await compressImage(original)).toBe(original);
  });

  it('repasse en JPEG sur fond blanc quand le navigateur n’écrit pas le WebP', async () => {
    installDecoder(1200, 900);
    const canvas = installCanvas({ bytes: 100_000, webp: 'png' });

    const compressed = await compressImage(imageFile('capture.png', 'image/png', 900_000));

    expect(canvas.encoded).toEqual(['image/webp', 'image/jpeg']);
    expect(canvas.background).toBe('#ffffff');
    expect(compressed.name).toBe('capture.jpg');
    expect(compressed.type).toBe('image/jpeg');
    // Une image sous le plafond n'est pas agrandie pour autant.
    expect(canvas.painted).toEqual({ width: 1200, height: 900 });
  });

  it('repasse en JPEG quand l’encodeur WebP lève au lieu de rendre autre chose', async () => {
    installDecoder(1200, 900);
    const canvas = installCanvas({ bytes: 100_000, webp: 'lève' });

    const compressed = await compressImage(imageFile('photo.jpg', 'image/jpeg', 900_000));

    expect(canvas.encoded).toEqual(['image/webp', 'image/jpeg']);
    expect(compressed.type).toBe('image/jpeg');
    expect(compressed.size).toBe(100_000);
  });

  it('rend l’original quand le navigateur ne sait pas décoder l’image', async () => {
    vi.stubGlobal('createImageBitmap', undefined);
    installCanvas({ bytes: 1000 });
    const original = imageFile('photo.jpg', 'image/jpeg', 5_000_000);

    expect(await compressImage(original)).toBe(original);
  });

  it('rend l’original quand le décodage échoue', async () => {
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(() => Promise.reject(new Error('image corrompue'))),
    );
    installCanvas({ bytes: 1000 });
    const original = imageFile('photo.jpg', 'image/jpeg', 5_000_000);

    expect(await compressImage(original)).toBe(original);
  });

  it('rend l’original quand le canevas ne donne pas de contexte 2D', async () => {
    installDecoder(4000, 3000);
    installCanvas({ bytes: 1000, context: false });
    const original = imageFile('photo.jpg', 'image/jpeg', 5_000_000);

    expect(await compressImage(original)).toBe(original);
  });
});

/**
 * Champ qui retient un fichier, réduit à ce dont `pickCompressed` a besoin : la valeur courante et
 * un moyen de la remplacer au vu d'elle-même, c'est-à-dire un `setState` fonctionnel de React.
 */
function champ() {
  let retenu: File | null = null;
  return {
    get: () => retenu,
    retain: (update: (current: File | null) => File | null) => {
      retenu = update(retenu);
    },
  };
}

/** Laisse partir les promesses en attente : la compression se termine après le geste. */
const compressionTerminée = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('pickCompressed', () => {
  it('retient le fichier choisi sans attendre, puis le remplace par sa version allégée', async () => {
    installDecoder(4000, 3000);
    installCanvas({ bytes: 200_000 });
    const champFichier = champ();
    const choisi = imageFile('IMG_4213.JPG', 'image/jpeg', 5_000_000);

    pickCompressed(choisi, champFichier.retain);
    // Tout de suite : un envoi lancé ici part avec la photo entière, jamais sans pièce jointe.
    expect(champFichier.get()).toBe(choisi);

    await compressionTerminée();
    expect(champFichier.get()?.name).toBe('IMG_4213.webp');
    expect(champFichier.get()?.size).toBe(200_000);
  });

  it('abandonne la version allégée quand un autre fichier a été choisi entre-temps', async () => {
    installDecoder(4000, 3000);
    installCanvas({ bytes: 200_000 });
    const champFichier = champ();
    const premier = imageFile('premier.jpg', 'image/jpeg', 5_000_000);
    const second = imageFile('second.png', 'image/png', 4_000_000);

    pickCompressed(premier, champFichier.retain);
    pickCompressed(second, champFichier.retain);
    await compressionTerminée();

    // C'est l'identité du fichier retenu qui arbitre, pas l'ordre d'arrivée des compressions.
    expect(champFichier.get()?.name).toBe('second.webp');
  });

  it('abandonne la version allégée quand le champ a été vidé entre-temps', async () => {
    installDecoder(4000, 3000);
    installCanvas({ bytes: 200_000 });
    const champFichier = champ();

    // Le geste d'envoi : la dépense part, le formulaire se vide, et l'image arrivée trop tard ne
    // doit pas se coller à la dépense suivante.
    pickCompressed(imageFile('IMG_4213.JPG', 'image/jpeg', 5_000_000), champFichier.retain);
    champFichier.retain(() => null);
    await compressionTerminée();

    expect(champFichier.get()).toBeNull();
  });

  it('vide le champ quand le choix est annulé', async () => {
    installDecoder(4000, 3000);
    installCanvas({ bytes: 200_000 });
    const champFichier = champ();

    pickCompressed(imageFile('IMG_4213.JPG', 'image/jpeg', 5_000_000), champFichier.retain);
    pickCompressed(null, champFichier.retain);
    await compressionTerminée();

    expect(champFichier.get()).toBeNull();
  });
});

describe('fitted', () => {
  it('ramène le plus grand côté au plafond, proportions gardées', () => {
    expect(fitted(4032, 3024)).toEqual({ width: 2000, height: 1500 });
    expect(fitted(3024, 4032)).toEqual({ width: 1500, height: 2000 });
  });

  it('n’agrandit jamais une image déjà petite', () => {
    expect(fitted(800, 600)).toEqual({ width: 800, height: 600 });
    expect(fitted(2000, 2000)).toEqual({ width: 2000, height: 2000 });
  });
});

describe('renamed', () => {
  it('remplace l’extension par celle du format encodé', () => {
    expect(renamed('IMG_4213.JPG', 'image/webp')).toBe('IMG_4213.webp');
    expect(renamed('IMG_4213.JPG', 'image/jpeg')).toBe('IMG_4213.jpg');
    expect(renamed('photo.de.vacances.png', 'image/webp')).toBe('photo.de.vacances.webp');
  });

  it('ajoute l’extension à un nom qui n’en a pas', () => {
    expect(renamed('capture', 'image/webp')).toBe('capture.webp');
    // Un nom qui commence par un point n'a pas d'extension : le point ouvre le nom.
    expect(renamed('.photo', 'image/webp')).toBe('.photo.webp');
  });
});
