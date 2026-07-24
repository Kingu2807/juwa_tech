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
import { basename } from "node:path";

// Modèles utilisés — modifiables ici uniquement.
export const OCR_MODEL = "mistral-ocr-latest";
export const EXTRACTION_MODEL = "mistral-large-latest";

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
 * On téléverse le PDF via l'API Files (purpose "ocr"), on récupère une URL signée,
 * puis on lance l'OCR. Cette approche gère les fichiers locaux et les scans de
 * mauvaise qualité. On concatène le Markdown de toutes les pages.
 */
export async function runOcr(pdfPath: string): Promise<string> {
  const content = await readFile(pdfPath);

  const client = getClient();
  const uploaded = await client.files.upload({
    file: { fileName: basename(pdfPath), content },
    purpose: "ocr",
  });

  const signed = await client.files.getSignedUrl({ fileId: uploaded.id });

  const ocr = await client.ocr.process({
    model: OCR_MODEL,
    document: { type: "document_url", documentUrl: signed.url },
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
    '  "invoiceDate":   { "value": string|null, "confidence": "...", "warning": string|null },',
    '  "invoiceNumber": { "value": string|null, "confidence": "...", "warning": string|null },',
    '  "lineItems": [',
    '    {',
    '      "designation": { "value": string|null, "confidence": "...", "warning": string|null },',
    '      "quantity":    { "value": number|null, "confidence": "...", "warning": string|null },',
    '      "unitPrice":   { "value": number|null, "confidence": "...", "warning": string|null }',
    '    }',
    '  ],',
    '  "totalHT":  { "value": number|null, "confidence": "...", "warning": string|null },',
    '  "totalTTC": { "value": number|null, "confidence": "...", "warning": string|null }',
    "}",
    "",
    "RÈGLES IMPÉRATIVES :",
    "- N'invente JAMAIS une valeur. Si un champ n'est pas lisible de façon fiable,",
    "  mets value=null, confidence=\"low\" et un warning explicite décrivant le problème",
    "  (ex: \"montant illisible sur le scan\", \"numéro de facture ambigu\").",
    "- Les montants sont des nombres (point décimal), sans symbole ni séparateur de milliers.",
    "- invoiceDate : garde le format tel qu'écrit sur la facture (ex: \"01/07/2026\").",
    "- confidence=\"high\" seulement si la lecture est nette et sans ambiguïté.",
    "- Si tu ne trouves aucune ligne de produit fiable, renvoie \"lineItems\": [].",
    "- warning=null quand la valeur est fiable.",
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
