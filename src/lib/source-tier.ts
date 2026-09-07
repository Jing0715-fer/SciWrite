/**
 * round-57 (P0-1): mechanical source-tier gating for the citation pool.
 *
 * Round-56 production audit found two of twenty references were non-primary
 * web pages doing first-class evidential work:
 *   - [19] a Boston Children's Hospital popular-science page cited as the
 *     primary evidence for a 2015 gene-therapy milestone (the real primary
 *     paper, Askew 2015 Sci Transl Med, was missing entirely)
 *   - [7] a MIT gene-portal/database page supporting a core argument
 *
 * Root cause: the curation LLM scores topical relevance, not SOURCE TIER — a
 * hospital outreach page about TMC1 gene therapy scores REL 8/10 on relevance
 * while being useless as first-class evidence. No mechanical layer ever asked
 * "what KIND of page is this?".
 *
 * This module answers that question mechanically, from the URL alone (no LLM,
 * no network): hospital/patient-facing pages, news/press/media, encyclopedias,
 * gene-portal and university outreach paths are partitioned OUT of the citable
 * pool before the plan/analyze/allocate stages ever see them. Database-typed
 * references (pubmed / rcsb / uniprot …) are exempt — those come from
 * deliberate, metadata-verified database retrieval, not free web search.
 *
 * Fail-safe: if the gate would empty the pool, it keeps the original pool and
 * reports the drops — the run must never brick itself on a classification.
 */

/** Coarse tier of a source URL. */
export type SourceTier = "primary" | "non-primary" | "unknown";

export interface SourceTierDecision {
  tier: SourceTier;
  label: string; // human-readable reason, e.g. "hospital/patient-facing"
}

export interface SourcePartition {
  keptRefs: any[];
  keptScores: any[];
  dropped: { ref: any; reason: string }[];
  /** true when the gate kept everything because filtering would empty the pool */
  fellBackToUnfiltered: boolean;
}

/* ------------------------------------------------------------------ *
 * 1. Host-level blacklists (exact host or host-suffix match)
 * ------------------------------------------------------------------ */

/** Hospitals / clinics / patient-facing health systems. */
const HOSPITAL_HOSTS = [
  "childrenshospital.org",
  "massgeneral.org",
  "massgeneralforchildren.org",
  "mayoclinic.org",
  "hopkinsmedicine.org",
  "hopkinschildrens.org",
  "clevelandclinic.org",
  "stanfordhealthcare.org",
  "stanfordchildrens.org",
  "ucsfhealth.org",
  "ucsfbenioffchildrens.org",
  "mountsinai.org",
  "nyulangone.org",
  "pennmedicine.org",
  "chop.edu",
  "hss.edu",
  "cedars-sinai.org",
  "mskcc.org",
  "mdanderson.org",
  "stjude.org",
  "Seattlechildrens.org",
  "Nationwidechildrens.org",
  "Bostonchildrens.org",
];

/** Generic hospital/clinic host suffixes (host *ends with* these). */
const HOSPITAL_SUFFIXES = [
  ".hospital",
  ".org/hospital",
  "hospital.org",
  "hospital.com",
  "clinics.org",
  "clinic.org",
  "medicalcenter.org",
  "healthsystem.org",
  "childrenshospital.net",
];

/** Popular-science media, news outlets, press-release wires. */
const MEDIA_HOSTS = [
  "sciencedaily.com",
  "phys.org",
  "statnews.com",
  "quantamagazine.org",
  "the-scientist.com",
  "livescience.com",
  "newscientist.com",
  "sciencealert.com",
  "medicalnewstoday.com",
  "healthline.com",
  "webmd.com",
  "verywellhealth.com",
  "eurekalert.org",
  "newatlas.com",
  "spectrumnews.org",
  "technologyreview.com",
  "scientificamerican.com",
  "sciam.com",
  "acs.org/pressroom", // handled by path rule below as well
  "miragenews.com",
  "news-medical.net",
  "genengnews.com",
  "theconversation.com",
  "bigthink.com",
  "iflscience.com",
  "futurity.org",
];

