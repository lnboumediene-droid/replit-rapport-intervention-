# MSB-BAT — sauvegarde et reprise dans Genspark

## À lire d’abord

Ce dossier est une **copie du code et des données**, pas une application déjà
déployée chez Genspark. L’application originale n’a pas été modifiée ou arrêtée.
La reprise demande de configurer les services de destination et, si nécessaire,
d’adapter les parties qui dépendent de Replit.

**CONFIDENTIEL :** la sauvegarde contient des informations clients, des profils
utilisateurs, des rapports et leurs pièces jointes. Ne la publiez pas dans un
dépôt GitHub public. Ne partagez l’archive qu’avec les personnes et services
autorisés à traiter ces données.

## Ce qui est fourni

- `code/` : interface React, serveur Express et FastAPI Python, modèles PDF,
  schémas de base de données, tests, dépendances et maquettes existantes.
- `code/attached_assets/` : documents de référence et ressources du projet.
  Les captures d’écran de configuration sont exclues pour éviter de transmettre
  des clés visibles sur une image.
- `donnees/production.sql` et `production.json` : données de la version publiée,
  avec le schéma de ses tables applicatives.
- `donnees/development.sql` et `development.json` : copie indépendante des
  données de la version de travail.
- `fichiers/prive/` : fichiers du stockage privé, dont PDF originaux, PDF
  générés et photos. Les fichiers encore stockés mais non référencés dans les
  tables sont conservés eux aussi.
- `donnees/fichiers.json` : correspondance entre les chemins de l’application
  et les fichiers, tailles, empreintes et références éventuellement manquantes.
- `MANIFESTE.json` : inventaire et nombres de lignes exportées.
- `CONTROLES-SHA256.json` : empreintes pour vérifier que les fichiers sont intacts.
- `PROMPT-GENSPARK.md` : consigne de reprise prête à copier.

Les deux bases sont différentes. **Ne les importez pas successivement dans la
même base et ne les fusionnez pas automatiquement.** La production est le point
de départ pour retrouver les données de l’application publiée ; le développement
est une seconde copie à examiner pour récupérer des éléments supplémentaires.

### Limite constatée lors de cette sauvegarde

Deux fichiers référencés par la base de production ne sont pas disponibles dans
le stockage accessible : un ancien PDF généré et une photo. La recherche de copies
actuelles et d’anciennes générations dans le bucket n’en a trouvé aucune. Leurs
références restent présentes dans les exports ; leurs contenus ne sont pas
inventés ou remplacés. Consulter `missing_references` dans `donnees/fichiers.json`.
Toutes les références de fichiers de la base de développement ont été récupérées.

## Ce qui n’est pas fourni

- Aucune clé Anthropic, Genspark ou Clerk ; aucun mot de passe de base de données.
- Aucun fichier `.env`, cookie, jeton de session ou identifiant de connexion.
- Aucun export du magasin d’identités Clerk : les profils et les rôles
  applicatifs sont présents, mais ils ne constituent pas des comptes de connexion.
- Les conversations internes de l’agent, l’historique Git et les dépendances
  installées sont exclus. Les dépendances se réinstallent à partir des manifestes.
- Les règles de partage et les réglages du fournisseur d’hébergement ne sont
  pas transférés automatiquement.

Le code conserve les noms des variables de configuration, pas leurs valeurs.
Les références historiques d’utilisateurs sont nécessaires pour préserver
l’attribution des rapports. Elles devront être associées aux identités de
destination sans ouvrir l’accès aux dossiers d’autres utilisateurs.

## Parcours de reprise

1. Télécharger et conserver cette archive comme sauvegarde privée.
2. Décompresser l’archive, lire le manifeste et vérifier les empreintes.
3. Dans Genspark Code, choisir la catégorie **Existing code**. Utiliser le moyen
   d’import réellement proposé par l’interface. Si elle demande un dépôt GitHub,
   créer un **dépôt privé contenant uniquement `code/`**. Ne pas y mettre les
   dossiers `donnees/` et `fichiers/`.
4. Fournir `PROMPT-GENSPARK.md` à l’agent de Genspark. L’import direct de cette
   archive ZIP dans Genspark n’a pas été vérifié : ne pas supposer qu’il est accepté.
5. Configurer séparément la base PostgreSQL, le stockage privé, la connexion des
   utilisateurs et les secrets sur la destination.
6. Restaurer **un seul** des deux exports dans une nouvelle base vide.
7. Recharger les PDF et photos dans un stockage privé, en utilisant
   `donnees/fichiers.json` pour préserver les chemins et les correspondances.
8. Vérifier les parcours avant de remplacer l’application actuelle :
   connexion, droits par rôle, consultation des anciens rapports, affichage des
   photos, téléchargement des PDF, import et création d’un nouveau rapport.
9. Garder l’original disponible jusqu’à validation complète.

## Restauration PostgreSQL

Les exports SQL sont conçus pour PostgreSQL 16 ou plus récent. **Utiliser une
nouvelle base vide**, jamais la base actuelle de Replit. Les scripts ne contiennent
pas de commandes pour supprimer ou remplacer les tables existantes.

Le responsable de la destination doit configurer la connexion dans son propre
gestionnaire de secrets. Avec les variables PostgreSQL déjà configurées :

