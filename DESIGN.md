# DESIGN.md — Console de revue (JUWA)

Décisions visuelles durables de l'interface web (`web/`). Mode **Operate**.

## Direction (contrat)
- **THESIS** : une *console de revue de documents* (famille Rossum / Azure Document
  Intelligence), pas un flux de cartes. L'écran possède la relation
  « champ extrait ↔ sa fiabilité ↔ son document source ». Refuse la pile de cartes.
- **OWN-WORLD** : plan de travail bi-tons (fond ardoise froid, panneaux blancs), une file
  de revue à gauche, une feuille de champs à droite. UN accent azur pour la sélection et
  les actions ; UNE teinte d'attention ambre, réservée à ce qui demande une vérification ;
  le validé est calme (coche discrète), jamais criard. Zéro liseré coloré épais, zéro
  carte-conteneur générique.
- **STORY** : l'utilisateur voit la file (combien, lesquelles à vérifier), ouvre une
  facture, lit une feuille calme où seuls les champs douteux ressortent, avec leur raison
  et leur source.
- **FIRST VIEWPORT** : barre d'app fine (titre + synthèse « N documents · X à vérifier » +
  bouton d'ajout). Dessous, deux colonnes : file de revue (~300px) | détail de la facture
  sélectionnée. Le premier document « à vérifier » est présélectionné.
- **FORM** : maître-détail, une seule page, sélection en state (pas de routing).

## Système visuel

### Couleur — stratégie *Restrained* (neutres + 1 accent)
Neutres froids (ardoise) pour le plan de travail ; l'accent azur ne sert qu'à la
sélection / aux actions / au focus ; l'ambre ne sert qu'à « à vérifier ». Le validé
s'exprime par une coche vert-sarcelle discrète, pas par un aplat. Cible : couleur vive
< 10 % de la surface. Clair (scène : bureau/terrain, lumière variable).

### Typographie — une seule famille système
Pile système façon SF Pro (`-apple-system, "SF Pro Text", "Segoe UI"…`), pas de police
display dans l'UI. Échelle rem fixe, ratio ~1.2. Chiffres en `tabular-nums` partout
(`font-feature-settings: "tnum"`). Le caractère vient de la hiérarchie et du détail.

### Espacement & rythme
Base 4px (4·8·12·16·24·32). Groupes serrés, séparations généreuses, plus d'espace
au-dessus d'un titre qu'en dessous.

### Rayons
Conteneurs 12–14px ; petits contrôles / puces = pill. Cohérent partout.

### Élévation — déclarée UNE fois
Séparation par **bordure fine** OU ombre douce (offset + flou), jamais les deux sur le
même élément (pas de « ghost card »). Direction v5 « premium épuré » : les cartes de
contenu (liste de champs, tableau des lignes) sont **portées par l'ombre** (`--shadow-card`),
sans bordure ; les panneaux structurels (file, aperçu) restent séparés par une bordure.
Couleurs en **oklch**, jamais de blanc pur ni de noir pur en pleine surface.

### États (obligatoires)
Lignes de file : default / hover / focus / **selected** (fond azur pâle + texte accent,
aucune barre colorée épaisse). Champ douteux : région teintée ambre + raison. Upload :
repos / survol / **chargement** (skeleton, pas spinner central) / erreur. Vide : enseigne
la prise en main. Focus clavier visible partout (contour azur).

### Motion
150–250 ms, uniquement pour signaler un changement d'état (sélection, apparition du
détail). Aucune séquence d'animation au chargement.

## Interdits propres à ce projet
- Cartes de même taille comme structure de page ; cartes imbriquées.
- Liseré coloré > 1px sur listes/champs/alertes (on teinte la région, on ne borde pas).
- Police monospace comme « costume technique ».
- Gradients de texte, verre/flou décoratifs, gabarit « gros chiffre + label ».
