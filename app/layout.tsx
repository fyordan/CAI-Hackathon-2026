import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "leaflet/dist/leaflet.css";
import "./globals.css";
import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "CitaYa PR (demo)",
  description: "Describe what you need; an agent finds Puerto Rico offices that fit and calls them for you. Hackathon demo with simulated calls and a synthetic directory.",
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#2F5D7C" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
