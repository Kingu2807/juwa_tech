/**
 * types.ts — Miroir TypeScript du schéma Zod du pipeline (pipeline/src/schema.ts).
 * L'interface ne fait que LIRE ces données ; pas de logique métier ici.
 */
export type Confidence = "high" | "medium" | "low";

/** Un champ extrait : valeur éventuellement nulle + confiance + avertissement. */
export interface Field<T> {
  value: T | null;
  confidence: Confidence;
  warning: string | null;
}

export interface LineItem {
  designation: Field<string>;
  quantity: Field<number>;
  unitPrice: Field<number>;
  /** Total de la ligne TEL QU'IMPRIMÉ sur la facture — jamais recalculé. */
  lineTotal?: Field<number>;
}

/** Une correction manuelle : ce que l'IA avait lu -> ce que l'humain a saisi. */
export interface Correction {
  path: string;
  label: string;
  from: string | null;
  to: string;
  at: string;
}

/** Revue humaine d'une facture : corrections saisies et validation. */
export interface Review {
  validated: boolean;
  validatedAt: string | null;
  corrections: Correction[];
}

/**
 * Champs COMPLÉMENTAIRES (`?`) : ils peuvent manquer pour deux raisons distinctes.
 *  - la clé est absente du JSON  -> extraction faite AVANT l'ajout de ces champs ;
 *  - `{ value: null, confidence: "high", warning: null }` -> l'information ne figure
 *    tout simplement pas sur la facture. Ce n'est PAS une anomalie.
 * En revanche `value: null` avec un warning (ou une confiance basse) = à vérifier.
 */
export interface ExtractionResult {
  sourceDocument: string;
  supplier: Field<string>;
  /** À qui la facture est adressée. */
  client?: Field<string>;
  invoiceDate: Field<string>;
  invoiceNumber: Field<string>;
  lineItems: LineItem[];
  totalHT: Field<number>;
  /** Montant de la TVA en euros (pas le taux). */
  totalTVA?: Field<number>;
  totalTTC: Field<number>;
  /** Mode / conditions de règlement, tels qu'écrits. */
  paymentMethod?: Field<string>;
  /** Mention des pénalités de retard, telle qu'écrite. */
  latePenalties?: Field<string>;
  /** Revue humaine. Absent = facture jamais revue. */
  review?: Review;
  warnings: string[];
  meta: {
    extractedAt: string;
    ocrModel: string;
    extractionModel: string;
    ocrCharCount: number;
  };
}
