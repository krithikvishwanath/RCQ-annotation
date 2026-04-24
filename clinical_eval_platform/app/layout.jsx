import "./globals.css";

export const metadata = {
  title: "ClinBench Evaluator",
  description: "Physician review portal for clinical LLM responses.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

