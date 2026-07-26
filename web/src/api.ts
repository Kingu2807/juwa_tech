/**
 * api.ts — Helpers de chargement des données pour l'interface.
 *
 * Deux façons d'obtenir des factures dans la page :
 *   1) extractFile : on envoie un fichier PDF/image au serveur d'extraction, qui lance
 *      le pipeline (OCR -> LLM -> validation) et renvoie le résultat. C'est le flux
 *      principal pour un salarié : il dépose sa facture, il obtient les données.
 *   2) loadJson : on relit un JSON déjà produit par le pipeline (pratique pour rejouer
 *      un résultat sans relancer l'extraction).
 *
 * Ce fichier ne contient AUCUNE logique d'affichage : juste des appels réseau / lecture
 * de fichier, avec des messages d'erreur lisibles.
 */
import type { ExtractionResult } from "./types";

/**
 * Erreur « facture déjà analysée » : le serveur a refusé l'extraction (code 409) parce
 * qu'un document du même nom existe déjà. On l'expose comme un type à part pour que
 * l'interface l'affiche comme une information, pas comme un échec.
 */
export class DuplicateError extends Error {
  readonly duplicate = true;
  constructor(message: string) {
    super(message);
    this.name = "DuplicateError";
  }
}

/**
 * Liste les factures déjà analysées, telles qu'elles existent sur le disque du serveur.
 * Appelée à l'ouverture de la page : c'est ce qui rend les factures persistantes.
 * Renvoie `null` si le serveur est injoignable (l'interface bascule alors sur le jeu
 * de démonstration embarqué).
 */
export async function fetchInvoices(): Promise<ExtractionResult[] | null> {
  try {
    const r = await fetch("/api/invoices");
    if (!r.ok) return null;
    const data = await r.json();
    return Array.isArray(data) ? (data as ExtractionResult[]) : null;
  } catch {
    return null;
  }
}

/**
 * Envoie un fichier (PDF ou image) au serveur d'extraction et renvoie la facture extraite.
 *
 * Le fichier est transmis "en brut" dans le corps de la requête, avec son nom dans
 * l'en-tête `x-filename` (le serveur en déduit l'extension : PDF ou image). L'appel passe
 * par "/api/extract" — le proxy Vite le redirige vers le serveur du pipeline.
 *
 * En cas de problème, on lève une erreur avec un message clair (affiché tel quel à l'écran).
 */
export async function extractFile(file: File): Promise<ExtractionResult> {
  let response: Response;
  try {
    response = await fetch("/api/extract", {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "x-filename": file.name,
      },
      body: file,
    });
  } catch {
    // fetch échoue seulement si le serveur est injoignable (pas démarré, réseau coupé...).
    throw new Error(
      "Le serveur d'extraction est injoignable. Vérifie qu'il est bien démarré (npm run dev)."
    );
  }

  // Le serveur répond toujours en JSON : soit la facture, soit { error: "..." }.
  const data = await response.json().catch(() => null);

  if (!response.ok) {
    const message =
      data && typeof data.error === "string"
        ? data.error
        : `Erreur du serveur (code ${response.status}).`;
    // 409 = document du même nom déjà analysé : ce n'est pas une panne.
    if (response.status === 409 || data?.duplicate) throw new DuplicateError(message);
    throw new Error(message);
  }

  return data as ExtractionResult;
}

/**
 * Enregistre une facture corrigée et/ou validée. Le serveur revalide l'objet et relance
 * les contrôles de cohérence : il renvoie la version à jour (les alertes ont pu changer).
 */
export async function saveInvoice(inv: ExtractionResult): Promise<ExtractionResult> {
  let r: Response;
  try {
    r = await fetch(`/api/invoice/${encodeURIComponent(inv.sourceDocument)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(inv),
    });
  } catch {
    throw new Error("Le serveur est injoignable — modification non enregistrée.");
  }
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error(data?.error ?? `Erreur du serveur (code ${r.status}).`);
  return data as ExtractionResult;
}

/** URL de la facture originale (PDF/image) servie par le serveur d'extraction. */
export function originalFileUrl(sourceDocument: string): string {
  return `/api/file/${encodeURIComponent(sourceDocument)}`;
}

/**
 * Vérifie si la facture originale est disponible sur le disque (elle peut avoir été
 * déplacée ou supprimée à la main). Requête HEAD = on ne télécharge pas le fichier.
 */
export async function originalFileExists(sourceDocument: string): Promise<boolean> {
  try {
    const r = await fetch(originalFileUrl(sourceDocument), { method: "HEAD" });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Supprime une facture partout (fichier original, extraction, données par défaut).
 * Lève une erreur avec un message lisible si le serveur est injoignable.
 */
export async function deleteInvoice(sourceDocument: string): Promise<void> {
  let r: Response;
  try {
    r = await fetch(`/api/invoice/${encodeURIComponent(sourceDocument)}`, { method: "DELETE" });
  } catch {
    throw new Error("Le serveur d'extraction est injoignable — suppression impossible.");
  }
  if (!r.ok) {
    const d = await r.json().catch(() => null);
    throw new Error(d?.error ?? `Erreur du serveur (code ${r.status}).`);
  }
}

/**
 * Lit un fichier JSON déjà produit par le pipeline et renvoie la liste des factures.
 * Accepte aussi bien un tableau de factures qu'une facture seule (on normalise en tableau).
 */
export async function loadJson(file: File): Promise<ExtractionResult[]> {
  const text = await file.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Fichier JSON invalide.");
  }
  return Array.isArray(parsed)
    ? (parsed as ExtractionResult[])
    : [parsed as ExtractionResult];
}
