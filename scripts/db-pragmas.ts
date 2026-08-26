import { db } from "@/lib/db";
async function main() {
  const j = await db.$queryRawUnsafe(`PRAGMA journal_mode`);
  console.log("journal_mode:", JSON.stringify(j));
  const q = await db.$queryRawUnsafe(`PRAGMA quick_check`);
  console.log("quick_check:", JSON.stringify(q));
  const s = await db.$queryRawUnsafe(`PRAGMA writable_schema`);
  console.log("writable_schema:", JSON.stringify(s));
  const r = await db.$queryRawUnsafe(`PRAGMA read_only`);
  console.log("read_only PRAGMA result:", JSON.stringify(r));
}
main().catch(e=>console.error("err:", e?.message ?? String(e))).finally(()=>db.$disconnect());
