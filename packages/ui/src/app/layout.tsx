
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SLAD OS",
  description: "SLAD OS prototype",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es">
      <body>
        <div id="root">{children}</div>
      </body>
    </html>
  );
}
