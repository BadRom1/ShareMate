# Déploiement Android

Cette doc prépare la publication de l'app Android (empaquetée avec Capacitor) sur le Google Play
Store. **L'APK/AAB est construit en CI sur GitHub Actions** — aucun Mac ni installation d'Android
Studio n'est nécessaire pour produire les binaires (un build Android tourne sur runner Linux).

- Le workflow : [`.github/workflows/android.yml`](../.github/workflows/android.yml)
- Le projet natif : `web/android/` (`appId` `app.sharemate.mobile`)
- Le contexte technique (auth Bearer, base d'API) : section _Application mobile_ du
  [README](../README.md#application-mobile-android)

## Ce que produit la CI

Le workflow **Android** génère :

| Artefact                | Signé ? | Pour quoi                                                                       |
| ----------------------- | ------- | ------------------------------------------------------------------------------- |
| `sharemate-debug-apk`   | debug   | Tester par sideload sur un appareil/émulateur.                                  |
| `sharemate-release-aab` | release | Publier sur le Play Store (produit **seulement si** un keystore est configuré). |

Déclenchement : manuel (**Actions → Android → Run workflow**) ou automatique sur un tag `v*`.

---

## 1. Prérequis (une fois)

- Un **compte Google Play Console** (25 $, paiement unique).
- Rien d'autre en local : la CI s'occupe du build.
- Pour tester l'APK debug : un téléphone Android en mode développeur, ou `adb`.

## 2. Configurer le backend

L'app native tape le backend distant ; il faut donc :

1. **Sur Railway**, ajouter la variable de service :
   ```
   CORS_ORIGINS=https://localhost
   ```
   (`https://localhost` est l'origine de la WebView Android.)
2. **Sur GitHub** (Settings → Secrets and variables → Actions → **Variables**), définir :
   ```
   VITE_API_BASE_URL = https://<ton-domaine-railway>
   ```
   (ou la passer en entrée manuelle du workflow à chaque run).

## 3. Générer la clé de signature (une fois)

La clé signe toutes les versions publiées : **ne jamais la perdre ni la regénérer** une fois l'app
en ligne, sinon les mises à jour seront refusées par le Play Store.

```bash
keytool -genkeypair -v \
  -keystore sharemate-release.jks \
  -alias sharemate \
  -keyalg RSA -keysize 2048 -validity 10000
```

Conserve `sharemate-release.jks` et les mots de passe dans un gestionnaire de secrets (hors dépôt).

## 4. Enregistrer le keystore dans les secrets GitHub

Encode le keystore en base64 :

```bash
base64 -w0 sharemate-release.jks   # macOS : base64 -i sharemate-release.jks
```

Puis, dans Settings → Secrets and variables → Actions → **Secrets**, crée :

| Secret                      | Valeur                       |
| --------------------------- | ---------------------------- |
| `ANDROID_KEYSTORE_BASE64`   | la sortie base64 ci-dessus   |
| `ANDROID_KEYSTORE_PASSWORD` | mot de passe du keystore     |
| `ANDROID_KEY_ALIAS`         | `sharemate` (l'alias choisi) |
| `ANDROID_KEY_PASSWORD`      | mot de passe de la clé       |

Tant que ces secrets sont absents, la CI ne produit **que** l'APK debug (aucune erreur).

## 5. Lancer un build

- **Manuel** : Actions → _Android_ → _Run workflow_ (option : renseigner `api_base_url`).
- **Par tag** : `git tag v1.0.0 && git push origin v1.0.0`.

Le `versionCode` (numéro de build exigé croissant par le Play Store) est renseigné automatiquement
avec le numéro de run GitHub. Récupère les artefacts en bas de la page du run.

## 6. Tester l'APK debug

```bash
adb install -r app-debug.apk
```

Vérifie la connexion (login, calendrier, dépenses) contre le backend Railway.

## 7. Publier sur le Play Store

1. Play Console → **Créer une application**.
2. Activer **Play App Signing** (Google gère la clé d'app finale ; ta clé ci-dessus est la clé
   d'_upload_).
3. Créer une release (Test interne d'abord, recommandé) et **uploader l'AAB** `app-release.aab`.
4. Renseigner la fiche (description, captures, politique de confidentialité) puis soumettre.
5. Mises à jour : chaque nouvelle release doit avoir un `versionCode` supérieur — c'est déjà géré
   par la CI (numéro de run).

---

## Build local (alternative sans CI)

Avec **Android Studio** (SDK + JDK) installés, depuis `web/` :

```bash
VITE_API_BASE_URL=https://<ton-domaine-railway> npm run build --workspace web
npm run cap --workspace web -- sync android
npm run cap --workspace web -- open android   # puis Run / Build APK depuis l'IDE
```

## iOS (plus tard)

Non couvert ici. Ce sera `cap add ios`, puis un build sur Mac ou un service cloud (Codemagic,
GitHub Actions runner macOS) — le même découplage backend/auth s'applique déjà.
