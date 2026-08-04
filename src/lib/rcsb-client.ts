/**
 * RCSB Data API client.
 *
 * Fetches real structural metadata from RCSB's REST v1 API:
 * https://data.rcsb.org/rest/v1/core/{entry,polymer_entity,nonpolymer_entity,assembly,interface}/<pdb>/<id>
 *
 * All endpoints are public, no auth required. Used by:
 *   - /api/analyze/metadata/[id]    → entry + entities + assembly summary
 *   - /api/analyze/interface/[id]   → assembly BSA + per-interface residue lists
 *   - /api/llm/report               → pre-fetches structure context for the LLM
 */

const RCSB_BASE = "https://data.rcsb.org/rest/v1/core";

export interface RcsbEntry {
  title: string;
  methods: string[];
  resolution: number | null;
  depositDate: string | null;
  releaseDate: string | null;
  molecularWeight: number | null;
  atomCount: number | null;
  disulfideBondCount: number | null;
  polymerEntityIds: string[];
  nonpolymerEntityIds: string[];
  assemblyIds: string[];
  doi?: string | null;
  pubmedId?: string | null;
  authors?: string[];
}

export interface RcsbPolymerEntity {
  entityId: string;
  chains: string[]; // label asym ids
  authChains: string[]; // auth asym ids
  sequence: string;
  sequenceLength: number;
  description: string;
  organism: string | null;
  entityType: string; // "polypeptide(L)", "polydeoxyribonucleotide", ...
}

export interface RcsbNonpolymerEntity {
  entityId: string;
  compId: string; // 3-letter code e.g. "HEM"
  name: string;
  formulaWeight: number | null;
}

export interface RcsbAssembly {
  assemblyId: string;
  totalBuriedSurfaceArea: number | null;
  totalInterfaceResidues: number | null;
  numInterfaces: number;
  interfaceIds: string[];
}

export interface RcsbInterface {
  interfaceId: string;
  interfaceArea: number | null; // Å²
  numInterfaceResidues: number | null;
  numCoreInterfaceResidues: number | null;
  polymerComposition: string;
  interfaceCharacter: string; // "hetero" | "homo"
  partner1?: InterfacePartner;
  partner2?: InterfacePartner;
}

export interface InterfacePartner {
  chainId: string;
  authChainId: string;
  entityId: string;
  // Per-residue BSA arrays (parallel)
  residueSeqIds: number[];
  residueNames: string[];
  bsaValues: number[]; // ASA_UNBOUND − ASA_BOUND, Å²
}

export interface RcsbFullMetadata {
  entry: RcsbEntry;
  polymers: RcsbPolymerEntity[];
  nonpolymers: RcsbNonpolymerEntity[];
  assemblies: RcsbAssembly[];
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    // Cache at runtime so repeated calls are cheap.
    next: { revalidate: 3600 },
  });
  if (!res.ok) {
    throw new Error(`RCSB ${res.status} for ${url}`);
  }
  return (await res.json()) as T;
}

export async function fetchEntry(pdbId: string): Promise<RcsbEntry> {
  const id = pdbId.toLowerCase();
  const d = await fetchJson<any>(`${RCSB_BASE}/entry/${id}`);
  const info = d.rcsb_entry_info ?? {};
  const acc = d.rcsb_accession_info ?? {};
  const cit = d.rcsb_primary_citation ?? {};
  const ids = d.rcsb_entry_container_identifiers ?? {};
  return {
    title: d.struct?.title ?? id,
    methods: (d.exptl ?? []).map((e: any) => e.method).filter(Boolean),
    resolution: info.resolution_combined?.[0] ?? null,
    depositDate: acc.deposit_date ?? null,
    releaseDate: acc.initial_release_date ?? null,
    molecularWeight: info.molecular_weight ?? null,
    atomCount: info.deposited_atom_count ?? null,
    disulfideBondCount: info.disulfide_bond_count ?? null,
    polymerEntityIds: ids.polymer_entity_ids ?? [],
    nonpolymerEntityIds: ids.non_polymer_entity_ids ?? [],
    assemblyIds: ids.assembly_ids ?? [],
    doi: cit.pdbx_database_id_DOI ?? null,
    pubmedId: cit.pdbx_database_id_PubMed ?? null,
    authors: cit.rcsb_authors ?? [],
  };
}

