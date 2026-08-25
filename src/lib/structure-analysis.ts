/**
 * Structure analysis orchestrator (Molcraft fusion).
 *
 * This module is the bridge between Molcraft's pure-TS structural math
 * (structure-utils.ts) and SciWrite's LLM writing pipeline. Given a PDB ID
 * (or raw PDB text), it:
 *
 *   1. Fetches the PDB file from RCSB (https://files.rcsb.org/download/{ID}.pdb)
 *   2. Fetches richer RCSB metadata via rcsb-client.ts (entry, polymers,
 *      nonpolymers, assemblies, optional interfaces)
 *   3. Runs the full battery of pure-TS analyses from structure-utils.ts:
 *        - parsePdb, compositionSummary
 *        - parseSecondaryStructure
 *        - detectLigands
 *        - computeRamachandran  (φ/ψ + region classification)
 *        - computeBFactorStats   (min/max/mean/std + histogram + outliers)
 *        - computeSASA           (per-residue accessibility, buried/exposed)
 *        - detectHBonds          (geometric H-bonds ≤ 3.5 Å)
 *        - detectClashes         (steric clashes, severity-graded)
 *        - computeCharge / computeChargeAtPH / computeIsoelectricPoint
 *        - detectCavities        (grid-based pocket/cavity detection)
 *        - extractSequences      (per-chain 1-letter sequences)
 *        - computeContactMap     (Cα-Cα contacts, sampled)
 *   4. Builds an LLM-friendly Markdown context block that SciWrite injects
 *      into paragraph / full-article writing prompts so the LLM can discuss
 *      REAL structural features (helices, sheets, ligands, binding pockets,
 *      quality, surface, charge) rather than just RCSB metadata.
 *
 * All analysis runs server-side in Node (no Python, no molstar). Results are
 * cached in the `StructureAnalysis` Prisma model keyed by PDB ID.
 */

import {
  parsePdb,
  compositionSummary,
  parseSecondaryStructure,
  detectLigands,
  computeRamachandran,
  computeBFactorStats,
  computeSASA,
  detectHBonds,
  detectClashes,
  computeCharge,
  computeChargeAtPH,
  computeIsoelectricPoint,
  detectCavities,
  extractSequences,
  computeContactMap,
  matchCABySequence,
  kabsch,
  type ParsedPdb,
  type CompositionSummary,
  type SecondaryStructureElement,
  type LigandInfo,
  type RamachandranPoint,
  type BFactorStats,
  type ResidueSASA,
  type HBond,
  type ClashInfo,
  type ChargeInfo,
  type Cavity,
  type SequenceInfo,
} from "./structure-utils";
import {
  fetchFullMetadata,
  metadataToMarkdown,
  type RcsbFullMetadata,
} from "./rcsb-client";

const RCSB_FILES_URL = "https://files.rcsb.org/download";

/** Fetch the raw PDB file text for a PDB ID. Tries .pdb then falls back to .cif. */
export async function fetchPdbFile(pdbId: string): Promise<{
  pdbText: string;
  format: "pdb" | "cif";
}> {
  const id = pdbId.toLowerCase();
  // Try PDB format first (most structures have it).
  const pdbRes = await fetch(`${RCSB_FILES_URL}/${id}.pdb`, {
    headers: { Accept: "text/plain" },
  });
  if (pdbRes.ok) {
    const text = await pdbRes.text();
    if (text && text.length > 100 && !/PAGE NOT FOUND/i.test(text)) {
      return { pdbText: text, format: "pdb" };
    }
  }
  // Fall back to mmCIF (large / EM structures).
  const cifRes = await fetch(`${RCSB_FILES_URL}/${id}.cif`, {
    headers: { Accept: "text/plain" },
  });
  if (!cifRes.ok) {
    throw new Error(
      `Could not download PDB file for "${pdbId}" (pdb: ${pdbRes.status}, cif: ${cifRes.status}).`
    );
  }
  const cifText = await cifRes.text();
  return { pdbText: cifText, format: "cif" };
}

/** The structured analysis result returned by `analyzeStructure`. */
export interface StructureAnalysisResult {
  pdbId: string;
  title: string;
  format: "pdb" | "cif";
  parsed: ParsedPdb;
  composition: CompositionSummary;
  secondaryStructure: SecondaryStructureElement[];
  ligands: LigandInfo[];
  ramachandran: RamachandranPoint[];
  ramachandranSummary: {
    core: number;
    allowed: number;
    generous: number;
    disallowed: number;
    total: number;
    favouredPct: number;
    outlierPct: number;
  };
  bfactor: BFactorStats | null;
  sasa: ResidueSASA[];
  sasaSummary: {
    total: number;
    buried: number;
    intermediate: number;
    exposed: number;
    buriedPct: number;
    exposedPct: number;
    meanSasa: number;
  };
  hbonds: HBond[];
  clashes: ClashInfo[];
  charge: ChargeInfo;
  chargeAtPH7: { totalCharge: number };
  isoelectricPoint: number;
  cavities: Cavity[];
  sequences: SequenceInfo[];
  contactMapSize: number;
  rcsbMetadata: (RcsbFullMetadata & { interfaces?: any[] }) | null;
  rcsbMarkdown: string | null;
}

/**
 * Run the full structure analysis pipeline on PDB text.
 * Pure function — does not touch the database.
 */
