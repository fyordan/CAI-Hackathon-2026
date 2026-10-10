import { loadPersona } from "@/lib/profiles";
import Workspace from "@/components/Workspace";

export default async function DemoPage({ params }: { params: Promise<{ persona: string }> }) {
  const { persona } = await params;
  return <Workspace persona={await loadPersona(persona)} />;
}
