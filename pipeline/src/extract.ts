/**
 * extract.ts — Orchestration : OCR -> LLM -> validation Zod -> contrôles de cohérence.
 *
 * C'est ici qu'on transforme la sortie brute du modèle en un ExtractionResult sûr,
 * et qu'on ajoute des avertissements calculés côté code (indépendants du LLM).
 */
import { basename } from "node:path";
import { ExtractedInvoiceSchema, ExtractionResultSchema } from "./schema.js";
import type { ExtractedInvoice, ExtractionResult } from "./schema.js";
import {
  runOcr,
  runExtraction,
  OCR_MODEL,
  EXTRACTION_MODEL,
} from "./mistral.js";

/** Tolérance sur les comparaisons de montants (centimes). */
const EPS = 0.02;

/**
 * Contrôles de cohérence : on n'invente rien, on SIGNALE seulement des incohérences.
 * Ces avertissements viennent en plus de ceux du modèle et servent de filet anti-hallucination.
 */
function coherenceChecks(inv: ExtractedInvoice, warnings: string[]): void {
  // 1) Somme des lignes (quantité × prix unitaire) vs total HT.
  const allLinesReadable = inv.lineItems.every(
    (l) => l.quantity.value !== null && l.unitPrice.value !== null
  );
  if (inv.totalHT.value !== null && inv.lineItems.length > 0 && allLinesReadable) {
    const computed = inv.lineItems.reduce(
      (sum, l) => sum + (l.quantity.value ?? 0) * (l.unitPrice.value ?? 0),
      0
    );
    if (Math.abs(computed - inv.totalHT.value) > EPS) {
      warnings.push(
        `Incohérence : somme des lignes = ${computed.toFixed(2)} mais total HT lu = ` +
          `${inv.totalHT.value.toFixed(2)}. À vérifier manuellement.`
      );
    }
  }

  // 2) Cohérence HT / TTC : le TTC doit être >= HT.
  if (inv.totalHT.value !== null && inv.totalTTC.value !== null) {
    if (inv.totalTTC.value + EPS < inv.totalHT.value) {
      warnings.push(
        `Incohérence : total TTC (${inv.totalTTC.value.toFixed(2)}) < total HT ` +
          `(${inv.totalHT.value.toFixed(2)}).`
      );
    }
  }

  // 3) Rappel des champs clés manquants, remonté au niveau document pour l'interface.
  const missing: string[] = [];
  if (inv.supplier.value === null) missing.push("fournisseur");
  if (inv.invoiceNumber.value === null) missing.push("numéro de facture");
  if (inv.invoiceDate.value === null) missing.push("date");
  if (inv.totalTTC.value === null) missing.push("total TTC");
  if (missing.length > 0) {
    warnings.push(
      `Champs clés non lisibles : ${missing.join(", ")}. Vérification humaine requise.`
    );
  }
}

/**
 * Traite un PDF de bout en bout et renvoie un ExtractionResult validé.
 * Lève une erreur seulement si l'OCR/appel échoue ou si le JSON est irrécupérable.
 */
export async function extractInvoice(pdfPath: string): Promise<ExtractionResult> {
  const sourceDocument = basename(pdfPath);

  // 1) OCR
  const ocrText = await runOcr(pdfPath);
  if (ocrText.length === 0) {
    throw new Error(`${sourceDocument} : l'OCR n'a renvoyé aucun texte.`);
  }

  // 2) Extraction structurée (JSON mode)
  const rawJson = await runExtraction(ocrText);

  // 3) Parse + validation Zod
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new Error(`${sourceDocument} : le modèle n'a pas renvoyé un JSON valide.`);
  }

  const check = ExtractedInvoiceSchema.safeParse(parsed);
  if (!check.success) {
    throw new Error(
      `${sourceDocument} : JSON non conforme au schéma.\n` +
        JSON.stringify(check.error.format(), null, 2)
    );
  }
  const invoice = check.data;

  // 4-5) Contrôles de cohérence + assemblage (logique pure, testable hors-ligne)
  return finalizeInvoice(invoice, sourceDocument, ocrText.length);
}

/**
 * finalizeInvoice — logique PURE (aucun appel réseau) : contrôles de cohérence,
 * ajout des avertissements niveau document, assemblage et validation finale Zod.
 * Isolée pour être testable sans clé API ni PDF.
 */
export function finalizeInvoice(
  invoice: ExtractedInvoice,
  sourceDocument: string,
  ocrCharCount: number
): ExtractionResult {
  const warnings: string[] = [];
  if (ocrCharCount < 80) {
    warnings.push(
      "OCR très pauvre (peu de texte extrait) : lecture peu fiable, à contrôler."
    );
  }
  coherenceChecks(invoice, warnings);

  return ExtractionResultSchema.parse({
    ...invoice,
    sourceDocument,
    warnings,
    meta: {
      extractedAt: new Date().toISOString(),
      ocrModel: OCR_MODEL,
      extractionModel: EXTRACTION_MODEL,
      ocrCharCount,
    },
  });
}
