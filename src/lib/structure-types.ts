// Core types for the protein structure visualization workspace.

export type StructureSource = "pdb" | "upload" | "uniprot";

export type Representation =
  | "cartoon"
  | "stick"
  | "line"
  | "sphere"
  | "surface";

export type ColorScheme =
  | "chain"
  | "element"
  | "secondary"
  | "single"
  | "spectrum"
  | "bfactor"
  | "residue"
  | "charge";

export interface StructureStyle {
  representation: Representation;
  colorScheme: ColorScheme;
  opacity: number; // 0..1
  singleColor: string; // hex used when colorScheme === "single"
}

export interface StructureMetadata {
  title?: string;
  organism?: string;
  resolution?: number | null;
  method?: string;
  chains?: string[];
  numAtoms?: number;
  numResidues?: number;
  depositionDate?: string;
  uniprotId?: string;
}

/**
 * A single opened protein structure. Multiple structures can coexist in the
 * workspace; the user selects which one is "active" for analysis.
 */
export interface ProteinStructure {
  id: string;
  name: string;
  source: StructureSource;
  sourceId?: string; // PDB ID or UniProt ID
  pdbText: string;
  metadata: StructureMetadata;
  color: string; // canonical color for this structure (used in list + viewer legend)
  visible: boolean;
  style: StructureStyle;
  // Rigid-body transform (4x4 matrix, row-major) applied when this structure
  // participates in an alignment as the mobile structure. Undefined until aligned.
  transform?: number[][];
  alignRmsd?: number;
  alignTmScore?: number;
  createdAt: number;
}

export interface AlignmentResult {
  id: string;
  referenceId: string;
  mobileId: string;
  rmsd: number;
  tmScore: number; // 0..1, length-normalized similarity
  numAligned: number; // number of CA atom pairs used
  transform: number[][]; // 4x4 row-major
  alignmentMethod: "residue-number" | "sequence"; // how CA atoms were matched
  alignScore?: number; // Smith-Waterman score (only for sequence method)
  createdAt: number;
}

export const DEFAULT_STYLE: StructureStyle = {
  representation: "cartoon",
  colorScheme: "spectrum",
  opacity: 1,
  singleColor: "#6366f1",
};

// A curated palette so each opened structure gets a distinct, harmonious color.
export const STRUCTURE_PALETTE = [
  "#6366f1", // indigo
  "#10b981", // emerald
  "#f59e0b", // amber
  "#ec4899", // pink
  "#06b6d4", // cyan
  "#8b5cf6", // violet
  "#ef4444", // red
  "#84cc16", // lime
  "#14b8a6", // teal
  "#f97316", // orange
];
