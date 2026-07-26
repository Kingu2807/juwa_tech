# JUWA — Pipeline factures + interface

Extraction structurée de factures fournisseurs (PDF, y compris scans dégradés) via
**OCR → LLM structured output → schéma validé (Zod)**, puis une **interface web**
qui rend le résultat exploitable par un salarié non technique.

- **B1 — `pipeline/`** : script CLI en TypeScript. Pour chaque PDF, produit un JSON
  validé par Zod. Un champ non lisible de façon fiable est renvoyé à `null` avec un
  **avertissement explicite** — jamais une valeur inventée.
- **B2 — `web/`** : mini-interface React + Vite (une seule page, pas d'auth, pas de
  base de données, pas de routing). C'est une **console de revue** : à gauche la file des
  documents, groupés « à vérifier » puis « validées » ; à droite le détail du document
  sélectionné, avec la **facture originale affichable côte à côte**. On y dépose
  directement une facture (PDF ou image scannée) : elle est envoyée à un petit serveur
  local qui lance le pipeline et renvoie le résultat. Seules les données douteuses sont
  signalées ; tout le reste reste silencieux.

Tout l'IA passe **exclusivement par l'API Mistral** (`console.mistral.ai`).

---

## Prérequis

- Node.js >= 18 (`node --version`)
- Une clé API Mistral (tier « Experiment » gratuit suffisant) : https://console.mistral.ai

## Setup (< 5 min)

### 1. Clé API (jamais commitée)

```bash
cp .env.example .env
# puis édite .env et colle ta clé :
# MISTRAL_API_KEY=xxxxxxxxxxxxxxxxxxxx
```

Le fichier `.env` est ignoré par git (voir `.gitignore`).

### 2. Pipeline B1

```bash
cd pipeline
npm install
# Dépose tes PDF dans pipeline/invoices/  (ex: facture-1.pdf, facture-2.pdf, scan.pdf)
npm run extract
```

Pour chaque PDF, le script :
- affiche le JSON validé en sortie (stdout) ;
- écrit le même JSON dans `pipeline/output/<nom>.json` ;
- copie l'ensemble dans `web/src/data/results.json` pour l'interface.

Vérifier la logique (contrôles de cohérence, gestion des `null`) sans clé ni PDF :

```bash
npm test
```

Traiter un seul fichier :

```bash
npm run extract -- ./invoices/scan.pdf
```

### 3. Interface B2

```bash
cd ../web
npm install
npm run dev
# ouvre http://localhost:5173
```

`npm run dev` démarre **deux choses en une seule commande** : l'interface (Vite) **et** le
petit serveur d'extraction du pipeline (via un plugin Vite, voir `web/vite.config.ts`).
Aucune manip supplémentaire : la clé API reste côté serveur, jamais dans le navigateur.

Dans la page, tu peux :
- **déposer une ou plusieurs factures** (`.pdf`, `.jpg`, `.png`, `.webp`) : elles sont
  traitées l'une après l'autre, avec un suivi par fichier, et **sauvegardées dans
  `pipeline/invoices/`** (leur JSON dans `pipeline/output/`) ;
- ou charger un **JSON déjà produit** par le pipeline (pratique pour rejouer un résultat).

**Les factures sont persistantes** : au démarrage, l'interface interroge le serveur
(`GET /api/invoices`), qui liste les extractions présentes dans `pipeline/output/`. Une
facture déposée reste donc visible après un rechargement de page, tant qu'elle n'a pas été
supprimée (icône corbeille). Il n'y a pas de base de données pour autant : le dossier
`output/` fait office de stockage. Si le serveur n'est pas joignable, l'interface se rabat
sur le jeu de démonstration `web/src/data/results.json`.

**Doublons** : déposer un fichier portant le nom d'une facture déjà analysée ne relance
pas l'extraction (pas d'appel API inutile) — l'interface le signale « déjà analysée ».

**Traçabilité — voir la source** : chaque document affiche son nom de fichier, et l'icône
œil ouvre la **facture originale côte à côte** avec l'extraction, pour comparer une valeur
douteuse au document d'un coup d'œil. L'icône corbeille supprime une facture partout
(fichier, JSON, liste).

**Corriger et valider** : une valeur signalée en ambre se corrige **au clic** (Entrée pour
enregistrer, Échap pour annuler). La correction est sauvegardée immédiatement et les
contrôles de cohérence sont relancés — rectifier un prix de ligne peut faire disparaître
l'alerte « somme des lignes ≠ total HT ». Ce que l'IA avait lu n'est jamais effacé : le
champ porte la mention « modifié » et le détail (`95 → 100`) figure dans « Détails
techniques ». Le bouton **Valider la facture**, en bas, la fait passer dans « Validées » ;
elle devient alors en lecture seule (bouton « Reprendre la vérification » pour y revenir).