/** Encyclopedias, Q&A sites, collaborative wikis. */
const ENCYCLOPEDIA_HOSTS = [
  "wikipedia.org",
  "britannica.com",
  "wikimedia.org",
  "wikiwand.com",
  "quora.com",
  "answers.com",
  "stackexchange.com",
];

/** Gene/protein portal pages & curated digests (secondary by construction).
 * NOTE: uniprot.org / rcsb.org entries that arrive as typed database sources
 * are exempt at the partition step — this only hits free web results. */
const PORTAL_HOSTS = [
  "genecards.org",
  "medlineplus.gov",
  "genome.gov",
  "genetics.edu.au",
  "yourgenome.org",
  "ncbi.nlm.nih.gov/gene",
  "ncbi.nlm.nih.gov/books",
  "ncbi.nlm.nih.gov/disease",
  "ensembl.org",
  "uniprot.org",
  "proteinatlas.org",
  "alphafold.ebi.ac.uk",
  "rcsb.org/ligand",
  "scribd.com",
  "slideshare.net",
];

/** Primary scholarly hosts — an explicit whitelist that overrides path rules
 * (e.g. nature.com/news is media, but nature.com/articles is primary). */
const PRIMARY_HOSTS = [
  "pubmed.ncbi.nlm.nih.gov",
  "pubmed.gov",
  "ncbi.nlm.nih.gov/pmc",
  "ncbi.nlm.nih.gov/pubmed",
  "doi.org",
  "dx.doi.org",
  "nature.com",
  "science.org",
  "sciencemag.org",
  "cell.com",
  "springer.com",
  "springernature.com",
  "nature.org",
  "wiley.com",
  "onlinelibrary.wiley.com",
  "sciencedirect.com",
  "elsevier.com",
  "academic.oup.com",
  "oup.com",
  "pnas.org",
  "elifesciences.org",
  "plos.org",
  "journals.plos.org",
  "frontiersin.org",
  "mdpi.com",
  "biorxiv.org",
  "medrxiv.org",
  "chemrxiv.org",
  "preprints.org",
  "rcsb.org",
  "wwpdb.org",
  "asm.org",
  "jneurosci.org",
  "jn.physiology.org",
  "rupress.org",
  "cshlp.org",
  "embopress.org",
  "elifesciences.org",
  "iopscience.iop.org",
  "pubs.acs.org",
  "pubs.rsc.org",
  "thelancet.com",
  "nejm.org",
  "bmj.com",
  "jamanetwork.com",
  "biomedcentral.com",
  "portlandpress.com",
  "biochemj.org",
  "jbc.org",
  "genetics.org",
  "g3journal.org",
  "mbe.oxfordjournals.org",
  "academic.oup.com",
  "mcponline.org",
  "europepmc.org",
  "semanticscholar.org",
  "scholar.google.com",
];

/* ------------------------------------------------------------------ *
 * 2. Path-level rules (for .edu / .org / .gov sites the host alone
 *    cannot decide — a university hosts both labs and press rooms)
 * ------------------------------------------------------------------ */

/** Path fragments that mark news / press / outreach / blog / educational pages. */
const NON_PRIMARY_PATH_RE =
  /\/(news|newsroom|press[-_]?release|pressroom|press|stories|story|outreach|blog|blogs|learn[-_]?more|learn|education|educational|outreach|discover|magazine|news-article|article-news|updates?|insights?|about|events|features?)\/|\/(news|stories|press)\.(html?|php|aspx)$/i;

/** Wiki-style paths (independent of host). */
const WIKI_PATH_RE = /\/wiki\//i;

/* ------------------------------------------------------------------ *
 * 3. Helpers
 * ------------------------------------------------------------------ */

