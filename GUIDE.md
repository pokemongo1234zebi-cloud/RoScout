# 🌌 RoScout Serveur — Guide d'installation complet (option GitHub, 0€)

Ton tracker Roblox qui collecte **24h/24, même PC éteint**, avec historique continu,
univers jusqu'à 30 000 jeux, et alertes Discord quand une pépite décolle.

**Temps d'installation : ~20 minutes. Aucun code à écrire.**

---

## Étape 1 — Créer le compte et le dépôt (5 min)

1. Va sur **github.com** → crée un compte (gratuit) si tu n'en as pas.
2. En haut à droite : **+** → **New repository**.
3. Repository name : `roscout` (ou ce que tu veux).
4. Coche **Public** ⚠️ *important : les minutes GitHub Actions sont illimitées et
   gratuites uniquement pour les dépôts publics. Tes données de jeux seront visibles,
   mais ce ne sont que des stats publiques Roblox — rien de personnel.*
5. Coche **Add a README file** → **Create repository**.

## Étape 2 — Envoyer les fichiers (5 min)

1. Sur la page de ton dépôt : **Add file** → **Upload files**.
2. Glisse-dépose **tout le contenu du dossier** `roscout-server` que je t'ai donné :
   - le dossier `collector/` (avec `collect.mjs`)
   - le dossier `site/` (avec `index.html`)
   - le fichier `tracked.json`
   - ⚠️ le dossier `.github/` ne peut pas être glissé-déposé (GitHub ignore les
     dossiers cachés à l'upload). Fais-le à la main :
     **Add file → Create new file** → dans le champ du nom, tape exactement :
     `.github/workflows/collect.yml` (les `/` créent les dossiers) → colle dedans
     le contenu du fichier `collect.yml` que je t'ai fourni → **Commit changes**.
3. Pour le reste : après le glisser-déposer → **Commit changes** en bas.

## Étape 3 — Activer et lancer le collecteur (2 min)

1. Onglet **Actions** de ton dépôt → si un bandeau te demande d'activer les
   workflows, clique **I understand… enable them**.
2. Dans la liste à gauche : **🌌 RoScout Collector** → bouton **Run workflow** →
   **Run workflow** (vert). C'est le lancement manuel du premier run.
3. Attends 2-4 minutes, recharge la page : le run doit être ✅ vert.
   Clique dessus → « Collecte des données Roblox » pour voir les logs
   (« univers: X jeux »). Un dossier `data/` est apparu dans ton dépôt.
4. À partir de maintenant, **ça tourne tout seul toutes les ~15 minutes**, pour
   toujours, même PC éteint. (GitHub décale parfois de quelques minutes, c'est normal.)

## Étape 4 — Mettre le site en ligne (3 min)

1. Onglet **Settings** du dépôt → menu gauche **Pages**.
2. Source : **Deploy from a branch** → Branch : **main** → dossier : **/ (root)** → **Save**.
3. Attends ~2 minutes. Ton site est en ligne à :
   **`https://TON-PSEUDO.github.io/roscout/site/`**
   (l'URL exacte s'affiche en haut de la page Pages une fois déployé).
4. Ouvre-le : tu dois voir tes jeux avec « 🌌 X jeux du collecteur · données
   collectées il y a Y min ». Le site se recharge tout seul toutes les 60 s —
   il lit les données fraîches du collecteur, donc **zéro charge sur ton navigateur**
   et **historique continu** même si tu fermes tout pendant une semaine.

## Étape 5 (optionnelle mais 🔥) — Alertes Discord (5 min)

Reçois un message automatique quand un jeu fait **+50% en 6h** (🚀) ou quand une
**pépite** apparaît (💎 : < 30 jours, 150-2000 joueurs, ≥ 90% de 👍).

1. Dans ton serveur Discord : **Paramètres du serveur → Intégrations → Webhooks →
   Nouveau webhook** → choisis le salon → **Copier l'URL du webhook**.
2. Sur GitHub : **Settings → Secrets and variables → Actions → New repository secret**.
3. Name : `DISCORD_WEBHOOK` · Secret : colle l'URL → **Add secret**.
4. C'est tout — les alertes partiront dès le prochain run. (Max 8 par run,
   anti-doublon de 12 h par jeu.)

## Utilisation au quotidien

- **Suivre un jeu précis 24h/24** : sur GitHub, ouvre `tracked.json` → ✏️ (crayon) →
  ajoute le placeId dans la liste, ex. `"placeIds": [2753915549, 920587237]` →
  **Commit changes**. Le collecteur le suivra à chaque run même hors charts.
  (Le bouton « + Suivre » du site te rappelle ce numéro à copier.)
- **La ⭐ watchlist du site** reste locale à ton navigateur (tri/filtrage instantané).
- **Les graphiques longue durée** : chaque fiche de jeu charge maintenant l'historique
  du collecteur — points fins sur 3 jours + un point par jour jusqu'à 400 jours.
  Plus le collecteur tourne, plus les courbes sont longues.

## Questions fréquentes

**Ça coûte vraiment 0€ ?** Oui : Actions illimité sur dépôt public + Pages gratuit.
**Je peux passer à 5 min au lieu de 15 ?** Change `*/15` en `*/5` dans
`.github/workflows/collect.yml`. GitHub ne garantit pas la cadence exacte, et 15 min
suffit largement pour du scouting — je recommande de rester à 15.
**Le run échoue (rouge) ?** Ouvre les logs du run. Le plus souvent c'est un pic de
rate-limit Roblox : le run suivant repartira normalement. Si ça persiste, envoie-moi
les logs.
**Le dépôt grossit avec le temps ?** Oui, chaque commit garde une version des données.
C'est sans conséquence pendant des mois. Si un jour tu veux nettoyer : supprime le
dépôt et recrée-le (tu perds l'historique) — ou demande-moi la version « branche
orpheline » qui ne garde qu'un commit.
**Et si je veux plus (univers plus grand, cadence 1 min, site privé) ?** C'est
l'option 2/3 (Render ou VPS) — dis-le-moi, la migration prend 10 minutes et les
données actuelles sont réutilisables.
