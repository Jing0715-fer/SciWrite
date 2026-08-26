import { db } from "@/lib/db";
async function main() {
  const p = await db.project.findUnique({ where: { id: "repro-v2-1787711990720" } });
  console.log("found?", p ? JSON.stringify({id:p.id,topic:p.topic}) : "NOT FOUND");
  const all = await db.project.findMany({ select: { id: true, topic: true } });
  console.log("all projects:", all.map(x => ({id:x.id, topic: x.topic.slice(0,40)})));
}
main().catch(e=>console.error(e?.message ?? e)).finally(()=>db.$disconnect());
