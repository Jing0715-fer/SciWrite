// Pure utilities for parsing PDB text and computing structure superposition.
// All functions are client-safe (no Node APIs) so they can run in the browser.

export interface CAAtom {
  chain: string;
  resSeq: number; // residue sequence number
  resName: string;
  x: number;
  y: number;
  z: number;
}

export interface ParsedPdb {
  ca: CAAtom[];
  chains: string[];
  numAtoms: number;
  numResidues: number;
  title: string;
}

/**
 * Parse PDB text. Extracts TITLE, all ATOM/HETATM records count, unique chains,
 * residue count, and the C-alpha atoms (used for alignment).
 */
export function parsePdb(pdb: string): ParsedPdb {
  // Auto-detect CIF format (mmCIF files start with data_ or contain _atom_site).
  if (pdb.includes("_atom_site.") || pdb.trimStart().startsWith("data_")) {
    return parseCif(pdb);
  }
  const lines = pdb.split(/\r?\n/);
  const ca: CAAtom[] = [];
  const chainSet = new Set<string>();
  const residueSet = new Set<string>();
  let numAtoms = 0;
  let title = "";

  for (const line of lines) {
    const rec = line.substring(0, 6).trim();
    if (rec === "TITLE") {
      // PDB TITLE columns 11-80 may be continued; take the text portion.
      const text = line.substring(10).trim();
      if (text) title = title ? `${title} ${text}` : text;
    } else if (rec === "ATOM" || rec === "HETATM") {
      numAtoms++;
      const chain = line.substring(21, 22).trim() || " ";
      chainSet.add(chain);
      const atomName = line.substring(12, 16).trim();
      const resName = line.substring(17, 20).trim();
      const resSeq = parseInt(line.substring(22, 26), 10);
      // Count polymer residues from ATOM records only (exclude HETATM waters/ligands).
      if (!Number.isNaN(resSeq) && rec === "ATOM") residueSet.add(`${chain}:${resSeq}`);
      if (atomName === "CA" && rec === "ATOM") {
        const x = parseFloat(line.substring(30, 38));
        const y = parseFloat(line.substring(38, 46));
        const z = parseFloat(line.substring(46, 54));
        if (!Number.isNaN(x) && !Number.isNaN(y) && !Number.isNaN(z)) {
          ca.push({ chain, resSeq, resName, x, y, z });
        }
      }
    }
  }

  return {
    ca,
    chains: [...chainSet],
    numAtoms,
    numResidues: residueSet.size,
    title: title.replace(/\s+/g, " ").trim(),
  };
}

/**
 * Parse an mmCIF file. Extracts the same fields as parsePdb (Cα atoms, chains,
 * residue count, atom count, title) from the `_atom_site` loop.
 *
 * mmCIF uses a loop_ structure with column headers like:
 *   _atom_site.group_PDB
 *   _atom_site.label_asym_id   (chain)
 *   _atom_site.auth_asym_id    (author chain — preferred for display)
 *   _atom_site.label_atom_id   (atom name, e.g. "CA")
 *   _atom_site.label_comp_id   (residue name, e.g. "ALA")
 *   _atom_site.auth_seq_id     (author residue number — preferred)
 *   _atom_site.Cartn_x / Cartn_y / Cartn_z
 *   _atom_site.B_iso_or_equiv  (B-factor)
 *
 * We prefer auth_asym_id / auth_seq_id (author numbering) over label_ variants
 * because those match the published PDB numbering users expect.
 */
function parseCif(cif: string): ParsedPdb {
  const lines = cif.split(/\r?\n/);
  const ca: CAAtom[] = [];
  const chainSet = new Set<string>();
  const residueSet = new Set<string>();
  let numAtoms = 0;
  let title = "";

  // Extract title from _struct.title
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("_struct.title")) {
      // Value may be on the same line (quoted) or the next line(s).
      const match = trimmed.match(/^_struct\.title\s+(.+)$/);
      if (match) {
        title = match[1].replace(/^['"]|['"]$/g, "").trim();
      }
      break;
    }
  }

  // Find the _atom_site loop and parse its column layout.
  let inAtomSiteLoop = false;
  let columnIndices: Record<string, number> = {};
  let headerDone = false;
  let inData = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith("loop_")) {
      // Check if the next lines are _atom_site.* headers
      if (lines[i + 1]?.trim().startsWith("_atom_site.")) {
        inAtomSiteLoop = true;
        columnIndices = {};
        headerDone = false;
        inData = false;
        continue;
      }
    }

    if (inAtomSiteLoop && !headerDone) {
      if (trimmed.startsWith("_atom_site.")) {
        const colName = trimmed.split(/\s+/)[0];
        const idx = Object.keys(columnIndices).length;
        columnIndices[colName] = idx;
        continue;
      } else {
        // Headers are done; data starts here.
        headerDone = true;
        inData = true;
      }
    }

    if (inAtomSiteLoop && inData && headerDone) {
      // End of loop: blank line or a new loop_/section.
      if (trimmed === "" || trimmed.startsWith("loop_") || trimmed.startsWith("_") || trimmed.startsWith("data_")) {
        inAtomSiteLoop = false;
        inData = false;
        continue;
      }

      // Parse the data line. Handle quoted values (simple case: single-line quotes).
      const fields = parseCifLine(trimmed);
      if (fields.length < 3) continue;

      const groupPDB = fields[columnIndices["_atom_site.group_PDB"]] || "";
      // Prefer auth_asym_id over label_asym_id for chain.
      const chain = fields[columnIndices["_atom_site.auth_asym_id"]] ||
        fields[columnIndices["_atom_site.label_asym_id"]] || " ";
      const atomName = fields[columnIndices["_atom_site.label_atom_id"]] || "";
      const resName = fields[columnIndices["_atom_site.label_comp_id"]] || "";
      // Prefer auth_seq_id (author numbering) over label_seq_id.
      const resSeqStr = fields[columnIndices["_atom_site.auth_seq_id"]] ||
        fields[columnIndices["_atom_site.label_seq_id"]] || "0";
      const resSeq = parseInt(resSeqStr, 10);

      if (groupPDB === "ATOM" || groupPDB === "HETATM") {
        numAtoms++;
        chainSet.add(chain);
        if (!Number.isNaN(resSeq) && groupPDB === "ATOM") {
          residueSet.add(`${chain}:${resSeq}`);
        }
        if (atomName === "CA" && groupPDB === "ATOM") {
          const x = parseFloat(fields[columnIndices["_atom_site.Cartn_x"]]);
          const y = parseFloat(fields[columnIndices["_atom_site.Cartn_y"]]);
          const z = parseFloat(fields[columnIndices["_atom_site.Cartn_z"]]);
          if (!Number.isNaN(x) && !Number.isNaN(y) && !Number.isNaN(z)) {
            ca.push({ chain, resSeq, resName, x, y, z });
          }
        }
      }
    }
  }

  return {
    ca,
    chains: [...chainSet],
    numAtoms,
    numResidues: residueSet.size,
    title: title.replace(/\s+/g, " ").trim(),
  };
}

/**
 * Parse a single mmCIF data line into fields, handling quoted strings.
 * mmCIF uses single or double quotes for values containing spaces.
 */
function parseCifLine(line: string): string[] {
  const fields: string[] = [];
  let i = 0;
  while (i < line.length) {
    // Skip whitespace.
    while (i < line.length && (line[i] === " " || line[i] === "\t")) i++;
    if (i >= line.length) break;
    if (line[i] === "'" || line[i] === '"') {
      const quote = line[i];
      i++; // skip opening quote
      let val = "";
      while (i < line.length && line[i] !== quote) {
        val += line[i];
        i++;
      }
      i++; // skip closing quote
      fields.push(val);
    } else if (line[i] === ";" && (i === 0 || line[i - 1] === " " || line[i - 1] === "\t")) {
      // Semicolon-delimited multi-line value (rare in _atom_site) — take rest of line.
      i++; // skip semicolon
      let val = "";
      while (i < line.length) {
        val += line[i];
        i++;
      }
      fields.push(val.trim());
    } else {
      // Unquoted token.
      let val = "";
      while (i < line.length && line[i] !== " " && line[i] !== "\t") {
        val += line[i];
        i++;
      }
      fields.push(val);
    }
  }
  return fields;
}

/**
 * Split a multi-model PDB file (NMR ensemble) into individual model texts.
 * Returns an array of PDB text strings, one per MODEL record.
 * If the file has no MODEL records, returns a single-element array with the
 * original text.
 */
export function splitModels(pdb: string): { modelNum: number; pdbText: string }[] {
  const lines = pdb.split(/\r?\n/);
  const models: { modelNum: number; pdbText: string }[] = [];
  let currentModel: number | null = null;
  let currentLines: string[] = [];
  let headerLines: string[] = [];

  for (const line of lines) {
    const rec = line.substring(0, 6).trim();
    if (rec === "MODEL") {
      currentModel = parseInt(line.substring(10, 14), 10) || models.length + 1;
      currentLines = [...headerLines];
    } else if (rec === "ENDMDL") {
      if (currentModel !== null) {
        models.push({ modelNum: currentModel, pdbText: currentLines.join("\n") });
        currentModel = null;
        currentLines = [];
      }
    } else if (currentModel !== null) {
      currentLines.push(line);
    } else {
      // Collect header lines (before first MODEL) to prepend to each model.
      if (rec !== "END" && rec !== "ENDMDL") {
        headerLines.push(line);
      }
    }
  }

  // If no MODEL records found, return the original as a single model.
  if (models.length === 0) {
    return [{ modelNum: 1, pdbText: pdb }];
  }

  return models;
}

/**
 * Match CA atoms of two structures by (chain, resSeq). Returns paired coordinates
 * for the common subset. Falls back to sequential pairing (in chain order) when
 * residue numbers do not overlap, which still gives a reasonable superposition
 * for homologous structures.
 */
export function matchCAAtoms(
  ref: CAAtom[],
  mob: CAAtom[],
  refChain?: string,
  mobChain?: string
): { refCoords: number[][]; mobCoords: number[][]; count: number } {
  const refFiltered = refChain ? ref.filter((a) => a.chain === refChain) : ref;
  const mobFiltered = mobChain ? mob.filter((a) => a.chain === mobChain) : mob;

  const refMap = new Map<string, CAAtom>();
  for (const a of refFiltered) refMap.set(`${a.chain}:${a.resSeq}`, a);

  const refCoords: number[][] = [];
  const mobCoords: number[][] = [];

  for (const m of mobFiltered) {
    const r = refMap.get(`${m.chain}:${m.resSeq}`);
    if (r) {
      refCoords.push([r.x, r.y, r.z]);
      mobCoords.push([m.x, m.y, m.z]);
    }
  }

  // Fallback: if no residue-number overlap, pair sequentially by order.
  if (refCoords.length < 3 && refFiltered.length && mobFiltered.length) {
    refCoords.length = 0;
    mobCoords.length = 0;
    const n = Math.min(refFiltered.length, mobFiltered.length);
    for (let i = 0; i < n; i++) {
      const r = refFiltered[i];
      const m = mobFiltered[i];
      refCoords.push([r.x, r.y, r.z]);
      mobCoords.push([m.x, m.y, m.z]);
    }
  }

  return { refCoords, mobCoords, count: refCoords.length };
}