export async function fetchPolymerEntity(
  pdbId: string,
  entityId: string
): Promise<RcsbPolymerEntity> {
  const id = pdbId.toLowerCase();
  const d = await fetchJson<any>(`${RCSB_BASE}/polymer_entity/${id}/${entityId}`);
  const ids = d.rcsb_polymer_entity_container_identifiers ?? {};
  const src = d.rcsb_entity_source_organism ?? [];
  return {
    entityId,
    chains: ids.asym_ids ?? [],
    authChains: ids.auth_asym_ids ?? [],
    sequence: d.entity_poly?.pdbx_seq_one_letter_code_can ?? "",
    sequenceLength: d.entity_poly?.rcsb_sample_sequence_length ?? 0,
    description: d.rcsb_polymer_entity?.pdbx_description ?? "",
    organism: src[0]?.ncbi_scientific_name ?? null,
    entityType: d.entity_poly?.type ?? "unknown",
  };
}

export async function fetchNonpolymerEntity(
  pdbId: string,
  entityId: string
): Promise<RcsbNonpolymerEntity> {
  const id = pdbId.toLowerCase();
  const d = await fetchJson<any>(
    `${RCSB_BASE}/nonpolymer_entity/${id}/${entityId}`
  );
  const np = d.pdbx_entity_nonpoly ?? {};
  const comp = d.rcsb_nonpolymer_instance_container_identifiers ?? {};
  return {
    entityId,
    compId: np.comp_id ?? "",
    name: np.name ?? "",
    formulaWeight: comp?.formula_weight ?? null,
  };
}

export async function fetchAssembly(
  pdbId: string,
  assemblyId: string
): Promise<RcsbAssembly> {
  const id = pdbId.toLowerCase();
  const d = await fetchJson<any>(`${RCSB_BASE}/assembly/${id}/${assemblyId}`);
  const info = d.rcsb_assembly_info ?? {};
  const ids = d.rcsb_assembly_container_identifiers ?? {};
  return {
    assemblyId,
    totalBuriedSurfaceArea: info.total_assembly_buried_surface_area ?? null,
    totalInterfaceResidues: info.total_number_interface_residues ?? null,
    numInterfaces: info.num_interfaces ?? 0,
    interfaceIds: ids.interface_ids ?? [],
  };
}

export async function fetchInterface(
  pdbId: string,
  assemblyId: string,
  interfaceId: string
): Promise<RcsbInterface> {
  const id = pdbId.toLowerCase();
  const d = await fetchJson<any>(
    `${RCSB_BASE}/interface/${id}/${assemblyId}/${interfaceId}`
  );
  const info = d.rcsb_interface_info ?? {};
  const partners = d.rcsb_interface_partner ?? [];

  const parsePartner = (p: any): InterfacePartner | undefined => {
    if (!p) return undefined;
    const ident = p.interface_partner_identifier ?? {};
    const feat = p.interface_partner_feature ?? [];
    // Find ASA_UNBOUND and ASA_BOUND features
    const unboundFeat = feat.find(
      (f: any) => f.type === "ASA_UNBOUND" || f.name === "Unbound ASA"
    );
    const boundFeat = feat.find(
      (f: any) => f.type === "ASA_BOUND" || f.name === "Bound ASA"
    );
    const fpU = unboundFeat?.feature_positions?.[0];
    const fpB = boundFeat?.feature_positions?.[0];
    const begSeq = fpU?.beg_seq_id ?? 1;
    const endSeq = fpU?.end_seq_id ?? begSeq;
    const unboundVals: number[] = fpU?.values ?? [];
    const boundVals: number[] = fpB?.values ?? [];
    const len = Math.min(unboundVals.length, boundVals.length);
    const seqIds: number[] = [];
    const bsaValues: number[] = [];
    for (let i = 0; i < len; i++) {
      const u = unboundVals[i];
      const b = boundVals[i] ?? 0;
      const bsa = Math.max(0, u - b);
      if (bsa > 0.1) {
        // Only keep residues that actually contribute to the interface
        seqIds.push(begSeq + i);
        bsaValues.push(Math.round(bsa * 100) / 100);
      }
    }
    return {
      chainId: ident.asym_id ?? "",
      authChainId: ident.auth_asym_id ?? ident.asym_id ?? "",
      entityId: ident.entity_id ?? "",
      residueSeqIds: seqIds,
      residueNames: [], // RCSB interface endpoint doesn't include comp_id; cross-ref with polymer entity
      bsaValues,
    };
  };
  return {
    interfaceId,
    interfaceArea: info.interface_area ?? null,
    numInterfaceResidues: info.num_interface_residues ?? null,
    numCoreInterfaceResidues: info.num_core_interface_residues ?? null,
    polymerComposition: info.polymer_composition ?? "",
    interfaceCharacter: info.interface_character ?? "",
    partner1: parsePartner(partners[0]),
    partner2: parsePartner(partners[1]),
  };
}

