import { createRequest } from "@/lib/engine";
export async function POST(req: Request) {
  const { persona } = await req.json();
  return Response.json({ id: await createRequest(persona) });
}
