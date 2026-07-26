/**
 * mistral.ts — Appels bas niveau à l'API Mistral (le SEUL fournisseur IA utilisé).
 *
 * Deux étapes :
 *   1) OCR   : transforme le PDF (même scan dégradé) en texte Markdown.
 *   2) Chat  : lit ce texte et renvoie un JSON structuré (JSON mode).
 *
 * La clé API vient de la variable d'environnement MISTRAL_API_KEY (jamais commitée).
 */
import { Mistral } from "@mistralai/mistralai";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

// Modèles utilisés — modifiables ici uniquement.
export const OCR_MODEL = "mistral-ocr-latest";
export const EXTRACTION_MODEL = "mistral-large-latest";

/**
 * Extensions d'images acceptées (une facture scannée arrive parfois en photo, pas en PDF).
 * Tout le reste (typiquement .pdf) est traité comme un document.
 */
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

/** true si le fichier est une image (selon son extension), false pour un PDF. */
function isImage(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(extname(filePath).toLowerCase());
}

/**
 * Client Mistral initialisé paresseusement (au premier appel réseau).
 * Avantage : importer ce module ne plante pas si la clé est absente, ce qui
 * rend la logique de validation testable hors-ligne.
 */
let _client: Mistral | null = null;
function getClient(): Mistral {
  if (_client) return _client;
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) {
    throw new Error(
      "MISTRAL_API_KEY manquante. Copie .env.example en .env et renseigne ta clé."
    );
  }
  _client = new Mistral({ apiKey });
  return _client;
}

/**
 * Étape 1 — OCR.
 * On téléverse le fichier via l'API Files (purpose "ocr"), on récupère une URL signée,
 * puis on lance l'OCR. Cette approche gère les fichiers locaux et les scans de
 * mauvaise qualité. On concatène le Markdown de toutes les pages.
 *
 * Le fichier peut être un PDF OU une image (facture scannée / photographiée). L'OCR
 * Mistral accepte les deux, mais le champ `document` diffère :
 *   - PDF   -> { type: "document_url", documentUrl: ... }
 *   - image -> { type: "image_url",    imageUrl:    ... }
 * On choisit donc la bonne forme selon l'extension du fichier.
 */
export async function runOcr(filePath: string): Promise<string> {
  const content = await readFile(filePath);

  const client = getClient();
  const uploaded = await client.files.upload({
    file: { fileName: basename(filePath), content },
    purpose: "ocr",
  });

  const signed = await client.files.getSignedUrl({ fileId: uploaded.id });

  // Selon PDF ou image, on passe l'URL signée dans le bon champ (voir commentaire ci-dessus).
  const document = isImage(filePath)
    ? ({ type: "image_url", imageUrl: signed.url } as const)
    : ({ type: "document_url", documentUrl: signed.url } as const);

  const ocr = await client.ocr.process({
    model: OCR_MODEL,
    document,
  });

  // ocr.pages[].markdown : texte reconstruit page par page.
  const text = (ocr.pages ?? [])
    .map((p: { markdown?: string }) => p.markdown ?? "")
    .join("\n\n");

  return text.trim();
}

/**
 * Étape 2 — Extraction structurée (JSON mode).
 *
 * Le prompt système impose les règles anti-hallucination : en cas de doute -> null
 * + warning, jamais de valeur inventée. Le JSON mode garantit une sortie JSON parsable ;
 * la validation réelle de la structure est faite ensuite par Zod (voir extract.ts).
 *
 * Alternative possible : responseFormat json_schema strict (dérivé de Zod). On reste
 * en json_object ici pour la robustesse et la lisibilité ; le principe est identique.
 */
