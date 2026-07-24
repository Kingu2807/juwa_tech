/**
 * schema.ts — Source de vérité des types de l'extraction.
 *
 * Idée directrice : on ne stocke JAMAIS une valeur brute seule.
 * Chaque champ extrait est un objet `Field` qui porte, en plus de la valeur :
 *   - un niveau de confiance,
 *   - un avertissement optionnel.
 *
 * Ainsi une donnée illisible devient `{ value: null, confidence: "low", warning: "..." }`
 * et ne peut pas être confondue avec une vraie valeur (ex: un "0" réel).
 */
import { z } from "zod";

/** Niveau de confiance renvoyé par le modèle pour un champ donné. */
export const Confidence = z.enum(["high", "medium", "low"]);
export type Confidence = z.infer<typeof Confidence>;

/**
 * Field<T> : un champ extrait.
 * - value    : la valeur lue, ou `null` si non lisible de façon fiable.
 * - confidence : à quel point le modèle est sûr de cette lecture.
 * - warning  : message explicite quand la valeur est douteuse ou nulle.
 *
 * Règle métier (imposée aussi côté prompt) : si value === null, il DOIT y avoir un warning.
 */
const field = <T extends z.ZodTypeAny>(value: T) =>
  z.object({
    value: value.nullable(),
    confidence: Confidence,
    warning: z.string().nullable().default(null),
  });

/** Champs scalaires de la facture. */
export const SupplierField = field(z.string());
export const DateField = field(z.string()); // format libre tel que lu (ex: "01/07/2026")
export const InvoiceNumberField = field(z.string());
export const AmountField = field(z.number()); // montants en nombre (ex: 1234.56)

/** Une ligne de produit. */
export const LineItemSchema = z.object({
  designation: field(z.string()),
  quantity: field(z.number()),
  unitPrice: field(z.number()),
});
export type LineItem = z.infer<typeof LineItemSchema>;

/**
 * Ce que le LLM doit produire (avant contrôles de cohérence côté code).
 * C'est exactement la forme demandée dans le JSON mode.
 */
export const ExtractedInvoiceSchema = z.object({
  supplier: SupplierField,
  invoiceDate: DateField,
  invoiceNumber: InvoiceNumberField,
  lineItems: z.array(LineItemSchema),
  totalHT: AmountField,
  totalTTC: AmountField,
});
export type ExtractedInvoice = z.infer<typeof ExtractedInvoiceSchema>;

/**
 * Résultat final écrit sur disque et consommé par l'interface.
 * On ajoute la traçabilité (document source) + métadonnées + avertissements globaux.
 */
export const ExtractionResultSchema = ExtractedInvoiceSchema.extend({
  /** Nom du fichier PDF d'origine — traçabilité pour l'interface. */
  sourceDocument: z.string(),
  /** Avertissements au niveau du document (contrôles de cohérence, OCR dégradé...). */
  warnings: z.array(z.string()).default([]),
  /** Métadonnées d'exécution. */
  meta: z.object({
    extractedAt: z.string(),
    ocrModel: z.string(),
    extractionModel: z.string(),
    ocrCharCount: z.number(),
  }),
});
export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;
