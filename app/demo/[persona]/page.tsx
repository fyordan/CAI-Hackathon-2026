import { getPersona } from "@/lib/personas";
import Workspace from "@/components/Workspace";

export default async function DemoPage({ params }: { params: Promise<{ persona: string }> }) {
  const { persona } = await params;
  return <Workspace persona={getPersona(persona)} />;
}
