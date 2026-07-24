/**
 * App.tsx — L'unique page de l'interface.
 *
 * Objectifs (ce sur quoi B2 est jugé) :
 *  1. Lisibilité non-technique : gros libellés FR, montants formatés, couleurs simples.
 *  2. Traçabilité : chaque facture affiche son document source.
 *  3. Incertitude visible : un champ null ou porteur d'un avertissement ne se noie pas —
 *     il passe en rouge/orange avec un badge « à vérifier », et un bandeau récapitule
 *     en haut de carte combien de champs demandent une vérification humaine.
 */
import { useMemo, useState, type ChangeEvent } from "react";
import type { ExtractionResult, Field, LineItem } from "./types";
import results from "./data/results.json";

/* --------------------------- Helpers d'affichage --------------------------- */

/** Statut visuel d'un champ, unique règle partagée par tout le composant. */
type Status = "ok" | "warn" | "bad";
function statusOf<T>(f: Field<T>): Status {
  if (f.value === null) return "bad"; // donnée absente = à vérifier en priorité
  if (f.warning || f.confidence === "low") return "bad";
  if (f.confidence === "medium") return "warn";
  return "ok";
}

const chipLabel: Record<Status, string> = {
  ok: "fiable",
  warn: "à confirmer",
  bad: "à vérifier",
};

function euros(n: number): string {
  return n.toLocaleString("fr-FR", { style: "currency", currency: "EUR" });
}

/* ------------------------------- Sous-vues -------------------------------- */

/** Un champ d'en-tête (fournisseur, date, numéro, total). */
function HeaderField({
  label,
  field,
  format = (v: unknown) => String(v),
}: {
  label: string;
  field: Field<string | number>;
  format?: (v: string | number) => string;
}) {
  const status = statusOf(field);
  const cls = status === "bad" ? "is-bad" : status === "warn" ? "is-warn" : "";
  return (
    <div className={`field ${cls}`}>
      <div className="label">{label}</div>
      <div className="value">
        {field.value === null ? (
          <span className="missing">non lisible</span>
        ) : (
          <span>{format(field.value)}</span>
        )}
        <span className={`chip ${status}`}>{chipLabel[status]}</span>
      </div>
      {field.warning && <div className="field-warning">⚠ {field.warning}</div>}
    </div>
  );
}

/** Une cellule de ligne produit, colorée selon l'incertitude. */
function Cell({
  field,
  format = (v: unknown) => String(v),
  numeric = false,
}: {
  field: Field<string | number>;
  format?: (v: string | number) => string;
  numeric?: boolean;
}) {
  const status = statusOf(field);
  const cls =
    (numeric ? "num " : "") +
    (status === "bad" ? "cell-bad" : status === "warn" ? "cell-warn" : "");
  return (
    <td className={cls}>
      {field.value === null ? <span className="missing">non lisible</span> : format(field.value)}
      {field.warning && <span className="cell-flag">⚠ {field.warning}</span>}
    </td>
  );
}

/** Compte les champs à vérifier dans une facture (en-tête + lignes). */
function countToVerify(inv: ExtractionResult): number {
  const headerFields: Field<string | number>[] = [
    inv.supplier,
    inv.invoiceDate,
    inv.invoiceNumber,
    inv.totalHT,
    inv.totalTTC,
  ];
  const lineFields = inv.lineItems.flatMap((l: LineItem) => [
    l.designation,
    l.quantity,
    l.unitPrice,
  ]);
  return [...headerFields, ...lineFields].filter((f) => statusOf(f) === "bad").length;
}