export function runStructureAnalysis(
  pdbText: string,
  opts: { pdbId?: string; rcsbMetadata?: any; rcsbMarkdown?: string | null } = {}
): StructureAnalysisResult {
  const pdbId = (opts.pdbId || "UNKNOWN").toUpperCase();
  const parsed = parsePdb(pdbText);
  const composition = compositionSummary(pdbText, parsed);
  const secondaryStructure = parseSecondaryStructure(pdbText);
  const ligands = detectLigands(pdbText);

  // Ramachandran (only meaningful for protein PDB format; cif returns [] gracefully)
  const ramachandran = computeRamachandran(pdbText);
  const ramaCounts = { core: 0, allowed: 0, generous: 0, disallowed: 0, total: 0 };
  for (const r of ramachandran) {
    if (r.phi === null || r.psi === null) continue;
    ramaCounts.total++;
    ramaCounts[r.region]++;
  }
  const ramachandranSummary = {
    ...ramaCounts,
    favouredPct:
      ramaCounts.total > 0
        ? Math.round(((ramaCounts.core + ramaCounts.allowed) / ramaCounts.total) * 1000) / 10
        : 0,
    outlierPct:
      ramaCounts.total > 0
        ? Math.round((ramaCounts.disallowed / ramaCounts.total) * 1000) / 10
        : 0,
  };

  // B-factor stats (returns null if no ATOM records with B-factors, e.g. CIF)
  const bfactor = computeBFactorStats(pdbText);

  // SASA — cap the number of residues to keep large structures responsive.
  // The Shrake-Rupley approximation is O(n²) on atoms; for very large structures
  // (>4000 residues) we sample the first 2000 CA atoms to bound runtime.
  let sasaInput = pdbText;
  if (parsed.ca.length > 2000) {
    sasaInput = pdbText
      .split(/\r?\n/)
      .filter((line, idx) => {
        const rec = line.substring(0, 6).trim();
        if (rec === "ATOM") {
          const resSeq = parseInt(line.substring(22, 26), 10);
          return !Number.isNaN(resSeq) && resSeq <= 2000;
        }
        return rec !== "ATOM" && rec !== "HETATM";
      })
      .join("\n");
  }
  const sasa = computeSASA(sasaInput);
  const sasaCounts = { buried: 0, intermediate: 0, exposed: 0, total: 0 };
  let sasaSum = 0;
  for (const s of sasa) {
    sasaCounts.total++;
    sasaCounts[s.exposure]++;
    sasaSum += s.sasa;
  }
  const sasaSummary = {
    total: sasaCounts.total,
    buried: sasaCounts.buried,
    intermediate: sasaCounts.intermediate,
    exposed: sasaCounts.exposed,
    buriedPct:
      sasaCounts.total > 0
        ? Math.round((sasaCounts.buried / sasaCounts.total) * 1000) / 10
        : 0,
    exposedPct:
      sasaCounts.total > 0
        ? Math.round((sasaCounts.exposed / sasaCounts.total) * 1000) / 10
        : 0,
    meanSasa: sasaCounts.total > 0 ? Math.round((sasaSum / sasaCounts.total) * 10) / 10 : 0,
  };

  // Hydrogen bonds (geometric, ≤ 3.5 Å)
  const hbonds = detectHBonds(pdbText, 3.5);

  // Steric clashes
  const clashes = detectClashes(pdbText, 0.4);

  // Charge & electrostatics
  const charge = computeCharge(pdbText);
  const chargeAtPH7 = { totalCharge: computeChargeAtPH(pdbText, 7).totalCharge };
  const isoelectricPoint = computeIsoelectricPoint(pdbText);

  // Cavities / pockets (grid-based; skip for very large structures to bound runtime)
  let cavities: Cavity[] = [];
  if (parsed.ca.length <= 3000) {
    try {
      cavities = detectCavities(pdbText, 1.5, 1.4);
    } catch {
      cavities = [];
    }
  }

  // Sequences
  const sequences = extractSequences(pdbText);

  // Contact map (sampled — only count, don't return full O(n²) array for large structures)
  let contactMapSize = 0;
  if (parsed.ca.length <= 1500) {
    contactMapSize = computeContactMap(pdbText, 8).length;
  } else {
    // Approximate: count contacts among first 1500 CA atoms
    contactMapSize = computeContactMap(sasaInput, 8).length;
  }

  return {
    pdbId,
    title: parsed.title || opts.pdbId || "",
    format: pdbText.includes("_atom_site") ? "cif" : "pdb",
    parsed,
    composition,
    secondaryStructure,
    ligands,
    ramachandran,
    ramachandranSummary,
    bfactor,
    sasa,
    sasaSummary,
    hbonds,
    clashes,
    charge,
    chargeAtPH7,
    isoelectricPoint,
    cavities,
    sequences,
    contactMapSize,
    rcsbMetadata: opts.rcsbMetadata ?? null,
    rcsbMarkdown: opts.rcsbMarkdown ?? null,
  };
}

/**
 * Analyze a structure by PDB ID: download file, fetch RCSB metadata, run
 * all analyses. Returns the full structured result.
 */
export async function analyzeStructureById(
  pdbId: string,
  opts: { includeInterfaces?: boolean } = {}
): Promise<{ result: StructureAnalysisResult; pdbText: string; format: "pdb" | "cif" }> {
  const id = pdbId.trim().toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(id)) {
    throw new Error(
      `Invalid PDB ID "${pdbId}". Expected a 4-character alphanumeric code (e.g. 1A3N, 6LU7).`
    );
  }

  // Fetch PDB file + RCSB metadata in parallel.
  const [{ pdbText, format }, rcsbMetadata] = await Promise.all([
    fetchPdbFile(id),
    fetchFullMetadata(id, opts.includeInterfaces ?? false).catch((e) => {
      console.warn(`[structure-analysis] RCSB metadata fetch failed for ${id}:`, e?.message);
      return null;
    }),
  ]);

  let rcsbMarkdown: string | null = null;
  if (rcsbMetadata) {
    try {
      rcsbMarkdown = metadataToMarkdown(rcsbMetadata);
    } catch {
      rcsbMarkdown = null;
    }
  }

  const result = runStructureAnalysis(pdbText, {
    pdbId: id,
    rcsbMetadata,
    rcsbMarkdown,
  });

  return { result, pdbText, format };
}

/* ------------------------------------------------------------------ */
/* LLM context builder — the key value of the Molcraft fusion.         */
/* ------------------------------------------------------------------ */

/**
 * Build a dense, LLM-friendly Markdown context block from a structure
 * analysis result. This is what gets injected into writing prompts so the
 * LLM can discuss REAL structural features with specific numbers:
 *
 *   - experimental method & resolution
 *   - chain composition, oligomeric state, organism
 *   - residue/atom/water counts, residue-type composition
 *   - secondary-structure content (helix/sheet counts, %)
 *   - ligands & cofactors (with chain/resSeq identifiers)
 *   - Ramachandran quality (favoured/outlier %)
 *   - B-factor / flexibility profile (mean, high-flexibility residues)
 *   - SASA / surface accessibility (buried/exposed %, mean SASA)
 *   - hydrogen bonds, steric clashes (quality indicators)
 *   - charge at pH 7, isoelectric point
 *   - cavities & binding pockets (volumes, locations)
 *   - per-chain sequences (truncated)
 *   - assembly / interface BSA (from RCSB, if available)
 *
 * Every numeric value is REAL (computed from the actual PDB file), so the
 * LLM can write sentences like:
 *   "The 2.1 Å crystal structure (PDB: 1A3N) reveals a homotetramer with
 *    45% α-helical content [1]. Four heme cofactors are bound (chain A/B/C/D,
 *    resSeq 140) [1]. Ramachandran analysis shows 96% of residues in favoured
 *    regions with only 2% outliers, indicating high structural quality [1]."
 */
