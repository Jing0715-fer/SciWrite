async function main() {
  // The page calls /api/articles/[id] to load the article for viewing.
  const resp = await fetch("http://localhost:3000/api/articles/cmt9irxdu00o8rertvgdk79u3");
  console.log("GET /api/articles/[id]:", resp.status);
  const j = await resp.json();
  const content = j.article?.content || j.content || "";
  const ethStart = content.indexOf("## Ethical Considerations and Future Directions");
  const refStart = content.indexOf("## References");
  if (ethStart >= 0 && refStart > ethStart) {
    const ethSection = content.slice(ethStart, refStart);
    console.log("\n=== User-visible Ethics chapter ===");
    console.log(ethSection.slice(0, 500) + "...");
    console.log(`\n--- repetition check ---`);
    console.log(`"1987" mentioned: ${ethSection.includes("1987") ? "YES (BUG)" : "no ✓"}`);
    console.log(`"Nobel" mentioned: ${ethSection.includes("Nobel") ? "YES (BUG)" : "no ✓"}`);
    console.log(`"Escherichia coli" mentioned: ${ethSection.includes("Escherichia coli") ? "YES (BUG)" : "no ✓"}`);
  } else {
    console.log("Ethics section not found in user-visible content!");
    console.log("ethStart:", ethStart, "refStart:", refStart);
  }
  // Check article word count
  const wc = (content.match(/\S+/g) || []).length;
  console.log(`\nArticle word count (user-visible): ${wc}`);
}
main().catch(e=>console.error(e));