```sh
# Choisir UNE commande, pas les deux.
psql -X --set ON_ERROR_STOP=1 --file donnees/production.sql
psql -X --set ON_ERROR_STOP=1 --single-transaction --file donnees/development.sql
```

Le script de production contient déjà sa propre transaction. Les exports JSON conservent les données et
les descriptions de colonnes, contraintes et index pour une adaptation éventuelle
à un autre système. Une conversion vers SQLite/D1 n’est **pas** déjà réalisée.

## Dépendances à adapter dans Genspark

L’interface full-stack par défaut de Genspark annonce Hono/Node.js et Cloudflare
Pages. Ce projet utilise **Express/Node.js + FastAPI/Python + PostgreSQL**.
Il faut vérifier le support de Python avant de prétendre que le projet peut
démarrer tel quel. Si ce support n’existe pas, conserver un serveur compatible
ailleurs, ou porter le backend sans perdre les contrôles métier.

### Stockage

`artifacts/api-server/python_api/main.py` et
`artifacts/api-server/src/lib/objectStorage.ts` utilisent l’authentification
du stockage fournie par le serveur local de Replit. Cette authentification ne
fonctionne pas telle quelle hors de Replit. Remplacer l’adaptateur par celui du
stockage choisi ; ne pas rendre les photos ou les rapports publics.

Les noms de buckets et les réglages secrets du stockage ne sont pas exportés.
Pour un objet dont le chemin applicatif est `/objects/imports/exemple/source.pdf`,
le contenu est dans `fichiers/prive/imports/exemple/source.pdf`.
Les métadonnées historiques doivent être examinées avant réutilisation :
les identités doivent être réassociées aux comptes de destination.

### Connexion

Le projet utilise Clerk géré par Replit. Le proxy, la configuration des domaines
et les clés doivent être adaptés ou remplacés par une connexion équivalente.
Ne jamais exposer le serveur Python qui fait confiance aux en-têtes d’identité :
seul le serveur public qui vérifie les identités peut l’appeler.

### IA

Le code exporté continue à appeler **l’API Anthropic directement**. La migration
vers le proxy Genspark n’a pas été faite : les essais de génération n’ont pas
produit de résultat exploitable et reproductible. Importer le projet dans
Genspark Code ne remplace pas automatiquement son fournisseur d’IA.

Claude est autorisé derrière Genspark. Une bascule vers la clé et les crédits
Genspark doit être validée par un appel réel ; pas de repli silencieux vers
Anthropic. Les clés sont à configurer uniquement comme secrets côté serveur.

## Repères pour lancer le code après configuration

Exécuter les commandes à partir de `code/`. Le projet fournit les manifestes
pnpm et Python. Les commandes ci-dessous sont des repères de configuration ;
elles n’ont pas été validées dans l’environnement Genspark.

```sh
pnpm install --frozen-lockfile
python -m pip install -r artifacts/api-server/python_api/requirements.txt
pnpm run typecheck

# Deux processus distincts : leurs PORT sont différents.
PORT=5000 pnpm --filter @workspace/api-server run dev
PORT=5173 BASE_PATH=/ pnpm --filter @workspace/msb-rapports run dev
```

Un reverse proxy doit acheminer `/api/*` vers le serveur Express et le reste
vers l’interface. Le backend Express lance lui-même FastAPI sur une adresse locale.
Ne pas lancer une seconde copie du backend Python et ne pas l’exposer au public.
Le runtime actuel est Node.js 24 et Python 3.13. OCR : fournir aussi `tesseract`
et les langues nécessaires au traitement des scans.

La configuration pnpm contient des exclusions de dépendances propres à Linux
x64 ; les examiner pour une installation sur un autre système.

### Variables à configurer, sans les valeurs originales

- `DATABASE_URL` : nouvelle base PostgreSQL.
- `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`,
  `VITE_CLERK_PUBLISHABLE_KEY` : configuration d’identité de destination.
- `ANTHROPIC_API_KEY` : si les appels Anthropic directs sont conservés.
- `GSK_API_KEY` : seulement si l’intégration Genspark est réellement implémentée.
- `MSB_INITIAL_DIRECTION_EMAIL` : compte qui doit recevoir le rôle direction.
- `PORT`, `BASE_PATH`, éventuellement `MSB_FASTAPI_PORT` : routage et services.
- L’équivalent de `PRIVATE_OBJECT_DIR` et `PUBLIC_OBJECT_SEARCH_PATHS` :
  configuration du nouvel adaptateur de stockage.

## Vérifications attendues

- Les nombres de lignes correspondent au manifeste pour la base choisie.
- Toutes les références de fichiers de cette base correspondent à un contenu.
- Les PDF existants s’ouvrent et les photos sont visibles.
- Le format PDF de référence est respecté ; les noms à effacer le restent.
- Les rapports partiels restent possibles sans inventer des faits manquants.
- Les droits de lecture, d’édition et de suppression restent séparés.
- Les utilisateurs ne récupèrent pas automatiquement les dossiers d’autres comptes.
- Aucun secret n’apparaît dans les fichiers publics ou dans le navigateur.

Sources consultées pour préparer cette reprise :
https://www.genspark.ai/helpcenter/ai-developer
https://www.genspark.ai/ai_developer
https://docs.replit.com/features/auth-and-identity/clerk-auth
https://docs.replit.com/features/data-and-storage/object-storage
