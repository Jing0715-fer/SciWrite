async function main() {
  const resp = await fetch("http://localhost:3000/api/export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "article",
      id: "cmt9irxdu00o8rertvgdk79u3",
      format: "markdown",
      language: "en",
    }),
  });
  console.log("status=", resp.status);
  const text = await resp.text();
  const idx = text.indexOf("Citation Validation");
  const uncitedIdx = text.toLowerCase().indexOf("uncited");
  const orphanIdx = text.toLowerCase().indexOf("orphan");
  console.log(`text length: ${text.length}`);
  console.log(`"Citation Validation" section: ${idx >= 0 ? "FOUND at " + idx : "NOT PRESENT (no issues = no appendix)"}`);
  console.log(`"uncited" occurrences: ${(text.match(/uncited/gi) || []).length}`);
  console.log(`"orphan" occurrences: ${(text.match(/orphan/gi) || []).length}`);
  if (idx >= 0) {
    console.log("\n=== Citation Validation Report appendix ===");
    console.log(text.slice(idx, idx + 1500));
  }
}
main().catch(e=>console.error(e));
