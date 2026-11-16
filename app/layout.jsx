import "./styles.css";
import "./theme.css";
import "./scanforge.css";

export const metadata = {
  title: "ScanForge — Automated Website Testing & Quality Analysis",
  description: "Automated website testing, quality analysis, and workspace reporting."
};

export default function RootLayout({ children }) {
  return <html lang="en"><body suppressHydrationWarning>{children}</body></html>;
}