// Simplified BLOSUM62 substitution matrix (20 standard amino acids).
// Scores for matching/mismatching residues — used for sequence alignment.
const BLOSUM62: Record<string, Record<string, number>> = {
  A: { A: 4, R: -1, N: -2, D: -2, C: 0, Q: -1, E: -1, G: 0, H: -2, I: -1, L: -1, K: -1, M: -1, F: -2, P: -1, S: 1, T: 0, W: -3, Y: -2, V: 0 },
  R: { A: -1, R: 5, N: 0, D: -2, C: -3, Q: 1, E: 0, G: -2, H: 0, I: -3, L: -2, K: 2, M: -1, F: -3, P: -2, S: -1, T: -1, W: -3, Y: -2, V: -3 },
  N: { A: -2, R: 0, N: 6, D: 1, C: -3, Q: 0, E: 0, G: 0, H: 1, I: -3, L: -3, K: 0, M: -2, F: -3, P: -2, S: 1, T: 0, W: -4, Y: -2, V: -3 },
  D: { A: -2, R: -2, N: 1, D: 6, C: -3, Q: 0, E: 2, G: -1, H: -1, I: -3, L: -4, K: -1, M: -3, F: -3, P: -1, S: 0, T: -1, W: -4, Y: -3, V: -3 },
  C: { A: 0, R: -3, N: -3, D: -3, C: 9, Q: -3, E: -4, G: -3, H: -3, I: -1, L: -1, K: -3, M: -1, F: -2, P: -3, S: -1, T: -1, W: -2, Y: -2, V: -1 },
  Q: { A: -1, R: 1, N: 0, D: 0, C: -3, Q: 5, E: 2, G: -2, H: 0, I: -3, L: -2, K: 1, M: 0, F: -3, P: -1, S: 0, T: -1, W: -2, Y: -1, V: -2 },
  E: { A: -1, R: 0, N: 0, D: 2, C: -4, Q: 2, E: 5, G: -2, H: 0, I: -3, L: -3, K: 1, M: -2, F: -3, P: -1, S: 0, T: -1, W: -3, Y: -2, V: -2 },
  G: { A: 0, R: -2, N: 0, D: -1, C: -3, Q: -2, E: -2, G: 6, H: -2, I: -4, L: -4, K: -2, M: -3, F: -3, P: -2, S: 0, T: -2, W: -2, Y: -3, V: -3 },
  H: { A: -2, R: 0, N: 1, D: -1, C: -3, Q: 0, E: 0, G: -2, H: 8, I: -3, L: -3, K: -1, M: -2, F: -1, P: -2, S: -1, T: -2, W: -2, Y: 2, V: -3 },
  I: { A: -1, R: -3, N: -3, D: -3, C: -1, Q: -3, E: -3, G: -4, H: -3, I: 4, L: 2, K: -3, M: 1, F: 0, P: -3, S: -2, T: -1, W: -3, Y: -1, V: 3 },
  L: { A: -1, R: -2, N: -3, D: -4, C: -1, Q: -2, E: -3, G: -4, H: -3, I: 2, L: 4, K: -2, M: 2, F: 0, P: -3, S: -2, T: -1, W: -2, Y: -1, V: 1 },
  K: { A: -1, R: 2, N: 0, D: -1, C: -3, Q: 1, E: 1, G: -2, H: -1, I: -3, L: -2, K: 5, M: -1, F: -3, P: -1, S: 0, T: -1, W: -3, Y: -2, V: -2 },
  M: { A: -1, R: -1, N: -2, D: -3, C: -1, Q: 0, E: -2, G: -3, H: -2, I: 1, L: 2, K: -1, M: 5, F: 0, P: -2, S: -1, T: -1, W: -1, Y: -1, V: 1 },
  F: { A: -2, R: -3, N: -3, D: -3, C: -2, Q: -3, E: -3, G: -3, H: -1, I: 0, L: 0, K: -3, M: 0, F: 6, P: -4, S: -2, T: -2, W: 1, Y: 3, V: -1 },
  P: { A: -1, R: -2, N: -2, D: -1, C: -3, Q: -1, E: -1, G: -2, H: -2, I: -3, L: -3, K: -1, M: -2, F: -4, P: 7, S: -1, T: -1, W: -4, Y: -3, V: -2 },
  S: { A: 1, R: -1, N: 1, D: 0, C: -1, Q: 0, E: 0, G: 0, H: -1, I: -2, L: -2, K: 0, M: -1, F: -2, P: -1, S: 4, T: 1, W: -3, Y: -2, V: -2 },
  T: { A: 0, R: -1, N: 0, D: -1, C: -1, Q: -1, E: -1, G: -2, H: -2, I: -1, L: -1, K: -1, M: -1, F: -2, P: -1, S: 1, T: 5, W: -2, Y: -2, V: 0 },
  W: { A: -3, R: -3, N: -4, D: -4, C: -2, Q: -2, E: -3, G: -2, H: -2, I: -3, L: -2, K: -3, M: -1, F: 1, P: -4, S: -3, T: -2, W: 11, Y: 2, V: -3 },
  Y: { A: -2, R: -2, N: -2, D: -3, C: -2, Q: -1, E: -2, G: -3, H: 2, I: -1, L: -1, K: -2, M: -1, F: 3, P: -3, S: -2, T: -2, W: 2, Y: 7, V: -1 },
  V: { A: 0, R: -3, N: -3, D: -3, C: -1, Q: -2, E: -2, G: -3, H: -3, I: 3, L: 1, K: -2, M: 1, F: -1, P: -2, S: -2, T: 0, W: -3, Y: -1, V: 4 },
};

/**
 * Smith-Waterman local sequence alignment.
 * Returns aligned pairs of indices (refIdx, mobIdx) for matched positions.
 */
function smithWaterman(
  seq1: string,
  seq2: string,
  gapPenalty = -5
): { pairs: [number, number][]; score: number } {
  const m = seq1.length;
  const n = seq2.length;
  if (m === 0 || n === 0) return { pairs: [], score: 0 };

  // DP matrix.
  const H: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  const trace: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  // trace: 0=stop, 1=diag (match), 2=up (gap in seq2), 3=left (gap in seq1)

  let maxScore = 0;
  let maxI = 0;
  let maxJ = 0;

  for (let i = 1; i <= m; i++) {
    const a = seq1[i - 1];
    const row_a = BLOSUM62[a];
    for (let j = 1; j <= n; j++) {
      const b = seq2[j - 1];
      const subScore = row_a ? (row_a[b] ?? -4) : -4;
      const diag = H[i - 1][j - 1] + subScore;
      const up = H[i - 1][j] + gapPenalty;
      const left = H[i][j - 1] + gapPenalty;
      const best = Math.max(0, diag, up, left);
      H[i][j] = best;
      if (best === 0) trace[i][j] = 0;
      else if (best === diag) trace[i][j] = 1;
      else if (best === up) trace[i][j] = 2;
      else trace[i][j] = 3;

      if (best > maxScore) {
        maxScore = best;
        maxI = i;
        maxJ = j;
      }
    }
  }

  // Traceback from max.
  const pairs: [number, number][] = [];
  let i = maxI;
  let j = maxJ;
  while (i > 0 && j > 0 && H[i][j] > 0) {
    if (trace[i][j] === 1) {
      pairs.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (trace[i][j] === 2) {
      i--;
    } else {
      j--;
    }
  }

  pairs.reverse();
  return { pairs, score: maxScore };
}

/**
 * Needleman-Wunsch global sequence alignment.
 * Aligns the full length of both sequences (unlike Smith-Waterman which finds
 * the best local match). Better for comparing homologous structures where we
 * want to find the correspondence between ALL residues, not just a high-scoring
 * subregion. Avoids issues with internal sequence repeats.
 */
function needlemanWunsch(
  seq1: string,
  seq2: string,
  gapPenalty = -5
): { pairs: [number, number][]; score: number; identity: number } {
  const m = seq1.length;
  const n = seq2.length;
  if (m === 0 || n === 0) return { pairs: [], score: 0, identity: 0 };

  // DP matrix — no zeroing (global alignment, not local).
  const H: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  const trace: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  // trace: 0=stop (only for [0,0]), 1=diag (match), 2=up (gap in seq2), 3=left (gap in seq1)

  // Initialize first row and column with gap penalties.
  for (let i = 0; i <= m; i++) H[i][0] = i * gapPenalty;
  for (let j = 0; j <= n; j++) H[0][j] = j * gapPenalty;

  for (let i = 1; i <= m; i++) {
    const a = seq1[i - 1];
    const row_a = BLOSUM62[a];
    for (let j = 1; j <= n; j++) {
      const b = seq2[j - 1];
      const subScore = row_a ? (row_a[b] ?? -4) : -4;
      const diag = H[i - 1][j - 1] + subScore;
      const up = H[i - 1][j] + gapPenalty;
      const left = H[i][j - 1] + gapPenalty;
      // Global: take the best of the three (no zero option).
      let best = diag;
      let dir = 1;
      if (up > best) { best = up; dir = 2; }
      if (left > best) { best = left; dir = 3; }
      H[i][j] = best;
      trace[i][j] = dir;
    }
  }

  // Traceback from [m, n] to [0, 0].
  const pairs: [number, number][] = [];
  let i = m;
  let j = n;
  let identical = 0;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && trace[i][j] === 1) {
      pairs.push([i - 1, j - 1]);
      if (seq1[i - 1] === seq2[j - 1]) identical++;
      i--;
      j--;
    } else if (i > 0 && (j === 0 || trace[i][j] === 2)) {
      i--; // gap in seq2
    } else {
      j--; // gap in seq1
    }
  }

  pairs.reverse();
  const identity = pairs.length > 0 ? identical / pairs.length : 0;
  return { pairs, score: H[m][n], identity };
}

/**
 * Match CA atoms by sequence alignment.
 * Tries both Smith-Waterman (local) and Needleman-Wunsch (global) alignments,
 * and picks the one with the better (lower) RMSD after Kabsch superposition.
 * Used when residue numbers don't overlap or produce poor alignment.
 */
export function matchCABySequence(
  ref: CAAtom[],
  mob: CAAtom[],
  refChain?: string,
  mobChain?: string
): {
  refCoords: number[][];
  mobCoords: number[][];
  count: number;
  alignScore: number;
  pairs?: [number, number][];
  refSeq?: string;
  mobSeq?: string;
} {
  const refFiltered = refChain ? ref.filter((a) => a.chain === refChain) : ref;
  const mobFiltered = mobChain ? mob.filter((a) => a.chain === mobChain) : mob;

  if (refFiltered.length < 3 || mobFiltered.length < 3) {
    return { refCoords: [], mobCoords: [], count: 0, alignScore: 0 };
  }

  // Build single-letter sequences from resName.
  const toSeq = (atoms: CAAtom[]) =>
    atoms.map((a) => AA3TO1[a.resName] || "X").join("");

  const seq1 = toSeq(refFiltered);
  const seq2 = toSeq(mobFiltered);

  // Helper: convert pairs to coordinate arrays.
  const pairsToCoords = (pairs: [number, number][]) => {
    const rc: number[][] = [];
    const mc: number[][] = [];
    for (const [ri, mi] of pairs) {
      const r = refFiltered[ri];
      const m = mobFiltered[mi];
      rc.push([r.x, r.y, r.z]);
      mc.push([m.x, m.y, m.z]);
    }
    return { refCoords: rc, mobCoords: mc };
  };

  // Run both local (Smith-Waterman) and global (Needleman-Wunsch) alignments.
  const swResult = smithWaterman(seq1, seq2);
  const nwResult = needlemanWunsch(seq1, seq2);

  const swCoords = pairsToCoords(swResult.pairs);
  const nwCoords = pairsToCoords(nwResult.pairs);

  // Pick the alignment with lower RMSD after Kabsch superposition.
  // If both have enough pairs, compare RMSD; otherwise pick the one with more pairs.
  let bestCoords = swCoords;
  let bestScore = swResult.score;
  let bestCount = swCoords.refCoords.length;
  let bestPairs = swResult.pairs;
  let bestMethod: "sw" | "nw" = "sw";

  if (nwCoords.refCoords.length >= 3) {
    const nwKabsch = kabsch(nwCoords.refCoords, nwCoords.mobCoords);
    if (nwKabsch) {
      if (bestCount >= 3) {
        const swKabsch = kabsch(swCoords.refCoords, swCoords.mobCoords);
        // Prefer the alignment with lower RMSD (if both have ≥3 pairs).
        if (!swKabsch || nwKabsch.rmsd < swKabsch.rmsd) {
          bestCoords = nwCoords;
          bestScore = nwResult.score;
          bestCount = nwCoords.refCoords.length;
          bestPairs = nwResult.pairs;
          bestMethod = "nw";
        }
      } else {
        bestCoords = nwCoords;
        bestScore = nwResult.score;
        bestCount = nwCoords.refCoords.length;
        bestPairs = nwResult.pairs;
        bestMethod = "nw";
      }
    }
  }

  return {
    refCoords: bestCoords.refCoords,
    mobCoords: bestCoords.mobCoords,
    count: bestCount,
    alignScore: bestScore,
    pairs: bestPairs,
    refSeq: bestMethod === "nw" ? seq1 : seq1,
    mobSeq: bestMethod === "nw" ? seq2 : seq2,
  };
}
function centroid(points: number[][]): number[] {
  const n = points.length;
  if (n === 0) return [0, 0, 0];
  let sx = 0,
    sy = 0,
    sz = 0;
  for (const p of points) {
    sx += p[0];
    sy += p[1];
    sz += p[2];
  }
  return [sx / n, sy / n, sz / n];
}

/**
 * Multiply two matrices (m x n) and (n x p) -> (m x p).
 */
function matMul(a: number[][], b: number[][]): number[][] {
  const m = a.length;
  const n = b.length;
  const p = b[0].length;
  const out = Array.from({ length: m }, () => new Array(p).fill(0));
  for (let i = 0; i < m; i++) {
    for (let k = 0; k < n; k++) {
      const aik = a[i][k];
      if (aik === 0) continue;
      for (let j = 0; j < p; j++) {
        out[i][j] += aik * b[k][j];
      }
    }
  }
  return out;
}