/** Fetch everything for a PDB entry — entry + all polymer/nonpolymer entities + all assemblies (with interfaces optional). */
export async function fetchFullMetadata(
  pdbId: string,
  includeInterfaces = false
): Promise<RcsbFullMetadata & { interfaces?: RcsbInterface[] }> {
  const entry = await fetchEntry(pdbId);

  const [polymers, nonpolymers, assemblies] = await Promise.all([
    Promise.all(
      entry.polymerEntityIds.map((eid) => fetchPolymerEntity(pdbId, eid))
    ),
    Promise.all(
      entry.nonpolymerEntityIds.map((eid) =>
        fetchNonpolymerEntity(pdbId, eid)
      )
    ),
    Promise.all(entry.assemblyIds.map((aid) => fetchAssembly(pdbId, aid))),
  ]);

  let interfaces: RcsbInterface[] | undefined;
  if (includeInterfaces && assemblies.length > 0) {
    const first = assemblies[0];
    interfaces = await Promise.all(
      first.interfaceIds.map((iid) =>
        fetchInterface(pdbId, first.assemblyId, iid)
      )
    );
  }

  return { entry, polymers, nonpolymers, assemblies, interfaces };
}

/** Compact, LLM-friendly Markdown summary of a structure's metadata. */
export function metadataToMarkdown(
  data: RcsbFullMetadata & { interfaces?: RcsbInterface[] }
): string {
  const lines: string[] = [];
  const e = data.entry;
  // Build entity_id → auth chain + residue-name lookup
  const entityLookup = new Map<
    string,
    { authChain: string; labelChain: string; description: string; seq: string }
  >();
  for (const p of data.polymers) {
    entityLookup.set(p.entityId, {
      authChain: p.authChains.join(",") || p.chains.join(","),
      labelChain: p.chains.join(","),
      description: p.description,
      seq: p.sequence,
    });
  }
  // Helper: seq_id (1-based within entity) → residue 1-letter code
  const residueNameAt = (entityId: string, seqId: number): string => {
    const e = entityLookup.get(entityId);
    if (!e || !e.seq) return "?";
    // RCSB sequences are 1-indexed; sequence strings may have gaps handled by entity_poly_seq
    return e.seq[seqId - 1] ?? "?";
  };

  lines.push(`# 结构 ${e.title}`);
  lines.push(`- **PDB ID**: ${e.title ? "" : ""}`);
  lines.push(`- **标题**: ${e.title}`);
  lines.push(`- **实验方法**: ${e.methods.join(", ") || "未知"}`);
  lines.push(
    `- **分辨率**: ${e.resolution !== null ? `${e.resolution} Å` : "N/A"}`
  );
  lines.push(`- **分子量**: ${e.molecularWeight ?? "N/A"} kDa`);
  lines.push(`- **原子数**: ${e.atomCount ?? "N/A"}`);
  lines.push(`- **二硫键数**: ${e.disulfideBondCount ?? 0}`);
  lines.push(
    `- ** deposited / released**: ${e.depositDate ?? "?"} / ${e.releaseDate ?? "?"}`
  );
  if (e.doi) lines.push(`- **DOI**: ${e.doi}`);
  if (e.pubmedId) lines.push(`- **PubMed**: ${e.pubmedId}`);

  lines.push("");
  lines.push("## 聚合物实体 (Chains)");
  for (const p of data.polymers) {
    lines.push(
      `### Entity ${p.entityId} — ${p.description} (auth 链 ${p.authChains.join(",") || p.chains.join(",")})`
    );
    lines.push(`- 类型: ${p.entityType}`);
    lines.push(`- 长度: ${p.sequenceLength} aa`);
    lines.push(`- label 链: ${p.chains.join(", ")}`);
    lines.push(`- auth 链: ${p.authChains.join(", ")}`);
    if (p.organism) lines.push(`- 来源: ${p.organism}`);
    if (p.sequence) {
      const seq = p.sequence.length > 80 ? p.sequence.slice(0, 80) + "…" : p.sequence;
      lines.push(`- 序列 (前 80): ${seq}`);
    }
  }

  if (data.nonpolymers.length > 0) {
    lines.push("");
    lines.push("## 配体 / 非聚合物");
    for (const n of data.nonpolymers) {
      lines.push(`- ${n.compId} (Entity ${n.entityId}): ${n.name}`);
    }
  }

  if (data.assemblies.length > 0) {
    lines.push("");
    lines.push("## 组装体 (Assemblies)");
    for (const a of data.assemblies) {
      lines.push(`### Assembly ${a.assemblyId}`);
      lines.push(`- 界面数: ${a.numInterfaces}`);
      if (a.totalBuriedSurfaceArea !== null)
        lines.push(`- 总埋藏表面积 (BSA): ${a.totalBuriedSurfaceArea.toFixed(1)} Å²`);
      if (a.totalInterfaceResidues !== null)
        lines.push(`- 总界面残基数: ${a.totalInterfaceResidues}`);
    }
  }

  if (data.interfaces && data.interfaces.length > 0) {
    lines.push("");
    lines.push("## 界面详情 (Assembly 1)");
    for (const it of data.interfaces) {
      lines.push(`### Interface ${it.interfaceId}`);
      lines.push(`- 界面面积: ${it.interfaceArea?.toFixed(1) ?? "N/A"} Å²`);
      lines.push(`- 界面残基数: ${it.numInterfaceResidues ?? "N/A"}`);
      lines.push(`- 核心残基数: ${it.numCoreInterfaceResidues ?? "N/A"}`);
      lines.push(`- 类型: ${it.polymerComposition} / ${it.interfaceCharacter}`);
      const fmtPartner = (p: InterfacePartner | undefined, label: string) => {
        if (!p) return;
        const ent = entityLookup.get(p.entityId);
        const authChain = ent?.authChain ?? p.chainId;
        lines.push(`- ${label}: 链 ${authChain} (label ${p.chainId}, Entity ${p.entityId}${ent ? `, ${ent.description}` : ""})`);
        // Top-15 residues by BSA, with 1-letter residue name from sequence
        const top = p.residueSeqIds
          .map((seq, i) => ({
            seq,
            name: residueNameAt(p.entityId, seq),
            bsa: p.bsaValues[i] ?? 0,
          }))
          .sort((a, b) => b.bsa - a.bsa)
          .slice(0, 15);
        if (top.length > 0) {
          lines.push(
            `  - 关键残基 (按 BSA 排序): ${top
              .map((r) => `${r.name}${r.seq}(${r.bsa.toFixed(1)}Å²)`)
              .join(", ")}`
          );
        }
      };
      fmtPartner(it.partner1, "Partner 1");
      fmtPartner(it.partner2, "Partner 2");
    }
  }

  return lines.join("\n");
}
