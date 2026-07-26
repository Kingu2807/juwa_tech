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
  // Devient vrai dès qu'un contrôle met le total HT en doute : la TVA et le TTC qui en
  // découlent deviennent alors suspects par ricochet (voir contrôle 5).
  let htSuspect = false;

  // 1) CHAQUE LIGNE : le total imprimé doit valoir quantité × prix unitaire.
  //    On ne corrige rien — on signale que le document se contredit lui-même.
  inv.lineItems.forEach((l, i) => {
    const q = l.quantity.value;
    const p = l.unitPrice.value;
    const printed = l.lineTotal?.value ?? null;
    if (q === null || p === null || printed === null) return;

    const computed = q * p;
    if (Math.abs(computed - printed) > EPS) {
      const name = l.designation.value ?? `ligne ${i + 1}`;
      warnings.push(
        `Ligne « ${name} » : total imprimé ${printed.toFixed(2)} alors que ` +
          `${q} × ${p.toFixed(2)} = ${computed.toFixed(2)}. Erreur sur le document même.`
      );
    }
  });

  // 2) SOMME DES LIGNES vs total HT. On additionne en priorité les totaux IMPRIMÉS
  //    (la réalité du document) ; à défaut seulement, les produits quantité × prix.
  const printedTotals = inv.lineItems.map((l) => l.lineTotal?.value ?? null);
  const hasLines = inv.lineItems.length > 0;
  const allPrinted = hasLines && printedTotals.every((v) => v !== null);
  const allComputable =
    hasLines && inv.lineItems.every((l) => l.quantity.value !== null && l.unitPrice.value !== null);

  let sum: number | null = null;
  let basis = "";
  if (allPrinted) {
    sum = printedTotals.reduce((s: number, v) => s + (v as number), 0);
    basis = "des totaux de lignes imprimés";
  } else if (allComputable) {
    sum = inv.lineItems.reduce(
      (s, l) => s + (l.quantity.value as number) * (l.unitPrice.value as number),
      0
    );
    basis = "des lignes (quantité × prix)";
  }

  if (sum !== null && inv.totalHT.value !== null && Math.abs(sum - inv.totalHT.value) > EPS) {
    warnings.push(
      `Incohérence : somme ${basis} = ${sum.toFixed(2)} mais total HT lu = ` +
        `${inv.totalHT.value.toFixed(2)}. À vérifier manuellement.`
    );
    htSuspect = true;
  }

  // 3) Cohérence HT / TTC : le TTC doit être >= HT.
  if (inv.totalHT.value !== null && inv.totalTTC.value !== null) {
    if (inv.totalTTC.value + EPS < inv.totalHT.value) {
      warnings.push(
        `Incohérence : total TTC (${inv.totalTTC.value.toFixed(2)}) < total HT ` +
          `(${inv.totalHT.value.toFixed(2)}).`
      );
    }
  }

  // 4) Cohérence HT + TVA = TTC. Le contrôle le plus parlant sur une facture :
  // si les trois montants sont lus, leur addition doit tomber juste.
  const tva = inv.totalTVA?.value ?? null;
  if (inv.totalHT.value !== null && tva !== null && inv.totalTTC.value !== null) {
    const expected = inv.totalHT.value + tva;
    if (Math.abs(expected - inv.totalTTC.value) > EPS) {
      warnings.push(
        `Incohérence : total HT (${inv.totalHT.value.toFixed(2)}) + TVA (${tva.toFixed(2)}) ` +
          `= ${expected.toFixed(2)} mais total TTC lu = ${inv.totalTTC.value.toFixed(2)}.`
      );
    }
  }

  // 5) CASCADE : si le total HT est douteux, tout ce qui en découle l'est aussi.
  //    La TVA peut être « correcte » vis-à-vis du HT imprimé tout en étant fausse,
  //    puisqu'elle est calculée sur une base erronée. On le dit sans rien recalculer.
  if (htSuspect) {
    const derived: string[] = [];
    if (inv.totalTVA?.value != null) derived.push(`la TVA (${inv.totalTVA.value.toFixed(2)})`);
    if (inv.totalTTC.value !== null) derived.push(`le total TTC (${inv.totalTTC.value.toFixed(2)})`);
    if (derived.length > 0) {
      warnings.push(
        `Le total HT étant incohérent, ${derived.join(" et ")} qui en ` +
          `${derived.length > 1 ? "découlent sont également faux" : "découle est également faux"}.`
      );
    }
  }

  // 6) Rappel des champs clés manquants, remonté au niveau document pour l'interface.
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
 * recheckInvoice — recalcule les avertissements d'une facture DÉJÀ extraite.
 *
 * Sert après une correction manuelle : si l'utilisateur rectifie un prix, la somme des
 * lignes peut redevenir cohérente et l'alerte doit disparaître d'elle-même. On réutilise
 * exactement les mêmes contrôles que l'extraction initiale ; métadonnées et revue humaine
 * sont conservées telles quelles. Logique pure, sans réseau.
 */
export function recheckInvoice(result: ExtractionResult): ExtractionResult {
  const warnings: string[] = [];
  if (result.meta.ocrCharCount < 80) {
    warnings.push(
      "OCR très pauvre (peu de texte extrait) : lecture peu fiable, à contrôler."
    );
  }
  coherenceChecks(result, warnings);
  return { ...result, warnings };
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