function transpose(a: number[][]): number[][] {
  const rows = a.length;
  const cols = a[0].length;
  const out = Array.from({ length: cols }, () => new Array(rows).fill(0));
  for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) out[j][i] = a[i][j];
  return out;
}

/**
 * SVD of a 3x3 matrix using the Jacobi eigenvalue iteration on A^T A.
 * Returns { U: 3x3, S: number[3], V: 3x3 } such that A = U * diag(S) * V^T.
 * This is robust enough for the 3x3 covariance matrices we encounter.
 */
function svd3(a: number[][]): { U: number[][]; S: number[]; V: number[][] } {
  // Compute A^T A (3x3 symmetric) -> eigendecomposition gives V and singular values.
  const At = transpose(a);
  const AtA = matMul(At, a);
  const { eigenvectors: V, eigenvalues } = jacobiEigen3(AtA);
  // Singular values are sqrt of eigenvalues (clamp tiny negatives to 0).
  const S = eigenvalues.map((v) => Math.sqrt(Math.max(0, v)));
  // U columns: u_i = A v_i / s_i (for non-zero s_i)
  // Here A is the 3x3 matrix `a`, v_i is the i-th eigenvector (column of V).
  // We compute Av_i directly (matrix-vector product).
  const U: number[][] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < 3; i++) {
    // vi is the i-th column of V (an eigenvector of A^T A).
    const v0 = V[0][i];
    const v1 = V[1][i];
    const v2 = V[2][i];
    // Compute A * vi (3x3 matrix times 3x1 column vector).
    const Av0 = a[0][0] * v0 + a[0][1] * v1 + a[0][2] * v2;
    const Av1 = a[1][0] * v0 + a[1][1] * v1 + a[1][2] * v2;
    const Av2 = a[2][0] * v0 + a[2][1] * v1 + a[2][2] * v2;
    if (S[i] > 1e-10) {
      U[0][i] = Av0 / S[i];
      U[1][i] = Av1 / S[i];
      U[2][i] = Av2 / S[i];
    } else {
      // Degenerate column; pick an arbitrary orthonormal vector later.
      U[0][i] = 0;
      U[1][i] = 0;
      U[2][i] = 0;
    }
  }
  // Ensure U is a proper rotation by orthonormalizing columns.
  orthonormalize3(U);
  return { U, S, V };
}

/** Orthonormalize the columns of a 3x3 matrix in place using Gram-Schmidt. */
function orthonormalize3(m: number[][]) {
  for (let i = 0; i < 3; i++) {
    // v_i = v_i - sum_{j<i} (v_i . v_j) v_j
    for (let j = 0; j < i; j++) {
      let dot = 0;
      for (let r = 0; r < 3; r++) dot += m[r][i] * m[r][j];
      for (let r = 0; r < 3; r++) m[r][i] -= dot * m[r][j];
    }
    // normalize
    let norm = 0;
    for (let r = 0; r < 3; r++) norm += m[r][i] * m[r][i];
    norm = Math.sqrt(norm) || 1;
    for (let r = 0; r < 3; r++) m[r][i] /= norm;
  }
}

/**
 * Jacobi eigenvalue algorithm for a 3x3 symmetric matrix.
 * Returns eigenvectors as columns and eigenvalues in ascending order.
 */
function jacobiEigen3(sym: number[][]): {
  eigenvalues: number[];
  eigenvectors: number[][];
} {
  // Copy into working arrays.
  let a = [
    [sym[0][0], sym[0][1], sym[0][2]],
    [sym[1][0], sym[1][1], sym[1][2]],
    [sym[2][0], sym[2][1], sym[2][2]],
  ];
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];

  const maxIter = 60;
  for (let iter = 0; iter < maxIter; iter++) {
    // Find largest off-diagonal element.
    let p = 0,
      q = 1,
      max = Math.abs(a[0][1]);
    if (Math.abs(a[0][2]) > max) {
      max = Math.abs(a[0][2]);
      p = 0;
      q = 2;
    }
    if (Math.abs(a[1][2]) > max) {
      max = Math.abs(a[1][2]);
      p = 1;
      q = 2;
    }
    if (max < 1e-12) break;

    const app = a[p][p];
    const aqq = a[q][q];
    const apq = a[p][q];
    const phi = 0.5 * Math.atan2(2 * apq, aqq - app);
    const c = Math.cos(phi);
    const s = Math.sin(phi);

    // Rotate.
    for (let i = 0; i < 3; i++) {
      const aiq = a[i][q];
      const aip = a[i][p];
      a[i][p] = c * aip - s * aiq;
      a[i][q] = s * aip + c * aiq;
    }
    for (let j = 0; j < 3; j++) {
      const apj = a[p][j];
      const aqj = a[q][j];
      a[p][j] = c * apj - s * aqj;
      a[q][j] = s * apj + c * aqj;
    }
    for (let i = 0; i < 3; i++) {
      const vip = v[i][p];
      const viq = v[i][q];
      v[i][p] = c * vip - s * viq;
      v[i][q] = s * vip + c * viq;
    }
  }

  const eigenvalues = [a[0][0], a[1][1], a[2][2]];
  // eigenvectors are columns of v
  const eigenvectors = [
    [v[0][0], v[0][1], v[0][2]],
    [v[1][0], v[1][1], v[1][2]],
    [v[2][0], v[2][1], v[2][2]],
  ];
  return { eigenvalues, eigenvectors };
}

export interface KabschResult {
  rotation: number[][]; // 3x3
  translation: number[]; // 3 (pre-subtract mobile centroid, post-add ref centroid)
  rmsd: number;
  transform: number[][]; // 4x4 row-major homogeneous transform applied to mobile
  count: number;
  tmScore: number; // 0..1, >0.5 generally implies same fold
}

/**
 * Kabsch algorithm: compute the optimal rigid-body transform that maps the
 * mobile points onto the reference points (least-squares, RMSD-minimizing).
 * Returns a 4x4 homogeneous transform (row-major) such that:
 *   [x', y', z', 1] = transform @ [x, y, z, 1]
 */
export function kabsch(
  refCoords: number[][],
  mobCoords: number[][]
): KabschResult | null {
  const n = refCoords.length;
  if (n < 3 || n !== mobCoords.length) return null;

  const refC = centroid(refCoords);
  const mobC = centroid(mobCoords);

  // Center both point sets.
  const refCentered = refCoords.map((p) => [p[0] - refC[0], p[1] - refC[1], p[2] - refC[2]]);
  const mobCentered = mobCoords.map((p) => [p[0] - mobC[0], p[1] - mobC[1], p[2] - mobC[2]]);

  // Covariance H = sum mob_i (ref_i)^T  -> 3x3
  // We want R minimizing sum || R*mob - ref ||^2. Standard Kabsch uses H = P^T Q
  // where P = mob, Q = ref. R = V * (det sign) * U^T from SVD of H.
  const H = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < n; i++) {
    const m = mobCentered[i];
    const r = refCentered[i];
    H[0][0] += m[0] * r[0];
    H[0][1] += m[0] * r[1];
    H[0][2] += m[0] * r[2];
    H[1][0] += m[1] * r[0];
    H[1][1] += m[1] * r[1];
    H[1][2] += m[1] * r[2];
    H[2][0] += m[2] * r[0];
    H[2][1] += m[2] * r[1];
    H[2][2] += m[2] * r[2];
  }

  const { U, S, V } = svd3(H);

  // Correct for reflection: d = sign(det(V * U^T))
  const VUt = matMul(V, transpose(U));
  let d = VUt[0][0] * (VUt[1][1] * VUt[2][2] - VUt[1][2] * VUt[2][1]) -
    VUt[0][1] * (VUt[1][0] * VUt[2][2] - VUt[1][2] * VUt[2][0]) +
    VUt[0][2] * (VUt[1][0] * VUt[2][1] - VUt[1][1] * VUt[2][0]);
  d = d > 0 ? 1 : d < 0 ? -1 : 0;

  // Build the reflection correction diagonal.
  const D = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, d],
  ];

  // Rotation: R = V * D * U^T
  const R = matMul(matMul(V, D), transpose(U));

  // Build 4x4 homogeneous transform: x' = R (x - mobC) + refC
  // i.e. x' = R x + (refC - R mobC)
  const t: number[] = [
    refC[0] - (R[0][0] * mobC[0] + R[0][1] * mobC[1] + R[0][2] * mobC[2]),
    refC[1] - (R[1][0] * mobC[0] + R[1][1] * mobC[1] + R[1][2] * mobC[2]),
    refC[2] - (R[2][0] * mobC[0] + R[2][1] * mobC[1] + R[2][2] * mobC[2]),
  ];

  const transform: number[][] = [
    [R[0][0], R[0][1], R[0][2], t[0]],
    [R[1][0], R[1][1], R[1][2], t[1]],
    [R[2][0], R[2][1], R[2][2], t[2]],
    [0, 0, 0, 1],
  ];

  // RMSD over the aligned subset.
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const m = mobCoords[i];
    const mx = R[0][0] * m[0] + R[0][1] * m[1] + R[0][2] * m[2] + t[0];
    const my = R[1][0] * m[0] + R[1][1] * m[1] + R[1][2] * m[2] + t[1];
    const mz = R[2][0] * m[0] + R[2][1] * m[1] + R[2][2] * m[2] + t[2];
    const dx = mx - refCoords[i][0];
    const dy = my - refCoords[i][1];
    const dz = mz - refCoords[i][2];
    sumSq += dx * dx + dy * dy + dz * dz;
  }
  const rmsd = Math.sqrt(sumSq / n);

  // TM-score: a length-normalized similarity metric that is more robust than
  // RMSD for distant homologs. d0 = 1.24*(L-15)^(1/3) - 1.8, clamped to >= 0.5.
  // TM = (1/L) * sum_i [ 1 / (1 + (d_i/d0)^2) ]
  // where L = length of the reference (target) structure and the sum is over
  // all aligned pairs. TM ranges 0..1; >0.5 generally means same fold.
  const Lnorm = n;
  const d0 = Math.max(0.5, 1.24 * Math.pow(Math.max(1, Lnorm - 15), 1 / 3) - 1.8);
  let tmSum = 0;
  for (let i = 0; i < n; i++) {
    const m = mobCoords[i];
    const mx = R[0][0] * m[0] + R[0][1] * m[1] + R[0][2] * m[2] + t[0];
    const my = R[1][0] * m[0] + R[1][1] * m[1] + R[1][2] * m[2] + t[1];
    const mz = R[2][0] * m[0] + R[2][1] * m[1] + R[2][2] * m[2] + t[2];
    const dx = mx - refCoords[i][0];
    const dy = my - refCoords[i][1];
    const dz = mz - refCoords[i][2];
    const d2 = dx * dx + dy * dy + dz * dz;
    tmSum += 1 / (1 + d2 / (d0 * d0));
  }
  const tmScore = tmSum / Lnorm;

  return { rotation: R, translation: t, rmsd, transform, count: n, tmScore };
}

/**
 * Apply a 4x4 homogeneous transform (row-major) to a parsed PDB text and return
 * a new PDB text with transformed ATOM/HETATM coordinate columns. Only the
 * coordinates are rewritten; everything else is preserved.
 */
export function applyTransformToPdb(pdb: string, transform: number[][]): string {
  const R = [
    [transform[0][0], transform[0][1], transform[0][2]],
    [transform[1][0], transform[1][1], transform[1][2]],
    [transform[2][0], transform[2][1], transform[2][2]],
  ];
  const t = [transform[0][3], transform[1][3], transform[2][3]];

  const out: string[] = [];
  const lines = pdb.split(/\r?\n/);
  for (const line of lines) {
    const rec = line.substring(0, 6).trim();
    if (rec === "ATOM" || rec === "HETATM") {
      const x = parseFloat(line.substring(30, 38));
      const y = parseFloat(line.substring(38, 46));
      const z = parseFloat(line.substring(46, 54));
      if (Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(z)) {
        out.push(line);
        continue;
      }
      const nx = R[0][0] * x + R[0][1] * y + R[0][2] * z + t[0];
      const ny = R[1][0] * x + R[1][1] * y + R[1][2] * z + t[1];
      const nz = R[2][0] * x + R[2][1] * y + R[2][2] * z + t[2];
      // Reformat coordinate columns (8.3f) to preserve PDB column alignment.
      const xs = nx.toFixed(3).padStart(8, " ");
      const ys = ny.toFixed(3).padStart(8, " ");
      const zs = nz.toFixed(3).padStart(8, " ");
      out.push(line.substring(0, 30) + xs + ys + zs + line.substring(54));
    } else {
      out.push(line);
    }
  }
  return out.join("\n");
}

/**
 * Extract a compact composition summary from parsed PDB for the analysis panel.
 */
export interface CompositionSummary {
  chains: string[];
  numAtoms: number;
  numResidues: number;
  numWaters: number;
  residueCounts: { resName: string; count: number }[];
  helixCount: number;
  sheetCount: number;
}

