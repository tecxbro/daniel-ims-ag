import { NextResponse } from "next/server";

export async function POST(req: Request) {
  const body = await req.json();

  // Keep Photon/Spectrum transport verification at the edge of the app, then
  // hand normalized events to your durable backend workflow.
  console.log("Photon event", body);

  return NextResponse.json({ ok: true });
}
