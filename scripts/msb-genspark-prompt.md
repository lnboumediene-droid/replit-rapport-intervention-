# Consigne à copier dans Genspark Code

Je veux reprendre mon application existante **Rapports d’intervention MSB-BAT**,
sans la reconstruire à partir d’une simple description et sans perdre mon travail.

Le dossier `code/` contient l’interface, les serveurs, les modèles PDF, les tests,
les schémas et les ressources. Les exports de données et les fichiers privés sont
fournis séparément. Lis d’abord `LIRE-MOI.md` et `MANIFESTE.json`.

## Règles impératives

1. Commence par analyser le code réel et vérifier les capacités d’exécution de
   la destination. L’interface est React/Vite, le serveur public Express/Node.js,
   le serveur interne FastAPI/Python et la base PostgreSQL. N’annonce pas que
   l’application fonctionne avant d’avoir démarré et vérifié ses services.
2. Réutilise le travail existant : interface, règles métier, formats PDF, import,
   extraction des photos et contrôles de qualité. N’invente pas une application
   de démonstration ou des données à la place des données fournies.
3. Il existe deux bases distinctes, production et développement. Choisis la
   production pour reprendre l’application publiée, et conserve le développement
   comme copie indépendante. Ne fusionne pas les deux et ne supprime aucun
   rapport sans validation explicite.
4. Préserve les clients, sites, rapports, zones, photos, PDF sources, versions
   générées, historiques, profils et rôles. Utilise `donnees/fichiers.json`
   pour restaurer les correspondances et vérifie les empreintes SHA-256.
5. Le document CBRE Lognes fourni dans les ressources est la référence exacte
   du format des rapports, pas seulement une inspiration visuelle.
6. Préserve les contrôles contre l’invention de faits, chiffres, dates et travaux.
   Les informations absentes doivent rester signalées à compléter. Il doit
   rester possible de produire un rapport partiel et d’ajouter plusieurs photos.
7. Préserve la séparation des droits et les confirmations de suppression.
   Un droit de consultation ne donne pas un droit de suppression.
8. Remplace proprement les dépendances de plateforme qui ne fonctionnent pas
   ici : stockage authentifié par le serveur local Replit, proxy Clerk et routage.
   Ne contourne pas ces dépendances en rendant les documents publics ou en
   désactivant la vérification d’identité. Ne publie pas le serveur Python interne.
9. Les profils exportés ne sont pas des mots de passe ou comptes de connexion.
   Réassocie les utilisateurs aux identités de destination, en préservant les
   propriétaires des dossiers et les droits. Demande les clés nécessaires dans
   le gestionnaire de secrets, jamais dans une conversation ou du code public.
10. L’IA de l’application appelle actuellement Anthropic directement. Je veux
    utiliser Genspark et ses crédits si cela fonctionne ; Claude derrière
    Genspark est autorisé. Vérifie une génération réelle avant de basculer.
    Aucun repli silencieux vers Anthropic en cas d’échec. Si cette intégration
    reste bloquée, indique-le clairement et ne prétends pas qu’elle est terminée.
11. Teste les parcours essentiels : connexion et rôles, ouverture des anciens
    dossiers, photos, téléchargement des PDF, import PDF, modification,
    génération et suppression autorisée d’un rapport.
12. Utilise une destination indépendante. Ne modifie ni n’arrête mon application
    originale ici avant que j’aie validé la reprise.

## Résultat demandé

Une reprise fonctionnelle de la même application avec les données restaurées,
ou un état clair des adaptations encore nécessaires. À chaque limitation de
compatibilité, propose une solution concrète sans supprimer les fonctionnalités
existantes et sans perdre les données.
