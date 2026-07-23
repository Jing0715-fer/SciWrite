import { NextRequest, NextResponse } from "next/server";
import { readPage } from "@/lib/ai";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const { url } = await req.json();
    if (!url) {
      return NextResponse.json({ error: "Missing 'url'." }, { status: 400 });
    }
    const result = await readPage(String(url));
    return NextResponse.json(result);
  } catch (err: any) {
    console.error("[/api/reader] error:", err);
    return NextResponse.json(
      { error: err?.message || "Reader failed." },
      { status: 500 }
    );
  }
}
