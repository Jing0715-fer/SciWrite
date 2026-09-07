/**
 * Web-source tier classification (round-57).
 *
 * WHY (E2E audit, round-56): 10% of the final reference list was
 * non-primary web pages — a Boston Children's hospital outreach page cited
 * as the primary evidence for the 2015 Tmc1 gene-therapy milestone, and an
 * "Anonymous (2026)" MIT gene-portal page propping up a core argument. The
 * metadata was REAL (the pages exist), so every verification layer passed —
 * the problem was ADMISSION: general web search results entered the citable
 * pool with no primary/secondary distinction.
 *
 * This module is a MECHANICAL (model-independent, deterministic) admission
 * gate: hosts/paths that are unambiguously NOT primary scientific sources
 * are classified NON-PRIMARY and excluded from the citation pool. Unknown
 * hosts stay citable (conservative — no false positives on small journals).
 */

/** Patterns are matched against `https?://HOST/PATH` lowercase. */

// Hosts (exact or suffix) that never carry primary scientific content.
const NON_PRIMARY_HOSTS: RegExp[] = [
  // Hospital / clinic outreach & answers pages
  /^(?:answers|www\.answers)\.[a-z-]+\.org$/i,
  /[a-z-]*childrenshospital\.(?:org|com)$/i,
  /[a-z-]*\.hospital\.(?:org|com|edu)$/i,
  /^(?:www\.)?[a-z-]+(?:hospital|clinic|medicalcenter)[a-z-]*\.(?:org|com)$/i,
  // Popular science / news aggregators
  /medicalxpress\.com$/i,
  /sciencedaily\.com$/i,
  /phys\.org$/i,
  /eurekalert\.org$/i,
  /prnewswire\.com$/i,
  /scitechdaily\.com$/i,
  /livescience\.com$/i,
  /newscientist\.com$/i,
  /scientificamerican\.com$/i,
  // Encyclopedias / Q&A / social
  /wikipedia\.org$/i,
  /britannica\.com$/i,
  /quora\.com$/i,
  /reddit\.com$/i,
  /medium\.com$/i,
  /substack\.com$/i,
  /linkedin\.com$/i,
  /twitter\.com$/i,
  /x\.com$/i,
  /facebook\.com$/i,
  /youtube\.com$/i,
  // Blogs (host or path)
  /(?:^|\.)blog(?:s)?\./i,
  /blogspot\./i,
  /wordpress\.com$/i,
];

// Hosts that are databases/entry portals — useful for context but their
// *entry pages* are not citable primary literature.
const NON_PRIMARY_PATHS: RegExp[] = [
  /\/gene\//i,        // gene portal entries (affinage.wi.mit.edu/gene/TMC1)
  /\/genes\//i,
  /\/entry\//i,       // UniProt/InterPro entry viewer pages
  /\/uniprot\//i,
  /\/genecards\//i,
  /\/news[-/]?(?:room|releases?)?\//i, // university news rooms
  /\/press[-_]?release/i,
  /\/news\/articles?\//i, // journal news sections (nature.com/news/articles)
  /\/d\d{5,}/,             // nature news IDs (d41586-...)
];

export interface SourceTierResult {
  nonPrimary: boolean;
  reason: string;
}

/**
 * Classify a web source by URL. Only applies to type-`web` sources (PubMed/
 * RCSB/UniProt DB references pass through untouched — those arrive with
 * curated metadata from their own channels).
 */
export function classifyWebSource(url: string | null | undefined, title?: string | null): SourceTierResult {
  const raw = String(url || "").trim();
  if (!raw) return { nonPrimary: false, reason: "" };
  const withProto = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let host = "";
  let path = "";
  try {
    const u = new URL(withProto);
    host = u.hostname.toLowerCase();
    path = u.pathname.toLowerCase();
  } catch {
    return { nonPrimary: false, reason: "" };
  }

  for (const re of NON_PRIMARY_HOSTS) {
    if (re.test(host)) {
      return { nonPrimary: true, reason: `non-primary host: ${host}` };
    }
  }
  for (const re of NON_PRIMARY_PATHS) {
    if (re.test(path)) {
      return { nonPrimary: true, reason: `non-primary path: ${host}${path}` };
    }
  }
  // Title-based fallback: overt outreach phrasing.
  const t = String(title || "").toLowerCase();
  if (t && /\b(?:patient|family|faq|about|our|blog|newsletter|press release)\b/.test(t.slice(0, 80))) {
    return { nonPrimary: true, reason: "outreach-style title" };
  }
  return { nonPrimary: false, reason: "" };
}

/**
 * Split a ref pool: returns the citable subset plus the excluded non-primary
 * web sources with reasons (for telemetry/UI transparency). Non-web types
 * and unknown hosts stay citable.
 */
export function partitionCitablePool(refs: any[]): {
  citable: any[];
  excluded: { title: string; reason: string; url: string }[];
} {
  const { citable, excluded } = partitionCitablePoolIndexed(refs);
  return { citable, excluded };
}

/**
 * Index-aware variant: callers that keep a score array aligned 1:1 with the
 * refs array (score → refs[i]) need the KEEP INDICES, not the filtered
 * objects, so scores and refs stay in lockstep after partitioning.
 */
export function partitionCitablePoolIndexed(refs: any[]): {
  keepIndices: number[];
  citable: any[];
  excluded: { index: number; title: string; reason: string; url: string }[];
} {
  const keepIndices: number[] = [];
  const citable: any[] = [];
  const excluded: { index: number; title: string; reason: string; url: string }[] = [];
  refs.forEach((r, i) => {
    const isWeb = String(r?.type || "").toLowerCase() === "web";
    if (isWeb) {
      const cls = classifyWebSource(r?.url, r?.title);
      if (cls.nonPrimary) {
        excluded.push({
          index: i,
          title: String(r?.title || "Untitled").slice(0, 90),
          reason: cls.reason,
          url: String(r?.url || "").slice(0, 160),
        });
        return;
      }
    }
    keepIndices.push(i);
    citable.push(r);
  });
  return { keepIndices, citable, excluded };
}