**Fallback** (si le serveur ne démarre pas automatiquement) — le lancer à la main dans un
autre terminal :

```bash
cd pipeline
npm run serve   # sert http://localhost:8787
```

---

## Enchaînement technique

```
PDF ou image ──► [Mistral OCR: mistral-ocr-latest] ──► texte Markdown
             ──► [Mistral chat: JSON mode]         ──► JSON brut
             ──► [Zod .safeParse]                  ──► JSON validé et typé
             ──► [contrôles de cohérence]          ──► avertissements (totaux, champs manquants)
```

Le même enchaînement sert au CLI (`npm run extract`) et au serveur web
(`npm run serve`) : ce dernier reçoit le fichier déposé dans l'interface, le passe à
`extractInvoice`, et renvoie le JSON validé.

Le schéma de données (structure, types, champs optionnels) est défini dans
`pipeline/src/schema.ts` et reflété côté interface dans `web/src/types.ts`.

### Structure produite

Sortie obtenue sur `facture_2_studio_botanica.pdf` (abrégée à une ligne de produit) :

```jsonc
{
  "supplier":      { "value": "STUDIO BOTANICA", "confidence": "high", "warning": null },
  // lu, mais ambigu -> signalé sans être inventé
  "client": {
    "value": "Siège social", "confidence": "medium",
    "warning": "Destinataire facturé pas clairement identifié (lu dans le champ « Chantier »)."
  },
  "invoiceDate":   { "value": "03/06/26", "confidence": "high", "warning": null },
  "invoiceNumber": { "value": "2026-087", "confidence": "high", "warning": null },
  "lineItems": [
    {
      "designation": { "value": "Taille de haies et évacuation", "confidence": "high", "warning": null },
      "quantity":    { "value": 4,   "confidence": "high", "warning": null },
      "unitPrice":   { "value": 95,  "confidence": "high", "warning": null },
      "lineTotal":   { "value": 285, "confidence": "high", "warning": null }   // tel qu'imprimé
    }
  ],
  "totalHT":       { "value": 1040, "confidence": "high", "warning": null },
  "totalTVA":      { "value": 208,  "confidence": "high", "warning": null },
  "totalTTC":      { "value": 1248, "confidence": "high", "warning": null },
  "paymentMethod": { "value": "virement", "confidence": "high", "warning": null },
  // absent du document : « high » + aucun warning -> l'interface reste neutre
  "latePenalties": { "value": null, "confidence": "high", "warning": null },

  "sourceDocument": "facture_2_studio_botanica.pdf",   // traçabilité
  "warnings": [                                        // contrôles côté code, pas du LLM
    "Ligne « Taille de haies et évacuation » : total imprimé 285.00 alors que 4 × 95.00 = 380.00. Erreur sur le document même.",
    "Incohérence : somme des totaux de lignes imprimés = 925.00 mais total HT lu = 1040.00.",
    "Le total HT étant incohérent, la TVA (208.00) et le total TTC (1248.00) qui en découlent sont également faux."
  ],
  "review": { "validated": false, "validatedAt": null, "corrections": [] },
  "meta": { "extractedAt": "…", "ocrModel": "…", "extractionModel": "…", "ocrCharCount": 850 }
}
```

**Types** : `value` est `string | null` (fournisseur, date, numéro, désignation, règlement,
pénalités) ou `number | null` (quantités, prix, totaux) ; `confidence` est l'énumération
`"high" | "medium" | "low"` ; `warning` est `string | null`. La date reste une **chaîne au
format lu sur la facture** (« 03/06/26 »), jamais normalisée : normaliser demanderait de
deviner l'ordre jour/mois.

### Champs extraits

**Essentiels** (leur absence est toujours signalée) : fournisseur, date, numéro de
facture, lignes de produits (désignation, quantité, prix unitaire), total HT, total TTC.

**Complémentaires** (`.optional()` dans le schéma Zod) : client facturé, montant de TVA,
mode de règlement, pénalités de retard, et le **total de chaque ligne** — toutes les
factures n'ont pas de colonne « Total ». Ces informations peuvent légitimement ne pas
figurer sur le document ; `.optional()` sert aussi à ce que les extractions faites avant
l'ajout d'un champ restent valides. Le modèle distingue donc deux cas :

