/**
 * App.tsx — Console de revue de factures (v4).
 *
 * DIRECTION : une console de revue de documents, dans l'esprit des outils spécialisés
 * d'extraction (Rossum, Azure Document Intelligence). L'écran relie trois choses :
 *   le champ extrait  ↔  sa fiabilité  ↔  son document source.
 *
 * STRUCTURE : maître-détail, sur une seule page (pas de routing, juste une sélection).
 *   - à gauche, la FILE DE REVUE : tous les documents, groupés « à vérifier » puis
 *     « validés ». On voit en un coup d'œil combien et lesquels demandent l'attention.
 *   - à droite, le DÉTAIL du document sélectionné : une feuille calme où seuls les
 *     champs douteux ressortent (teinte ambre + raison + confiance + source).
 *
 * RÈGLE D'OR : on signale l'exception. Un champ fiable n'a aucun ornement. Deux états
 * seulement : fiable (silencieux) / à vérifier.
 */
import { useMemo, useState, useRef, useEffect, type DragEvent, type ChangeEvent } from "react";
import type { ExtractionResult, Field, LineItem } from "./types";
import {
  extractFile, loadJson, deleteInvoice, originalFileUrl, originalFileExists,
  fetchInvoices, DuplicateError, saveInvoice,
} from "./api";
import results from "./data/results.json";

/* ------------------------------ Logique de statut ------------------------- */

/** Un champ est "à vérifier" dès qu'il n'est pas parfaitement fiable. */
function isFlagged<T>(f: Field<T>): boolean {
  return f.value === null || f.warning !== null || f.confidence !== "high";
}

/**
 * « Non mentionné sur la facture » : le modèle affirme (confiance élevée, aucun
 * avertissement) que l'information ne figure pas sur le document. C'est un cas NORMAL,
 * pas une anomalie — à ne pas confondre avec « présent mais illisible ».
 */
function isAbsent<T>(f: Field<T>): boolean {
  return f.value === null && f.warning === null && f.confidence === "high";
}

/**
 * Champ complémentaire (client, TVA, règlement, pénalités) : il n'est signalé que s'il
 * est réellement douteux. Absent du document, ou absent du JSON (ancienne extraction) :
 * on ne crie pas. Sans cette nuance, toutes les factures passeraient « à vérifier ».
 */
function isFlaggedOptional<T>(f: Field<T> | undefined): boolean {
  if (!f || isAbsent(f)) return false;
  return isFlagged(f);
}

/** Champs ESSENTIELS : leur absence est toujours un problème. */
function coreFields(inv: ExtractionResult): Field<string | number>[] {
  return [
    inv.supplier, inv.invoiceDate, inv.invoiceNumber, inv.totalHT, inv.totalTTC,
    ...inv.lineItems.flatMap((l: LineItem) => [l.designation, l.quantity, l.unitPrice]),
  ];
}

/** Champs COMPLÉMENTAIRES : peuvent légitimement ne pas figurer sur la facture. */
function extraFields(inv: ExtractionResult): (Field<string | number> | undefined)[] {
  return [inv.client, inv.totalTVA, inv.paymentMethod, inv.latePenalties];
}

/**
 * Une facture demande une attention humaine… sauf si un humain l'a justement validée.
 * C'est le sens du bouton « Valider » : la facture quitte « À vérifier » pour « Validées ».
 */
function needsAttention(inv: ExtractionResult): boolean {
  if (inv.review?.validated) return false;
  return (
    coreFields(inv).some(isFlagged) ||
    extraFields(inv).some(isFlaggedOptional) ||
    inv.warnings.length > 0
  );
}
function pointsToVerify(inv: ExtractionResult): number {
  return (
    coreFields(inv).filter(isFlagged).length +
    extraFields(inv).filter(isFlaggedOptional).length +
    inv.warnings.length
  );
}

/**
 * Un champ peut être parfaitement lu (confiance élevée) tout en étant impliqué dans un
 * CONTRÔLE DE COHÉRENCE (ex: « somme des lignes ≠ total HT »). Pour que le repérage soit
 * homogène — partout où il y a un problème, la donnée est surlignée — on déduit des
 * avertissements quels totaux sont concernés, afin de les marquer eux aussi.
 */
function coherenceFlags(inv: ExtractionResult): {
  totalHT: boolean; totalTVA: boolean; totalTTC: boolean;
} {
  const w = inv.warnings.join(" ").toLowerCase();
  return {
    totalHT: /total ht|somme des lignes/.test(w),
    totalTVA: /tva/.test(w),
    totalTTC: /total ttc/.test(w),
  };
}

/**
 * Une ligne se contredit-elle ? Compare le total IMPRIMÉ sur la facture au produit
 * quantité × prix unitaire.
 *
 * On ne propose AUCUNE correction : impossible de savoir lequel des trois chiffres est
 * faux (le prix ? la quantité ? le total ?). On signale le fait, l'humain tranche en
 * regardant le document. Ex. Botanica : « 4 × 95 € » affiché « 285 € ».
 */
function lineMismatch(l: LineItem): boolean {
  const q = l.quantity.value;
  const p = l.unitPrice.value;
  const printed = l.lineTotal?.value ?? null;
  if (q === null || p === null || printed === null) return false;
  return Math.abs(q * p - printed) > 0.02;
}

/* ------------------------- Correction manuelle d'un champ ----------------- */

/**
 * Un champ est désigné par un « chemin » : "totalHT", "client",
 * ou "lineItems.1.unitPrice" pour une cellule du tableau.
 */
type FieldPath = string;

/** Lit le champ situé à ce chemin (undefined si absent). */
function fieldAt(inv: ExtractionResult, path: FieldPath): Field<string | number> | undefined {
  const p = path.split(".");
  if (p[0] === "lineItems") {
    const line = inv.lineItems[Number(p[1])] as unknown as Record<string, Field<string | number>>;
    return line ? line[p[2]] : undefined;
  }
  return (inv as unknown as Record<string, Field<string | number> | undefined>)[p[0]];
}

/** Renvoie une COPIE de la facture avec le champ remplacé (jamais de mutation). */
function withFieldAt(
  inv: ExtractionResult,
  path: FieldPath,
  next: Field<string | number>
): ExtractionResult {
  const p = path.split(".");
  if (p[0] === "lineItems") {
    const idx = Number(p[1]);
    return {
      ...inv,
      lineItems: inv.lineItems.map((l, i) => (i === idx ? { ...l, [p[2]]: next } : l)),
    };
  }
  return { ...inv, [p[0]]: next };
}

