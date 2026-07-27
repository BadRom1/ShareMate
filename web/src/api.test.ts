import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, receiptUrl, setUnauthorizedHandler } from './api';

/** Réponse `fetch` minimale : seules les propriétés lues par `request` sont nécessaires. */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  setUnauthorizedHandler(null);
  vi.unstubAllGlobals();
});

describe("gestion globale de l'authentification", () => {
  it("déconnecte sur 401 hors routes d'auth", async () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    fetchMock.mockResolvedValue(jsonResponse(401, { error: 'Session expirée.' }));

    await expect(api.listEquipments()).rejects.toThrow('Session expirée.');
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  // Régression Q1 : le serveur répond désormais 403 (et non plus 401) sur les gestes réservés
  // à l'auteur. Un 403 traité comme un 401 renverrait le membre à l'écran de connexion alors
  // que sa session est parfaitement valide.
  it("ne déconnecte pas sur 403 : l'autorisation manque, pas la session", async () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    fetchMock.mockResolvedValue(jsonResponse(403, { error: 'Seul son auteur peut modifier ce message.' }));

    await expect(api.deleteMessage('m1')).rejects.toMatchObject({
      status: 403,
      message: 'Seul son auteur peut modifier ce message.',
    });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("ne déconnecte pas sur un échec de connexion (401 sur une route d'auth)", async () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    fetchMock.mockResolvedValue(jsonResponse(401, { error: 'Identifiants invalides.' }));

    await expect(api.login('alice', 'mauvais')).rejects.toThrow('Identifiants invalides.');
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("reste silencieux quand aucun gestionnaire n'est installé", async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, {}));
    await expect(api.listEquipments()).rejects.toBeInstanceOf(ApiError);
  });
});

describe('décodage des réponses', () => {
  it('rend le corps JSON des réponses réussies', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, [{ id: 'e1' }]));
    await expect(api.listEquipments()).resolves.toEqual([{ id: 'e1' }]);
  });

  it('rend undefined sur 204 sans tenter de lire le corps', async () => {
    const json = vi.fn();
    fetchMock.mockResolvedValue({ ok: true, status: 204, json } as unknown as Response);
    await expect(api.deleteExpense('x1')).resolves.toBeUndefined();
    expect(json).not.toHaveBeenCalled();
  });

  it("retombe sur un message générique quand le corps d'erreur n'est pas du JSON", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error('pas du JSON');
      },
    } as unknown as Response);

    await expect(api.listEquipments()).rejects.toThrow('Erreur 500');
  });

  it('pose Content-Type uniquement quand il y a un corps', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, []));
    await api.listEquipments();
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toEqual({});

    fetchMock.mockResolvedValue(jsonResponse(200, { id: 't1' }));
    await api.createThread('e1', 'Titre');
    expect((fetchMock.mock.calls[1][1] as RequestInit).headers).toEqual({ 'Content-Type': 'application/json' });
  });
});

describe('quitter un cercle', () => {
  it('passe par la route dédiée en POST', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 204, json: vi.fn() } as unknown as Response);
    await api.leaveEquipment('e1');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/equipments/e1/leave');
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('POST');
  });
});

describe('justificatifs', () => {
  const uploaded = '/uploads/0189a4c2-1f3b-4d5e-8a9b-0c1d2e3f4a5b.jpg';

  it('accepte un chemin produit par le serveur', () => {
    expect(receiptUrl(uploaded)).toBe(uploaded);
  });

  it.each<[string | null, string]>([
    ['https://exemple.test/piege.jpg', 'une URL absolue choisie par un membre'],
    ['/uploads/../etc/passwd', 'une traversée de répertoire'],
    ['/uploads/quelconque.jpg', 'un nom de fichier hors format'],
    [null, 'une dépense sans justificatif'],
  ])('refuse %s (%s)', (path, _raison) => {
    expect(receiptUrl(path)).toBeNull();
  });
});