/** Une carte facture complète. */
function InvoiceCard({ inv }: { inv: ExtractionResult }) {
  const toVerify = countToVerify(inv);
  const hasIssues = toVerify > 0 || inv.warnings.length > 0;

  return (
    <div className="card">
      <div className="card-top">
        <h2 className="supplier">
          {inv.supplier.value ?? <span className="missing">Fournisseur non lisible</span>}
        </h2>
        {/* Traçabilité : d'où vient cette donnée */}
        <span className="source">
          source&nbsp;: <b>{inv.sourceDocument}</b>
        </span>
      </div>

      {/* Bandeau de synthèse — l'utilisateur voit en 5 s l'état de fiabilité */}
      {hasIssues ? (
        <div className="banner check">
          ⚠ {toVerify > 0 ? `${toVerify} champ(s) à vérifier` : "Points d'attention"}
          {inv.warnings.length > 0 && ` · ${inv.warnings.length} alerte(s) de cohérence`}
        </div>
      ) : (
        <div className="banner clean">✓ Extraction complète — aucun champ douteux</div>
      )}

      <div className="fields">
        <HeaderField label="Numéro de facture" field={inv.invoiceNumber} />
        <HeaderField label="Date" field={inv.invoiceDate} />
        <HeaderField label="Total HT" field={inv.totalHT} format={(v) => euros(v as number)} />
        <HeaderField label="Total TTC" field={inv.totalTTC} format={(v) => euros(v as number)} />
      </div>

      <table>
        <thead>
          <tr>
            <th>Désignation</th>
            <th style={{ textAlign: "right" }}>Qté</th>
            <th style={{ textAlign: "right" }}>Prix unitaire</th>
          </tr>
        </thead>
        <tbody>
          {inv.lineItems.length === 0 ? (
            <tr>
              <td colSpan={3} className="missing">Aucune ligne de produit lue de façon fiable.</td>
            </tr>
          ) : (
            inv.lineItems.map((l, i) => (
              <tr key={i}>
                <Cell field={l.designation} />
                <Cell field={l.quantity} numeric />
                <Cell field={l.unitPrice} numeric format={(v) => euros(v as number)} />
              </tr>
            ))
          )}
        </tbody>
      </table>

      <div className="totals">
        <div className="total-box">
          <div className="label">Total HT</div>
          <div className="value">
            {inv.totalHT.value === null ? <span className="missing">—</span> : euros(inv.totalHT.value)}
          </div>
        </div>
        <div className="total-box">
          <div className="label">Total TTC</div>
          <div className="value">
            {inv.totalTTC.value === null ? <span className="missing">—</span> : euros(inv.totalTTC.value)}
          </div>
        </div>
      </div>

      {inv.warnings.length > 0 && (
        <div className="doc-warnings">
          <h4>À vérifier manuellement</h4>
          <ul>
            {inv.warnings.map((w, i) => (
              <li key={i}>⚠ {w}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="meta">
        Extrait le {new Date(inv.meta.extractedAt).toLocaleString("fr-FR")} · OCR {inv.meta.ocrModel} ·
        extraction {inv.meta.extractionModel}
      </div>
    </div>
  );
}

/* ------------------------------- Page ------------------------------------- */

export default function App() {
  // Données par défaut : le JSON produit par le pipeline (import statique).
  const initial = results as unknown as ExtractionResult[];
  const [data, setData] = useState<ExtractionResult[]>(initial);
  const [error, setError] = useState<string | null>(null);

  const totalToVerify = useMemo(
    () => data.reduce((n, inv) => n + countToVerify(inv) + inv.warnings.length, 0),
    [data]
  );

  // Petit upload optionnel : charger un autre results.json sans rebuild.
  function onUpload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    file.text().then((txt) => {
      try {
        const parsed = JSON.parse(txt);
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        setData(arr as ExtractionResult[]);
        setError(null);
      } catch {
        setError("Fichier JSON invalide.");
      }
    });
  }

  return (
    <div className="wrap">
      <div className="app-head">
        <h1>Factures fournisseurs — résultat d'extraction</h1>
        <p>
          {data.length} facture(s) ·{" "}
          {totalToVerify === 0
            ? "aucun point à vérifier"
            : `${totalToVerify} point(s) demandant une vérification humaine`}
        </p>
      </div>

      <div className="legend">
        Légende :
        <span className="chip ok">fiable</span>
        <span className="chip warn">à confirmer</span>
        <span className="chip bad">à vérifier</span>
      </div>

      <div className="loader">
        <span>Charger un autre résultat&nbsp;:</span>
        <input type="file" accept="application/json" onChange={onUpload} />
        {error && <span style={{ color: "var(--bad-fg)" }}>{error}</span>}
      </div>

      {data.length === 0 ? (
        <p className="missing">
          Aucune donnée. Lance le pipeline (<code>npm run extract</code>) pour générer
          <code> web/src/data/results.json</code>.
        </p>
      ) : (
        data.map((inv, i) => <InvoiceCard key={i} inv={inv} />)
      )}
    </div>
  );
}