export function compositionSummary(pdb: string, parsed: ParsedPdb): CompositionSummary {
  const lines = pdb.split(/\r?\n/);
  let numWaters = 0;
  let helixCount = 0;
  let sheetCount = 0;
  const resMap = new Map<string, number>();
  const chainSet = new Set<string>();

  for (const line of lines) {
    const rec = line.substring(0, 6).trim();
    if (rec === "ATOM" || rec === "HETATM") {
      const resName = line.substring(17, 20).trim();
      const chain = line.substring(21, 22).trim() || " ";
      chainSet.add(chain);
      if (rec === "HETATM" && resName === "HOH") numWaters++;
      else if (rec === "ATOM") {
        resMap.set(resName, (resMap.get(resName) || 0) + 1);
      }
    } else if (rec === "HELIX") {
      helixCount++;
    } else if (rec === "SHEET") {
      sheetCount++;
    }
  }

  const residueCounts = [...resMap.entries()]
    .map(([resName, count]) => ({ resName, count }))
    .sort((a, b) => b.count - a.count);

  return {
    chains: [...chainSet],
    numAtoms: parsed.numAtoms,
    numResidues: parsed.numResidues,
    numWaters,
    residueCounts: residueCounts.slice(0, 20),
    helixCount,
    sheetCount,
  };
}

/** Pretty-print an RMSD value in Ångström. */
export function formatRmsd(rmsd: number): string {
  return `${rmsd.toFixed(3)} Å`;
}

export interface LigandInfo {
  resName: string;
  chain: string;
  resSeq: number;
  numAtoms: number;
  centerX: number;
  centerY: number;
  centerZ: number;
}

/**
 * Detect HETATM ligand records (excluding waters). Returns one entry per
 * unique (resName, chain, resSeq) ligand, with its centroid for "focus" actions.
 */
export function detectLigands(pdb: string): LigandInfo[] {
  // Use the universal atom extractor (works for both PDB and CIF).
  const allAtoms = extractAllAtoms(pdb);
  const map = new Map<string, LigandInfo>();

  for (const atom of allAtoms) {
    if (atom.groupPDB !== "HETATM") continue;
    const resName = atom.resName;
    if (!resName || resName === "HOH") continue;
    const key = `${resName}:${atom.chain}:${atom.resSeq}`;
    const existing = map.get(key);
    if (existing) {
      existing.numAtoms++;
      existing.centerX += atom.x;
      existing.centerY += atom.y;
      existing.centerZ += atom.z;
    } else {
      map.set(key, {
        resName,
        chain: atom.chain,
        resSeq: atom.resSeq,
        numAtoms: 1,
        centerX: atom.x,
        centerY: atom.y,
        centerZ: atom.z,
      });
    }
  }

  // Finalize centroids.
  for (const lig of map.values()) {
    if (lig.numAtoms > 0) {
      lig.centerX /= lig.numAtoms;
      lig.centerY /= lig.numAtoms;
      lig.centerZ /= lig.numAtoms;
    }
  }

  return [...map.values()].sort((a, b) => b.numAtoms - a.numAtoms);
}

/**
 * Find the centroid of all atoms in the structure (for "reset view" focus).
 */
export function structureCentroid(pdb: string): { x: number; y: number; z: number } | null {
  const parsed = parsePdb(pdb);
  if (parsed.ca.length === 0) return null;
  let sx = 0, sy = 0, sz = 0;
  for (const a of parsed.ca) {
    sx += a.x;
    sy += a.y;
    sz += a.z;
  }
  const n = parsed.ca.length;
  return { x: sx / n, y: sy / n, z: sz / n };
}

export interface HBond {
  donorChain: string;
  donorResSeq: number;
  donorResName: string;
  donorAtom: string;
  donorX: number;
  donorY: number;
  donorZ: number;
  acceptorChain: string;
  acceptorResSeq: number;
  acceptorResName: string;
  acceptorAtom: string;
  acceptorX: number;
  acceptorY: number;
  acceptorZ: number;
  distance: number; // Å
}

// Common hydrogen-bond donor atoms (backbone N + sidechain donors).
const HBOND_DONORS = new Set(["N", "ND1", "ND2", "NE", "NE1", "NE2", "NH1", "NH2", "NZ", "OG", "OG1", "OH", "SG"]);
// Common hydrogen-bond acceptor atoms (backbone O + sidechain acceptors).
const HBOND_ACCEPTORS = new Set(["O", "OD1", "OD2", "OE1", "OE2", "OG", "OG1", "OH", "SD", "ND1", "NE2"]);

/**
 * Detect hydrogen bonds in a PDB structure using a simple geometric criterion:
 * donor-acceptor distance ≤ 3.5 Å and donor not in the same residue as acceptor.
 * This is an approximation (no angle check) suitable for visualization.
 */
export function detectHBonds(pdb: string, maxDist = 3.5): HBond[] {
  // Use the universal atom extractor (works for both PDB and CIF).
  const allAtoms = extractAllAtoms(pdb);
  const donors: any[] = [];
  const acceptors: any[] = [];

  for (const atom of allAtoms) {
    const a = { atomName: atom.atomName, resName: atom.resName, chain: atom.chain, resSeq: atom.resSeq, x: atom.x, y: atom.y, z: atom.z };
    if (HBOND_DONORS.has(atom.atomName)) donors.push(a);
    if (HBOND_ACCEPTORS.has(atom.atomName)) acceptors.push(a);
  }

  const bonds: HBond[] = [];
  const seen = new Set<string>();

  for (const d of donors) {
    for (const a of acceptors) {
      // Skip same-residue.
      if (d.chain === a.chain && d.resSeq === a.resSeq) continue;
      // Skip backbone N-O in adjacent residues (those are still valid HBonds, keep them).
      const dx = d.x - a.x;
      const dy = d.y - a.y;
      const dz = d.z - a.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist > maxDist || dist < 1.0) continue;

      // Deduplicate by unordered pair key.
      const key = [`${d.chain}:${d.resSeq}:${d.atomName}`, `${a.chain}:${a.resSeq}:${a.atomName}`]
        .sort()
        .join("|");
      if (seen.has(key)) continue;
      seen.add(key);

      bonds.push({
        donorChain: d.chain,
        donorResSeq: d.resSeq,
        donorResName: d.resName,
        donorAtom: d.atomName,
        donorX: d.x,
        donorY: d.y,
        donorZ: d.z,
        acceptorChain: a.chain,
        acceptorResSeq: a.resSeq,
        acceptorResName: a.resName,
        acceptorAtom: a.atomName,
        acceptorX: a.x,
        acceptorY: a.y,
        acceptorZ: a.z,
        distance: dist,
      });
    }
  }

  return bonds.sort((a, b) => a.distance - b.distance);
}

export interface SecondaryStructureElement {
  type: "helix" | "sheet" | "loop";
  chain: string;
  startResSeq: number;
  endResSeq: number;
  count: number;
}

/**
 * Parse HELIX and SHEET records to extract secondary structure elements.
 */
export function parseSecondaryStructure(pdb: string): SecondaryStructureElement[] {
  // Auto-detect CIF format.
  if (pdb.includes("_struct_conf.") || pdb.includes("_struct_sheet_range.")) {
    return parseSecondaryStructureFromCif(pdb);
  }
  const lines = pdb.split(/\r?\n/);
  const elements: SecondaryStructureElement[] = [];

  for (const line of lines) {
    const rec = line.substring(0, 6).trim();
    if (rec === "HELIX") {
      const chain = line.substring(19, 20).trim() || " ";
      const startResSeq = parseInt(line.substring(21, 25), 10);
      const endResSeq = parseInt(line.substring(33, 37), 10);
      if (!Number.isNaN(startResSeq) && !Number.isNaN(endResSeq)) {
        elements.push({
          type: "helix",
          chain,
          startResSeq,
          endResSeq,
          count: Math.abs(endResSeq - startResSeq) + 1,
        });
      }
    } else if (rec === "SHEET") {
      const chain = line.substring(21, 22).trim() || " ";
      const startResSeq = parseInt(line.substring(22, 26), 10);
      const endResSeq = parseInt(line.substring(33, 37), 10);
      if (!Number.isNaN(startResSeq) && !Number.isNaN(endResSeq)) {
        elements.push({
          type: "sheet",
          chain,
          startResSeq,
          endResSeq,
          count: Math.abs(endResSeq - startResSeq) + 1,
        });
      }
    }
  }

  return elements;
}

/**
 * Parse secondary structure from mmCIF _struct_conf (helices) and
 * _struct_sheet_range (sheets) loops.
 *
 * mmCIF stores helix info in _struct_conf with conf_type_id HELX_P (or
 * HELX_P###), and sheet info in _struct_sheet_range.
 */
function parseSecondaryStructureFromCif(cif: string): SecondaryStructureElement[] {
  const lines = cif.split(/\r?\n/);
  const elements: SecondaryStructureElement[] = [];

  // Parse _struct_conf loop for helices.
  // Columns: _struct_conf.conf_type_id, beg_auth_asym_id, beg_auth_seq_id,
  //          end_auth_asym_id, end_auth_seq_id
  let inStructConf = false;
  let confCols: Record<string, number> = {};
  let confHeaderDone = false;
  let inConfData = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    if (trimmed.startsWith("loop_")) {
      if (lines[i + 1]?.trim().startsWith("_struct_conf.")) {
        inStructConf = true;
        confCols = {};
        confHeaderDone = false;
        inConfData = false;
        continue;
      }
    }

    if (inStructConf && !confHeaderDone) {
      if (trimmed.startsWith("_struct_conf.")) {
        const colName = trimmed.split(/\s+/)[0];
        confCols[colName] = Object.keys(confCols).length;
        continue;
      } else {
        confHeaderDone = true;
        inConfData = true;
      }
    }

    if (inStructConf && inConfData && confHeaderDone) {
      if (trimmed === "" || trimmed.startsWith("loop_") || trimmed.startsWith("_") || trimmed.startsWith("data_")) {
        inStructConf = false;
        inConfData = false;
        continue;
      }
      const fields = parseCifLine(trimmed);
      if (fields.length < 3) continue;
      const confType = fields[confCols["_struct_conf.conf_type_id"]] || "";
      // Only parse helix entries (conf_type_id starts with HELX).
      if (!confType.toUpperCase().startsWith("HELX")) continue;
      const chain = fields[confCols["_struct_conf.beg_auth_asym_id"]] ||
        fields[confCols["_struct_conf.beg_label_asym_id"]] || " ";
      const startResSeq = parseInt(fields[confCols["_struct_conf.beg_auth_seq_id"]] ||
        fields[confCols["_struct_conf.beg_label_seq_id"]] || "0", 10);
      const endResSeq = parseInt(fields[confCols["_struct_conf.end_auth_seq_id"]] ||
        fields[confCols["_struct_conf.end_label_seq_id"]] || "0", 10);
      if (!Number.isNaN(startResSeq) && !Number.isNaN(endResSeq)) {
        elements.push({
          type: "helix",
          chain,
          startResSeq,
          endResSeq,
          count: Math.abs(endResSeq - startResSeq) + 1,
        });
      }
    }
  }

  // Parse _struct_sheet_range loop for sheets.
  let inSheet = false;
  let sheetCols: Record<string, number> = {};
  let sheetHeaderDone = false;
  let inSheetData = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    if (trimmed.startsWith("loop_")) {
      if (lines[i + 1]?.trim().startsWith("_struct_sheet_range.")) {
        inSheet = true;
        sheetCols = {};
        sheetHeaderDone = false;
        inSheetData = false;
        continue;
      }
    }

    if (inSheet && !sheetHeaderDone) {
      if (trimmed.startsWith("_struct_sheet_range.")) {
        const colName = trimmed.split(/\s+/)[0];
        sheetCols[colName] = Object.keys(sheetCols).length;
        continue;
      } else {
        sheetHeaderDone = true;
        inSheetData = true;
      }
    }

    if (inSheet && inSheetData && sheetHeaderDone) {
      if (trimmed === "" || trimmed.startsWith("loop_") || trimmed.startsWith("_") || trimmed.startsWith("data_")) {
        inSheet = false;
        inSheetData = false;
        continue;
      }
      const fields = parseCifLine(trimmed);
      if (fields.length < 3) continue;
      const chain = fields[sheetCols["_struct_sheet_range.beg_auth_asym_id"]] ||
        fields[sheetCols["_struct_sheet_range.beg_label_asym_id"]] || " ";
      const startResSeq = parseInt(fields[sheetCols["_struct_sheet_range.beg_auth_seq_id"]] ||
        fields[sheetCols["_struct_sheet_range.beg_label_seq_id"]] || "0", 10);
      const endResSeq = parseInt(fields[sheetCols["_struct_sheet_range.end_auth_seq_id"]] ||
        fields[sheetCols["_struct_sheet_range.end_label_seq_id"]] || "0", 10);
      if (!Number.isNaN(startResSeq) && !Number.isNaN(endResSeq)) {
        elements.push({
          type: "sheet",
          chain,
          startResSeq,
          endResSeq,
          count: Math.abs(endResSeq - startResSeq) + 1,
        });
      }
    }
  }

  return elements;
}

