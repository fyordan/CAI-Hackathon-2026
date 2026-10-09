import { resetDemo } from "@/lib/demo";
export async function POST() { return Response.json(await resetDemo()); }