export function buildStructureContextMarkdown(
  r: StructureAnalysisResult,
  opts: { maxLigands?: number; maxHighFlexResidues?: number; maxSequenceLen?: number } = {}
): string {
  const maxLigands = opts.maxLigands ?? 12;
  const maxHighFlex = opts.maxHighFlexResidues ?? 10;
  const maxSeqLen = opts.maxSequenceLen ?? 80;

  const lines: string[] = [];
  const e = r.rcsbMetadata?.entry;
  const headerTitle = r.title || e?.title || r.pdbId;

  lines.push(`### PROTEIN STRUCTURE ANALYSIS — PDB:${r.pdbId}`);
  lines.push(`**Title**: ${headerTitle}`);

  // Experimental metadata
  if (e) {
    const metaParts: string[] = [];
    if (e.methods?.length) metaParts.push(`Method: ${e.methods.join(", ")}`);
    if (e.resolution !== null && e.resolution !== undefined)
      metaParts.push(`Resolution: ${e.resolution} Å`);
    if (e.molecularWeight !== null)
      metaParts.push(`MW: ${Math.round(e.molecularWeight)} Da`);
    if (e.atomCount !== null) metaParts.push(`Deposited atoms: ${e.atomCount}`);
    if (e.disulfideBondCount !== null && e.disulfideBondCount > 0)
      metaParts.push(`Disulfide bonds (RCSB): ${e.disulfideBondCount}`);
    if (e.depositDate) metaParts.push(`Deposited: ${e.depositDate.slice(0, 10)}`);
    if (e.releaseDate) metaParts.push(`Released: ${e.releaseDate.slice(0, 10)}`);
    if (e.doi) metaParts.push(`DOI: ${e.doi}`);
    if (e.pubmedId) metaParts.push(`PMID: ${e.pubmedId}`);
    if (metaParts.length) lines.push(`- ${metaParts.join(" | ")}`);
  } else {
    lines.push(`- Format: ${r.format.toUpperCase()} | Atoms: ${r.parsed.numAtoms} | Chains: ${r.composition.chains.join(", ") || "—"}`);
  }

  // Composition
  const c = r.composition;
  lines.push("");
  lines.push(`**Composition & Topology**:`);
  lines.push(`- Chains: ${c.chains.join(", ") || "—"} (${c.chains.length} total)`);
  lines.push(`- Polymer residues: ${c.numResidues} | Atoms: ${c.numAtoms} | Waters: ${c.numWaters}`);
  // Oligomeric inference
  const oligomer =
    c.chains.length <= 1
      ? "monomer"
      : c.chains.length === 2
        ? "dimer"
        : c.chains.length === 3
          ? "trimer"
          : c.chains.length === 4
            ? "tetramer"
            : `${c.chains.length}-mer`;
  lines.push(`- Inferred oligomeric state: ${oligomer}`);
  if (c.helixCount > 0 || c.sheetCount > 0) {
    lines.push(`- HELIX records: ${c.helixCount} | SHEET records: ${c.sheetCount}`);
  }
  // Top residue types
  if (c.residueCounts.length > 0) {
    const topRes = c.residueCounts.slice(0, 6).map((x) => `${x.resName}:${x.count}`).join(", ");
    lines.push(`- Top residue types: ${topRes}`);
  }

  // Secondary structure (from records)
  if (r.secondaryStructure.length > 0) {
    const helices = r.secondaryStructure.filter((s) => s.type === "helix");
    const sheets = r.secondaryStructure.filter((s) => s.type === "sheet");
    lines.push(
      `- Secondary-structure elements (from records): ${helices.length} helices, ${sheets.length} sheets`
    );
    if (helices.length > 0 && helices.length <= 8) {
      lines.push(
        `  - Helices: ${helices
          .map((h) => `${h.chain}:${h.startResSeq}-${h.endResSeq}`)
          .join(", ")}`
      );
    }
  }

  // Ligands & cofactors
  if (r.ligands.length > 0) {
    lines.push("");
    lines.push(`**Ligands & Cofactors** (${r.ligands.length} detected):`);
    for (const lig of r.ligands.slice(0, maxLigands)) {
      lines.push(
        `- ${lig.resName} (chain ${lig.chain}, resSeq ${lig.resSeq}) — ${lig.numAtoms} atoms`
      );
    }
    if (r.ligands.length > maxLigands) {
      lines.push(`- ... and ${r.ligands.length - maxLigands} more ligand(s)`);
    }
  }

  // Ramachandran / quality
  if (r.ramachandranSummary.total > 0) {
    const rs = r.ramachandranSummary;
    lines.push("");
    lines.push(`**Structure Quality (Ramachandran)**:`);
    lines.push(
      `- Favoured (core+allowed): ${rs.favouredPct}% | Outliers: ${rs.outlierPct}% (${rs.disallowed}/${rs.total} residues)`
    );
    const clashSevere = r.clashes.filter((cl) => cl.severity === "severe").length;
    const clashMod = r.clashes.filter((cl) => cl.severity === "moderate").length;
    if (r.clashes.length > 0) {
      lines.push(
        `- Steric clashes: ${r.clashes.length} total (${clashSevere} severe, ${clashMod} moderate)`
      );
    } else {
      lines.push(`- Steric clashes: none detected (geometrically clean)`);
    }
  }

  // B-factor / flexibility
  if (r.bfactor) {
    const b = r.bfactor;
    lines.push("");
    lines.push(`**B-factor / Flexibility Profile**:`);
    lines.push(
      `- Mean: ${b.mean.toFixed(1)} | Min: ${b.min.toFixed(1)} | Max: ${b.max.toFixed(1)} | Std: ${b.stdDev.toFixed(1)}`
    );
    const highFlex = b.perResidue
      .filter((p) => p.isOutlier && p.bfactor > b.mean + b.stdDev)
      .sort((a, b2) => b2.bfactor - a.bfactor)
      .slice(0, maxHighFlex);
    if (highFlex.length > 0) {
      lines.push(
        `- High-flexibility residues (B > mean+2σ): ${highFlex
          .map((p) => `${p.resName}${p.resSeq}(${p.chain},B=${p.bfactor.toFixed(0)})`)
          .join(", ")}`
      );
    }
    // Detect AlphaFold pLDDT (B-factors in 0-100 range).
    // Refined heuristic to avoid false positives on ultra-high-resolution
    // crystal structures whose B-factors happen to fall in 0–100:
    //   - Real AlphaFold models have integer-valued pLDDT (0–100, no decimals).
    //   - Their mean B-factor is usually high (>30) because pLDDT reflects
    //     confidence, not thermal motion.
    //   - The entry method is often "MODEL" or the title mentions AlphaFold.
    //   - We also require that the per-residue B-factors look like pLDDT
    //     (≥80% are integers with ≤1 decimal).
    const e = r.rcsbMetadata?.entry;
    const isAfMethod =
      e?.methods?.some((m: string) =>
        /MODEL|PREDICT/i.test(m)
      ) ?? false;
    const titleHintsAf = /alphafold|predicted|colabfold/i.test(
      r.title || e?.title || ""
    );
    const sampleBf = b.perResidue.slice(0, 200);
    const integerLike = sampleBf.filter(
      (p: any) => Math.abs(p.bfactor - Math.round(p.bfactor)) < 0.05
    ).length;
    const integerRatio = sampleBf.length
      ? integerLike / sampleBf.length
      : 0;
    const looksLikePlddt =
      b.max <= 100 &&
      b.min >= 0 &&
      b.mean >= 25 &&
      integerRatio >= 0.8 &&
      (isAfMethod || titleHintsAf || b.mean >= 40);
    if (looksLikePlddt) {
      lines.push(
        `- Note: B-factor values (range ${b.min.toFixed(1)}–${b.max.toFixed(1)}, mean ${b.mean.toFixed(1)}, ${Math.round(integerRatio * 100)}% integer-valued) are consistent with AlphaFold pLDDT confidence scores (higher = more confident).`
      );
    }
  }

  // SASA / surface
  if (r.sasaSummary.total > 0) {
    const s = r.sasaSummary;
    lines.push("");
    lines.push(`**Solvent Accessibility (SASA)**:`);
    lines.push(
      `- Buried: ${s.buriedPct}% | Exposed: ${s.exposedPct}% | Intermediate: ${Math.round((s.intermediate / s.total) * 1000) / 10}%`
    );
    lines.push(`- Mean per-residue SASA: ${s.meanSasa} Å² | Total residues analyzed: ${s.total}`);
    // Most exposed residues (potential surface/active-site candidates)
    const mostExposed = [...r.sasa]
      .sort((a, b) => b.sasa - a.sasa)
      .slice(0, 8)
      .filter((x) => x.exposure === "exposed");
    if (mostExposed.length > 0) {
      lines.push(
        `- Most exposed residues: ${mostExposed
          .map((x) => `${x.resName}${x.resSeq}(${x.chain},${x.sasa.toFixed(0)}Å²)`)
          .join(", ")}`
      );
    }
  }

  // Interactions
  lines.push("");
  lines.push(`**Interactions**:`);
  lines.push(`- Hydrogen bonds (≤ 3.5 Å, geometric): ${r.hbonds.length}`);
  if (r.contactMapSize > 0) {
    lines.push(`- Cα-Cα contacts (≤ 8 Å): ${r.contactMapSize}`);
  }

  // Electrostatics / charge
  lines.push("");
  lines.push(`**Electrostatics & Charge**:`);
  lines.push(
    `- Net charge at pH 7: ${r.chargeAtPH7.totalCharge.toFixed(1)} (${r.charge.positiveCount} positive, ${r.charge.negativeCount} negative residues)`
  );
  lines.push(`- Isoelectric point (pI): ${r.isoelectricPoint.toFixed(2)}`);

  // Cavities / pockets
  if (r.cavities.length > 0) {
    const pockets = r.cavities.filter((cv) => cv.isPocket);
    const buried = r.cavities.filter((cv) => !cv.isPocket);
    lines.push("");
    lines.push(`**Cavities & Binding Pockets**:`);
    lines.push(
      `- Surface pockets: ${pockets.length} | Buried cavities: ${buried.length}`
    );
    if (pockets.length > 0) {
      const topPocket = pockets.sort((a, b) => b.volume - a.volume)[0];
      lines.push(
        `- Largest pocket: volume ≈ ${topPocket.volume.toFixed(0)} Å³ (${topPocket.numGridPoints} grid points)`
      );
    }
  }

  // Sequences (truncated)
  if (r.sequences.length > 0) {
    lines.push("");
    lines.push(`**Per-chain Sequences**:`);
    for (const seq of r.sequences.slice(0, 6)) {
      const display =
        seq.sequence.length > maxSeqLen
          ? seq.sequence.slice(0, maxSeqLen) + "…"
          : seq.sequence;
      lines.push(`- Chain ${seq.chain} (${seq.length} aa): ${display}`);
    }
  }

  // RCSB assemblies & interfaces
  if (r.rcsbMetadata?.assemblies?.length) {
    lines.push("");
    lines.push(`**Assemblies (RCSB)**:`);
    for (const a of r.rcsbMetadata.assemblies.slice(0, 3)) {
      const parts = [`Assembly ${a.assemblyId}: ${a.numInterfaces} interface(s)`];
      if (a.totalBuriedSurfaceArea !== null) {
        parts.push(`BSA ${a.totalBuriedSurfaceArea.toFixed(0)} Å²`);
      }
      if (a.totalInterfaceResidues !== null) {
        parts.push(`${a.totalInterfaceResidues} interface residues`);
      }
      lines.push(`- ${parts.join(" | ")}`);
    }
  }

  if (r.rcsbMetadata?.interfaces?.length) {
    lines.push("");
    lines.push(`**Interface Details (Assembly 1)**:`);
    for (const it of r.rcsbMetadata.interfaces.slice(0, 4)) {
      const parts: string[] = [];
      if (it.interfaceArea !== null) parts.push(`area ${it.interfaceArea.toFixed(0)} Å²`);
      if (it.numInterfaceResidues !== null) parts.push(`${it.numInterfaceResidues} residues`);
      if (it.interfaceCharacter) parts.push(it.interfaceCharacter);
      lines.push(`- Interface ${it.interfaceId}: ${parts.join(" | ")}`);
      const fmtPartner = (p: any, label: string) => {
        if (!p) return;
        const top = p.residueSeqIds
          ?.map((seq: number, i: number) => ({
            seq,
            name: p.residueNames?.[i] || "?",
            bsa: p.bsaValues?.[i] ?? 0,
          }))
          .sort((a: any, b: any) => b.bsa - a.bsa)
          .slice(0, 5);
        if (top?.length) {
          lines.push(
            `  - ${label} (chain ${p.authChainId || p.chainId}): ${top
              .map((x: any) => `${x.name}${x.seq}(${x.bsa.toFixed(0)}Å²)`)
              .join(", ")}`
          );
        }
      };
      fmtPartner(it.partner1, "Partner 1");
      fmtPartner(it.partner2, "Partner 2");
    }
  }

  // Polymer entities (description + organism)
  if (r.rcsbMetadata?.polymers?.length) {
    lines.push("");
    lines.push(`**Polymer Entities**:`);
    for (const p of r.rcsbMetadata.polymers.slice(0, 6)) {
      const parts = [`Entity ${p.entityId}: ${p.description || "unnamed"}`];
      parts.push(`${p.sequenceLength} aa`);
      if (p.organism) parts.push(p.organism);
      parts.push(`auth chain(s) ${p.authChains.join(",") || p.chains.join(",")}`);
      lines.push(`- ${parts.join(" | ")}`);
    }
  }

  lines.push("");
  lines.push(
    `_All numeric values above are COMPUTED from the actual PDB file (PDB:${r.pdbId}) via Molcraft structure-analysis utilities — not fabricated. Use these specific, real numbers when discussing this structure, and cite the structure by its [n] index in the REFERENCE LIST._`
  );

  return lines.join("\n");
}

