# JUWA — Pipeline factures + interface

Extraction structurée de factures fournisseurs (PDF, y compris scans dégradés) via
**OCR → LLM structured output → schéma validé (Zod)**, puis une **interface web**
qui rend le résultat exploitable par un salarié non technique.

- **B1 — `pipeline/`** : script CLI en TypeScript. Pour chaque PDF, produit un JSON
  validé par Zod. Un champ non lisible de façon fiable est renvoyé à `null` avec un
  **avertissement explicite** — jamais une valeur inventée.
- **B2 — `web/`** : mini-interface React + Vite (une seule page, pas d'auth, pas de
  base de données, pas de routing). Elle charge le JSON produit par le pipeline et met
  en évidence ce qui est fiable et ce qui demande une vérification humaine.

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

L'interface charge automatiquement `web/src/data/results.json`. Tu peux aussi
glisser-déposer un JSON produit par le pipeline directement dans la page.

---

## Enchaînement technique

```
PDF ──► [Mistral OCR: mistral-ocr-latest] ──► texte Markdown
    ──► [Mistral chat: JSON mode]         ──► JSON brut
    ──► [Zod .safeParse]                  ──► JSON validé et typé
    ──► [contrôles de cohérence]          ──► avertissements (totaux, champs manquants)
```

Le schéma de données (structure, types, champs optionnels) est défini dans
`pipeline/src/schema.ts` et reflété côté interface dans `web/src/types.ts`.

### Choix de conception clés

- **Chaque champ est un objet `{ value, confidence, warning }`**, pas une valeur brute.
  C'est ce qui permet de distinguer « lu avec certitude » de « à vérifier », et de ne
  jamais confondre un `0` réel avec une absence de donnée.
- **`value: null` est légitime et attendu.** Le prompt interdit explicitement au modèle
  d'inventer : en cas de doute, il met `null` + `warning`.
- **Contrôles de cohérence côté code** (indépendants du LLM) : somme des lignes vs
  total HT, cohérence HT/TTC. Ils ajoutent des avertissements même quand le modèle est
  « sûr de lui », pour attraper les hallucinations.

---

## Structure

```
juwa-factures/
├─ .env.example          # modèle de config (clé API)
├─ .gitignore
├─ pipeline/             # B1 — CLI TypeScript
│  ├─ src/
│  │  ├─ schema.ts       # schéma Zod (source de vérité des types)
│  │  ├─ mistral.ts      # appels bas niveau à l'API Mistral (OCR + chat)
│  │  ├─ extract.ts      # orchestration OCR → LLM → validation → contrôles
│  │  └─ cli.ts          # point d'entrée CLI
│  ├─ invoices/          # tes PDF (ignorés par git)
│  └─ output/            # JSON générés (ignorés par git)
└─ web/                  # B2 — interface React + Vite
   └─ src/
      ├─ App.tsx         # la page unique
      ├─ types.ts        # types TS (miroir du schéma Zod)
      └─ data/results.json  # rempli par le pipeline
```

## Notes pour le débrief

- Modèles : `mistral-ocr-latest` (OCR) et `mistral-large-latest` (extraction),
  modifiables en haut de `pipeline/src/mistral.ts`.
- Le JSON mode (`responseFormat: { type: "json_object" }`) garantit une sortie JSON ;
  Zod est la couche qui **valide** réellement la structure. On pourrait passer en
  `json_schema` strict — le principe reste identique.