export async function runExtraction(ocrText: string): Promise<string> {
  const system = [
    "Tu es un extracteur de données de factures fournisseurs françaises.",
    "Tu reçois le texte OCR d'UNE facture (parfois issu d'un scan dégradé).",
    "Tu renvoies UNIQUEMENT un objet JSON, sans texte autour, respectant EXACTEMENT ce format :",
    "",
    "{",
    '  "supplier":      { "value": string|null, "confidence": "high"|"medium"|"low", "warning": string|null },',
    '  "client":        { "value": string|null, "confidence": "...", "warning": string|null },',
    '  "invoiceDate":   { "value": string|null, "confidence": "...", "warning": string|null },',
    '  "invoiceNumber": { "value": string|null, "confidence": "...", "warning": string|null },',
    '  "lineItems": [',
    '    {',
    '      "designation": { "value": string|null, "confidence": "...", "warning": string|null },',
    '      "quantity":    { "value": number|null, "confidence": "...", "warning": string|null },',
    '      "unitPrice":   { "value": number|null, "confidence": "...", "warning": string|null },',
    '      "lineTotal":   { "value": number|null, "confidence": "...", "warning": string|null }',
    '    }',
    '  ],',
    '  "totalHT":  { "value": number|null, "confidence": "...", "warning": string|null },',
    '  "totalTVA": { "value": number|null, "confidence": "...", "warning": string|null },',
    '  "totalTTC": { "value": number|null, "confidence": "...", "warning": string|null },',
    '  "paymentMethod": { "value": string|null, "confidence": "...", "warning": string|null },',
    '  "latePenalties": { "value": string|null, "confidence": "...", "warning": string|null }',
    "}",
    "",
    "RÈGLES IMPÉRATIVES :",
    "- N'invente JAMAIS une valeur. Si un champ n'est pas lisible de façon fiable,",
    "  mets value=null, confidence=\"low\" et un warning explicite décrivant le problème",
    "  (ex: \"montant illisible sur le scan\", \"numéro de facture ambigu\").",
    "- NE CALCULE JAMAIS un montant, ne corrige JAMAIS le document. Tu RECOPIES ce qui est",
    "  écrit, même si c'est visiblement faux. Si une facture affiche « 4 × 95 € = 285 € »,",
    "  tu renvoies lineTotal=285 (et surtout pas 380). Détecter l'erreur n'est pas ton rôle :",
    "  des contrôles automatiques s'en chargent ensuite, et un humain tranchera.",
    "- Les montants sont des nombres (point décimal), sans symbole ni séparateur de milliers.",
    "- invoiceDate : garde le format tel qu'écrit sur la facture (ex: \"01/07/2026\").",
    "- confidence=\"high\" seulement si la lecture est nette et sans ambiguïté.",
    "- Si tu ne trouves aucune ligne de produit fiable, renvoie \"lineItems\": [].",
    "- warning=null quand la valeur est fiable.",
    "",
    "DISTINCTION IMPORTANTE pour client, totalTVA, paymentMethod, latePenalties :",
    "- L'information N'EXISTE PAS sur la facture (elle n'y figure tout simplement pas) :",
    "  value=null, confidence=\"high\", warning=null. Ce n'est PAS une anomalie.",
    "- L'information EXISTE mais tu ne la lis pas de façon fiable :",
    "  value=null, confidence=\"low\", warning explicite. Là c'est une anomalie.",
    "",
    "PRÉCISIONS SUR CES CHAMPS :",
    "- supplier : l'émetteur de la facture. Donne UNIQUEMENT son nom (raison sociale),",
    "  sans l'adresse, ni le SIRET, ni le numéro de TVA.",
    "- client : le destinataire facturé (souvent après « Facturé à », « Client »,",
    "  « Adressé à »). Son nom seul, sans l'adresse.",
    "- lineTotal : le total de la ligne tel qu'IMPRIMÉ dans la colonne « Total » de la",
    "  facture. Ne le déduis pas de quantité × prix. Si la facture n'a pas de colonne",
    "  total, value=null, confidence=\"high\", warning=null.",
    "- totalTVA : le MONTANT de TVA en euros (pas le taux). Si seul un taux est indiqué",
    "  (ex: 20 %) et qu'aucun montant n'apparaît, ne calcule rien : value=null,",
    "  confidence=\"high\", warning=null.",
    "- paymentMethod : le mode ou les conditions de règlement, tels qu'écrits",
    "  (ex: \"Virement à 30 jours\", \"Chèque à réception\", \"Prélèvement\").",
    "- latePenalties : la mention des pénalités de retard, telle qu'écrite",
    "  (ex: \"3 fois le taux d'intérêt légal + indemnité forfaitaire de 40 €\").",
  ].join("\n");

  const client = getClient();
  const chat = await client.chat.complete({
    model: EXTRACTION_MODEL,
    temperature: 0,
    responseFormat: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: `Texte OCR de la facture :\n\n${ocrText}` },
    ],
  });

  const content = chat.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.length === 0) {
    throw new Error("Réponse vide du modèle d'extraction.");
  }
  return content;
}