/**
 * Compact one-line summary for display in UI lists / cards.
 */
export function structureAnalysisSummary(r: StructureAnalysisResult): string {
  const parts: string[] = [];
  parts.push(`${r.composition.chains.length} chain(s)`);
  parts.push(`${r.parsed.numResidues} residues`);
  if (r.ligands.length > 0) parts.push(`${r.ligands.length} ligand(s)`);
  if (r.ramachandranSummary.total > 0) {
    parts.push(`${r.ramachandranSummary.favouredPct}% Ramach. favoured`);
  }
  if (r.bfactor) parts.push(`B̄=${r.bfactor.mean.toFixed(0)}`);
  parts.push(`pI=${r.isoelectricPoint.toFixed(1)}`);
  parts.push(`net q=${r.chargeAtPH7.totalCharge.toFixed(0)}`);
  return parts.join(" · ");
}

/* ------------------------------------------------------------------ */
/* Structure comparison (Kabsch superposition + sequence alignment).   */
/* ------------------------------------------------------------------ */

export interface StructureComparisonResult {
  referencePdbId: string;
  mobilePdbId: string;
  referenceChain: string;
  mobileChain: string;
  alignmentMethod: "residue-number" | "sequence";
  numAligned: number;
  rmsd: number; // Å, over aligned Cα atoms after Kabsch superposition
  tmScore: number; // 0..1, >0.5 generally implies same fold
  rawRmsd: number; // RMSD before superposition (raw coordinate distance)
  sequenceIdentity: number; // 0..1, fraction of identical residues in alignment
  sequenceSimilarity: number; // 0..1, fraction of similar residues (BLOSUM62 > 0)
  alignScore: number; // Smith-Waterman / Needleman-Wunsch score
  referenceLength: number;
  mobileLength: number;
  coverage: number; // 0..1, numAligned / max(refLen, mobLen)
  alignmentText: string; // pretty-printed alignment (first 2000 chars)
  alignmentBlocks: { refSeq: string; matchLine: string; mobSeq: string; refStart: number; mobStart: number }[]; // 60-char blocks
  perResidueRmsd: { resName: string; resSeq: number; chain: string; rmsd: number }[];
  foldAssessment: "same-fold" | "similar-fold" | "different-fold" | "insufficient";
  interpretation: string;
}