export interface BackboneAtom {
  chain: string;
  resSeq: number;
  resName: string;
  n?: [number, number, number]; // backbone N
  ca?: [number, number, number]; // C-alpha
  c?: [number, number, number]; // backbone C
}

export interface RamachandranPoint {
  chain: string;
  resSeq: number;
  resName: string;
  phi: number | null; // degrees
  psi: number | null; // degrees
  region: "core" | "allowed" | "generous" | "disallowed";
}

/**
 * Compute phi/psi backbone dihedral angles for each residue.
 * phi(i) = dihedral(C(i-1), N(i), CA(i), C(i))
 * psi(i) = dihedral(N(i), CA(i), C(i), N(i+1))
 */
export function computeRamachandran(pdb: string): RamachandranPoint[] {
  // Use the universal atom extractor (works for both PDB and CIF).
  const allAtoms = extractAllAtoms(pdb);
  const residueMap = new Map<string, BackboneAtom>();

  for (const atom of allAtoms) {
    if (atom.groupPDB && atom.groupPDB !== "ATOM") continue;
    if (atom.atomName !== "N" && atom.atomName !== "CA" && atom.atomName !== "C") continue;
    const key = `${atom.chain}:${atom.resSeq}`;
    if (!residueMap.has(key)) {
      residueMap.set(key, { chain: atom.chain, resSeq: atom.resSeq, resName: atom.resName });
    }
    const res = residueMap.get(key)!;
    if (atom.atomName === "N") res.n = [atom.x, atom.y, atom.z];
    else if (atom.atomName === "CA") res.ca = [atom.x, atom.y, atom.z];
    else if (atom.atomName === "C") res.c = [atom.x, atom.y, atom.z];
  }

  // Sort residues by chain then resSeq.
  const residues = [...residueMap.values()].sort((a, b) => {
    if (a.chain !== b.chain) return a.chain.localeCompare(b.chain);
    return a.resSeq - b.resSeq;
  });

  const points: RamachandranPoint[] = [];

  for (let i = 0; i < residues.length; i++) {
    const cur = residues[i];
    const prev = i > 0 ? residues[i - 1] : null;
    const next = i < residues.length - 1 ? residues[i + 1] : null;

    // phi requires prev C, cur N, cur CA, cur C
    let phi: number | null = null;
    if (prev?.c && cur.n && cur.ca && cur.c) {
      // Only valid if prev and cur are on the same chain (peptide bond).
      if (prev.chain === cur.chain) {
        phi = dihedral(prev.c, cur.n, cur.ca, cur.c);
      }
    }

    // psi requires cur N, cur CA, cur C, next N
    let psi: number | null = null;
    if (cur.n && cur.ca && cur.c && next?.n) {
      if (cur.chain === next.chain) {
        psi = dihedral(cur.n, cur.ca, cur.c, next.n);
      }
    }

    if (phi !== null || psi !== null) {
      points.push({
        chain: cur.chain,
        resSeq: cur.resSeq,
        resName: cur.resName,
        phi,
        psi,
        region: classifyRamachandran(phi, psi, cur.resName),
      });
    }
  }

  return points;
}

/**
 * Classify a (phi, psi) point into Ramachandran regions.
 * Simplified: checks if the point is in the favored alpha-helix / beta-sheet
 * basins. Glycine is treated more permissively.
 */
function classifyRamachandran(
  phi: number | null,
  psi: number | null,
  resName: string
): "core" | "allowed" | "generous" | "disallowed" {
  if (phi === null || psi === null) return "disallowed";
  // Normalize to -180..180.
  const p = ((phi + 180) % 360 + 360) % 360 - 180;
  const s = ((psi + 180) % 360 + 360) % 360 - 180;

  const dist2 = (x: number, y: number) => (p - x) ** 2 + (s - y) ** 2;

  // Alpha helix basin: phi≈-57, psi≈-47
  const dHelix = Math.sqrt(dist2(-57, -47));
  // Beta sheet basin: phi≈-119, psi≈113  (and phi≈-139, psi≈135)
  const dBeta = Math.sqrt(Math.min(dist2(-119, 113), dist2(-139, 135)));
  // Left-handed helix: phi≈57, psi≈47 (rare, mostly Gly)
  const dLHelix = Math.sqrt(dist2(57, 47));

  const isGly = resName === "GLY";
  const minDist = Math.min(dHelix, dBeta, dLHelix);

  if (minDist < 25) return "core";
  if (minDist < 50) return "allowed";
  if (minDist < 80 || (isGly && dLHelix < 100)) return "generous";
  return "disallowed";
}

/**
 * Compute the dihedral angle between 4 points (a-b-c-d) in degrees.
 */
function dihedral(
  a: [number, number, number],
  b: [number, number, number],
  c: [number, number, number],
  d: [number, number, number]
): number {
  const sub = (x: number[], y: number[]) => [x[0] - y[0], x[1] - y[1], x[2] - y[2]];
  const cross = (x: number[], y: number[]) => [
    x[1] * y[2] - x[2] * y[1],
    x[2] * y[0] - x[0] * y[2],
    x[0] * y[1] - x[1] * y[0],
  ];
  const dot = (x: number[], y: number[]) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
  const norm = (x: number[]) => Math.sqrt(dot(x, x));

  const b1 = sub(b, a);
  const b2 = sub(c, b);
  const b3 = sub(d, c);

  const m1 = cross(b1, b2);
  const m2 = cross(b2, b3);
  const x = dot(m1, m2);
  const y = dot(cross(m1, b2), m2) * (1 / (norm(b2) || 1));

  return (Math.atan2(y, x) * 180) / Math.PI;
}

export interface ContactMapPoint {
  i: number; // residue index (0-based)
  j: number;
  distance: number; // Å between Cα atoms
  contact: boolean; // true if distance ≤ threshold
}

/**
 * Compute a Cα-Cα contact map for a structure.
 * Returns pairs (i, j) with i < j and distance ≤ maxDist (default 8 Å).
 */
export function computeContactMap(pdb: string, maxDist = 8): ContactMapPoint[] {
  const parsed = parsePdb(pdb);
  const ca = parsed.ca;
  const points: ContactMapPoint[] = [];
  const maxDistSq = maxDist * maxDist;

  for (let i = 0; i < ca.length; i++) {
    for (let j = i + 1; j < ca.length; j++) {
      const dx = ca[i].x - ca[j].x;
      const dy = ca[i].y - ca[j].y;
      const dz = ca[i].z - ca[j].z;
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq <= maxDistSq) {
        points.push({
          i,
          j,
          distance: Math.sqrt(distSq),
          contact: true,
        });
      }
    }
  }

  return points;
}

export interface SequenceInfo {
  chain: string;
  sequence: string; // one-letter amino acid codes
  length: number;
}

// 3-letter to 1-letter amino acid code mapping.
const AA3TO1: Record<string, string> = {
  ALA: "A", ARG: "R", ASN: "N", ASP: "D", CYS: "C",
  GLN: "Q", GLU: "E", GLY: "G", HIS: "H", ILE: "I",
  LEU: "L", LYS: "K", MET: "M", PHE: "F", PRO: "P",
  SER: "S", THR: "T", TRP: "W", TYR: "Y", VAL: "V",
  MSE: "M", // selenomethionine
  SEC: "U", // selenocysteine
  PYL: "O", // pyrrolysine
};

/**
 * Extract the polymer sequence from SEQRES records (preferred) or ATOM records.
 */
export function extractSequences(pdb: string): SequenceInfo[] {
  // Auto-detect CIF format and try _entity_poly first.
  if (pdb.includes("_entity_poly.") || pdb.includes("_atom_site.")) {
    const cifSeqs = extractSequencesFromCif(pdb);
    if (cifSeqs.length > 0) return cifSeqs;
    // Fall through to ATOM-based extraction below if _entity_poly is empty.
  }
  const lines = pdb.split(/\r?\n/);
  const seqMap = new Map<string, string[]>();

  // First try SEQRES.
  for (const line of lines) {
    if (line.substring(0, 6).trim() !== "SEQRES") continue;
    const chain = line.substring(11, 12).trim() || "A";
    const residues = line.substring(19).trim().split(/\s+/);
    if (!seqMap.has(chain)) seqMap.set(chain, []);
    for (const r of residues) {
      const one = AA3TO1[r] || "X";
      seqMap.get(chain)!.push(one);
    }
  }

  // If no SEQRES, fall back to ATOM records (first occurrence per residue).
  if (seqMap.size === 0) {
    const allAtoms = extractAllAtoms(pdb);
    const seen = new Map<string, string>();
    for (const atom of allAtoms) {
      if (atom.groupPDB && atom.groupPDB !== "ATOM") continue;
      if (atom.atomName !== "CA") continue;
      const key = `${atom.chain}:${atom.resSeq}`;
      if (seen.has(key)) continue;
      seen.set(key, AA3TO1[atom.resName] || "X");
    }
    // Reconstruct per-chain sequences ordered by resSeq.
    const chainResidues = new Map<string, { resSeq: number; aa: string }[]>();
    for (const [key, aa] of seen.entries()) {
      const [chain, resSeqStr] = key.split(":");
      if (!chainResidues.has(chain)) chainResidues.set(chain, []);
      chainResidues.get(chain)!.push({ resSeq: parseInt(resSeqStr), aa });
    }
    for (const [chain, residues] of chainResidues) {
      residues.sort((a, b) => a.resSeq - b.resSeq);
      seqMap.set(chain, residues.map((r) => r.aa));
    }
  }

  return [...seqMap.entries()].map(([chain, seq]) => ({
    chain,
    sequence: seq.join(""),
    length: seq.length,
  }));
}

/**
 * Extract sequences from mmCIF _entity_poly.pdbx_seq_one_letter_code_can.
 * This is the canonical one-letter sequence for each polymer entity.
 */
function extractSequencesFromCif(cif: string): SequenceInfo[] {
  const lines = cif.split(/\r?\n/);
  const results: SequenceInfo[] = [];
  // _entity_poly.pdbx_seq_one_letter_code_can is usually a semicolon-delimited
  // multi-line value. We look for the key and read the value.
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("_entity_poly.pdbx_seq_one_letter_code_can")) {
      // Value may be on the same line or start with ; (multi-line).
      const sameLine = trimmed.match(/^_entity_poly\.pdbx_seq_one_letter_code_can\s+(.+)$/);
      if (sameLine) {
        const val = sameLine[1].replace(/^['";]|['";]$/g, "").trim();
        if (val) {
          // Try to get the entity_id from the same or previous line.
          // We'll just use a generic chain label since entity_poly doesn't
          // directly map to auth_asym_id without _struct_asym.
          results.push({ chain: "?", sequence: val, length: val.length });
        }
      } else if (lines[i + 1]?.trim().startsWith(";")) {
        // Multi-line semicolon-delimited value.
        let seq = "";
        for (let j = i + 2; j < lines.length; j++) {
          if (lines[j].trim() === ";") break;
          seq += lines[j].trim();
        }
        if (seq) {
          results.push({ chain: "?", sequence: seq, length: seq.length });
        }
      }
    }
  }
  // If we got sequences, try to map entity IDs to auth_asym_id via _struct_asym.
  // For simplicity, if we can't map, just label them by index.
  if (results.length > 0) {
    // Try to find _struct_asym loop for entity→chain mapping.
    const asymMap = new Map<string, string>(); // entity_id → auth_asym_id
    let inAsymLoop = false;
    let asymCols: Record<string, number> = {};
    let asymHeaderDone = false;
    let inAsymData = false;
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (trimmed.startsWith("loop_")) {
        if (lines[i + 1]?.trim().startsWith("_struct_asym.")) {
          inAsymLoop = true;
          asymCols = {};
          asymHeaderDone = false;
          inAsymData = false;
          continue;
        }
      }
      if (inAsymLoop && !asymHeaderDone) {
        if (trimmed.startsWith("_struct_asym.")) {
          const colName = trimmed.split(/\s+/)[0];
          asymCols[colName] = Object.keys(asymCols).length;
          continue;
        } else {
          asymHeaderDone = true;
          inAsymData = true;
        }
      }
      if (inAsymLoop && inAsymData && asymHeaderDone) {
        if (trimmed === "" || trimmed.startsWith("loop_") || trimmed.startsWith("_") || trimmed.startsWith("data_")) {
          inAsymLoop = false;
          inAsymData = false;
          continue;
        }
        const fields = parseCifLine(trimmed);
        const entityId = fields[asymCols["_struct_asym.entity_id"]] || "";
        // auth_asym_id isn't in _struct_asym; we'd need _atom_site mapping.
        // For simplicity, use label_asym_id as the chain label.
        const asymId = fields[asymCols["_struct_asym.id"]] || entityId;
        if (entityId) asymMap.set(entityId, asymId);
      }
    }
    // Relabel sequences with chain IDs if we have a mapping.
    // Since _entity_poly rows are ordered by entity_id, we map by index.
    const entityIds = [...asymMap.keys()].sort();
    results.forEach((r, idx) => {
      if (idx < entityIds.length) {
        r.chain = asymMap.get(entityIds[idx]) || String.fromCharCode(65 + idx);
      } else {
        r.chain = String.fromCharCode(65 + idx);
      }
    });
  }
  return results;
}

