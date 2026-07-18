# Notifications

ShareMate a un système de notifications à trois canaux, **découplé** des fonctionnalités qui les
déclenchent (discussions, dépenses, réservations, entretien) :

1. **Centre in-app** (cloche 🔔) — toujours actif, aucune configuration. Badge de non-lus,
   liste, marquage lu, préférences par type d'événement.
2. **Web Push (PWA)** — notifications navigateur même app fermée. Nécessite des clés VAPID.
3. **Push natif Android (FCM)** — notifications système sur l'app Capacitor. Nécessite Firebase.

Sans les variables d'environnement ci-dessous, le push est **désactivé proprement** : l'app reste
100 % fonctionnelle avec le seul centre in-app. Le serveur journalise alors au démarrage :
`Push désactivé (VAPID_* / FCM_SERVICE_ACCOUNT absents) : seul le centre in-app est actif.`

## Événements notifiés

| Type                     | Déclencheur                                | Destinataires         |
| ------------------------ | ------------------------------------------ | --------------------- |
| `MESSAGE_POSTED`         | Nouveau message sur le fil d'un équipement | Cercle sauf l'auteur  |
| `EXPENSE_ADDED`          | Nouvelle dépense                           | Cercle sauf le payeur |
| `RESERVATION_CREATED`    | Nouvelle réservation                       | Cercle sauf l'auteur  |
| `REIMBURSEMENT_RECORDED` | Remboursement enregistré                   | Le bénéficiaire       |
| `MAINTENANCE_ALERT`      | Passage au-dessus du seuil d'entretien     | Tout le cercle        |

Chaque membre règle, par type, la réception in-app et push (`GET/PUT /api/notifications/preferences`).
Par défaut tout est activé.

## Web Push (PWA)

1. Générer une paire de clés VAPID :
   ```bash
   npx web-push generate-vapid-keys
   ```
2. Poser les variables d'environnement (Railway → service backend) :
   - `VAPID_PUBLIC_KEY`
   - `VAPID_PRIVATE_KEY`
   - `VAPID_SUBJECT` (ex. `mailto:contact@exemple.fr`)
3. Redéployer. Côté client, l'utilisateur active le push depuis la cloche → ⚙︎ → « Activer le
   push sur cet appareil » (demande la permission navigateur puis s'abonne).

Les handlers `push` / `notificationclick` vivent dans `web/public/push-sw.js`, importé dans le
service worker Workbox via `workbox.importScripts` (`web/vite.config.ts`).

## Push natif Android (FCM)

1. Créer un projet **Firebase**, y enregistrer une app Android avec le package
   `app.sharemate.mobile`.
2. Télécharger `google-services.json` et le placer dans `web/android/app/`.
3. Ajouter le plugin Gradle Google Services :
   - `web/android/build.gradle` (buildscript dependencies) :
     `classpath 'com.google.gms:google-services:4.4.2'`
   - `web/android/app/build.gradle` (fin de fichier) :
     `apply plugin: 'com.google.gms.google-services'`
4. Générer une **clé de compte de service** (Firebase → Paramètres → Comptes de service →
   « Générer une nouvelle clé privée ») et poser son JSON (sur une ligne) dans la variable Railway
   `FCM_SERVICE_ACCOUNT`.
5. Synchroniser le projet natif : `npm run cap:sync` (déjà nécessaire après ajout du plugin
   `@capacitor/push-notifications`).

La permission `POST_NOTIFICATIONS` (Android 13+) et la demande de permission à l'exécution sont
gérées par le plugin `@capacitor/push-notifications` (`setupNativePush` dans `web/src/notifications.ts`).

### CI (`.github/workflows/android.yml`)

`google-services.json` ne doit pas être committé. En CI, l'injecter depuis un secret GitHub avant le
build, par exemple :

```yaml
- name: Écrire google-services.json
  run: echo "${{ secrets.GOOGLE_SERVICES_JSON }}" | base64 -d > web/android/app/google-services.json
```

(secret `GOOGLE_SERVICES_JSON` = le fichier encodé en base64).

## Récapitulatif des variables

| Variable               | Canal    | Où                        |
| ---------------------- | -------- | ------------------------- |
| `VAPID_PUBLIC_KEY`     | Web Push | Backend (Railway)         |
| `VAPID_PRIVATE_KEY`    | Web Push | Backend (Railway)         |
| `VAPID_SUBJECT`        | Web Push | Backend (Railway)         |
| `FCM_SERVICE_ACCOUNT`  | FCM      | Backend (Railway)         |
| `GOOGLE_SERVICES_JSON` | FCM      | Secret GitHub (build APK) |