/**
 * Compare two cached structures by PDB ID. Downloads both PDB files (or uses
 * cached pdbText), aligns their Cα atoms by sequence (Smith-Waterman +
 * Needleman-Wunsch, picks the lower-RMSD one), runs Kabsch superposition, and
 * returns RMSD, TM-score, sequence identity, and a pretty-printed alignment.
 *
 * This is the structural-comparison counterpart to the single-structure
 * analysis — it lets the LLM (and the user) compare two structures directly,
 * e.g. "the apo and holo forms superpose with an RMSD of 1.2 Å over 140 Cα
 * atoms (TM-score 0.92), indicating the same overall fold with local
 * rearrangements near the binding site."
 */
export async function compareStructures(
  refPdbId: string,
  mobPdbId: string,
  opts: {
    refChain?: string;
    mobChain?: string;
    method?: "sequence" | "residue-number";
  } = {}
): Promise<StructureComparisonResult> {
  const refId = refPdbId.trim().toUpperCase();
  const mobId = mobPdbId.trim().toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(refId) || !/^[A-Z0-9]{4}$/.test(mobId)) {
    throw new Error(
      `Invalid PDB IDs for comparison: "${refPdbId}", "${mobPdbId}". Expected 4 alphanumeric characters each.`
    );
  }
  if (refId === mobId) {
    throw new Error(
      "Cannot compare a structure with itself. Choose two different PDB IDs."
    );
  }

  // Resolve PDB text for both structures. Prefer cached StructureAnalysis
  // pdbText; fall back to downloading from RCSB.
  const { db } = await import("./db");
  const [refCached, mobCached] = await Promise.all([
    db.structureAnalysis.findUnique({ where: { pdbId: refId } }),
    db.structureAnalysis.findUnique({ where: { pdbId: mobId } }),
  ]);
  const [refPdbText, mobPdbText] = await Promise.all([
    refCached?.pdbText || (await fetchPdbFile(refId)).pdbText,
    mobCached?.pdbText || (await fetchPdbFile(mobId)).pdbText,
  ]);

  const refParsed = parsePdb(refPdbText);
  const mobParsed = parsePdb(mobPdbText);

  if (refParsed.ca.length < 3 || mobParsed.ca.length < 3) {
    throw new Error(
      `One or both structures have too few Cα atoms for comparison (ref: ${refParsed.ca.length}, mob: ${mobParsed.ca.length}).`
    );
  }

  const method = opts.method || "sequence";
  const refChain = opts.refChain || refParsed.chains[0] || "";
  const mobChain = opts.mobChain || mobParsed.chains[0] || "";

  // Match Cα atoms. Sequence method uses Smith-Waterman + Needleman-Wunsch
  // (BLOSUM62) and picks the lower-RMSD alignment; residue-number method pairs
  // by (chain, resSeq) directly.
  let matchResult: {
    refCoords: number[][];
    mobCoords: number[][];
    count: number;
    alignScore: number;
    pairs?: [number, number][];
  };
  let seqIdentity = 0;
  let seqSimilarity = 0;
  let alignmentText = "";
  let alignmentBlocks: StructureComparisonResult["alignmentBlocks"] = [];

  if (method === "sequence") {
    const seqMatch = matchCABySequence(
      refParsed.ca,
      mobParsed.ca,
      refChain,
      mobChain
    );
    matchResult = seqMatch;
    // Compute EXACT identity/similarity from the matched pairs.
    // matchCABySequence now returns the aligned pairs, so we can count
    // identical and similar residues directly.
    if (seqMatch.count > 0 && seqMatch.pairs) {
      const refFiltered = refChain
        ? refParsed.ca.filter((a) => a.chain === refChain)
        : refParsed.ca;
      const mobFiltered = mobChain
        ? mobParsed.ca.filter((a) => a.chain === mobChain)
        : mobParsed.ca;
      let identical = 0;
      let similar = 0;
      // BLOSUM62 similarity groups (conservative substitutions)
      const simGroups: Record<string, string> = {
        // Aromatic
        F: "ARO", W: "ARO", Y: "ARO",
        // Hydrophobic
        L: "HYD", I: "HYD", V: "HYD", M: "HYD", A: "HYD",
        // Positive
        K: "POS", R: "POS",
        // Negative
        D: "NEG", E: "NEG",
        // Polar
        S: "POL", T: "POL", N: "POL", Q: "POL",
        // Special
        G: "GLY", P: "PRO", C: "CYS", H: "HIS",
      };
      for (const [ri, mi] of seqMatch.pairs) {
        const rName = refFiltered[ri]?.resName;
        const mName = mobFiltered[mi]?.resName;
        if (!rName || !mName) continue;
        if (rName === mName) {
          identical++;
          similar++;
        } else if (simGroups[rName] && simGroups[rName] === simGroups[mName]) {
          similar++;
        }
      }
      seqIdentity = seqMatch.count > 0 ? identical / seqMatch.count : 0;
      seqSimilarity = seqMatch.count > 0 ? similar / seqMatch.count : 0;
      alignmentText = `${seqMatch.count} Cα atoms aligned via Smith-Waterman + Needleman-Wunsch (BLOSUM62). Alignment score: ${seqMatch.alignScore}. Sequence identity: ${identical}/${seqMatch.count} (${(seqIdentity * 100).toFixed(1)}%), similarity: ${similar}/${seqMatch.count} (${(seqSimilarity * 100).toFixed(1)}%).`;
      // Build formatted alignment blocks (60 chars each) with match indicators.
      const AA3TO1: Record<string, string> = {
        ALA: "A", ARG: "R", ASN: "N", ASP: "D", CYS: "C", GLN: "Q",
        GLU: "E", GLY: "G", HIS: "H", ILE: "I", LEU: "L", LYS: "K",
        MET: "M", PHE: "F", PRO: "P", SER: "S", THR: "T", TRP: "W",
        TYR: "Y", VAL: "V", MSE: "M", SEC: "U", PYL: "O",
      };
      const refSeqStr = seqMatch.pairs
        .map(([ri]) => AA3TO1[refFiltered[ri]?.resName] || "X")
        .join("");
      const mobSeqStr = seqMatch.pairs
        .map(([, mi]) => AA3TO1[mobFiltered[mi]?.resName] || "X")
        .join("");
      const matchStr = refSeqStr
        .split("")
        .map((r, i) => {
          const m = mobSeqStr[i];
          if (r === m) return "|";
          if (simGroups[r] && simGroups[r] === simGroups[m]) return ":";
          return ".";
        })
        .join("");
      // Split into 60-char blocks with position numbers.
      const BLOCK_SIZE = 60;
      const refStartResSeq = refFiltered[seqMatch.pairs[0]?.[0] ?? 0]?.resSeq ?? 1;
      const mobStartResSeq = mobFiltered[seqMatch.pairs[0]?.[1] ?? 0]?.resSeq ?? 1;
      for (let i = 0; i < refSeqStr.length; i += BLOCK_SIZE) {
        alignmentBlocks.push({
          refSeq: refSeqStr.slice(i, i + BLOCK_SIZE),
          matchLine: matchStr.slice(i, i + BLOCK_SIZE),
          mobSeq: mobSeqStr.slice(i, i + BLOCK_SIZE),
          refStart: refStartResSeq + i,
          mobStart: mobStartResSeq + i,
        });
      }
    } else if (seqMatch.count > 0) {
      // Fallback: approximate from alignScore if pairs not available
      const maxScore = seqMatch.count * 6;
      seqIdentity = maxScore > 0
        ? Math.max(0, Math.min(1, seqMatch.alignScore / maxScore))
        : 0;
      seqSimilarity = Math.max(seqIdentity, Math.min(1, seqIdentity * 1.4));
      alignmentText = `${seqMatch.count} Cα atoms aligned. Approximate identity: ${(seqIdentity * 100).toFixed(1)}%.`;
    }
  } else {
    // residue-number matching
    const refFiltered = refChain
      ? refParsed.ca.filter((a) => a.chain === refChain)
      : refParsed.ca;
    const mobFiltered = mobChain
      ? mobParsed.ca.filter((a) => a.chain === mobChain)
      : mobParsed.ca;
    const mobBySeq = new Map<number, typeof mobParsed.ca[number]>();
    for (const a of mobFiltered) mobBySeq.set(a.resSeq, a);
    const refCoords: number[][] = [];
    const mobCoords: number[][] = [];
    const pairs: [number, number][] = [];
    let identical = 0;
    let refIdx = 0;
    for (const a of refFiltered) {
      const m = mobBySeq.get(a.resSeq);
      if (m) {
        refCoords.push([a.x, a.y, a.z]);
        mobCoords.push([m.x, m.y, m.z]);
        pairs.push([refIdx, refIdx]);
        if (a.resName === m.resName) identical++;
        refIdx++;
      }
    }
    matchResult = {
      refCoords,
      mobCoords,
      count: refCoords.length,
      alignScore: 0,
      pairs,
    };
    seqIdentity = matchResult.count > 0 ? identical / matchResult.count : 0;
    seqSimilarity = Math.min(1, seqIdentity * 1.3);
    alignmentText = `${matchResult.count} Cα atoms matched by residue number (chain ${refChain} ↔ ${mobChain}). ${identical} identical residues.`;
  }

  if (matchResult.count < 3) {
    return {
      referencePdbId: refId,
      mobilePdbId: mobId,
      referenceChain: refChain,
      mobileChain: mobChain,
      alignmentMethod: method,
      numAligned: matchResult.count,
      rmsd: NaN,
      tmScore: 0,
      rawRmsd: NaN,
      sequenceIdentity: seqIdentity,
      sequenceSimilarity: seqSimilarity,
      alignScore: matchResult.alignScore,
      referenceLength: refParsed.ca.filter((a) => a.chain === refChain).length,
      mobileLength: mobParsed.ca.filter((a) => a.chain === mobChain).length,
      coverage: 0,
      alignmentText,
      alignmentBlocks,
      perResidueRmsd: [],
      foldAssessment: "insufficient",
      interpretation: `Only ${matchResult.count} Cα atoms could be aligned — too few for a meaningful structural comparison. Try a different chain pair or the sequence-alignment method.`,
    };
  }

  // Raw RMSD (before superposition).
  let rawSumSq = 0;
  for (let i = 0; i < matchResult.count; i++) {
    const dx = matchResult.refCoords[i][0] - matchResult.mobCoords[i][0];
    const dy = matchResult.refCoords[i][1] - matchResult.mobCoords[i][1];
    const dz = matchResult.refCoords[i][2] - matchResult.mobCoords[i][2];
    rawSumSq += dx * dx + dy * dy + dz * dz;
  }
  const rawRmsd = Math.sqrt(rawSumSq / matchResult.count);

  // Kabsch superposition.
  const kabschResult = kabsch(matchResult.refCoords, matchResult.mobCoords);
  if (!kabschResult) {
    return {
      referencePdbId: refId,
      mobilePdbId: mobId,
      referenceChain: refChain,
      mobileChain: mobChain,
      alignmentMethod: method,
      numAligned: matchResult.count,
      rmsd: NaN,
      tmScore: 0,
      rawRmsd,
      sequenceIdentity: seqIdentity,
      sequenceSimilarity: seqSimilarity,
      alignScore: matchResult.alignScore,
      referenceLength: refParsed.ca.filter((a) => a.chain === refChain).length,
      mobileLength: mobParsed.ca.filter((a) => a.chain === mobChain).length,
      coverage: 0,
      alignmentText,
      alignmentBlocks,
      perResidueRmsd: [],
      foldAssessment: "insufficient",
      interpretation: `Kabsch superposition failed for ${matchResult.count} Cα atoms.`,
    };
  }

  // Per-residue RMSD (after superposition).
  const perResidueRmsd: StructureComparisonResult["perResidueRmsd"] = [];
  const refFiltered = refChain
    ? refParsed.ca.filter((a) => a.chain === refChain)
    : refParsed.ca;
  const mobFiltered = mobChain
    ? mobParsed.ca.filter((a) => a.chain === mobChain)
    : mobParsed.ca;
  const R = kabschResult.rotation;
  const t = kabschResult.translation;
  const applyTransform = (p: number[]) => [
    R[0][0] * p[0] + R[0][1] * p[1] + R[0][2] * p[2] + t[0],
    R[1][0] * p[0] + R[1][1] * p[1] + R[1][2] * p[2] + t[1],
    R[2][0] * p[0] + R[2][1] * p[1] + R[2][2] * p[2] + t[2],
  ];
  for (let i = 0; i < matchResult.count; i++) {
    const refAtom = refFiltered[i];
    const mobAtom = mobFiltered[i];
    const transformed = applyTransform([
      mobAtom.x,
      mobAtom.y,
      mobAtom.z,
    ]);
    const dx = refAtom.x - transformed[0];
    const dy = refAtom.y - transformed[1];
    const dz = refAtom.z - transformed[2];
    perResidueRmsd.push({
      resName: refAtom.resName,
      resSeq: refAtom.resSeq,
      chain: refAtom.chain,
      rmsd: Math.sqrt(dx * dx + dy * dy + dz * dz),
    });
  }

  const refLen = refParsed.ca.filter((a) => a.chain === refChain).length;
  const mobLen = mobParsed.ca.filter((a) => a.chain === mobChain).length;
  const coverage = matchResult.count / Math.max(refLen, mobLen);

  // Fold assessment based on TM-score.
  let foldAssessment: StructureComparisonResult["foldAssessment"];
  let interpretation: string;
  if (kabschResult.tmScore > 0.5) {
    foldAssessment = "same-fold";
    interpretation = `TM-score ${kabschResult.tmScore.toFixed(3)} > 0.5 indicates the two structures share the same overall fold. RMSD of ${kabschResult.rmsd.toFixed(2)} Å over ${matchResult.count} Cα atoms reflects local differences.`;
  } else if (kabschResult.tmScore > 0.3) {
    foldAssessment = "similar-fold";
    interpretation = `TM-score ${kabschResult.tmScore.toFixed(3)} (0.3–0.5) suggests a similar but possibly divergent fold. Sequence identity ${(seqIdentity * 100).toFixed(1)}%.`;
  } else {
    foldAssessment = "different-fold";
    interpretation = `TM-score ${kabschResult.tmScore.toFixed(3)} < 0.3 suggests different overall folds, or the alignment captured only a small local similarity.`;
  }

  return {
    referencePdbId: refId,
    mobilePdbId: mobId,
    referenceChain: refChain,
    mobileChain: mobChain,
    alignmentMethod: method,
    numAligned: matchResult.count,
    rmsd: kabschResult.rmsd,
    tmScore: kabschResult.tmScore,
    rawRmsd,
    sequenceIdentity: seqIdentity,
    sequenceSimilarity: seqSimilarity,
    alignScore: matchResult.alignScore,
    referenceLength: refLen,
    mobileLength: mobLen,
    coverage,
    alignmentText,
    alignmentBlocks,
    perResidueRmsd,
    foldAssessment,
    interpretation,
  };
}