// Van der Waals radii (Å) for common atoms — used for SASA and clash detection.
const VDW_RADII: Record<string, number> = {
  H: 1.2, C: 1.7, N: 1.55, O: 1.52, S: 1.8, P: 1.8,
  F: 1.47, CL: 1.75, BR: 1.85, I: 1.98,
  FE: 2.0, ZN: 1.39, CA: 2.31, MG: 1.73, MN: 2.05, CU: 1.4, NA: 2.27, K: 2.75,
  // Default for unknown
};

export interface AtomInfo {
  serial: number;
  atomName: string;
  resName: string;
  chain: string;
  resSeq: number;
  x: number;
  y: number;
  z: number;
  element: string;
  vdwRadius: number;
  isBackbone: boolean;
  bfactor?: number; // B-factor / temperature factor (added for CIF support)
  groupPDB?: string; // "ATOM" or "HETATM" (added for CIF support)
}

/**
 * Extract all atoms with element info and VDW radii from PDB or CIF text.
 * Auto-detects format and delegates to the appropriate parser.
 */
export function extractAllAtoms(pdb: string): AtomInfo[] {
  // Auto-detect CIF format.
  if (pdb.includes("_atom_site.") || pdb.trimStart().startsWith("data_")) {
    return extractAllAtomsFromCif(pdb);
  }
  const lines = pdb.split(/\r?\n/);
  const atoms: AtomInfo[] = [];

  for (const line of lines) {
    const rec = line.substring(0, 6).trim();
    if (rec !== "ATOM" && rec !== "HETATM") continue;
    const serial = parseInt(line.substring(6, 11), 10) || 0;
    const atomName = line.substring(12, 16).trim();
    const resName = line.substring(17, 20).trim();
    const chain = line.substring(21, 22).trim() || " ";
    const resSeq = parseInt(line.substring(22, 26), 10) || 0;
    const x = parseFloat(line.substring(30, 38));
    const y = parseFloat(line.substring(38, 46));
    const z = parseFloat(line.substring(46, 54));
    if (Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(z)) continue;
    const bfactor = parseFloat(line.substring(60, 66));

    // Element: columns 77-78 if present, else infer from atom name.
    let element = line.substring(76, 78).trim();
    if (!element) {
      // Infer from atom name: first non-digit char(s), capitalized.
      const nameClean = atomName.replace(/[^A-Za-z]/g, "");
      element = nameClean.length >= 2
        ? nameClean.substring(0, 2).toUpperCase()
        : nameClean.substring(0, 1).toUpperCase();
    }

    const vdwRadius = VDW_RADII[element] || VDW_RADII[element[0]] || 1.7;

    // Backbone atoms: N, CA, C, O (typical protein backbone).
    const isBackbone = ["N", "CA", "C", "O", "OXT"].includes(atomName);

    atoms.push({ serial, atomName, resName, chain, resSeq, x, y, z, element, vdwRadius, isBackbone, bfactor: Number.isNaN(bfactor) ? undefined : bfactor, groupPDB: rec });
  }

  return atoms;
}

/**
 * Extract all atoms from an mmCIF file. Parses the _atom_site loop and returns
 * the same AtomInfo[] format as extractAllAtoms, including B-factor and
 * group_PDB (ATOM/HETATM).
 */
function extractAllAtomsFromCif(cif: string): AtomInfo[] {
  const lines = cif.split(/\r?\n/);
  const atoms: AtomInfo[] = [];
  let inAtomSiteLoop = false;
  let columnIndices: Record<string, number> = {};
  let headerDone = false;
  let inData = false;
  let serial = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith("loop_")) {
      if (lines[i + 1]?.trim().startsWith("_atom_site.")) {
        inAtomSiteLoop = true;
        columnIndices = {};
        headerDone = false;
        inData = false;
        continue;
      }
    }

    if (inAtomSiteLoop && !headerDone) {
      if (trimmed.startsWith("_atom_site.")) {
        const colName = trimmed.split(/\s+/)[0];
        const idx = Object.keys(columnIndices).length;
        columnIndices[colName] = idx;
        continue;
      } else {
        headerDone = true;
        inData = true;
      }
    }

    if (inAtomSiteLoop && inData && headerDone) {
      if (trimmed === "" || trimmed.startsWith("loop_") || trimmed.startsWith("_") || trimmed.startsWith("data_")) {
        inAtomSiteLoop = false;
        inData = false;
        continue;
      }

      const fields = parseCifLine(trimmed);
      if (fields.length < 3) continue;

      const groupPDB = fields[columnIndices["_atom_site.group_PDB"]] || "ATOM";
      const chain = fields[columnIndices["_atom_site.auth_asym_id"]] ||
        fields[columnIndices["_atom_site.label_asym_id"]] || " ";
      const atomName = fields[columnIndices["_atom_site.label_atom_id"]] || "";
      const resName = fields[columnIndices["_atom_site.label_comp_id"]] || "";
      const resSeqStr = fields[columnIndices["_atom_site.auth_seq_id"]] ||
        fields[columnIndices["_atom_site.label_seq_id"]] || "0";
      const resSeq = parseInt(resSeqStr, 10) || 0;
      const x = parseFloat(fields[columnIndices["_atom_site.Cartn_x"]]);
      const y = parseFloat(fields[columnIndices["_atom_site.Cartn_y"]]);
      const z = parseFloat(fields[columnIndices["_atom_site.Cartn_z"]]);
      if (Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(z)) continue;

      // B-factor
      const bfactorStr = fields[columnIndices["_atom_site.B_iso_or_equiv"]] || "";
      const bfactor = bfactorStr ? parseFloat(bfactorStr) : NaN;

      // Element
      let element = (fields[columnIndices["_atom_site.type_symbol"]] || "").trim();
      if (!element) {
        const nameClean = atomName.replace(/[^A-Za-z]/g, "");
        element = nameClean.length >= 2
          ? nameClean.substring(0, 2).toUpperCase()
          : nameClean.substring(0, 1).toUpperCase();
      }

      const vdwRadius = VDW_RADII[element] || VDW_RADII[element[0]] || 1.7;
      const isBackbone = ["N", "CA", "C", "O", "OXT"].includes(atomName);

      atoms.push({
        serial: serial++,
        atomName,
        resName,
        chain,
        resSeq,
        x, y, z,
        element,
        vdwRadius,
        isBackbone,
        bfactor: Number.isNaN(bfactor) ? undefined : bfactor,
        groupPDB,
      });
    }
  }

  return atoms;
}

export interface ResidueSASA {
  chain: string;
  resSeq: number;
  resName: string;
  sasa: number; // Å²
  normalizedSasa: number; // 0..1 relative to max in this structure
  exposure: "buried" | "intermediate" | "exposed";
}

/**
 * Approximate per-residue SASA using a simple shrake-rupley-like approach.
 * For each residue's CA atom, count how many test points on a sphere around it
 * are not occluded by other atoms. This is a fast approximation suitable for
 * visualization (not publication-grade).
 *
 * @param pdb PDB text
 * @param probeRadius Water probe radius (default 1.4 Å)
 * @param numPoints Number of test points per residue (default 50, more = slower but accurate)
 */
export function computeSASA(
  pdb: string,
  probeRadius = 1.4,
  numPoints = 50
): ResidueSASA[] {
  const atoms = extractAllAtoms(pdb);
  const caAtoms = atoms.filter((a) => a.atomName === "CA" && a.isBackbone);

  if (caAtoms.length === 0) return [];

  // Precompute neighbor list: for each CA, find atoms within a cutoff.
  const cutoff = 15; // Å — only check atoms within this distance
  const results: ResidueSASA[] = [];
  let maxSasa = 0;

  // Generate Fibonacci sphere points for even distribution.
  const points: [number, number, number][] = [];
  const golden = (1 + Math.sqrt(5)) / 2;
  for (let i = 0; i < numPoints; i++) {
    const t = i / numPoints;
    const phi = Math.acos(1 - 2 * t);
    const theta = 2 * Math.PI * i / golden;
    points.push([
      Math.sin(phi) * Math.cos(theta),
      Math.sin(phi) * Math.sin(theta),
      Math.cos(phi),
    ]);
  }

  for (const ca of caAtoms) {
    // Test sphere radius = CA VDW + probe
    const testRadius = ca.vdwRadius + probeRadius + 3; // extend to sample neighborhood
    let accessible = 0;

    for (const [px, py, pz] of points) {
      const tx = ca.x + px * testRadius;
      const ty = ca.y + py * testRadius;
      const tz = ca.z + pz * testRadius;

      // Check if this test point is occluded by any other atom.
      let occluded = false;
      for (const other of atoms) {
        if (other.serial === ca.serial) continue;
        const dx = tx - other.x;
        const dy = ty - other.y;
        const dz = tz - other.z;
        const distSq = dx * dx + dy * dy + dz * dz;
        const occRadius = other.vdwRadius + probeRadius;
        if (distSq < occRadius * occRadius) {
          occluded = true;
          break;
        }
        // Early exit if too far (optimization).
        if (distSq > cutoff * cutoff) continue;
      }

      if (!occluded) accessible++;
    }

    // SASA proportional to fraction of accessible points × sphere area.
    const fraction = accessible / numPoints;
    const sphereArea = 4 * Math.PI * testRadius * testRadius;
    const sasa = fraction * sphereArea;

    if (sasa > maxSasa) maxSasa = sasa;

    results.push({
      chain: ca.chain,
      resSeq: ca.resSeq,
      resName: ca.resName,
      sasa,
      normalizedSasa: 0, // filled in after max known
      exposure: "intermediate",
    });
  }

  // Normalize + classify.
  for (const r of results) {
    r.normalizedSasa = maxSasa > 0 ? r.sasa / maxSasa : 0;
    if (r.normalizedSasa < 0.25) r.exposure = "buried";
    else if (r.normalizedSasa > 0.6) r.exposure = "exposed";
    else r.exposure = "intermediate";
  }

  return results;
}

export interface ClashInfo {
  atom1: AtomInfo;
  atom2: AtomInfo;
  distance: number;
  overlap: number; // Å of overlap (sum of VDW radii - distance)
  severity: "minor" | "moderate" | "severe";
}

/**
 * Detect steric clashes: atom pairs where distance < sum of VDW radii - tolerance.
 */
export function detectClashes(pdb: string, tolerance = 0.4): ClashInfo[] {
  const atoms = extractAllAtoms(pdb);
  const clashes: ClashInfo[] = [];
  const cutoff = 4; // Å — only check pairs closer than this

  // O(n²) but with cutoff optimization. For large structures, consider spatial hashing.
  for (let i = 0; i < atoms.length; i++) {
    for (let j = i + 1; j < atoms.length; j++) {
      const a = atoms[i];
      const b = atoms[j];
      // Skip atoms in the same residue (bonded).
      if (a.chain === b.chain && a.resSeq === b.resSeq) continue;

      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const dz = a.z - b.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq > cutoff * cutoff) continue;

      const dist = Math.sqrt(distSq);
      const vdwSum = a.vdwRadius + b.vdwRadius;
      const overlap = vdwSum - dist - tolerance;

      if (overlap > 0) {
        clashes.push({
          atom1: a,
          atom2: b,
          distance: dist,
          overlap,
          severity: overlap > 1.0 ? "severe" : overlap > 0.5 ? "moderate" : "minor",
        });
      }
    }
  }

  return clashes.sort((a, b) => b.overlap - a.overlap);
}

export interface BondStats {
  count: number;
  meanLength: number;
  minLength: number;
  maxLength: number;
  outliers: { atom1: AtomInfo; atom2: AtomInfo; length: number; expected: number }[];
}

/**
 * Compute backbone bond length statistics (N-CA, CA-C, C-N).
 * Identifies bonds that deviate significantly from expected values.
 */
