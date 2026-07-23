import { NextRequest, NextResponse } from "next/server";
import { webSearch } from "@/lib/ai";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const { query, num } = await req.json();
    if (!query) {
      return NextResponse.json({ error: "Missing 'query'." }, { status: 400 });
    }
    const results = await webSearch(String(query), Number(num) || 8);
    return NextResponse.json({ query, items: results });
  } catch (err: any) {
    console.error("[/api/search] error:", err);
    return NextResponse.json(
      { error: err?.message || "Search failed." },
      { status: 500 }
    );
  }
}
