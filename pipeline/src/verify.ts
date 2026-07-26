import { finalizeInvoice } from "./extract.js";
import { ExtractedInvoiceSchema, ExtractionResultSchema } from "./schema.js";
import type { ExtractedInvoice } from "./schema.js";

const f = (value: unknown, confidence = "high", warning: string | null = null) =>
  ({ value, confidence, warning });

let pass = 0, fail = 0;
const check = (name: string, cond: boolean) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  cond ? pass++ : fail++;
};

// 1) Facture propre et cohérente : 2*10 + ... = totalHT
const clean: ExtractedInvoice = {
  supplier: f("Garnier SA"),
  invoiceDate: f("01/07/2026"),
  invoiceNumber: f("FA-1"),
  lineItems: [
    { designation: f("Vis"), quantity: f(10), unitPrice: f(12.5) },
    { designation: f("Chevilles"), quantity: f(6), unitPrice: f(4.9) },
  ],
  totalHT: f(154.4),
  totalTTC: f(185.28),
} as any;
const r1 = finalizeInvoice(ExtractedInvoiceSchema.parse(clean), "facture-1.pdf", 1800);
check("facture propre -> 0 warning", r1.warnings.length === 0);
check("resultat final valide (Zod)", ExtractionResultSchema.safeParse(r1).success);

// 2) Incoherence somme des lignes vs total HT
const mismatch = { ...clean, totalHT: f(999) } as ExtractedInvoice;
const r2 = finalizeInvoice(ExtractedInvoiceSchema.parse(mismatch), "f2.pdf", 1800);
check("total HT incoherent -> warning", r2.warnings.some(w => w.includes("somme des lignes")));

// 3) Champs nuls -> warning champs cles + pas de valeur inventee
const missing: ExtractedInvoice = {
  supplier: f("Quincaillerie", "medium"),
  invoiceDate: f(null, "low", "date illisible"),
  invoiceNumber: f(null, "low", "numero coupe"),
  lineItems: [{ designation: f("Cable", "medium"), quantity: f(null, "low", "qte illisible"), unitPrice: f(1.35, "medium") }],
  totalHT: f(null, "low", "montant illisible"),
  totalTTC: f(96.5, "medium"),
} as any;
const r3 = finalizeInvoice(ExtractedInvoiceSchema.parse(missing), "scan.pdf", 210);
check("champs nuls -> warning champs cles", r3.warnings.some(w => w.includes("Champs clés non lisibles")));
check("null reste null (pas de valeur inventee)", r3.totalHT.value === null && r3.invoiceDate.value === null);

// 4) OCR pauvre
const r4 = finalizeInvoice(ExtractedInvoiceSchema.parse(clean), "s.pdf", 40);
check("ocr pauvre -> warning", r4.warnings.some(w => w.includes("OCR très pauvre")));

// 5) TTC < HT
const badttc = { ...clean, totalTTC: f(10) } as ExtractedInvoice;
const r5 = finalizeInvoice(ExtractedInvoiceSchema.parse(badttc), "b.pdf", 1800);
check("TTC < HT -> warning", r5.warnings.some(w => w.includes("TTC")));

// 6) HT + TVA = TTC : addition juste -> aucun warning
const withTva = { ...clean, totalTVA: f(30.88) } as ExtractedInvoice; // 154.40 + 30.88 = 185.28
const r6 = finalizeInvoice(ExtractedInvoiceSchema.parse(withTva), "tva-ok.pdf", 1800);
check("HT + TVA = TTC juste -> 0 warning", r6.warnings.length === 0);

// 7) HT + TVA != TTC -> warning
const badTva = { ...clean, totalTVA: f(50) } as ExtractedInvoice; // 154.40 + 50 != 185.28
const r7 = finalizeInvoice(ExtractedInvoiceSchema.parse(badTva), "tva-ko.pdf", 1800);
check("HT + TVA != TTC -> warning", r7.warnings.some(w => w.includes("TVA")));

// 8) Champs complémentaires absents de la facture (null + high + pas de warning) :
//    c'est légitime, ça ne doit générer AUCUN avertissement document.
const absent = {
  ...clean,
  client: f(null, "high", null),
  totalTVA: f(null, "high", null),
  paymentMethod: f(null, "high", null),
  latePenalties: f(null, "high", null),
} as ExtractedInvoice;
const r8 = finalizeInvoice(ExtractedInvoiceSchema.parse(absent), "sobre.pdf", 1800);
check("champs complementaires absents -> 0 warning", r8.warnings.length === 0);

// 9) Rétro-compatibilité : une extraction SANS les nouveaux champs reste valide.
const r9 = finalizeInvoice(ExtractedInvoiceSchema.parse(clean), "ancien.pdf", 1800);
check("ancienne facture (sans nouveaux champs) reste valide", ExtractionResultSchema.safeParse(r9).success);

// 10) CAS RÉEL (facture Studio Botanica) : le document se contredit lui-même.
//     Ligne 2 : 4 × 95 mais « 285 » imprimé. Somme des totaux imprimés = 925 ≠ 1040 lu.
//     La TVA et le TTC, calculés sur ce HT erroné, sont donc faux eux aussi.
//     RÈGLE : on recopie ce qui est écrit, on signale — on ne corrige jamais.
const botanica: ExtractedInvoice = {
  supplier: f("STUDIO BOTANICA"),
  invoiceDate: f("03/06/26"),
  invoiceNumber: f("2026-087"),
  lineItems: [
    { designation: f("Tonte et débroussaillage"), quantity: f(1), unitPrice: f(320), lineTotal: f(320) },
    { designation: f("Taille de haies et évacuation"), quantity: f(4), unitPrice: f(95), lineTotal: f(285) },
    { designation: f("Plantation massifs"), quantity: f(1), unitPrice: f(140), lineTotal: f(140) },
    { designation: f("Traitement phytosanitaire doux"), quantity: f(3), unitPrice: f(60), lineTotal: f(180) },
  ],
  totalHT: f(1040),
  totalTVA: f(208),
  totalTTC: f(1248),
} as any;
const r10 = finalizeInvoice(ExtractedInvoiceSchema.parse(botanica), "botanica.pdf", 850);

check("ligne incoherente -> warning nommant la ligne",
  r10.warnings.some(w => w.includes("Taille de haies") && w.includes("285") && w.includes("380")));
check("somme des totaux IMPRIMES (925) comparee au total HT",
  r10.warnings.some(w => w.includes("925.00") && w.includes("1040.00")));
check("cascade : TVA et TTC signales comme faux",
  r10.warnings.some(w => w.includes("TVA") && w.includes("TTC") && w.includes("découlent")));
check("aucune valeur corrigee : lineTotal reste 285",
  r10.lineItems[1].lineTotal?.value === 285 && r10.lineItems[1].unitPrice.value === 95);

console.log(`\n${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