/**
 * Lit un montant saisi à la française : « 1 200,50 » ou « 1200.50 » -> 1200.5.
 * Renvoie null si ce n'est pas un nombre exploitable (on refuse alors la correction).
 */
function parseAmount(text: string): number | null {
  const cleaned = text.replace(/[\s €]/g, "").replace(",", ".");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Applique une correction manuelle et journalise l'ancienne valeur (traçabilité).
 * Le champ corrigé devient fiable : confiance élevée, plus d'avertissement — c'est un
 * humain qui l'affirme, et la trace de ce que l'IA avait lu reste dans `review`.
 * Renvoie null si la saisie est invalide (montant non numérique, texte vide).
 */
function applyCorrection(
  inv: ExtractionResult,
  path: FieldPath,
  label: string,
  text: string,
  numeric: boolean
): ExtractionResult | null {
  const current = fieldAt(inv, path);
  if (!current) return null;

  const trimmed = text.trim();
  const value: string | number | null = numeric ? parseAmount(trimmed) : trimmed || null;
  if (value === null) return null; // saisie inexploitable : on ne fait rien

  const from = current.value === null ? null : String(current.value);
  if (from === String(value)) return null; // aucune modification réelle

  const updated = withFieldAt(inv, path, { value, confidence: "high", warning: null });
  const review = updated.review ?? { validated: false, validatedAt: null, corrections: [] };

  return {
    ...updated,
    review: {
      ...review,
      corrections: [
        ...review.corrections.filter((c) => c.path !== path), // une entrée par champ
        { path, label, from, to: String(value), at: new Date().toISOString() },
      ],
    },
  };
}

/** Chemins des champs corrigés à la main : ils restent modifiables et sont signalés. */
function correctedPaths(inv: ExtractionResult): Set<string> {
  return new Set((inv.review?.corrections ?? []).map((c) => c.path));
}

/* --------------------------------- Formats -------------------------------- */

function euros(n: number): string {
  return n.toLocaleString("fr-FR", { style: "currency", currency: "EUR" });
}

/* --------------------------------- Icônes --------------------------------- */

/** Petite icône "document" (traçabilité). Dessinée à la main, pas une tuile d'icône générique. */
function DocIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M4 1.5h5L13 5v9.5a.5.5 0 0 1-.5.5h-8a.5.5 0 0 1-.5-.5V2a.5.5 0 0 1 .5-.5Z"
        stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M9 1.5V5h4" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Animation de chargement pendant l'extraction. Thème "document AI" : une ligne balaie
 * le document (évoque l'OCR), sous une barre de progression indéterminée. Honnête : la
 * durée est inconnue (un seul apper serveur), donc pas de fausse progression chiffrée.
 * Respecte prefers-reduced-motion (voir CSS).
 */
function ScanLoader() {
  return (
    <div className="scan" aria-hidden>
      <svg width="46" height="46" viewBox="0 0 24 24" fill="none">
        <rect x="4" y="2.5" width="16" height="19" rx="2.5" stroke="currentColor" strokeWidth="1.4" />
        <path d="M8 8h8M8 12h8M8 16h5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
      <span className="scan-line" />
    </div>
  );
}

/** Icône "œil" — voir la facture originale à côté de l'extraction. */
function EyeIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z"
        stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

/** Icône "corbeille" — supprimer la facture. */
function TrashIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M2.5 4h11M6.5 4V2.8a.8.8 0 0 1 .8-.8h1.4a.8.8 0 0 1 .8.8V4M4.5 4l.6 9.2a1 1 0 0 0 1 .8h3.8a1 1 0 0 0 1-.8L11.5 4"
        stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6.7 6.8v4.4M9.3 6.8v4.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

/** Icône "fermer" (croix). */
function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/* ------------------------------- Détail ----------------------------------- */

/**
 * Petite icône d'avertissement (triangle). Seul repère visuel posé À CÔTÉ d'une donnée
 * douteuse. Aucun texte explicatif ici : l'explication vit dans « Alertes détectées ».
 */
function WarnIcon() {
  return (
    <svg className="warn-icon" width="13" height="13" viewBox="0 0 16 16" fill="none"
      role="img" aria-label="à vérifier">
      <path d="M8 2 15 14H1L8 2Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M8 6.4v3.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="8" cy="11.7" r=".75" fill="currentColor" />
    </svg>
  );
}

/**
 * Valeur corrigeable au clic. Au repos, l'affichage est normal (juste un soulignement
 * pointillé au survol) ; au clic, un champ de saisie prend sa place.
 *   Entrée (ou clic ailleurs) = enregistrer · Échap = annuler.
 * Rien n'est ajouté à l'écran tant qu'on ne clique pas : l'interface reste sobre.
 */
function Editable({
  editable, raw, numeric = false, onCommit, children,
}: {
  editable: boolean;
  /** Texte pré-rempli dans le champ de saisie. */
  raw: string;
  numeric?: boolean;
  onCommit: (text: string) => void;
  children: React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(raw);
  const cancelled = useRef(false);

  if (!editable) return <>{children}</>;

  if (!editing) {
    return (
      <button
        type="button"
        className="editable"
        title="Cliquer pour corriger"
        onClick={() => { setText(raw); cancelled.current = false; setEditing(true); }}
      >
        {children}
      </button>
    );
  }

  return (
    <input
      className={`edit-input ${numeric ? "num" : ""}`}
      autoFocus
      value={text}
      inputMode={numeric ? "decimal" : undefined}
      onChange={(e) => setText(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={() => {
        setEditing(false);
        if (cancelled.current) { cancelled.current = false; return; }
        if (text.trim() !== raw) onCommit(text);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") { cancelled.current = true; e.currentTarget.blur(); }
      }}
    />
  );
}

/**
 * Une ligne de champ (label | valeur). Si la donnée est douteuse : la VALEUR passe en
 * ambre + une icône ⚠, sans aucun texte en dessous (la ligne garde sa hauteur normale).
 */
function FieldRow({
  label, field, path, edit, corrected = false, optional = false, numeric = false,
  showIcon = true,
  format = (v: unknown) => String(v),
}: {
  /** false une fois la facture validée : on retire l'icône ⚠, on garde la couleur. */
  showIcon?: boolean;
  label: string;
  /** `undefined` = champ absent du JSON (extraction antérieure) -> la ligne n'apparaît pas. */
  field: Field<string | number> | undefined;
  path: FieldPath;
  /** Callback de correction ; absent = lecture seule (facture validée). */
  edit?: (path: FieldPath, label: string, text: string, numeric: boolean) => void;
  corrected?: boolean;
  /** true pour un champ complémentaire : « non mentionné » y est normal, donc neutre. */
  optional?: boolean;
  numeric?: boolean;
  format?: (v: string | number) => string;
}) {
  if (!field) return null;

  const flagged = optional ? isFlaggedOptional(field) : isFlagged(field);
  const absent = optional && isAbsent(field);
  // Modifiable si la donnée est douteuse, absente, ou déjà corrigée (droit à l'erreur).
  const editable = !!edit && (flagged || absent || corrected);
  const raw = field.value === null ? "" : String(field.value);

  const shown = absent
    ? <span className="f-absent">non mentionné</span>
    : field.value === null
      ? <span className="missing">non lisible</span>
      : <>{format(field.value)}</>;

  return (
    <div className="field-row">
      <div className="f-label">{label}</div>
      <div className={`f-value ${flagged ? "flagged" : ""}`}>
        <Editable
          editable={editable}
          raw={raw}
          numeric={numeric}
          onCommit={(t) => edit?.(path, label, t, numeric)}
        >
          {shown}
        </Editable>
        {flagged && showIcon && <WarnIcon />}
        {corrected && <CorrectedMark />}
      </div>
    </div>
  );
}

/** Petit repère « corrigé à la main » — la donnée ne vient plus de l'IA. */
function CorrectedMark() {
  return <span className="corrected-mark" title="Corrigé manuellement">modifié</span>;
}

/**
 * Une cellule de ligne produit. Douteuse : texte en ambre + icône ⚠, rien de plus.
 * Les lignes conservent ainsi une hauteur standard et fine.
 */
function Cell({
  field, path, label, edit, corrected = false, numeric = false, mismatch = false,
  alsoEditable = false, showIcon = true,
  format = (v: unknown) => String(v),
}: {
  /** false une fois la facture validée : on retire l'icône ⚠, on garde la couleur. */
  showIcon?: boolean;
  field: Field<string | number>;
  path: FieldPath;
  label: string;
  edit?: (path: FieldPath, label: string, text: string, numeric: boolean) => void;
  corrected?: boolean;
  numeric?: boolean;
  /**
   * Ce champ porte l'incohérence de la ligne (total imprimé ≠ quantité × prix).
   * Sur une facture, la quantité et le prix unitaire sont les données saisies ; le
   * total en est le résultat. C'est donc LUI qu'on signale, pas les trois cellules.
   */
  mismatch?: boolean;
  /**
   * Corrigeable sans être signalé : quantité et prix d'une ligne incohérente restent
   * modifiables (l'erreur peut venir de là), mais sans ⚠ ni couleur.
   */
  alsoEditable?: boolean;
  format?: (v: string | number) => string;
}) {
  const flagged = isFlagged(field) || mismatch;
  const editable = !!edit && (flagged || corrected || alsoEditable);
  const raw = field.value === null ? "" : String(field.value);
  return (
    <td className={numeric ? "num" : ""}>
      <Editable
        editable={editable}
        raw={raw}
        numeric={numeric}
        onCommit={(t) => edit?.(path, label, t, numeric)}
      >
        <span className={flagged ? "flagged" : ""}>
          {field.value === null ? <span className="missing">non lisible</span> : format(field.value)}
        </span>
      </Editable>
      {flagged && showIcon && <WarnIcon />}
      {corrected && <CorrectedMark />}
    </td>
  );
}

/**
 * Un total (HT ou TTC) mis en avant. Douteux : montant en ambre + icône ⚠, sans texte
 * en dessous. C'est le SEUL endroit où les totaux apparaissent (pas de répétition).
 */
function TotalItem({
  label, field, path, edit, corrected = false,
  grand = false, alsoFlagged = false, optional = false, showIcon = true,
}: {
  /** false une fois la facture validée : on retire l'icône ⚠, on garde la couleur. */
  showIcon?: boolean;
  label: string;
  /** `undefined` = absent du JSON (extraction antérieure) -> non affiché. */
  field: Field<number> | undefined;
  path: FieldPath;
  edit?: (path: FieldPath, label: string, text: string, numeric: boolean) => void;
  corrected?: boolean;
  grand?: boolean;
  /** true si un contrôle de cohérence implique ce total (même si la lecture est fiable). */
  alsoFlagged?: boolean;
  /** true pour un montant complémentaire (TVA) : « non mentionné » y est normal. */
  optional?: boolean;
}) {
  if (!field) return null;

  const absent = optional && isAbsent(field);
  const flagged = !absent && ((optional ? isFlaggedOptional(field) : isFlagged(field)) || alsoFlagged);
  const editable = !!edit && (flagged || absent || corrected);
  const raw = field.value === null ? "" : String(field.value);

  return (
    <div className={`total-cell ${grand ? "grand" : ""}`}>
      <div className="t-label">{label}</div>
      <div className={`t-value ${flagged ? "flagged" : ""}`}>
        <Editable editable={editable} raw={raw} numeric onCommit={(t) => edit?.(path, label, t, true)}>
          {field.value === null
            ? <span className={absent ? "f-absent" : ""}>{absent ? "non mentionnée" : "—"}</span>
            : <>{euros(field.value)}</>}
        </Editable>
        {flagged && showIcon && <WarnIcon />}
      </div>
      {corrected && <CorrectedMark />}
    </div>
  );
}

/* ----------------------- Panneau de diagnostic (alertes) ------------------ */

/** Une alerte = l'endroit concerné + le texte d'explication. */
type Alert = { where: string; message: string };

/** Tronque un libellé long (ex: une désignation) pour le référencer proprement. */
function short(text: string, max = 42): string {
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

/**
 * Rassemble TOUS les textes d'explication d'une facture au même endroit :
 * avertissements de champs (en-tête + lignes) et contrôles de cohérence.
 */
function collectAlerts(inv: ExtractionResult): Alert[] {
  const out: Alert[] = [];

  // Champs d'en-tête : essentiels puis complémentaires. Chaque champ marqué en ambre
  // doit avoir SON explication ici — sinon l'utilisateur voit une alerte sans la cause.
  const header: [string, Field<string | number> | undefined, boolean][] = [
    ["Fournisseur", inv.supplier, false],
    ["Client", inv.client, true],
    ["Date", inv.invoiceDate, false],
    ["Numéro de facture", inv.invoiceNumber, false],
    ["Total HT", inv.totalHT, false],
    ["TVA", inv.totalTVA, true],
    ["Total TTC", inv.totalTTC, false],
    ["Mode de règlement", inv.paymentMethod, true],
    ["Pénalités de retard", inv.latePenalties, true],
  ];
  for (const [label, f, optional] of header) {
    if (!f) continue;
    if (!(optional ? isFlaggedOptional(f) : isFlagged(f))) continue;
    out.push({
      where: label,
      message:
        f.warning ??
        (f.value === null
          ? "information non lisible sur le document."
          : "lecture incertaine, à confirmer sur la facture."),
    });
  }

  inv.lineItems.forEach((l, i) => {
    const ref = l.designation.value ? `Ligne « ${short(l.designation.value)} »` : `Ligne ${i + 1}`;
    for (const [, f] of [["désignation", l.designation], ["quantité", l.quantity], ["prix unitaire", l.unitPrice]] as const) {
      if (f.warning) out.push({ where: ref, message: f.warning });
    }
  });

  // Les contrôles de cohérence (calculés par le pipeline) : erreurs de ligne, écart de
  // total HT, et répercussion sur la TVA / le TTC. Ils décrivent des FAITS constatés.
  for (const w of inv.warnings) out.push({ where: "Cohérence", message: w });

  return out;
}

/** L'encart « Alertes détectées » : une liste à puces simple et claire. */
function AlertsPanel({ alerts }: { alerts: Alert[] }) {
  if (alerts.length === 0) return null;
  return (
    <section className="alerts" aria-label="Alertes détectées">
      <div className="alerts-head">
        <WarnIcon />
        <span className="alerts-title">Alertes détectées</span>
        <span className="alerts-count">{alerts.length}</span>
      </div>
      <ul className="alerts-list">
        {alerts.map((a, i) => (
          <li key={i}>
            <span className="alerts-where">{a.where}</span> — {a.message}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Détails techniques repliés (méta d'exécution) — hors du bruit permanent. */
function TechnicalDetails({ inv }: { inv: ExtractionResult }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="tech">
      <button className="tech-toggle" onClick={() => setOpen((v) => !v)}>
        {open ? "▾" : "▸"} Détails techniques
      </button>
      {open && (
        <div className="tech-body">
          Extrait le {new Date(inv.meta.extractedAt).toLocaleString("fr-FR")}<br />
          OCR {inv.meta.ocrModel} · extraction {inv.meta.extractionModel} · {inv.meta.ocrCharCount} caractères lus

          {/* Journal des corrections : ce que l'IA avait lu, ce qui a été saisi à la main. */}
          {(inv.review?.corrections.length ?? 0) > 0 && (
            <div className="corr-log">
              <div className="corr-log-title">Corrections manuelles</div>
              <ul>
                {inv.review!.corrections.map((c, i) => (
                  <li key={i}>
                    {c.label} : <s>{c.from ?? "non lu"}</s> → <b>{c.to}</b>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** La feuille de détail d'un document sélectionné. */
function InvoiceDetail({
  inv, onBack, docOpen, onToggleDoc, onDelete, onEdit, onValidate, saving,
}: {
  inv: ExtractionResult;
  onBack: () => void;
  /** true si la facture originale est affichée à côté. */
  docOpen: boolean;
  onToggleDoc: () => void;
  onDelete: () => void;
  onEdit: (path: FieldPath, label: string, text: string, numeric: boolean) => void;
  onValidate: (validated: boolean) => void;
  saving: boolean;
}) {
  const attention = needsAttention(inv);
  const count = pointsToVerify(inv);
  const src = inv.sourceDocument;
  const coh = coherenceFlags(inv); // totaux impliqués par un contrôle de cohérence
  const corrected = correctedPaths(inv);
  const validated = inv.review?.validated ?? false;
  // Une facture validée passe en lecture seule : on annule la validation pour la reprendre.
  const edit = validated ? undefined : onEdit;

  return (
    // `is-validated` fait basculer les repères ambre vers une teinte « revue »
    // (voir index.css) : plus d'alerte, mais la mémoire des points contrôlés.
    <div className={`detail-inner ${validated ? "is-validated" : ""}`}>
      <button className="back-btn" onClick={onBack}>← Retour à la liste</button>

      <header className="doc-head">
        <div className="doc-id">
          <h1 className="doc-supplier" title={inv.supplier.value ?? undefined}>
            {inv.supplier.value ?? <span className="missing">Fournisseur non lisible</span>}
          </h1>
          <div className="doc-meta">
            {inv.invoiceNumber.value ? <>Facture <b>{inv.invoiceNumber.value}</b></> : "Numéro non lisible"}
            {" · "}
            {inv.invoiceDate.value ?? "date non lisible"}
          </div>
          <div className="doc-tags">
            <span className="source-tag" title={src}>
              <DocIcon /> <span className="fname">{src}</span>
            </span>
            {attention ? (
              <span className="verdict attn">{count} point{count > 1 ? "s" : ""} à vérifier</span>
            ) : (
              <span className="verdict ok">✓ Extraction fiable</span>
            )}
          </div>
        </div>

        {/* Actions sur le document : voir l'original côte à côte, supprimer. */}
        <div className="doc-actions">
          <button
            className={`icon-btn ${docOpen ? "active" : ""}`}
            title="Voir la facture originale"
            aria-label="Voir la facture originale"
            aria-pressed={docOpen}
            onClick={onToggleDoc}
          >
            <EyeIcon />
          </button>
          <button
            className="icon-btn danger"
            title="Supprimer cette facture"
            aria-label="Supprimer cette facture"
            onClick={onDelete}
          >
            <TrashIcon />
          </button>
        </div>
      </header>

      <div className="section-label">Informations</div>
      <div className="field-list">
        <FieldRow showIcon={!validated} label="Numéro de facture" field={inv.invoiceNumber} path="invoiceNumber"
          edit={edit} corrected={corrected.has("invoiceNumber")} />
        <FieldRow showIcon={!validated} label="Date" field={inv.invoiceDate} path="invoiceDate"
          edit={edit} corrected={corrected.has("invoiceDate")} />
        <FieldRow showIcon={!validated} label="Facturé à" field={inv.client} path="client" optional
          edit={edit} corrected={corrected.has("client")} />
        <FieldRow showIcon={!validated} label="Mode de règlement" field={inv.paymentMethod} path="paymentMethod" optional
          edit={edit} corrected={corrected.has("paymentMethod")} />
        <FieldRow showIcon={!validated} label="Pénalités de retard" field={inv.latePenalties} path="latePenalties" optional
          edit={edit} corrected={corrected.has("latePenalties")} />
      </div>

      <div className="section-label">Lignes de produits</div>
      <div className="lines-wrap">
        <table className="lines">
          <thead>
            <tr>
              <th>Désignation</th>
              <th className="num">Qté</th>
              <th className="num">Prix unitaire</th>
              <th className="num">Total</th>
            </tr>
          </thead>
          <tbody>
            {inv.lineItems.length === 0 ? (
              <tr><td colSpan={4} className="missing">Aucune ligne lue de façon fiable.</td></tr>
            ) : (
              inv.lineItems.map((l, i) => {
                // Ligne dont le total imprimé contredit quantité × prix : les trois
                // cellules deviennent corrigeables, car on ignore laquelle est fausse.
                const mismatch = lineMismatch(l);
                return (
                  <tr key={i}>
                    <Cell showIcon={!validated} field={l.designation} path={`lineItems.${i}.designation`}
                      label={`Ligne ${i + 1} — désignation`} edit={edit}
                      corrected={corrected.has(`lineItems.${i}.designation`)} />
                    {/* Quantité et prix : données saisies sur la facture. Corrigeables
                        si la ligne est incohérente, mais non signalées. */}
                    <Cell showIcon={!validated} field={l.quantity} numeric path={`lineItems.${i}.quantity`}
                      label={`Ligne ${i + 1} — quantité`} edit={edit} alsoEditable={mismatch}
                      corrected={corrected.has(`lineItems.${i}.quantity`)} />
                    <Cell showIcon={!validated} field={l.unitPrice} numeric format={(v) => euros(v as number)}
                      path={`lineItems.${i}.unitPrice`} label={`Ligne ${i + 1} — prix unitaire`}
                      edit={edit} alsoEditable={mismatch}
                      corrected={corrected.has(`lineItems.${i}.unitPrice`)} />
                    {/* Total TEL QU'IMPRIMÉ sur la facture — jamais recalculé. */}
                    {l.lineTotal ? (
                      <Cell showIcon={!validated} field={l.lineTotal} numeric format={(v) => euros(v as number)}
                        path={`lineItems.${i}.lineTotal`} label={`Ligne ${i + 1} — total`}
                        edit={edit} mismatch={mismatch}
                        corrected={corrected.has(`lineItems.${i}.lineTotal`)} />
                    ) : (
                      <td className="num"><span className="f-absent">—</span></td>
                    )}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="section-label">Montants</div>
      <div className="totals">
        <TotalItem showIcon={!validated} label="Total HT" field={inv.totalHT} path="totalHT" alsoFlagged={coh.totalHT}
          edit={edit} corrected={corrected.has("totalHT")} />
        <TotalItem showIcon={!validated} label="TVA" field={inv.totalTVA} path="totalTVA" optional alsoFlagged={coh.totalTVA}
          edit={edit} corrected={corrected.has("totalTVA")} />
        <TotalItem showIcon={!validated} label="Total TTC" field={inv.totalTTC} path="totalTTC" grand alsoFlagged={coh.totalTTC}
          edit={edit} corrected={corrected.has("totalTTC")} />
      </div>

      {/* Panneau de diagnostic. Une fois la facture validée, il disparaît : l'humain a
          tranché, les explications n'ont plus lieu d'être. Les repères ambre sur les
          valeurs, eux, restent — ils rappellent d'où venaient les doutes. */}
      {!validated && <AlertsPanel alerts={collectAlerts(inv)} />}

      {/* Barre de revue : l'action finale du parcours « je contrôle puis je valide ». */}
      <div className={`review-bar ${validated ? "done" : ""}`}>
        {validated ? (
          <>
            <span className="review-state">
              ✓ Validée{inv.review?.validatedAt
                ? ` le ${new Date(inv.review.validatedAt).toLocaleDateString("fr-FR")}`
                : ""}
            </span>
            <button className="btn btn-ghost" disabled={saving} onClick={() => onValidate(false)}>
              Reprendre la vérification
            </button>
          </>
        ) : (
          <>
            <span className="review-hint">
              {attention
                ? `${count} point${count > 1 ? "s" : ""} à vérifier — corrigez les valeurs en ambre, puis validez.`
                : "Aucune anomalie détectée."}
            </span>
            <button className="btn btn-primary" disabled={saving} onClick={() => onValidate(true)}>
              {saving ? "Enregistrement…" : "Valider la facture"}
            </button>
          </>
        )}
      </div>

      {/* Détails techniques : tout en bas, après l'action de validation. */}
      <TechnicalDetails inv={inv} />
    </div>
  );
}

/* --------------------------- File de revue (gauche) ----------------------- */

function QueueItem({
  inv, selected, onSelect,
}: {
  inv: ExtractionResult;
  selected: boolean;
  onSelect: () => void;
}) {
  const attention = needsAttention(inv);
  const count = pointsToVerify(inv);
  const name = inv.supplier.value ?? "Fournisseur non lisible";
  return (
    <button
      className={`qitem ${selected ? "selected" : ""}`}
      onClick={onSelect}
      aria-current={selected || undefined}
    >
      {/* Monogramme (initiale du fournisseur) — repère de balayage visuel. */}
      <span className="qitem-avatar" aria-hidden>{name.trim().charAt(0).toUpperCase() || "?"}</span>
      <span className="qitem-text">
        <span className="qitem-name" title={name}>{name}</span>
        <span className="qitem-sub">{inv.sourceDocument}</span>
      </span>
      {attention
        ? <span className="q-attn">{count}</span>
        : <span className="q-ok" title="Validé">✓</span>}
    </button>
  );
}

/* ------------------------------- Zone de dépôt ---------------------------- */

/** État d'un fichier dans un lot d'extraction. */
type ItemStatus = "pending" | "running" | "done" | "duplicate" | "error";
type BatchItem = { name: string; status: ItemStatus; message?: string };

const statusLabel: Record<ItemStatus, string> = {
  pending: "en attente",
  running: "analyse…",
  done: "terminé",
  duplicate: "déjà analysée",
  error: "échec",
};

/** Pastille d'état d'une ligne du lot (animée seulement pour le fichier en cours). */
function ItemDot({ status }: { status: ItemStatus }) {
  if (status === "done") {
    return (
      <svg className="bi-dot done" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
        <path className="check-path" d="M3.5 8.5 6.5 11.5 12.5 5" stroke="currentColor"
          strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (status === "duplicate") {
    return (
      <svg className="bi-dot dup" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
        <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.4" />
        <path d="M8 4.8v3.6M8 10.9v.1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  }
  if (status === "error") return <span className="bi-dot err" aria-hidden>⚠</span>;
  if (status === "running") return <span className="bi-dot run" aria-hidden />;
  return <span className="bi-dot wait" aria-hidden />;
}

/**
 * Zone de dépôt. `variant`:
 *   - "hero"  : plein écran quand aucune donnée ;
 *   - "modal" : fenêtre déclenchée par le bouton "Ajouter".
 *
 * Accepte PLUSIEURS fichiers à la fois (PDF / images → serveur d'extraction) ainsi qu'un
 * JSON déjà extrait. Les documents sont traités l'un après l'autre (on ne sature pas
 * l'API) avec un suivi visuel par fichier ; un doublon est signalé, pas ré-extrait.
 */
function Uploader({
  variant, onClose, onBatchDone, onLoadedJson,
}: {
  variant: "hero" | "modal";
  onClose?: () => void;
  onBatchDone: (extracted: ExtractionResult[]) => void;
  onLoadedJson: (list: ExtractionResult[]) => void;
}) {
  const [batch, setBatch] = useState<BatchItem[] | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  /** Traite une sélection : le JSON prend le pas, sinon on lance le lot de documents. */
  async function handleFiles(files: File[]) {
    if (files.length === 0) return;
    setError(null);

    // Un JSON déjà extrait remplace le jeu de données : cas isolé, pas un lot.
    const json = files.find((f) => f.name.toLowerCase().endsWith(".json"));
    if (json) {
      try {
        onLoadedJson(await loadJson(json));
        onClose?.();
      } catch (err) {
        setError((err as Error).message);
      }
      return;
    }

    const items: BatchItem[] = files.map((f) => ({ name: f.name, status: "pending" }));
    setBatch(items);
    setRunning(true);

    const extracted: ExtractionResult[] = [];
    for (let i = 0; i < files.length; i++) {
      setBatch((b) => b && b.map((it, k) => (k === i ? { ...it, status: "running" } : it)));
      try {
        extracted.push(await extractFile(files[i]));
        setBatch((b) => b && b.map((it, k) => (k === i ? { ...it, status: "done" } : it)));
      } catch (err) {
        const dup = err instanceof DuplicateError;
        setBatch((b) => b && b.map((it, k) => (k === i
          ? { ...it, status: dup ? "duplicate" : "error", message: dup ? undefined : (err as Error).message }
          : it)));
      }
    }

    setRunning(false);
    await onBatchDone(extracted);

    // Tout s'est bien passé : on referme. Sinon on laisse le récapitulatif à l'écran.
    const clean = items.length === extracted.length;
    if (clean) { setBatch(null); onClose?.(); }
  }

  function onInputChange(e: ChangeEvent<HTMLInputElement>) {
    handleFiles(Array.from(e.target.files ?? []));
    e.target.value = "";
  }
  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    handleFiles(Array.from(e.dataTransfer.files ?? []));
  }

  // Vue « lot » : remplace la zone de dépôt pendant et après le traitement.
  if (batch) {
    const finished = batch.filter((b) => b.status !== "pending" && b.status !== "running").length;
    const pct = Math.round((finished / batch.length) * 100);
    const nDup = batch.filter((b) => b.status === "duplicate").length;
    const nErr = batch.filter((b) => b.status === "error").length;

    // UN SEUL fichier : on garde l'animation de scan du document (durée inconnue).
    // Le traitement par lot, lui, a sa propre animation de file d'attente (plus bas).
    if (batch.length === 1) {
      const it = batch[0];
      const single = (
        <div className={`dropzone ${variant} busy`} role="status" aria-live="polite">
          {running ? (
            <>
              <ScanLoader />
              <div className="dz-title">Extraction en cours…</div>
              <div className="dz-sub">{it.name}</div>
              <div className="progress" aria-hidden><span /></div>
              <div className="dz-hint">Lecture OCR puis analyse — quelques secondes.</div>
            </>
          ) : (
            <>
              <div className="dz-title">
                {it.status === "duplicate" ? "Facture déjà analysée" : "Extraction impossible"}
              </div>
              <div className="dz-sub">{it.name}</div>
              {it.status === "duplicate" ? (
                <div className="dz-hint">
                  Un document du même nom figure déjà dans la liste — il n'a pas été ré-analysé.
                </div>
              ) : (
                <div className="dz-error">⚠ {it.message}</div>
              )}
              <button className="btn btn-ghost dz-cancel" onClick={() => { setBatch(null); onClose?.(); }}>
                Fermer
              </button>
            </>
          )}
        </div>
      );
      if (variant === "hero") return single;
      return <div className="uploader-backdrop"><div>{single}</div></div>;
    }

    const panel = (
      <div className="batch" role="status" aria-live="polite">
        <div className="batch-head">
          <span className="batch-title">
            {running ? "Analyse des factures…" : "Analyse terminée"}
          </span>
          <span className="batch-count">{finished} / {batch.length}</span>
        </div>

        {/* Progression déterminée : on connaît le nombre de fichiers. */}
        <div className="batch-bar" aria-hidden>
          <span style={{ transform: `scaleX(${pct / 100})` }} />
        </div>

        <ul className="batch-list">
          {batch.map((it, i) => (
            <li
              key={i}
              className={`batch-row ${it.status}`}
              style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}
            >
              <ItemDot status={it.status} />
              <span className="bi-name" title={it.name}>{it.name}</span>
              <span className="bi-state">{it.message ?? statusLabel[it.status]}</span>
            </li>
          ))}
        </ul>

        {!running && (nDup > 0 || nErr > 0) && (
          <div className="batch-foot">
            <span className="batch-note">
              {nDup > 0 && `${nDup} déjà analysée${nDup > 1 ? "s" : ""} (ignorée${nDup > 1 ? "s" : ""})`}
              {nDup > 0 && nErr > 0 && " · "}
              {nErr > 0 && `${nErr} en échec`}
            </span>
            <button className="btn btn-ghost" onClick={() => { setBatch(null); onClose?.(); }}>
              Fermer
            </button>
          </div>
        )}
      </div>
    );

    if (variant === "hero") return panel;
    return <div className="uploader-backdrop"><div>{panel}</div></div>;
  }

  const zone = (
    <div
      className={`dropzone ${variant} ${dragOver ? "over" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
      onClick={() => inputRef.current?.click()}
      role="button" tabIndex={0}
    >
      <input
        ref={inputRef} type="file" hidden multiple onChange={onInputChange}
        accept=".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/*,application/json"
      />
      <div className="dz-icon" aria-hidden>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
          <path d="M12 16V4m0 0 4 4m-4-4-4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </div>
      <div className="dz-title">Déposez vos factures</div>
      <div className="dz-sub">
        PDF ou scan (JPG, PNG) · plusieurs fichiers acceptés<br />
        <span style={{ color: "var(--faint)" }}>un JSON déjà extrait est aussi accepté</span>
      </div>
      {error && <div className="dz-error" onClick={(e) => e.stopPropagation()}>⚠ {error}</div>}
      {variant === "modal" && (
        <button className="btn btn-ghost dz-cancel" onClick={(e) => { e.stopPropagation(); onClose?.(); }}>
          Annuler
        </button>
      )}
    </div>
  );

  if (variant === "hero") return zone;
  // En modale : fond assombri, clic à l'extérieur = fermer.
  return (
    <div className="uploader-backdrop" onClick={() => onClose?.()}>
      <div onClick={(e) => e.stopPropagation()}>{zone}</div>
    </div>
  );
}

/* ---------------------------------- Page ---------------------------------- */

/** Choisit le document à afficher par défaut : le premier à vérifier, sinon le premier. */
function pickDefault(list: ExtractionResult[]): ExtractionResult | null {
  return list.find(needsAttention) ?? list[0] ?? null;
}

export default function App() {
  const initial = results as unknown as ExtractionResult[];
  const [data, setData] = useState<ExtractionResult[]>(initial);
  const [selected, setSelected] = useState<ExtractionResult | null>(() => pickDefault(initial));
  // true tant qu'on n'a pas interrogé le serveur : évite d'afficher l'écran « déposez une
  // facture » une fraction de seconde alors que des factures existent sur le disque.
  const [booting, setBooting] = useState(true);
  const [saving, setSaving] = useState(false); // enregistrement d'une correction en cours
  const [showUploader, setShowUploader] = useState(false);
  const [showDetail, setShowDetail] = useState(false); // vue mobile : file OU détail
  const [docOpen, setDocOpen] = useState(false); // facture originale affichée à côté
  // null = vérification en cours ; false = fichier absent de pipeline/invoices/.
  const [docAvailable, setDocAvailable] = useState<boolean | null>(null);

  /**
   * Recharge la liste depuis le serveur (source de vérité : le dossier output/).
   * `keepName` permet de re-sélectionner la même facture après un rafraîchissement.
   */
  async function refresh(keepName?: string) {
    const list = await fetchInvoices();
    if (!list) return false; // serveur injoignable : on garde l'affichage courant
    setData(list);
    setSelected((prev) => {
      const wanted = keepName ?? prev?.sourceDocument;
      return list.find((x) => x.sourceDocument === wanted) ?? pickDefault(list);
    });
    return true;
  }

  // AU DÉMARRAGE : on lit les factures réellement présentes sur le disque. C'est ce qui
  // les rend persistantes — une facture déposée reste là après un rechargement de page,
  // tant qu'elle n'a pas été supprimée. Si le serveur ne répond pas (démo sans pipeline),
  // on garde le jeu de données embarqué (results.json).
  useEffect(() => {
    let cancelled = false;
    fetchInvoices().then((list) => {
      if (cancelled) return;
      if (list) {
        setData(list);
        setSelected(pickDefault(list));
      }
      setBooting(false);
    });
    return () => { cancelled = true; };
  }, []);

  // À l'ouverture du visualiseur (ou au changement de facture), on vérifie que le
  // fichier original est encore présent sur le disque avant de tenter de l'afficher.
  useEffect(() => {
    if (!docOpen || !selected) return;
    setDocAvailable(null);
    let cancelled = false;
    originalFileExists(selected.sourceDocument).then((ok) => {
      if (!cancelled) setDocAvailable(ok);
    });
    return () => { cancelled = true; };
  }, [docOpen, selected]);

  // Filtre (segmented control) + recherche de la barre d'application.
  const [filter, setFilter] = useState<"all" | "attn" | "ok">("all");
  const [query, setQuery] = useState("");

  // Une facture correspond-elle à la recherche (fournisseur, numéro, fichier) ?
  const matches = (inv: ExtractionResult) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return [inv.supplier.value, inv.invoiceNumber.value, inv.sourceDocument]
      .some((v) => (v ?? "").toLowerCase().includes(q));
  };
  // Visible = passe la recherche ET le filtre choisi.
  const visible = (inv: ExtractionResult) =>
    matches(inv) && (filter === "all" || (filter === "attn") === needsAttention(inv));

  // Groupes de la file : à vérifier d'abord, validés ensuite (après filtre/recherche).
  const { attention, validated } = useMemo(() => ({
    attention: data.filter((inv) => needsAttention(inv) && visible(inv)),
    validated: data.filter((inv) => !needsAttention(inv) && visible(inv)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [data, filter, query]);

  function select(inv: ExtractionResult) {
    setSelected(inv);
    setShowDetail(true); // sur mobile, on bascule vers le détail
  }
  /**
   * Fin d'un lot d'extractions : on relit la liste depuis le serveur (plus fiable que
   * de bricoler la liste en mémoire) et on sélectionne la première facture traitée.
   */
  async function handleBatchDone(extracted: ExtractionResult[]) {
    const ok = await refresh(extracted[0]?.sourceDocument);
    if (!ok && extracted.length > 0) {
      // Serveur devenu injoignable : on ajoute au moins ce qu'on a obtenu.
      setData((prev) => [...extracted, ...prev]);
      setSelected(extracted[0]);
    }
  }

  function handleLoadedJson(list: ExtractionResult[]) {
    setData(list);
    setSelected(pickDefault(list));
    setShowUploader(false);
  }

  /**
   * Enregistre une version modifiée de la facture sélectionnée. Le serveur relance les
   * contrôles de cohérence et renvoie la version à jour (une alerte peut disparaître).
   */
  async function persist(next: ExtractionResult) {
    setSaving(true);
    try {
      const saved = await saveInvoice(next);
      setData((prev) => prev.map((x) => (x.sourceDocument === saved.sourceDocument ? saved : x)));
      setSelected(saved);
    } catch (err) {
      window.alert((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  /** Correction manuelle d'un champ : appliquée puis enregistrée immédiatement. */
  function handleEdit(path: FieldPath, label: string, text: string, numeric: boolean) {
    if (!selected) return;
    const next = applyCorrection(selected, path, label, text, numeric);
    if (!next) return; // saisie invalide ou valeur inchangée : on ne fait rien
    persist(next);
  }

  /** Validation (ou reprise) de la facture : c'est ce qui la fait changer de groupe. */
  function handleValidate(validated: boolean) {
    if (!selected) return;
    const review = selected.review ?? { validated: false, validatedAt: null, corrections: [] };
    persist({
      ...selected,
      review: { ...review, validated, validatedAt: validated ? new Date().toISOString() : null },
    });
  }

  /**
   * Suppression d'une facture : confirmation, puis le serveur la retire partout
   * (fichier original, extraction, données par défaut) et on met la liste à jour.
   */
  async function handleDelete() {
    if (!selected) return;
    const name = selected.sourceDocument;
    const okToDelete = window.confirm(
      `Supprimer la facture « ${name} » ?\n` +
      `Le fichier original et son extraction seront retirés définitivement.`
    );
    if (!okToDelete) return;

    try {
      await deleteInvoice(name);
    } catch (err) {
      window.alert((err as Error).message);
      return;
    }
    setDocOpen(false);
    // On relit la liste depuis le disque : la suppression est définitive et persistante.
    const ok = await refresh();
    if (!ok) {
      setData((prev) => {
        const next = prev.filter((x) => x !== selected);
        setSelected(pickDefault(next));
        return next;
      });
    }
  }

  // Verdict global affiché dans la barre (sur TOUTES les factures, hors filtre/recherche).
  const nAttn = data.filter(needsAttention).length;

  // Démarrage : on interroge le serveur avant de conclure quoi que ce soit. Sans ce
  // garde-fou, l'écran « déposez une facture » clignoterait alors que des factures
  // existent bel et bien sur le disque.
  if (booting && data.length === 0) {
    return (
      <div className="app">
        <div className="empty-screen"><div className="empty-inner boot">Chargement…</div></div>
      </div>
    );
  }

  // État vide : le dépôt occupe tout l'écran.
  if (data.length === 0) {
    return (
      <div className="app">
        <div className="empty-screen">
          <div className="empty-inner">
            <h1>Revue de factures</h1>
            <p>Déposez vos factures, l'IA en extrait les données et vous montre quoi vérifier.</p>
            <Uploader variant="hero" onBatchDone={handleBatchDone} onLoadedJson={handleLoadedJson} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      {/* Barre d'application : identité, filtre, recherche, verdict, ajout. */}
      <div className="topbar">
        <div className="brand">
          <span className="brand-mark">J</span>
          <span className="brand-name">Revue de factures</span>
        </div>

        {/* Segmented control : filtre la file (Tous / À vérifier / Validées). */}
        <div className="seg" role="group" aria-label="Filtrer les documents">
          {([
            ["all", "Tous", data.length],
            ["attn", "À vérifier", data.filter(needsAttention).length],
            ["ok", "Validées", data.filter((d) => !needsAttention(d)).length],
          ] as const).map(([key, label, count]) => (
            <button
              key={key}
              aria-pressed={filter === key}
              onClick={() => setFilter(key)}
            >
              {label}<span className="seg-count">{count}</span>
            </button>
          ))}
        </div>

        {/* Recherche : fournisseur, numéro de facture ou nom de fichier. */}
        <label className="search">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
            <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.4" />
            <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          <input
            type="search"
            placeholder="Rechercher un fournisseur, un numéro…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Rechercher"
          />
        </label>

        <div className="topbar-spacer" />

        <div className="topbar-summary">
          {nAttn > 0
            ? <span className="attn-word">{nAttn} à vérifier</span>
            : <span className="ok-word">tout est validé ✓</span>}
        </div>

        <button className="btn btn-primary" onClick={() => setShowUploader(true)}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path d="M12 16V4m0 0 4 4m-4-4-4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          Ajouter
        </button>
      </div>

      <div className={`console ${showDetail ? "show-detail" : ""}`}>
        {/* File de revue */}
        <nav className="queue" aria-label="Documents à revoir">
          {attention.length > 0 && (
            <>
              <div className="queue-group attn">À vérifier · {attention.length}</div>
              {attention.map((inv, i) => (
                <QueueItem key={`a${i}`} inv={inv} selected={inv === selected} onSelect={() => select(inv)} />
              ))}
            </>
          )}
          {validated.length > 0 && (
            <>
              <div className="queue-group">Validées · {validated.length}</div>
              {validated.map((inv, i) => (
                <QueueItem key={`v${i}`} inv={inv} selected={inv === selected} onSelect={() => select(inv)} />
              ))}
            </>
          )}
        </nav>

        {/* Détail */}
        <main className="detail">
          {selected && (
            <InvoiceDetail
              inv={selected}
              onBack={() => setShowDetail(false)}
              docOpen={docOpen}
              onToggleDoc={() => setDocOpen((v) => !v)}
              onDelete={handleDelete}
              onEdit={handleEdit}
              onValidate={handleValidate}
              saving={saving}
            />
          )}
        </main>

        {/* Facture originale, côte à côte avec l'extraction. */}
        {docOpen && selected && (
          <aside className="doc-view" aria-label="Facture originale">
            <div className="doc-view-head">
              <span className="doc-view-name" title={selected.sourceDocument}>
                <DocIcon /> <span className="fname">{selected.sourceDocument}</span>
              </span>
              <button className="icon-btn" title="Fermer" aria-label="Fermer l'aperçu" onClick={() => setDocOpen(false)}>
                <CloseIcon />
              </button>
            </div>
            {docAvailable === false ? (
              <div className="doc-view-missing">
                Document original introuvable — le fichier n'est plus dans
                <code> pipeline/invoices/</code>.
              </div>
            ) : docAvailable === true ? (
              <iframe
                className="doc-frame"
                src={originalFileUrl(selected.sourceDocument)}
                title={`Facture originale — ${selected.sourceDocument}`}
              />
            ) : (
              <div className="doc-view-missing">Chargement…</div>
            )}
          </aside>
        )}
      </div>

      {showUploader && (
        <Uploader
          variant="modal"
          onClose={() => setShowUploader(false)}
          onBatchDone={handleBatchDone}
          onLoadedJson={handleLoadedJson}
        />
      )}
    </div>
  );
}
