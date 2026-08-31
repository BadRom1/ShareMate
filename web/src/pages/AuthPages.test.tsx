import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type * as ApiModule from '../api';
import { BootstrapPage, InvitePage, LoginPage, PasswordResetPage } from './AuthPages';
import { ApiError } from '../api';
import { aMember, createApiStub } from '../test/factories';
import type { ApiStub } from '../test/factories';

const mocks = vi.hoisted(() => ({ api: {} as Record<string, unknown> }));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return { ...actual, api: mocks.api };
});

let stub: ApiStub;

beforeEach(() => {
  stub = createApiStub();
  for (const key of Object.keys(mocks.api)) delete mocks.api[key];
  Object.assign(mocks.api, stub);
});

describe('connexion', () => {
  it("transmet identifiant et mot de passe puis entre dans l'application", async () => {
    const user = userEvent.setup();
    const onLoggedIn = vi.fn();
    stub.login.mockResolvedValue({ member: aMember({ id: 'm1', name: 'Alice' }) });
    render(<LoginPage onLoggedIn={onLoggedIn} />);

    await user.type(screen.getByLabelText('Nom ou email'), 'alice@exemple.test');
    await user.type(screen.getByLabelText('Mot de passe'), 'motdepasse');
    await user.click(screen.getByRole('button', { name: 'Se connecter' }));

    expect(stub.login).toHaveBeenCalledWith('alice@exemple.test', 'motdepasse');
    expect(onLoggedIn).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }));
  });

  it('affiche le refus du serveur et ne laisse pas entrer', async () => {
    const user = userEvent.setup();
    const onLoggedIn = vi.fn();
    stub.login.mockRejectedValue(new ApiError('Identifiants invalides.', 401));
    render(<LoginPage onLoggedIn={onLoggedIn} />);

    await user.type(screen.getByLabelText('Nom ou email'), 'alice');
    await user.type(screen.getByLabelText('Mot de passe'), 'faux');
    await user.click(screen.getByRole('button', { name: 'Se connecter' }));

    expect(await screen.findByText('Identifiants invalides.')).toBeDefined();
    expect(onLoggedIn).not.toHaveBeenCalled();
  });
});

describe('premier compte', () => {
  it('crée le compte fondateur', async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    render(<BootstrapPage onCreated={onCreated} />);

    await user.type(screen.getByLabelText('Votre prénom'), 'Alice');
    await user.type(screen.getByLabelText('Mot de passe (8 caractères minimum)'), 'motdepasse');
    await user.click(screen.getByRole('button', { name: "C'est parti" }));

    expect(stub.bootstrap).toHaveBeenCalledWith({ name: 'Alice', password: 'motdepasse' });
    expect(onCreated).toHaveBeenCalled();
  });
});