export function computeBondStats(pdb: string): {
  nCa: BondStats;
  caC: BondStats;
  cN: BondStats;
} {
  const atoms = extractAllAtoms(pdb);
  // Group by residue.
  const residueMap = new Map<string, { n?: AtomInfo; ca?: AtomInfo; c?: AtomInfo }>();
  for (const a of atoms) {
    if (!["N", "CA", "C"].includes(a.atomName)) continue;
    const key = `${a.chain}:${a.resSeq}`;
    if (!residueMap.has(key)) residueMap.set(key, {});
    const res = residueMap.get(key)!;
    if (a.atomName === "N") res.n = a;
    else if (a.atomName === "CA") res.ca = a;
    else if (a.atomName === "C") res.c = a;
  }

  const residues = [...residueMap.values()];

  const computeStats = (
    pairs: { a: AtomInfo; b: AtomInfo }[],
    expected: number
  ): BondStats => {
    if (pairs.length === 0) {
      return { count: 0, meanLength: 0, minLength: 0, maxLength: 0, outliers: [] };
    }
    const lengths = pairs.map((p) => {
      const dx = p.a.x - p.b.x;
      const dy = p.a.y - p.b.y;
      const dz = p.a.z - p.b.z;
      return Math.sqrt(dx * dx + dy * dy + dz * dz);
    });
    const mean = lengths.reduce((s, l) => s + l, 0) / lengths.length;
    const min = Math.min(...lengths);
    const max = Math.max(...lengths);
    const outliers = pairs
      .map((p, i) => ({ atom1: p.a, atom2: p.b, length: lengths[i], expected }))
      .filter((o) => Math.abs(o.length - expected) > 0.3); // >0.3 Å deviation
    return { count: lengths.length, meanLength: mean, minLength: min, maxLength: max, outliers };
  };

  // N-CA and CA-C within each residue.
  const nCaPairs: { a: AtomInfo; b: AtomInfo }[] = [];
  const caCPairs: { a: AtomInfo; b: AtomInfo }[] = [];
  for (const res of residues) {
    if (res.n && res.ca) nCaPairs.push({ a: res.n, b: res.ca });
    if (res.ca && res.c) caCPairs.push({ a: res.ca, b: res.c });
  }

  // C-N between consecutive residues (peptide bond).
  const cNPairs: { a: AtomInfo; b: AtomInfo }[] = [];
  // Iterate atoms in order and find C-N pairs across residues.
  const atomByChainRes = new Map<string, { n?: AtomInfo; c?: AtomInfo }>();
  for (const a of atoms) {
    if (a.atomName !== "N" && a.atomName !== "C") continue;
    const key = `${a.chain}:${a.resSeq}`;
    if (!atomByChainRes.has(key)) atomByChainRes.set(key, {});
    const entry = atomByChainRes.get(key)!;
    if (a.atomName === "N") entry.n = a;
    else entry.c = a;
  }
  // Sort by resSeq per chain.
  const chainResidues = new Map<string, { resSeq: number; n?: AtomInfo; c?: AtomInfo }[]>();
  for (const [key, entry] of atomByChainRes.entries()) {
    const [chain, resSeqStr] = key.split(":");
    if (!chainResidues.has(chain)) chainResidues.set(chain, []);
    chainResidues.get(chain)!.push({ resSeq: parseInt(resSeqStr), ...entry });
  }
  for (const [, list] of chainResidues) {
    list.sort((a, b) => a.resSeq - b.resSeq);
    for (let i = 0; i < list.length - 1; i++) {
      if (list[i].c && list[i + 1].n) {
        cNPairs.push({ a: list[i].c!, b: list[i + 1].n! });
      }
    }
  }

  return {
    nCa: computeStats(nCaPairs, 1.46), // expected N-CA ~1.46 Å
    caC: computeStats(caCPairs, 1.52), // expected CA-C ~1.52 Å
    cN: computeStats(cNPairs, 1.33),   // expected C-N (peptide) ~1.33 Å
  };
}

/**
 * Format a Smith-Waterman alignment as a text string for export.
 * Shows the two sequences with match indicators.
 */
export function formatAlignmentText(
  seq1: string,
  seq2: string,
  pairs: [number, number][]
): string {
  const lines: string[] = [];
  let line1 = "";
  let line2 = "";
  let match = "";

  let i1 = 0;
  let i2 = 0;
  let pairIdx = 0;

  while (i1 < seq1.length || i2 < seq2.length) {
    const nextPair = pairs[pairIdx];
    const atPair = nextPair && nextPair[0] === i1 && nextPair[1] === i2;

    if (atPair) {
      line1 += seq1[i1];
      line2 += seq2[i2];
      match += seq1[i1] === seq2[i2] ? "|" : ".";
      i1++;
      i2++;
      pairIdx++;
    } else {
      // Gap — figure out which sequence has the gap.
      const skip1 = !nextPair || nextPair[0] > i1;
      if (skip1 && i1 < seq1.length) {
        line1 += seq1[i1];
        line2 += "-";
        match += " ";
        i1++;
      } else if (i2 < seq2.length) {
        line1 += "-";
        line2 += seq2[i2];
        match += " ";
        i2++;
      } else {
        break;
      }
    }

    // Line break every 60 chars.
    if (line1.length >= 60) {
      lines.push(line1);
      lines.push(match);
      lines.push(line2);
      lines.push("");
      line1 = "";
      line2 = "";
      match = "";
    }
  }

  if (line1) {
    lines.push(line1);
    lines.push(match);
    lines.push(line2);
  }

  return lines.join("\n");
}

export interface BFactorStats {
  min: number;
  max: number;
  mean: number;
  stdDev: number;
  perResidue: { chain: string; resSeq: number; resName: string; bfactor: number; zScore: number; isOutlier: boolean }[];
  histogram: { bin: number; count: number; binLabel: string }[];
}

/**
 * Parse B-factor (temperature factor) from PDB and compute distribution stats.
 * B-factor is in columns 61-66 (right-justified, 1 decimal implied).
 */
export function computeBFactorStats(pdb: string): BFactorStats | null {
  // Use the universal atom extractor (works for both PDB and CIF).
  const allAtoms = extractAllAtoms(pdb);
  const perResidue: BFactorStats["perResidue"] = [];
  const bfactors: number[] = [];
  const seen = new Set<string>();

  for (const atom of allAtoms) {
    if (atom.groupPDB && atom.groupPDB !== "ATOM") continue;
    if (atom.atomName !== "CA") continue; // use CA only for per-residue
    if (atom.bfactor === undefined || Number.isNaN(atom.bfactor)) continue;
    const key = `${atom.chain}:${atom.resSeq}`;
    if (seen.has(key)) continue;
    seen.add(key);

    bfactors.push(atom.bfactor);
    perResidue.push({ chain: atom.chain, resSeq: atom.resSeq, resName: atom.resName, bfactor: atom.bfactor, zScore: 0, isOutlier: false });
  }

  if (bfactors.length === 0) return null;

  const n = bfactors.length;
  const mean = bfactors.reduce((s, b) => s + b, 0) / n;
  const variance = bfactors.reduce((s, b) => s + (b - mean) ** 2, 0) / n;
  const stdDev = Math.sqrt(variance);
  const min = Math.min(...bfactors);
  const max = Math.max(...bfactors);

  // Compute z-scores and flag outliers (|z| > 2).
  for (const r of perResidue) {
    r.zScore = stdDev > 0 ? (r.bfactor - mean) / stdDev : 0;
    r.isOutlier = Math.abs(r.zScore) > 2;
  }

  // Build histogram (10 bins from min to max).
  const numBins = 10;
  const binWidth = (max - min) / numBins || 1;
  const histogram = Array.from({ length: numBins }, (_, i) => ({
    bin: i,
    count: 0,
    binLabel: `${(min + i * binWidth).toFixed(1)}-${(min + (i + 1) * binWidth).toFixed(1)}`,
  }));
  for (const b of bfactors) {
    let binIdx = Math.floor((b - min) / binWidth);
    if (binIdx >= numBins) binIdx = numBins - 1;
    if (binIdx < 0) binIdx = 0;
    histogram[binIdx].count++;
  }

  return { min, max, mean, stdDev, perResidue, histogram };
}

export interface ChargeInfo {
  totalCharge: number;
  positiveCount: number;
  negativeCount: number;
  perResidue: { chain: string; resSeq: number; resName: string; charge: number }[];
}

// Amino acid charges at pH 7.
const AA_CHARGES: Record<string, number> = {
  ARG: 1, LYS: 1, HIS: 0.1, // partially protonated
  ASP: -1, GLU: -1,
  CYS: -0.1, TYR: -0.0, // mostly neutral at pH 7
};

/**
 * Compute per-residue and total charge at pH 7.
 */
export function computeCharge(pdb: string): ChargeInfo {
  const parsed = parsePdb(pdb);
  const perResidue = parsed.ca.map((a) => ({
    chain: a.chain,
    resSeq: a.resSeq,
    resName: a.resName,
    charge: AA_CHARGES[a.resName] || 0,
  }));

  const totalCharge = perResidue.reduce((s, r) => s + r.charge, 0);
  const positiveCount = perResidue.filter((r) => r.charge > 0).length;
  const negativeCount = perResidue.filter((r) => r.charge < 0).length;

  return { totalCharge, positiveCount, negativeCount, perResidue };
}

/**
 * Compute charge-based color for electrostatic-style coloring.
 * Returns a hex color string for a given residue name.
 */
export function residueChargeColor(resName: string): string {
  const charge = AA_CHARGES[resName] || 0;
  if (charge > 0.5) return "#2563eb"; // blue (positive)
  if (charge > 0) return "#60a5fa"; // light blue (partial positive)
  if (charge < -0.5) return "#dc2626"; // red (negative)
  if (charge < 0) return "#f87171"; // light red (partial negative)
  return "#94a3b8"; // gray (neutral)
}

// Amino acid pKa values for ionizable sidechains.
const AA_PKA: Record<string, { group: string; pKa: number; chargeWhenProtonated: number }> = {
  ASP: { group: "sidechain-COOH", pKa: 3.65, chargeWhenProtonated: 0 },    // deprotonated = -1
  GLU: { group: "sidechain-COOH", pKa: 4.25, chargeWhenProtonated: 0 },    // deprotonated = -1
  HIS: { group: "imidazole", pKa: 6.0, chargeWhenProtonated: 1 },          // protonated = +1
  CYS: { group: "thiol", pKa: 8.3, chargeWhenProtonated: 0 },              // deprotonated = -1
  TYR: { group: "phenol", pKa: 10.07, chargeWhenProtonated: 0 },           // deprotonated = -1
  LYS: { group: "amino", pKa: 10.53, chargeWhenProtonated: 1 },            // protonated = +1
  ARG: { group: "guanidino", pKa: 12.48, chargeWhenProtonated: 1 },        // protonated = +1
};

// Terminal group pKa values.
const N_TERM_PKA = 9.0;  // protonated = +1
const C_TERM_PKA = 2.0;  // protonated = 0, deprotonated = -1

/**
 * Compute per-residue charge at a given pH using Henderson-Hasselbalch.
 * For acidic groups (COOH): charge = -1 / (1 + 10^(pKa - pH))
 * For basic groups (NH): charge = +1 / (1 + 10^(pH - pKa))
 *
 * Includes N-terminal (+1 when protonated) and C-terminal (-1 when deprotonated)
 * contributions applied to the first and last residues of each chain.
 */
export function computeChargeAtPH(
  pdb: string,
  pH: number
): ChargeInfo & { pH: number; nTermCharge: number; cTermCharge: number } {
  const parsed = parsePdb(pdb);
  const ca = parsed.ca;

  // Group by chain to find termini.
  const chainResidues = new Map<string, typeof ca>();
  for (const a of ca) {
    if (!chainResidues.has(a.chain)) chainResidues.set(a.chain, []);
    chainResidues.get(a.chain)!.push(a);
  }

  // Determine which residues are N-term / C-term (first/last per chain by resSeq).
  const nTermKeys = new Set<string>();
  const cTermKeys = new Set<string>();
  for (const [, residues] of chainResidues) {
    const sorted = [...residues].sort((a, b) => a.resSeq - b.resSeq);
    if (sorted.length > 0) {
      nTermKeys.add(`${sorted[0].chain}:${sorted[0].resSeq}`);
      cTermKeys.add(`${sorted[sorted.length - 1].chain}:${sorted[sorted.length - 1].resSeq}`);
    }
  }

  let nTermCharge = 0;
  let cTermCharge = 0;
  const perResidue = ca.map((a) => {
    let charge = 0;
    const pkaInfo = AA_PKA[a.resName];
    if (pkaInfo) {
      if (pkaInfo.chargeWhenProtonated > 0) {
        // Basic group (protonated = positive).
        charge = pkaInfo.chargeWhenProtonated / (1 + Math.pow(10, pH - pkaInfo.pKa));
      } else {
        // Acidic group (deprotonated = negative).
        charge = -1 / (1 + Math.pow(10, pkaInfo.pKa - pH));
      }
    }

    const key = `${a.chain}:${a.resSeq}`;
    if (nTermKeys.has(key)) {
      const nCharge = 1 / (1 + Math.pow(10, pH - N_TERM_PKA));
      charge += nCharge;
      nTermCharge += nCharge;
    }
    if (cTermKeys.has(key)) {
      const cCharge = -1 / (1 + Math.pow(10, C_TERM_PKA - pH));
      charge += cCharge;
      cTermCharge += cCharge;
    }

    return {
      chain: a.chain,
      resSeq: a.resSeq,
      resName: a.resName,
      charge,
    };
  });

  const totalCharge = perResidue.reduce((s, r) => s + r.charge, 0);
  const positiveCount = perResidue.filter((r) => r.charge > 0.1).length;
  const negativeCount = perResidue.filter((r) => r.charge < -0.1).length;

  return {
    totalCharge,
    positiveCount,
    negativeCount,
    perResidue,
    pH,
    nTermCharge,
    cTermCharge,
  };
}

