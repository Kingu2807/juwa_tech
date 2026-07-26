# PRODUCT.md — JUWA · Revue de factures extraites par IA

## Ce que fait le produit
Un pipeline IA lit des factures fournisseurs (PDF ou scan) et en extrait les données
structurées (fournisseur, date, n°, lignes, totaux HT/TTC), avec pour **chaque champ** un
niveau de confiance et un avertissement quand la lecture est douteuse. L'interface web
sert à **consulter et vérifier** ces extractions.

## Mécanisme unique (une phrase)
Chaque donnée arrive accompagnée de sa **fiabilité** et de sa **source** : l'écran existe
pour qu'un humain valide vite ce qui est sûr et se concentre sur ce qui ne l'est pas.

## Utilisateur & scène réelle
Un salarié GARNIER **non technicien**, souvent sur le terrain, pressé. Écran de bureau la
plupart du temps, parfois mobile. Lumière ambiante variable → interface claire.

## Les 3 questions auxquelles l'écran répond (en < 5 s)
1. Combien de factures, et lesquelles demandent mon attention ?
2. Où est le problème sur une facture donnée ?
3. Puis-je faire confiance à cette donnée — d'où vient-elle ?

## Périmètre (strict)
Une seule page. Pas d'auth, pas de base de données, pas de routing, pas de dashboard.
L'app charge le JSON du pipeline (ou un fichier PDF/image déposé, traité par un petit
serveur local). Ne pas sur-construire.

## Mode
**Operate** — l'utilisateur accomplit une tâche (revue). La familiarité et la clarté
priment sur l'expression ; le soin vit dans les détails précis.

## Contraintes / ce qui ne doit pas bouger
- Vérité produit : le schéma des données (champ = valeur + confiance + avertissement).
- La philosophie anti-hallucination : `null` + avertissement, jamais de valeur inventée.
- Sobriété : minimalisme soigné > usine à gaz. Pas d'animations partout.

## Hypothèses (à confirmer)
- La traçabilité retenue = nom du document + raison + confiance (pas d'aperçu du PDF, car
  le JSON statique n'embarque pas le fichier ni les coordonnées). Aperçu de la source =
  évolution possible pour les fichiers déposés.
