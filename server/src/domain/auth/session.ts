/** Session ouverte : seule l'empreinte du jeton est conservée côté serveur. */
export interface Session {
  tokenHash: string;
  memberId: string;
  expiresAt: Date;
}
