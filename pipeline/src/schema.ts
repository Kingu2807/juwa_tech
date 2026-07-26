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

/**
 * Champ COMPLÉMENTAIRE : information qui peut légitimement ne pas figurer sur la facture
 * (ex: pénalités de retard non mentionnées). `.optional()` sert à rester compatible avec
 * les extractions déjà faites AVANT l'ajout de ces champs : leur JSON reste valide.
 *
 * Convention (imposée au modèle) pour distinguer deux cas très différents :
 *   - absent du document      -> value: null, confidence: "high", warning: null  (normal)
 *   - présent mais illisible  -> value: null, confidence: "low",  warning: "..." (à vérifier)
 */
const optionalField = <T extends z.ZodTypeAny>(value: T) => field(value).optional();

/** Une ligne de produit. */
export const LineItemSchema = z.object({
  designation: field(z.string()),
  quantity: field(z.number()),
  unitPrice: field(z.number()),
  /**
   * Total de la ligne TEL QU'IMPRIMÉ sur la facture — jamais recalculé.
   * C'est ce qui permet de détecter qu'un document se contredit lui-même
   * (ex: 4 × 95 € affiché « 285 € »). Recalculer masquerait l'erreur.
   */
  lineTotal: optionalField(z.number()),
});
export type LineItem = z.infer<typeof LineItemSchema>;

/**
 * Ce que le LLM doit produire (avant contrôles de cohérence côté code).
 * C'est exactement la forme demandée dans le JSON mode.
 */
export const ExtractedInvoiceSchema = z.object({
  supplier: SupplierField,
  /** À qui la facture est adressée (le client facturé). */
  client: optionalField(z.string()),
  invoiceDate: DateField,
  invoiceNumber: InvoiceNumberField,
  lineItems: z.array(LineItemSchema),
  totalHT: AmountField,
  /** Montant de la TVA (en euros, pas le taux). */
  totalTVA: optionalField(z.number()),
  totalTTC: AmountField,
  /** Mode de règlement tel qu'écrit (ex: "Virement à 30 jours", "Chèque"). */
  paymentMethod: optionalField(z.string()),
  /** Mention des pénalités de retard, telle qu'écrite sur la facture. */
  latePenalties: optionalField(z.string()),
});
export type ExtractedInvoice = z.infer<typeof ExtractedInvoiceSchema>;

/**
 * Revue humaine d'une facture : corrections saisies à la main et validation.
 *
 * On ne remplace jamais silencieusement ce que l'IA a lu : chaque correction est
 * journalisée (`from` -> `to`), ce qui préserve la traçabilité de bout en bout.
 * `.optional()` : les extractions faites avant cette fonctionnalité restent valides.
 */
export const ReviewSchema = z.object({
  /** L'humain a contrôlé cette facture : elle passe dans « Validées ». */
  validated: z.boolean().default(false),
  validatedAt: z.string().nullable().default(null),
  /** Journal des corrections manuelles (audit). */
  corrections: z
    .array(
      z.object({
        /** Chemin technique du champ, ex: "totalHT" ou "lineItems.1.unitPrice". */
        path: z.string(),
        /** Libellé lisible, ex: "Total HT". */
        label: z.string(),
        /** Valeur lue par l'IA (null si elle n'avait rien lu). */
        from: z.string().nullable(),
        /** Valeur saisie par l'humain. */
        to: z.string(),
        at: z.string(),
      })
    )
    .default([]),
});
export type Review = z.infer<typeof ReviewSchema>;

/**
 * Résultat final écrit sur disque et consommé par l'interface.
 * On ajoute la traçabilité (document source) + métadonnées + avertissements globaux.
 */
export const ExtractionResultSchema = ExtractedInvoiceSchema.extend({
  /** Revue humaine (corrections + validation). Absent = jamais revue. */
  review: ReviewSchema.optional(),
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