/**
 * Compute the isoelectric point (pI) — the pH where net charge = 0.
 * Uses bisection search over pH 0-14.
 */
export function computeIsoelectricPoint(pdb: string): number {
  let lo = 0;
  let hi = 14;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    const charge = computeChargeAtPH(pdb, mid).totalCharge;
    if (charge > 0) {
      lo = mid; // need higher pH to deprotonate
    } else {
      hi = mid;
    }
  }
  return (lo + hi) / 2;
}

export interface Cavity {
  id: number;
  centerX: number;
  centerY: number;
  centerZ: number;
  volume: number; // Å³
  numGridPoints: number;
  isPocket: boolean; // true if connected to surface, false if buried
}

/**
 * Detect cavities and pockets using a grid-based approach.
 * Places a 3D grid over the structure's bounding box, marks cells occupied
 * by atoms (within VDW radius + probe), then finds connected clusters of
 * empty cells. Clusters fully enclosed by protein = buried cavities;
 * clusters connected to the boundary = surface pockets.
 *
 * @param pdb PDB text
 * @param gridSize Grid spacing in Å (default 1.5 — smaller = more accurate but slower)
 * @param probeRadius Water probe radius (default 1.4 Å)
 */
export function detectCavities(
  pdb: string,
  gridSize = 1.5,
  probeRadius = 1.4
): Cavity[] {
  const atoms = extractAllAtoms(pdb);
  if (atoms.length === 0) return [];

  // Compute bounding box (expanded by probe radius).
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const a of atoms) {
    const r = a.vdwRadius + probeRadius;
    if (a.x - r < minX) minX = a.x - r;
    if (a.y - r < minY) minY = a.y - r;
    if (a.z - r < minZ) minZ = a.z - r;
    if (a.x + r > maxX) maxX = a.x + r;
    if (a.y + r > maxY) maxY = a.y + r;
    if (a.z + r > maxZ) maxZ = a.z + r;
  }

  // Grid dimensions.
  const nx = Math.ceil((maxX - minX) / gridSize) + 1;
  const ny = Math.ceil((maxY - minY) / gridSize) + 1;
  const nz = Math.ceil((maxZ - minZ) / gridSize) + 1;
  // Cap grid size to avoid memory issues with huge structures.
  if (nx * ny * nz > 500000) {
    // Increase grid size to reduce count.
    const scale = Math.cbrt(nx * ny * nz / 500000);
    const adjusted = gridSize * scale;
    return detectCavities(pdb, adjusted, probeRadius);
  }

  // Build occupancy grid: 0 = empty, 1 = occupied by atom.
  const grid = new Uint8Array(nx * ny * nz);
  const idx = (i: number, j: number, k: number) => i + j * nx + k * nx * ny;

  for (const a of atoms) {
    const r = a.vdwRadius + probeRadius;
    const rSq = r * r;
    const iCenter = Math.round((a.x - minX) / gridSize);
    const jCenter = Math.round((a.y - minY) / gridSize);
    const kCenter = Math.round((a.z - minZ) / gridSize);
    const iRange = Math.ceil(r / gridSize) + 1;
    for (let di = -iRange; di <= iRange; di++) {
      for (let dj = -iRange; dj <= iRange; dj++) {
        for (let dk = -iRange; dk <= iRange; dk++) {
          const i = iCenter + di;
          const j = jCenter + dj;
          const k = kCenter + dk;
          if (i < 0 || i >= nx || j < 0 || j >= ny || k < 0 || k >= nz) continue;
          const x = minX + i * gridSize;
          const y = minY + j * gridSize;
          const z = minZ + k * gridSize;
          const dx = x - a.x;
          const dy = y - a.y;
          const dz = z - a.z;
          if (dx * dx + dy * dy + dz * dz <= rSq) {
            grid[idx(i, j, k)] = 1;
          }
        }
      }
    }
  }

  // Flood fill from boundary to mark exterior (connected to surface).
  // Cells not occupied and not exterior = interior cavities.
  const visited = new Uint8Array(nx * ny * nz);
  const queue: number[] = [];

  // Seed from all boundary cells.
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      for (let k of [0, nz - 1]) {
        const id = idx(i, j, k);
        if (grid[id] === 0 && visited[id] === 0) {
          visited[id] = 1; // exterior
          queue.push(id);
        }
      }
    }
  }
  for (let i = 0; i < nx; i++) {
    for (let k = 0; k < nz; k++) {
      for (let j of [0, ny - 1]) {
        const id = idx(i, j, k);
        if (grid[id] === 0 && visited[id] === 0) {
          visited[id] = 1;
          queue.push(id);
        }
      }
    }
  }
  for (let j = 0; j < ny; j++) {
    for (let k = 0; k < nz; k++) {
      for (let i of [0, nx - 1]) {
        const id = idx(i, j, k);
        if (grid[id] === 0 && visited[id] === 0) {
          visited[id] = 1;
          queue.push(id);
        }
      }
    }
  }

  // BFS flood fill.
  while (queue.length > 0) {
    const id = queue.shift()!;
    const i = id % nx;
    const j = Math.floor(id / nx) % ny;
    const k = Math.floor(id / (nx * ny));
    // 6-connected neighbors.
    const neighbors = [
      [i + 1, j, k], [i - 1, j, k],
      [i, j + 1, k], [i, j - 1, k],
      [i, j, k + 1], [i, j, k - 1],
    ];
    for (const [ni, nj, nk] of neighbors) {
      if (ni < 0 || ni >= nx || nj < 0 || nj >= ny || nk < 0 || nk >= nz) continue;
      const nid = idx(ni, nj, nk);
      if (grid[nid] === 0 && visited[nid] === 0) {
        visited[nid] = 1; // exterior
        queue.push(nid);
      }
    }
  }

  // Remaining unvisited empty cells = interior cavities.
  // Cluster them via BFS.
  const cavities: Cavity[] = [];
  let cavityId = 0;
  const cellVolume = gridSize * gridSize * gridSize;

  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      for (let k = 0; k < nz; k++) {
        const id = idx(i, j, k);
        if (grid[id] === 0 && visited[id] === 0) {
          // Found an interior cell — BFS to find the full cavity.
          const cluster: [number, number, number][] = [];
          const clusterQueue: number[] = [id];
          visited[id] = 2; // mark as cavity-visited
          let sx = 0, sy = 0, sz = 0;
          while (clusterQueue.length > 0) {
            const cid = clusterQueue.shift()!;
            const ci = cid % nx;
            const cj = Math.floor(cid / nx) % ny;
            const ck = Math.floor(cid / (nx * ny));
            cluster.push([ci, cj, ck]);
            sx += minX + ci * gridSize;
            sy += minY + cj * gridSize;
            sz += minZ + ck * gridSize;
            const neighbors = [
              [ci + 1, cj, ck], [ci - 1, cj, ck],
              [ci, cj + 1, ck], [ci, cj - 1, ck],
              [ci, cj, ck + 1], [ci, cj, ck - 1],
            ];
            for (const [ni, nj, nk] of neighbors) {
              if (ni < 0 || ni >= nx || nj < 0 || nj >= ny || nk < 0 || nk >= nz) continue;
              const nid = idx(ni, nj, nk);
              if (grid[nid] === 0 && visited[nid] === 0) {
                visited[nid] = 2;
                clusterQueue.push(nid);
              }
            }
          }
          const n = cluster.length;
          if (n >= 5) {
            // Only count cavities with ≥5 grid points (~17 Å³ at 1.5Å grid).
            cavities.push({
              id: cavityId++,
              centerX: sx / n,
              centerY: sy / n,
              centerZ: sz / n,
              volume: n * cellVolume,
              numGridPoints: n,
              isPocket: false, // interior cavity (not connected to surface)
            });
          }
        }
      }
    }
  }

  // Sort by volume descending.
  cavities.sort((a, b) => b.volume - a.volume);
  return cavities;
}

export interface FrameRMSD {
  frame: number;
  rmsd: number; // RMSD vs reference frame (Å)
  maxRmsd?: number; // max per-residue Cα displacement
}

/**
 * Compute per-frame RMSD of an NMR ensemble against a reference frame.
 * For each frame, aligns CA atoms to the reference (using Kabsch) then
 * computes the RMSD of the aligned coordinates.
 *
 * @param models Array of { modelNum, pdbText } from splitModels
 * @param refFrameIndex Index of the reference frame (default 0 = first frame)
 * @returns Array of { frame, rmsd } for each frame (reference frame has rmsd=0)
 */
export function computeEnsembleRMSD(
  models: { modelNum: number; pdbText: string }[],
  refFrameIndex = 0
): FrameRMSD[] {
  if (models.length === 0) return [];

  const refParsed = parsePdb(models[refFrameIndex].pdbText);
  const refCA = refParsed.ca;
  if (refCA.length === 0) return [];

  // Build a lookup map for reference CA atoms by (chain, resSeq).
  const refMap = new Map<string, CAAtom>();
  for (const a of refCA) refMap.set(`${a.chain}:${a.resSeq}`, a);

  const results: FrameRMSD[] = [];

  for (let i = 0; i < models.length; i++) {
    if (i === refFrameIndex) {
      results.push({ frame: i, rmsd: 0 });
      continue;
    }

    const mobParsed = parsePdb(models[i].pdbText);
    const mobCA = mobParsed.ca;

    // Match CA atoms by (chain, resSeq).
    const refCoords: number[][] = [];
    const mobCoords: number[][] = [];
    for (const m of mobCA) {
      const r = refMap.get(`${m.chain}:${m.resSeq}`);
      if (r) {
        refCoords.push([r.x, r.y, r.z]);
        mobCoords.push([m.x, m.y, m.z]);
      }
    }

    if (refCoords.length < 3) {
      results.push({ frame: i, rmsd: NaN });
      continue;
    }

    // Align and compute RMSD via Kabsch.
    const kabschResult = kabsch(refCoords, mobCoords);
    if (kabschResult) {
      results.push({ frame: i, rmsd: kabschResult.rmsd });
    } else {
      results.push({ frame: i, rmsd: NaN });
    }
  }

  return results;
}

/**
 * Compute the average structure (mean CA coordinates) across ensemble frames.
 * Useful as an alternative reference for RMSD calculation.
 */
export function computeAverageStructure(
  models: { modelNum: number; pdbText: string }[]
): CAAtom[] | null {
  if (models.length === 0) return null;

  // Use first frame as template for residue list.
  const firstParsed = parsePdb(models[0].pdbText);
  if (firstParsed.ca.length === 0) return null;

  // Accumulate coordinates per residue key.
  const accum = new Map<string, { chain: string; resSeq: number; resName: string; x: number; y: number; z: number; count: number }>();
  for (const a of firstParsed.ca) {
    accum.set(`${a.chain}:${a.resSeq}`, { chain: a.chain, resSeq: a.resSeq, resName: a.resName, x: 0, y: 0, z: 0, count: 0 });
  }

  for (const model of models) {
    const parsed = parsePdb(model.pdbText);
    const mobMap = new Map<string, CAAtom>();
    for (const a of parsed.ca) mobMap.set(`${a.chain}:${a.resSeq}`, a);

    for (const [key, entry] of accum) {
      const m = mobMap.get(key);
      if (m) {
        entry.x += m.x;
        entry.y += m.y;
        entry.z += m.z;
        entry.count++;
      }
    }
  }

  // Compute averages.
  const avg: CAAtom[] = [];
  for (const entry of accum.values()) {
    if (entry.count > 0) {
      avg.push({
        chain: entry.chain,
        resSeq: entry.resSeq,
        resName: entry.resName,
        x: entry.x / entry.count,
        y: entry.y / entry.count,
        z: entry.z / entry.count,
      });
    }
  }

  return avg;
}