| Cas | Sortie | Interface |
|---|---|---|
| Absent du document | `value: null`, `confidence: "high"`, `warning: null` | « non mentionné », ton neutre |
| Présent mais illisible | `value: null`, `confidence: "low"`, `warning: "…"` | ambre + ⚠ + explication |

Sans cette nuance, toute facture sans pénalités de retard passerait à tort en
« à vérifier » et le signal serait noyé.

### Choix de conception clés

- **Chaque champ est un objet `{ value, confidence, warning }`**, pas une valeur brute.
  C'est ce qui permet de distinguer « lu avec certitude » de « à vérifier », et de ne
  jamais confondre un `0` réel avec une absence de donnée.
- **`value: null` est légitime et attendu.** Le prompt interdit explicitement au modèle
  d'inventer : en cas de doute, il met `null` + `warning`.
- **On recopie, on ne calcule jamais.** Le modèle transcrit ce qui est imprimé, même si
  c'est visiblement faux — un montant recalculé masquerait l'erreur du document. Le total
  de chaque ligne est donc **lu dans la colonne « Total »**, pas déduit de quantité × prix.
- **Contrôles de cohérence côté code** (indépendants du LLM) : total de ligne vs
  quantité × prix, somme des lignes vs total HT, TTC ≥ HT, HT + TVA = TTC, et la
  **répercussion en cascade** — si le total HT est incohérent, la TVA et le TTC qui en
  découlent sont signalés à leur tour. Ces avertissements s'ajoutent même quand le modèle
  est « sûr de lui » : c'est le filet anti-hallucination.
- **Aucune correction suggérée.** Face à « 4 × 95 € = 285 € », on ne devine pas quel
  chiffre corriger : c'est à l'humain de trancher en regardant le document. Le repère est
  posé sur le **total de la ligne** — sur une facture, la quantité et le prix unitaire sont
  les données saisies, le total en est le résultat. Quantité et prix restent modifiables
  (l'erreur peut venir de là) mais ne sont pas signalés. Les trois avertissements produits
  par ce cas figurent dans l'exemple de sortie plus haut.

---

## Structure

```
juwa-factures/
├─ .env.example          # modèle de config (clé API)
├─ .gitignore
├─ pipeline/             # B1 — CLI TypeScript + serveur d'extraction
│  ├─ src/
│  │  ├─ schema.ts       # schéma Zod (source de vérité des types)
│  │  ├─ mistral.ts      # appels bas niveau à l'API Mistral (OCR PDF/image + chat)
│  │  ├─ extract.ts      # orchestration OCR → LLM → validation → contrôles
│  │  ├─ cli.ts          # point d'entrée CLI
│  │  ├─ server.ts       # serveur HTTP local (5 endpoints, voir ci-dessous)
│  │  └─ verify.ts       # tests hors-ligne (npm test)
│  ├─ invoices/          # les factures déposées (ignorées par git)
│  └─ output/            # JSON générés — fait office de stockage (ignoré par git)
└─ web/                  # B2 — interface React + Vite
   ├─ vite.config.ts     # proxy /api + démarrage auto du serveur pipeline
   └─ src/
      ├─ App.tsx         # la page unique (console maître-détail)
      ├─ api.ts          # appels au serveur (liste, extraction, sauvegarde, suppression)
      ├─ types.ts        # types TS (miroir du schéma Zod)
      └─ data/results.json  # jeu de démonstration, utilisé si le serveur est injoignable
```

### Endpoints du serveur (`pipeline/src/server.ts`, module `http` natif, zéro dépendance)

| Méthode | Route | Rôle |
|---|---|---|
| `GET` | `/api/invoices` | liste les extractions du disque (persistance au rechargement) |
| `POST` | `/api/extract` | extrait une facture (409 si déjà analysée) |
| `PUT` | `/api/invoice/<nom>` | enregistre une facture corrigée / validée |
| `GET` | `/api/file/<nom>` | sert la facture originale (aperçu côte à côte) |
| `DELETE` | `/api/invoice/<nom>` | supprime une facture partout |
| `GET` | `/api/health` | état du serveur |

## Notes pour le débrief

- Modèles : `mistral-ocr-latest` (OCR) et `mistral-large-latest` (extraction),
  modifiables en haut de `pipeline/src/mistral.ts`.
- Le JSON mode (`responseFormat: { type: "json_object" }`) garantit une sortie JSON ;
  Zod est la couche qui **valide** réellement la structure. On pourrait passer en
  `json_schema` strict — le principe reste identique.
