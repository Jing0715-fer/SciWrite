import { db } from "@/lib/db";
async function main() {
  console.log("Trying to write...");
  try {
    const p = await db.project.create({
      data: { title: "wtest", topic: "wtest-topic", status: "active" },
    });
    console.log("WRITE OK, id=", p.id);
    await db.project.delete({ where: { id: p.id } });
    console.log("DELETE OK");
  } catch (e: any) {
    console.error("WRITE FAILED:", e?.message ?? String(e));
  }
  // Also test raw query
  try {
    await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS _wtest (id int)`);
    await db.$executeRawUnsafe(`INSERT INTO _wtest VALUES (1)`);
    await db.$executeRawUnsafe(`DROP TABLE _wtest`);
    console.log("RAW WRITE OK");
  } catch (e: any) {
    console.error("RAW WRITE FAILED:", e?.message ?? String(e));
  }
}
main().finally(() => db.$disconnect());