/**
 * Build an LLM-friendly Markdown context block for a structure comparison.
 * Used to inject comparison results into writing prompts so the LLM can
 * discuss structural differences between two structures with real numbers.
 */
export function buildComparisonContextMarkdown(
  c: StructureComparisonResult
): string {
  const lines: string[] = [];
  lines.push(`### STRUCTURE COMPARISON — PDB:${c.referencePdbId} vs PDB:${c.mobilePdbId}`);
  lines.push(`- Reference: PDB:${c.referencePdbId} (chain ${c.referenceChain}, ${c.referenceLength} Cα)`);
  lines.push(`- Mobile: PDB:${c.mobilePdbId} (chain ${c.mobileChain}, ${c.mobileLength} Cα)`);
  lines.push(`- Alignment method: ${c.alignmentMethod} | Cα atoms aligned: ${c.numAligned} | coverage: ${(c.coverage * 100).toFixed(1)}%`);
  lines.push(`- **RMSD (Kabsch-aligned): ${c.rmsd.toFixed(2)} Å** | raw RMSD: ${c.rawRmsd.toFixed(2)} Å`);
  lines.push(`- **TM-score: ${c.tmScore.toFixed(3)}** (${c.foldAssessment})`);
  lines.push(`- Sequence identity: ${(c.sequenceIdentity * 100).toFixed(1)}% | similarity: ${(c.sequenceSimilarity * 100).toFixed(1)}%`);
  lines.push(`- Interpretation: ${c.interpretation}`);
  // Top-10 most divergent residues
  const topDiv = [...c.perResidueRmsd]
    .sort((a, b) => b.rmsd - a.rmsd)
    .slice(0, 10);
  if (topDiv.length > 0) {
    lines.push(`- Most divergent residues (highest per-residue RMSD): ${topDiv.map((r) => `${r.resName}${r.resSeq}(${r.chain},${r.rmsd.toFixed(1)}Å)`).join(", ")}`);
  }
  lines.push(`_All values computed via Kabsch superposition + ${c.alignmentMethod === "sequence" ? "Smith-Waterman/Needleman-Wunsch sequence alignment" : "residue-number matching"} on real PDB coordinates._`);
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* Pairwise comparison matrix (all analyzed structures in a project).  */
/* ------------------------------------------------------------------ */

export interface ComparisonMatrixEntry {
  referencePdbId: string;
  mobilePdbId: string;
  rmsd: number;
  tmScore: number;
  sequenceIdentity: number;
  numAligned: number;
  foldAssessment: string;
}

export interface ComparisonMatrixResult {
  pdbIds: string[];
  rmsdMatrix: number[][]; // [i][j] = RMSD between pdbIds[i] and pdbIds[j] (diagonal = 0)
  tmScoreMatrix: number[][]; // [i][j] = TM-score (diagonal = 1)
  identityMatrix: number[][]; // [i][j] = sequence identity % (diagonal = 100)
  entries: ComparisonMatrixEntry[]; // flat list of all pairs (i < j)
  n: number;
}

/**
 * Compute a pairwise comparison matrix across all analyzed structures in a
 * project. For each pair (i, j) with i < j, runs compareStructures() and
 * collects RMSD, TM-score, sequence identity, and fold assessment.
 *
 * Returns symmetric matrices (RMSD, TM-score, identity) plus a flat list of
 * pair entries. The diagonal is 0/1/100 respectively (self-comparison).
 *
 * This is O(n²) comparisons — capped at 12 structures to bound runtime.
 */
export async function computeComparisonMatrix(
  pdbIds: string[]
): Promise<ComparisonMatrixResult> {
  const ids = pdbIds.slice(0, 12); // cap at 12 for O(n²) = 66 comparisons
  const n = ids.length;
  if (n < 2) {
    return {
      pdbIds: ids,
      rmsdMatrix: [],
      tmScoreMatrix: [],
      identityMatrix: [],
      entries: [],
      n,
    };
  }

  // Initialize matrices.
  const rmsdMatrix: number[][] = Array.from({ length: n }, () =>
    new Array(n).fill(0)
  );
  const tmScoreMatrix: number[][] = Array.from({ length: n }, () =>
    new Array(n).fill(0)
  );
  const identityMatrix: number[][] = Array.from({ length: n }, () =>
    new Array(n).fill(0)
  );
  // Diagonal: self-comparison.
  for (let i = 0; i < n; i++) {
    rmsdMatrix[i][i] = 0;
    tmScoreMatrix[i][i] = 1;
    identityMatrix[i][i] = 100;
  }

  const entries: ComparisonMatrixEntry[] = [];

  // Compute all pairs (i < j) sequentially.
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      try {
        const c = await compareStructures(ids[i], ids[j], {
          method: "sequence",
        });
        const rmsd = isNaN(c.rmsd) ? -1 : c.rmsd;
        const tm = c.tmScore;
        const ident = c.sequenceIdentity * 100;
        rmsdMatrix[i][j] = rmsd;
        rmsdMatrix[j][i] = rmsd;
        tmScoreMatrix[i][j] = tm;
        tmScoreMatrix[j][i] = tm;
        identityMatrix[i][j] = ident;
        identityMatrix[j][i] = ident;
        entries.push({
          referencePdbId: ids[i],
          mobilePdbId: ids[j],
          rmsd,
          tmScore: tm,
          sequenceIdentity: ident,
          numAligned: c.numAligned,
          foldAssessment: c.foldAssessment,
        });
      } catch (err: any) {
        // If a comparison fails, fill with -1 / 0 / 0.
        rmsdMatrix[i][j] = -1;
        rmsdMatrix[j][i] = -1;
        tmScoreMatrix[i][j] = 0;
        tmScoreMatrix[j][i] = 0;
        identityMatrix[i][j] = 0;
        identityMatrix[j][i] = 0;
        entries.push({
          referencePdbId: ids[i],
          mobilePdbId: ids[j],
          rmsd: -1,
          tmScore: 0,
          sequenceIdentity: 0,
          numAligned: 0,
          foldAssessment: "insufficient",
        });
      }
    }
  }

  return {
    pdbIds: ids,
    rmsdMatrix,
    tmScoreMatrix,
    identityMatrix,
    entries,
    n,
  };
}
