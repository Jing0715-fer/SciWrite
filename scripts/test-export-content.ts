async function main() {
  const resp = await fetch("http://localhost:3000/api/export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "article", id: "cmt9irxdu00o8rertvgdk79u3", format: "markdown", language: "en" }),
  });
  const text = await resp.text();
  // Find Ethics section
  const ethIdx = text.indexOf("## Ethical Considerations and Future Directions");
  const refIdx = text.indexOf("## References");
  if (ethIdx >= 0 && refIdx > ethIdx) {
    console.log("=== ETHICS CHAPTER IN EXPORT ===");
    console.log(text.slice(ethIdx, refIdx));
  }
  // Also verify "1987" and "Nobel Prize" are NOT in the Ethics chapter
  const ethSection = text.slice(ethIdx, refIdx);
  console.log(`\n--- repetition check on Ethics chapter ---`);
  console.log(`"1987" mentioned: ${ethSection.includes("1987") ? "YES (BUG)" : "no ✓"}`);
  console.log(`"Nobel" mentioned: ${ethSection.includes("Nobel") ? "YES (BUG)" : "no ✓"}`);
  console.log(`"Escherichia coli" mentioned: ${ethSection.includes("Escherichia coli") ? "YES (BUG)" : "no ✓"}`);
  console.log(`"Casgevy" mentioned: ${ethSection.includes("Casgevy") ? "YES" : "no"}`);
  console.log(`"cancer" mentioned: ${ethSection.includes("cancer") ? "YES (in new framing, not redundant)" : "no"}`);
}
main().catch(e=>console.error(e));