describe('invitation', () => {
  it('accueille par son nom le membre invité puis active son accès', async () => {
    const user = userEvent.setup();
    const onRedeemed = vi.fn();
    stub.inviteInfo.mockResolvedValue({ memberName: 'Bob' });
    stub.redeemInvite.mockResolvedValue({ member: aMember({ id: 'm2', name: 'Bob' }) });
    render(<InvitePage code="code-invitation" onRedeemed={onRedeemed} />);

    expect(await screen.findByText('Bob')).toBeDefined();
    await user.type(screen.getByLabelText('Mot de passe (8 caractères minimum)'), 'motdepasse');
    await user.click(screen.getByRole('button', { name: 'Activer mon accès' }));

    expect(stub.redeemInvite).toHaveBeenCalledWith('code-invitation', 'motdepasse');
    expect(onRedeemed).toHaveBeenCalledWith(expect.objectContaining({ id: 'm2' }));
  });

  // Une invitation périmée ou déjà consommée ne doit pas laisser croire qu'il reste un mot de
  // passe à choisir : le formulaire n'apparaît pas.
  it("n'affiche aucun formulaire quand le lien est refusé", async () => {
    stub.inviteInfo.mockRejectedValue(new ApiError('Invitation invalide ou expirée.', 404));
    render(<InvitePage code="perime" onRedeemed={vi.fn()} />);

    expect(await screen.findByText('Invitation invalide ou expirée.')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Activer mon accès' })).toBeNull();
  });

  it("affiche le refus du serveur quand l'activation échoue", async () => {
    const user = userEvent.setup();
    const onRedeemed = vi.fn();
    stub.inviteInfo.mockResolvedValue({ memberName: 'Bob' });
    stub.redeemInvite.mockRejectedValue(new ApiError('Invitation invalide ou expirée.', 404));
    render(<InvitePage code="perime" onRedeemed={onRedeemed} />);

    await user.type(await screen.findByLabelText('Mot de passe (8 caractères minimum)'), 'motdepasse');
    await user.click(screen.getByRole('button', { name: 'Activer mon accès' }));

    expect(await screen.findByText('Invitation invalide ou expirée.')).toBeDefined();
    expect(onRedeemed).not.toHaveBeenCalled();
  });
});

/**
 * Les écrans publics sont les seuls où l'on est encore dans un navigateur, et l'invitation est le
 * moment précis où quelqu'un découvre l'application : c'est là que l'installation se propose.
 */
describe("installation depuis les écrans d'accueil", () => {
  // Le prompt est retenu au niveau du module : `appinstalled` est ce qui le périme.
  afterEach(() => window.dispatchEvent(new Event('appinstalled')));

  function annoncerLInstallation() {
    window.dispatchEvent(Object.assign(new Event('beforeinstallprompt'), { prompt: vi.fn() }));
  }

  it("propose l'installation sous le formulaire de connexion", async () => {
    annoncerLInstallation();

    render(<LoginPage onLoggedIn={vi.fn()} />);

    expect(await screen.findByRole('button', { name: "Installer l'app" })).toBeDefined();
  });

  it("propose l'installation à qui arrive par un lien d'invitation", async () => {
    stub.inviteInfo.mockResolvedValue({ memberName: 'Bob' });
    annoncerLInstallation();

    render(<InvitePage code="code-invitation" onRedeemed={vi.fn()} />);

    expect(await screen.findByRole('button', { name: "Installer l'app" })).toBeDefined();
  });

  it("ne propose rien tant que le navigateur ne sait pas installer l'application", () => {
    render(<LoginPage onLoggedIn={vi.fn()} />);

    expect(screen.queryByRole('button', { name: "Installer l'app" })).toBeNull();
  });
});

describe('mot de passe perdu', () => {
  it('accueille le titulaire par son nom, pose le nouveau mot de passe et le connecte', async () => {
    const user = userEvent.setup();
    const onReset = vi.fn();
    stub.passwordResetInfo.mockResolvedValue({ memberName: 'Bob' });
    stub.redeemPasswordReset.mockResolvedValue({ member: aMember({ id: 'm2', name: 'Bob' }) });
    render(<PasswordResetPage code="code-reset" onReset={onReset} />);

    expect(await screen.findByText('Bob')).toBeDefined();
    await user.type(screen.getByLabelText('Nouveau mot de passe (8 caractères minimum)'), 'nouveaupass');
    await user.click(screen.getByRole('button', { name: 'Reprendre mon compte' }));

    expect(stub.redeemPasswordReset).toHaveBeenCalledWith('code-reset', 'nouveaupass');
    expect(onReset).toHaveBeenCalledWith(expect.objectContaining({ id: 'm2' }));
  });

  // Un lien périmé ou déjà consommé ne doit pas laisser croire qu'il reste un mot de passe à
  // choisir : le formulaire n'apparaît pas.
  it("n'affiche aucun formulaire quand le lien est refusé", async () => {
    stub.passwordResetInfo.mockRejectedValue(
      new ApiError('Lien de réinitialisation invalide, expiré ou déjà utilisé.', 404),
    );
    render(<PasswordResetPage code="perime" onReset={vi.fn()} />);

    expect(await screen.findByText('Lien de réinitialisation invalide, expiré ou déjà utilisé.')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Reprendre mon compte' })).toBeNull();
  });

  it('affiche le refus du serveur quand la reprise échoue', async () => {
    const user = userEvent.setup();
    const onReset = vi.fn();
    stub.passwordResetInfo.mockResolvedValue({ memberName: 'Bob' });
    stub.redeemPasswordReset.mockRejectedValue(new ApiError('Le mot de passe doit faire au moins 8 caractères.', 400));
    render(<PasswordResetPage code="code-reset" onReset={onReset} />);

    await user.type(await screen.findByLabelText('Nouveau mot de passe (8 caractères minimum)'), 'motdepasse');
    await user.click(screen.getByRole('button', { name: 'Reprendre mon compte' }));

    expect(await screen.findByText('Le mot de passe doit faire au moins 8 caractères.')).toBeDefined();
    expect(onReset).not.toHaveBeenCalled();
  });
});
