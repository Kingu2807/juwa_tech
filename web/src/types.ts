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
}

export interface ExtractionResult {
  sourceDocument: string;
  supplier: Field<string>;
  invoiceDate: Field<string>;
  invoiceNumber: Field<string>;
  lineItems: LineItem[];
  totalHT: Field<number>;
  totalTTC: Field<number>;
  warnings: string[];
  meta: {
    extractedAt: string;
    ocrModel: string;
    extractionModel: string;
    ocrCharCount: number;
  };
}