function extractHost(url: string): string {
  if (!url) return "";
  let u = url.trim();
  if (!/^https?:\/\//i.test(u)) u = "https://" + u.replace(/^\/+/, "");
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    // bare domain like "nature.com/articles/..."
    const m = u.match(/^(?:https?:\/\/)?(?:www\.)?([a-z0-9.-]+\.[a-z]{2,})(?:\/|$)/i);
    return m ? m[1].toLowerCase() : "";
  }
}

function extractPath(url: string): string {
  if (!url) return "";
  let u = url.trim();
  if (!/^https?:\/\//i.test(u)) u = "https://" + u.replace(/^\/+/, "");
  try {
    return new URL(u).pathname.toLowerCase();
  } catch {
    const m = u.match(/^[a-z0-9.-]+\.[a-z]{2,}(\/.*)$/i);
    return m ? m[1].toLowerCase() : "";
  }
}

/** Hosts that MIRROR published papers (researchgate, academia.edu). The
 * mirror URL is secondary, but the CONTENT behind it may be a real published
 * paper — these are judged by metadata in partitionCitablePool (keep when the
 * ref carries journal+year or a doi: a published paper behind a mirror link;
 * drop when it is a bare portal/summary page). */
const MIRROR_HOSTS = ["researchgate.net", "academia.edu"];

function hostMatches(host: string, entries: string[]): boolean {
  return entries.some((e) => {
    const ee = e.toLowerCase();
    if (host === ee || host.endsWith("." + ee)) return true;
    // suffix-style entries like "hospital.org"
    if (ee.startsWith(".") && host.endsWith(ee)) return true;
    return false;
  });
}

/** host starts with "news." / "newsroom." / "press." — common university pattern */
const NEWS_SUBDOMAIN_RE = /^(news|newsroom|press|pressroom|magazine|media|outreach|communications|spotlight|stories)\./;

/* ------------------------------------------------------------------ *
 * 4. Public API
 * ------------------------------------------------------------------ */

/**
 * Classify a single source URL into a source tier. Pure, offline, total
 * (never throws, never fetches).
 */
export function classifySourceUrl(url: string): SourceTierDecision {
  const host = extractHost(url);
  const path = extractPath(url);
  if (!host) return { tier: "unknown", label: "no URL" };

  // Whitelist first: a recognized scholarly host is primary unless the PATH
  // explicitly marks a news/press section (nature.com/news/...), or the URL
  // carries the d41586 news-DOI prefix (nature.com/articles/d41586-... is a
  // NEWS article despite the primary-looking "articles" path).
  if (hostMatches(host, PRIMARY_HOSTS)) {
    if (NON_PRIMARY_PATH_RE.test(path) || WIKI_PATH_RE.test(path) || /\/articles\/d41586-/i.test(url)) {
      return { tier: "non-primary", label: "news/press section of scholarly site" };
    }
    return { tier: "primary", label: "scholarly publisher/database" };
  }

  // News subdomain on any host (news.mit.edu, news.harvard.edu …)
  if (NEWS_SUBDOMAIN_RE.test(host)) {
    return { tier: "non-primary", label: "news/press subdomain" };
  }

  if (hostMatches(host, MEDIA_HOSTS)) return { tier: "non-primary", label: "science news/media" };
  if (hostMatches(host, ENCYCLOPEDIA_HOSTS)) return { tier: "non-primary", label: "encyclopedia/wiki" };
  if (hostMatches(host, HOSPITAL_HOSTS) || hostMatches(host, HOSPITAL_SUFFIXES)) {
    return { tier: "non-primary", label: "hospital/patient-facing" };
  }
  if (hostMatches(host, MIRROR_HOSTS)) return { tier: "non-primary", label: "paper mirror host (metadata-judged)" };
  if (hostMatches(host, PORTAL_HOSTS)) return { tier: "non-primary", label: "gene/protein portal page" };

  // Gene-portal paths even off the exact hosts (ncbi.nlm.nih.gov/gene/…)
  if (/\/(gene|genes|Books|Bookshelf)\//i.test(path) && /ncbi|nih/i.test(host)) {
    return { tier: "non-primary", label: "gene portal/bookshelf page" };
  }
  if (NON_PRIMARY_PATH_RE.test(path)) {
    // .edu outreach/press pages, magazine sections, blogs
    if (/\.edu$/.test(host) || host.endsWith(".edu")) {
      return { tier: "non-primary", label: "university news/outreach page" };
    }
    return { tier: "non-primary", label: "news/blog/outreach path" };
  }
  if (WIKI_PATH_RE.test(path)) return { tier: "non-primary", label: "wiki page" };

  // Patient/education keywords in host tail (defensive catch for the long tail
  // of hospital & clinic sites not in the explicit list).
  if (/(hospital|clinic|medicalcenter|healthsystem|patients)/i.test(host)) {
    return { tier: "non-primary", label: "hospital/patient-facing" };
  }

  return { tier: "unknown", label: "unrecognized host" };
}

/**
 * Partition a curated citation pool into citable vs dropped-by-tier.
 *
 * `refs` and `scores` MUST be index-aligned (scores[i] describes refs[i]) —
 * that is the shape the v2 pipeline curate step produces. Only WEB-typed
 * references are subject to dropping; database-typed ones (pubmed/rcsb/
 * uniprot/…) pass untouched, and a ref with no URL at all passes (its tier
 * is decided elsewhere — e.g. pubmed refs are typed already).
 *
 * Fail-safe: if every ref would be dropped, returns the original pool with
 * fellBackToUnfiltered=true (the run degrades to pre-gate behavior rather
 * than dying).
 */
export function partitionCitablePool(refs: any[], scores: any[] = []): SourcePartition {
  const keptRefs: any[] = [];
  const keptScores: any[] = [];
  const dropped: { ref: any; reason: string }[] = [];

  for (let i = 0; i < refs.length; i++) {
    const ref = refs[i] ?? {};
    const type = String(ref.type || "").toLowerCase();
    const url: string = String(ref.url || "");
    // Database-typed refs are deliberate retrievals — exempt.
    if (type && type !== "web") {
      keptRefs.push(ref);
      keptScores.push(scores[i] ?? null);
      continue;
    }
    // No URL → cannot classify mechanically; keep (verify layer's job).
    if (!url) {
      keptRefs.push(ref);
      keptScores.push(scores[i] ?? null);
      continue;
    }
    const decision = classifySourceUrl(url);
    if (decision.tier === "non-primary") {
      // round-57 fix 2: mirror hosts (researchgate/academia) host BOTH bare
      // portal pages and full copies of PUBLISHED papers. A ref that carries
      // real publication metadata (journal AND year, or a doi) is a primary
      // paper behind a mirror link — keep it; only bare portal pages drop.
      if (decision.label.includes("mirror")) {
        const hasJournal = String(ref.journal || "").trim().length > 0;
        const hasYear = /^\d{4}$/.test(String(ref.year || "").trim());
        const hasDoi = String(ref.doi || "").trim().length > 0;
        if ((hasJournal && hasYear) || hasDoi) {
          keptRefs.push(ref);
          keptScores.push(scores[i] ?? null);
          continue;
        }
      }
      dropped.push({
        ref,
        reason: `${decision.label} — ${extractHost(url)}${extractPath(url).slice(0, 40)}`,
      });
      continue;
    }
    keptRefs.push(ref);
    keptScores.push(scores[i] ?? null);
  }

  if (keptRefs.length === 0 && refs.length > 0) {
    // Never brick the run: fall back to the unfiltered pool.
    return {
      keptRefs: refs,
      keptScores: scores,
      dropped,
      fellBackToUnfiltered: true,
    };
  }

  return { keptRefs, keptScores, dropped, fellBackToUnfiltered: false };
}
